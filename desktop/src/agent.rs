//! The agent loop: send the conversation, stream the reply, run the tools it
//! asks for, repeat until it answers. Runs on the async runtime and reports to
//! the window through events.

use crate::models::{self, ProviderId, Usage, Vision};
use crate::plugins;
use crate::prompt;
use crate::provider::{self, Delta, RoundError, Target, ThinkingStyle};
use crate::compact;
use crate::diagnostics;
use crate::mcp;
use crate::store::{Attachment, Bucket, Role, Settings, ToolEvent};
use crate::tools::{self, ChatState, Ctx, exec::Procs};
use base64::Engine;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

/// Tool rounds one reply may take before it stops and offers to continue.
const MAX_ROUNDS: usize = 64;
/// Times a reply cut off by the output limit is asked to carry on.
const MAX_CONTINUATIONS: usize = 3;
const MAX_RETRIES: usize = 3;
/// Earlier turns sent verbatim with each request.
const HISTORY_TURNS: usize = 40;
/// Newest tool results that are never collapsed.
const KEEP_RECENT_RESULTS: usize = 6;

pub enum Event {
    /// What the model is doing right now: "Thinking", "Writing", "Working".
    Status(&'static str),
    Reasoning(String),
    Content(String),
    /// A tool call still streaming its arguments. `path` is the file it names, once that much has arrived.
    ToolDraft { name: String, chars: usize, path: Option<String> },
    /// The reply took in a "btw" note before round `round` (counted from 1).
    NoteRead { note: String, round: usize },
    /// A request failed and try `attempt` of `attempts` starts after `wait`.
    Retry { reason: String, attempt: usize, attempts: usize, wait: Duration },
    ToolStart(ToolEvent),
    ToolDone { id: String, ok: bool, summary: String, image: Option<PathBuf>, changed: Option<String> },
    /// `key` is what "Always allow this" remembers; `mcp` titles the card for a remote tool.
    Approval { command: String, reason: String, key: String, mcp: bool, reply: oneshot::Sender<bool> },
    Question { question: String, options: Vec<String>, context: String, reply: oneshot::Sender<String> },
    Usage(Usage),
    /// Where the newest request's characters went.
    Context(Vec<Bucket>),
    /// The plan or findings changed.
    State(ChatState),
    /// A one-line note shown in the reply: retrying, continuing, context trimmed.
    Notice(String),
    Done { finish: Option<String>, incomplete: bool, stop_reason: Option<String> },
    Error(String),
}

/// Sends events to the window and wakes it up to draw them.
#[derive(Clone)]
pub struct Emitter {
    tx: mpsc::Sender<Event>,
    wake: Arc<dyn Fn() + Send + Sync>,
}

impl Emitter {
    pub fn new(tx: mpsc::Sender<Event>, wake: impl Fn() + Send + Sync + 'static) -> Emitter {
        Emitter { tx, wake: Arc::new(wake) }
    }
    pub fn send(&self, event: Event) {
        let _ = self.tx.send(event);
        (self.wake)();
    }
    pub fn wake(&self) {
        (self.wake)();
    }
    pub fn state(&self, state: ChatState) {
        self.send(Event::State(state));
    }
    /// Asks the user to allow a command. False when declined or the window is gone.
    pub async fn approve(&self, command: &str, reason: &str) -> bool {
        self.ask(command, reason, command, false).await
    }
    /// The same card for a call to an MCP server: `display` is shown, `key` is remembered.
    pub async fn approve_mcp(&self, display: &str, key: &str) -> bool {
        self.ask(display, "", key, true).await
    }
    async fn ask(&self, command: &str, reason: &str, key: &str, mcp: bool) -> bool {
        let (reply, answer) = oneshot::channel();
        self.send(Event::Approval { command: command.to_string(), reason: reason.to_string(), key: key.to_string(), mcp, reply });
        answer.await.unwrap_or(false)
    }
    pub async fn question(&self, question: &str, options: Vec<String>, context: &str) -> Option<String> {
        let (reply, answer) = oneshot::channel();
        self.send(Event::Question { question: question.to_string(), options, context: context.to_string(), reply });
        answer.await.ok()
    }
}

/// One message from the user, with everything needed to answer it.
pub struct Request {
    pub settings: Settings,
    /// Earlier turns of this chat, oldest first.
    pub history: Vec<(Role, String)>,
    pub text: String,
    /// Pictures attached to this message, as data URLs.
    pub images: Vec<Attachment>,
    /// The system message standing in for turns older than `history` (`summary::render`).
    pub summary: Option<String>,
    pub workspace: PathBuf,
    pub state_dir: PathBuf,
    pub chat: ChatState,
    pub conv_id: String,
    /// "btw" notes the user adds while the reply runs.
    pub notes: Arc<Mutex<Vec<String>>>,
}

struct Ending {
    finish: Option<String>,
    incomplete: bool,
    stop_reason: Option<String>,
}

pub async fn run(req: Request, emit: Emitter, procs: Arc<Procs>) {
    match run_inner(req, &emit, procs).await {
        Ok(end) => emit.send(Event::Done { finish: end.finish, incomplete: end.incomplete, stop_reason: end.stop_reason }),
        Err(message) => emit.send(Event::Error(message)),
    }
}

fn image_part(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    let mime = match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "image/png",
    };
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(json!({ "type": "image_url", "image_url": { "url": format!("data:{mime};base64,{data}") } }))
}

use compact::size_of as chars_of;

/// Collapses old tool output once the transcript outgrows the model's window.
/// The newest results stay whole. Returns how many were collapsed.
fn prune(messages: &mut [Value], budget_chars: usize) -> usize {
    let mut total = chars_of(messages);
    if total <= budget_chars {
        return 0;
    }
    let tools: Vec<usize> = (0..messages.len()).filter(|&i| messages[i]["role"] == "tool").collect();
    let mut collapsed = 0;
    for &i in tools.iter().take(tools.len().saturating_sub(KEEP_RECENT_RESULTS)) {
        let len = messages[i]["content"].as_str().map_or(0, str::len);
        if len > 600 {
            let head: String = messages[i]["content"].as_str().unwrap_or("").chars().take(200).collect();
            messages[i]["content"] = json!(format!("{head}\n[The rest of this earlier output was removed to save context. Run the tool again if you need it.]"));
            total -= len - 300;
            collapsed += 1;
            if total <= budget_chars {
                break;
            }
        }
    }
    collapsed
}

async fn run_inner(req: Request, emit: &Emitter, procs: Arc<Procs>) -> Result<Ending, String> {
    let s = &req.settings;
    let target = provider::resolve_target(&s.model, s)?;
    let customs = &s.custom_models;

    let effort = if s.effort == "auto" { prompt::auto_effort(&req.text) } else { s.effort.as_str() };
    // Local models on a CPU cannot spend the top effort: thinking fills the output budget and no answer comes.
    let effort = if target.style == ThinkingStyle::Qwen && s.effort == "auto" && effort == "max" { "high" } else { effort };
    let thinking = effort != "none";

    std::fs::create_dir_all(&req.workspace).map_err(|e| format!("Cannot open the workspace folder {}: {e}", req.workspace.display()))?;
    let native_vision = target.model.vision == Vision::Native;
    let web_search = s.web_mode() != "off" && (!s.tavily().is_empty() || !s.exa().is_empty());
    let git_repo = req.workspace.join(".git").exists();
    let window = models::context_window(&target.model.id, customs);
    // About 3.5 characters per token; a single read may use a quarter of the window.
    let window_chars = window as usize * 7 / 2;

    let chat = Arc::new(Mutex::new(req.chat.clone()));
    let ctx = Ctx {
        root: req.workspace.clone(),
        state_dir: req.state_dir.clone(),
        settings: s.clone(),
        client: provider::client(),
        read_chars: (window_chars / 4).clamp(20_000, 400_000),
        emit: emit.clone(),
        chat: chat.clone(),
        procs,
        planner: provider::helper_target(s).map(|h| crate::search::Planner { api_key: h.api_key, base_url: h.base_url, api_model: h.api_model, deepseek: h.style == ThinkingStyle::Deepseek }),
    };

    let every = plugins::all(&s.custom_plugins);
    let directives = plugins::directives(&every, &s.enabled_plugins);
    let mut system = prompt::system(&plugins::legacy_prompt(&every, &s.enabled_plugins), web_search, native_vision, git_repo);
    // Standing orders go at the start of the first system message: some lanes only honour that one.
    if !directives.is_empty() {
        system = format!("{directives}\n\n{system}");
    }

    let mut messages: Vec<Value> = vec![json!({ "role": "system", "content": system })];
    if let Some(summary) = req.summary.as_deref().filter(|s| !s.trim().is_empty()) {
        messages.push(json!({ "role": "system", "content": summary }));
    }
    let skip = req.history.len().saturating_sub(HISTORY_TURNS);
    for (role, text) in req.history.iter().skip(skip).filter(|(_, t)| !t.trim().is_empty()) {
        messages.push(json!({ "role": if *role == Role::User { "user" } else { "assistant" }, "content": text }));
    }
    let images: Vec<Value> = if native_vision { req.images.iter().filter_map(|a| a.data_url.as_ref()).map(|url| json!({ "type": "image_url", "image_url": { "url": url } })).collect() } else { Vec::new() };
    if images.is_empty() {
        let note = if req.images.is_empty() { String::new() } else { format!("\n\n[The user attached {} image(s), but this model cannot see images.]", req.images.len()) };
        messages.push(json!({ "role": "user", "content": format!("{}{note}", req.text) }));
    } else {
        let mut parts = vec![json!({ "type": "text", "text": req.text })];
        parts.extend(images);
        messages.push(json!({ "role": "user", "content": parts }));
    }

    let mut tool_defs = tools::definitions(web_search, native_vision, git_repo);
    // Tools lent by the MCP servers switched on in Settings ride after the built-in ones.
    tool_defs.extend(mcp::tools_for_model(&ctx.client, &crate::store::data_dir()).await);
    let tools_chars = json!(tool_defs).to_string().len();
    let mut usage = Usage::default();
    let mut mandatory = target.provider == ProviderId::Openrouter && provider::openrouter_reasoning_mandatory(&target.model.id);
    let mut continuations = 0;
    let mut nudged = false;
    let mut last_finish = None;
    // Set once the pinned OpenRouter endpoint turned the run away.
    let mut unpinned = false;

    for round in 0..MAX_ROUNDS {
        // Anything the user said in passing joins the conversation before the next request.
        for note in std::mem::take(&mut *req.notes.lock().unwrap()) {
            emit.send(Event::NoteRead { note: note.clone(), round: round + 1 });
            messages.push(json!({ "role": "user", "content": format!("[Note from the user while you work. Take it into account and carry on; do not start over.]
{note}") }));
        }
        // The valve: finished rounds fold into one line each once the run passes 65% of the window.
        let folded = compact::fold(&mut messages, window);
        if folded.rounds > 0 {
            emit.send(Event::Notice(format!("Context compacted · {} steps summarised · about {} tokens saved", folded.rounds, folded.tokens_saved)));
        }
        // Still too big after that (huge tool results in the rounds kept): collapse the oldest of them.
        let collapsed = prune(&mut messages, window_chars * 8 / 10);
        if collapsed > 0 {
            emit.send(Event::Notice(format!("Trimmed {collapsed} older tool results to fit the context window")));
        }

        // What exists right now, the plan and the findings ride at the end, so the
        // start of the request stays byte-identical and the provider's prompt cache keeps hitting.
        let tail = {
            let state = chat.lock().unwrap();
            let mut t = tokio::task::block_in_place(|| tools::files::workspace_context(&req.workspace));
            if let Some(plan) = &state.plan {
                t.push_str(&format!("\n\n{}", tools::plan::format_plan(plan)));
            }
            let findings = tools::plan::format_findings(&state.findings);
            if !findings.is_empty() {
                t.push_str(&format!("\n\n{findings}"));
            }
            t
        };
        let mut wire = messages.clone();
        if target.style == ThinkingStyle::Qwen {
            // Qwen's template only accepts a system message at index 0.
            let first = wire[0]["content"].as_str().unwrap_or("").to_string();
            wire[0]["content"] = json!(format!("{first}\n\n{tail}"));
        } else {
            wire.push(json!({ "role": "system", "content": tail }));
        }

        let mut body = Map::new();
        body.insert("model".into(), json!(target.api_model));
        body.insert("messages".into(), json!(wire));
        body.insert("stream".into(), json!(true));
        body.insert("stream_options".into(), json!({ "include_usage": true }));
        body.insert("max_tokens".into(), json!(target.model.max_output_tokens));
        body.insert("tools".into(), json!(tool_defs));
        body.insert("tool_choice".into(), json!("auto"));
        if target.provider == ProviderId::Openrouter {
            // Pins every round of this chat to one endpoint, so its prompt cache stays warm.
            body.insert("session_id".into(), json!(format!("conv-{}", req.conv_id)));
            if let Some(pinned) = provider::openrouter_provider_for(&target.model.id).filter(|_| !unpinned) {
                body.insert("provider".into(), pinned);
            }
        }
        provider::apply_thinking(&mut body, target.style, thinking, effort, mandatory);
        emit.send(Event::Context(compact::breakdown(&wire, tools_chars)));

        emit.send(Event::Status(if round > 0 { "Working" } else if thinking { "Thinking" } else { "Writing" }));
        let result = stream_with_retries(&ctx.client, &target, &mut body, &mut mandatory, &mut unpinned, thinking, effort, emit).await.inspect_err(|e| diagnostics::record("api_error", &target.model.id, e))?;

        if let Some(u) = result.usage {
            usage.add(u);
            emit.send(Event::Usage(usage));
        }
        last_finish = result.finish.clone();
        let cut_off = matches!(result.finish.as_deref(), Some("length" | "max_tokens"));

        let mut assistant = json!({ "role": "assistant", "content": result.content });
        // DeepSeek requires the reasoning back on tool-calling turns; OpenRouter's lanes reject the field.
        if target.provider != ProviderId::Openrouter && !result.reasoning.is_empty() {
            assistant["reasoning_content"] = json!(result.reasoning);
        }
        if !result.tool_calls.is_empty() {
            assistant["tool_calls"] = result
                .tool_calls
                .iter()
                .map(|c| json!({ "id": c.id, "type": "function", "function": { "name": c.name, "arguments": if c.args.trim().is_empty() { "{}" } else { &c.args } } }))
                .collect();
        }
        messages.push(assistant);

        if result.tool_calls.is_empty() {
            if cut_off && continuations < MAX_CONTINUATIONS {
                continuations += 1;
                emit.send(Event::Notice(format!("The reply hit the output limit. Continuing ({continuations}/{MAX_CONTINUATIONS})")));
                messages.push(json!({ "role": "user", "content": "Your reply was cut off by the output limit. Continue exactly where you stopped, without repeating anything." }));
                continue;
            }
            if result.content.trim().is_empty() && !nudged {
                // Thought, then said nothing: ask once for the answer itself.
                nudged = true;
                messages.push(json!({ "role": "user", "content": "You reasoned but wrote no answer. Do not think more. Give the answer or make the next tool call now." }));
                continue;
            }
            return Ok(Ending { finish: last_finish, incomplete: cut_off, stop_reason: cut_off.then(|| "The reply hit the output limit.".to_string()) });
        }

        emit.send(Event::Status("Working"));
        let mut looks: Vec<PathBuf> = Vec::new();
        let mut finished = false;
        for call in &result.tool_calls {
            let args_text = if call.args.trim().is_empty() { "{}" } else { call.args.as_str() };
            emit.send(Event::ToolStart(ToolEvent { id: call.id.clone(), name: call.name.clone(), args: args_text.to_string(), ..Default::default() }));
            let out = match serde_json::from_str::<Value>(args_text) {
                Ok(args) => tools::run(&call.name, &args, &ctx).await,
                Err(e) if cut_off => tools::Output::fail(format!("This call was cut off by the output limit before its arguments were complete ({e}). Send it again in smaller pieces: fewer files per call, or one file at a time.")),
                Err(e) => tools::Output::fail(format!("The arguments were not valid JSON ({e}). Send the call again.")),
            };
            if !out.ok {
                diagnostics::record("tool_failed", &call.name, if out.summary.is_empty() { &out.text } else { &out.summary });
            }
            emit.send(Event::ToolDone { id: call.id.clone(), ok: out.ok, summary: out.summary.clone(), image: out.image.clone(), changed: out.changed.clone() });
            messages.push(json!({ "role": "tool", "tool_call_id": call.id, "content": out.text }));
            looks.extend(out.look);
            if out.finish {
                // The receipt becomes the closing text, so a reply never ends on a bare tool step.
                let args: Value = serde_json::from_str(args_text).unwrap_or_default();
                let field = |key: &str| args[key].as_str().unwrap_or("").trim().to_string();
                emit.send(Event::Content(format!("{}

Verified: {}", field("result"), field("verified"))));
            }
            finished |= out.finish;
        }
        // Pictures the model asked to see follow the tool results as a user message: a tool result cannot carry one.
        let parts: Vec<Value> = looks.iter().filter_map(|p| image_part(p)).collect();
        if !parts.is_empty() {
            let mut content = vec![json!({ "type": "text", "text": "[tool image] The image(s) you asked to view:" })];
            content.extend(parts);
            messages.push(json!({ "role": "user", "content": content }));
        }
        if finished {
            return Ok(Ending { finish: Some("stop".into()), incomplete: false, stop_reason: None });
        }
        if let (Some(limit), Some(spent)) = (s.budget_usd.filter(|l| *l > 0.0), usage.cost(&target.model.id, customs)) {
            if spent >= limit {
                diagnostics::record("run_stopped", "spending limit", &format!("${spent:.3} of ${limit:.2}"));
                return Ok(Ending { finish: last_finish, incomplete: true, stop_reason: Some(format!("Stopped at the spending limit (${spent:.3} of ${limit:.2}). The work so far is saved.")) });
            }
        }
    }
    diagnostics::record("limit_hit", "tool rounds", &format!("Stopped after {MAX_ROUNDS} tool rounds."));
    Ok(Ending { finish: last_finish, incomplete: true, stop_reason: Some(format!("Stopped after {MAX_ROUNDS} tool rounds. Send \"continue\" to carry on.")) })
}

/// One round, retried on transient failures as long as nothing reached the user yet.
async fn stream_with_retries(
    client: &reqwest::Client,
    target: &Target,
    body: &mut Map<String, Value>,
    mandatory: &mut bool,
    unpinned: &mut bool,
    thinking: bool,
    effort: &str,
    emit: &Emitter,
) -> Result<provider::Round, String> {
    let mut attempt = 0;
    loop {
        let mut announced = "";
        let wire = Value::Object(body.clone());
        let result = provider::stream_round(client, target, &wire, |delta| match delta {
            Delta::Reasoning(t) => emit.send(Event::Reasoning(t.to_string())),
            Delta::Content(t) => {
                if announced != "Writing" {
                    announced = "Writing";
                    emit.send(Event::Status("Writing"));
                }
                emit.send(Event::Content(t.to_string()));
            }
            Delta::ToolDraft { name, chars, args } => emit.send(Event::ToolDraft { name: name.to_string(), chars, path: draft_path(args) }),
        })
        .await;
        let RoundError { message, status, detail, retryable } = match result {
            Ok(round) => return Ok(round),
            Err(e) => e,
        };
        // An endpoint that refuses "reasoning off" gets minimal effort instead, for the rest of the run.
        if status == 400 && !*mandatory && detail.to_lowercase().contains("reasoning is mandatory") {
            *mandatory = true;
            body.remove("reasoning");
            provider::apply_thinking(body, target.style, thinking, effort, true);
            continue;
        }
        // The cheap pinned endpoint is rate limited: any other one beats no answer, for the rest of the run.
        if status == 429 && body.remove("provider").is_some() {
            *unpinned = true;
            emit.send(Event::Notice("This model's usual provider is busy, so OpenRouter picks another one for this reply. It can cost a little more.".into()));
            continue;
        }
        attempt += 1;
        if !retryable || attempt >= MAX_RETRIES {
            return Err(message);
        }
        let wait = Duration::from_secs(2 << attempt);
        emit.send(Event::Retry { reason: message, attempt: attempt + 1, attempts: MAX_RETRIES, wait });
        tokio::time::sleep(wait).await;
    }
}

/// The file a tool call still streaming in is about, once its whole "path" has arrived.
fn draft_path(args: &str) -> Option<String> {
    static PATH: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r#""path"\s*:\s*"([^"]+)""#).unwrap());
    // The path leads the arguments: the file content after it is not searched again on every chunk.
    PATH.captures(&args[..args.floor_char_boundary(400)]).map(|c| c[1].replace("\\\\", "/"))
}

/// Measures how long a stretch of thinking took, for "Thought for 12s".
pub struct Stopwatch(Option<Instant>);

impl Stopwatch {
    pub fn new() -> Stopwatch {
        Stopwatch(None)
    }
    pub fn start(&mut self) {
        self.0.get_or_insert_with(Instant::now);
    }
    /// Whole seconds since `start`, while it runs.
    pub fn secs(&self) -> Option<u64> {
        self.0.map(|t| t.elapsed().as_secs())
    }
    /// Milliseconds since `start`, and resets.
    pub fn stop(&mut self) -> u64 {
        self.0.take().map_or(0, |t| t.elapsed().as_millis() as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_collapses_old_results_only() {
        let big = "x".repeat(5_000);
        let mut messages: Vec<Value> = vec![json!({"role": "system", "content": "s"})];
        for i in 0..10 {
            messages.push(json!({"role": "tool", "tool_call_id": i.to_string(), "content": big}));
        }
        assert_eq!(prune(&mut messages.clone(), 1_000_000), 0);
        let collapsed = prune(&mut messages, 10_000);
        assert_eq!(collapsed, 10 - KEEP_RECENT_RESULTS);
        assert!(messages[1]["content"].as_str().unwrap().contains("removed to save context"));
        assert_eq!(messages[10]["content"].as_str().unwrap().len(), 5_000);
    }
}

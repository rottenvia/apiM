//! The agent loop: send the conversation, stream the reply, run the tools it
//! asks for, repeat until it answers. Runs on the async runtime and reports to
//! the window through events.
//!
//! Around each round it does what the web app's chat route does: retries a
//! request the provider dropped, reshapes one it rejected, carries on a reply
//! that was cut off, picks up a model that stopped mid-task, and halts a run
//! that repeats itself, makes no progress, or reaches the spending limit. The
//! rules live in `run`, one module per web library; this file wires them in.

use crate::compact;
use crate::context::findings::{self, NewFinding};
use crate::context::goal_pin::{GOAL_PIN_MARKER, render_goal_pin, resolve_run_goal};
use crate::context::prune::{self as pruning, QWEN_PRUNE, prune_transcript};
use crate::context::rebuild_resume::{EXACT_RESUME_INSTRUCTION, ResumeState, rebuild_resume_from_stored, rebuilt_resume_instruction};
use crate::context::refine::{self, KnownLesson, Outcome};
use crate::context::subagent::{self, ToolRunner, delegate_tool, parse_delegate_args};
use crate::context::tool_limits::tool_limits_for;
use crate::context::Stop;
use crate::context::tree_delta::{StepKind, TreeEntry, TreeTracker};
use crate::context::workspace_context::build_workspace_context;
use crate::diagnostics;
use crate::lessons::{self, Lesson};
use crate::local;
use crate::mcp;
use crate::media::multimodal::strip_ride_along_videos;
use crate::models::{self, ProviderId, Usage, Vision};
use crate::plugins;
use crate::prompt;
use crate::provider::{self, Delta, Failure, Target, ThinkingStyle};
use crate::run::budget::{self, Budget, Verdict};
use crate::run::dedup::ContinuationDedup;
use crate::run::loop_breaker::{self, LoopBreaker};
use crate::run::revive::{self, Premature};
use crate::run::stall::{self, ChurnTracker, GatherTracker, PreviewTracker, StallTracker};
use crate::run::{fixed, head, plan, retry, transcript};
use crate::store::{Attachment, Bucket, Role, Settings, ToolEvent};
use crate::tools::{self, ChatState, Ctx, exec::Procs};
use base64::Engine;
use serde_json::{Map, Value, json};
use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

/// Times a reply cut off by the output limit is asked to carry on.
const MAX_CONTINUATIONS: u32 = 16;
/// Times a reply whose stream ended without a finish reason is asked to carry on.
const MAX_STREAM_CUTS: u32 = 4;
/// Times a round that spent its whole output on thinking is told to answer without it.
const MAX_THINK_NUDGES: u32 = 2;
/// Waits on a rate limit that outlasted the ordinary retries.
const MAX_RATE_LIMIT_WAITS: u32 = 6;
/// Times steps blocked by a refusal, or before anything was tried, are reopened.
const MAX_REFUSAL_REOPENS: u32 = 2;
/// What a request rejected for its size is folded down to before the retry.
const FOLD_RETRY_TARGET_CHARS: usize = 350_000;
/// Newest tool results that are never collapsed.
const KEEP_RECENT_RESULTS: usize = 6;

// What the model is told on the paths below. The wording is the web app's.
const CARRY_ON: &str = "Continue from exactly where you stopped — do not repeat anything you already wrote, do not restate the plan, and do not apologise. Carry straight on from the last character.";
const CLAIM_RETRY: &str = "Your reply above describes tools running and reporting results — edits applied, a build coming back green, checks passing — but those tools were not called in this reply. The user reads that as work that happened. Finish this reply one of two ways: either actually call the tools now and report exactly what comes back, or rewrite the reply to state plainly what was and was not done. Do not describe output you do not have.";
const REOPEN_BLOCKED: &str = "A blocked step means something OUTSIDE your control is in the way — a failing command, a missing file, a decision only the user can make. It is not a way to decline the task. This is ordinary creative and technical work on the user's own machine; there is nothing here to refuse. The blocked steps have been reopened. Do them now: pick a concrete approach and start with the first tool call. If your first idea for an approach seems unsuitable, use a different approach — do not stop. Only a real external obstacle may block a step, and even then ask_user first.";
const BLOCKED_UNTRIED: &str = "You marked work blocked without attempting any of it. Try the steps first. If something genuinely cannot be done — a missing key, a decision only the user can make — use ask_user to ask for it directly rather than stopping.";
const NARRATED: &str = "\n\nYou just described the next action instead of doing it. Do not narrate, plan aloud, or repeat what you already said — call the tool in this response.";
const THINK_ONLY: [&str; 2] = [
    "You used the whole output budget on thinking and produced no answer and no tool call. Stop reasoning. Call a tool or write the reply now. Do not think more.",
    "Still no answer and no tool call. Do not think. Write the reply or call a tool NOW, briefly.",
];

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
    /// A web search a tool call ran: its sources, queries and cost, for the reply it belongs to.
    WebSearch(crate::search::SearchOutcome),
    /// A helper's rounds so far, for its still-running `delegate` row.
    ToolProgress { id: String, text: String },
    /// `key` is what "Always allow this" remembers; `mcp` titles the card for a remote tool.
    Approval { command: String, reason: String, key: String, mcp: bool, reply: oneshot::Sender<bool> },
    Question { question: String, options: Vec<String>, context: String, reply: oneshot::Sender<String> },
    Usage(Usage),
    /// Where the newest request's characters went.
    Context(Vec<Bucket>),
    /// The plan or findings changed.
    State(ChatState),
    /// The model switched a plugin on or off, for this chat or (`all`) for every chat. An empty id: only the
    /// user's list of plugins changed.
    Skill { id: String, all: bool, on: bool },
    /// The tool groups this chat has loaded so far.
    Groups(Vec<String>),
    /// A one-line note shown in the reply: retrying, continuing, context trimmed.
    Notice(String),
    /// The transcript so far, in the shape of the web's `resumeState`: kept on the reply so Resume can replay it.
    Checkpoint(Value),
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
    /// Like approve, but "always allow" remembers `key` instead of the command line shown.
    pub async fn approve_keyed(&self, command: &str, reason: &str, key: &str) -> bool {
        self.ask(command, reason, key, false).await
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
#[derive(Default)]
pub struct Request {
    pub settings: Settings,
    /// Earlier turns of this chat, oldest first, each with the attachments it carried.
    pub history: Vec<(Role, String, Vec<Attachment>)>,
    pub text: String,
    /// Pictures attached to this message, as data URLs.
    pub images: Vec<Attachment>,
    /// The system message standing in for turns older than `history` (`summary::render`).
    pub summary: Option<String>,
    /// The newest earlier question (never a "btw" note): the goal a bare "continue" falls back to.
    pub history_last_user: Option<String>,
    pub workspace: PathBuf,
    pub state_dir: PathBuf,
    pub chat: ChatState,
    pub conv_id: String,
    /// "btw" notes the user adds while the reply runs.
    pub notes: Arc<Mutex<Vec<String>>>,
    /// Set to carry on an interrupted reply to this message instead of answering it from the start.
    pub resume: Option<Resume>,
}

/// An interrupted reply to carry on.
pub struct Resume {
    /// The reply as the web stores it (`Message::to_web`): its saved transcript under `resumeState`, or the text and steps one is rebuilt from.
    pub prior: Value,
    /// What the user typed next to "resume": an instruction for the rest of the work.
    pub note: String,
    /// What the reply had used before it stopped, so its totals carry on.
    pub usage: Usage,
}

struct Ending {
    finish: Option<String>,
    incomplete: bool,
    stop_reason: Option<String>,
    /// What each tool call did, for the lessons pass. Empty when lessons are off.
    outcomes: Vec<Outcome>,
}

/// Why the loop ended short of a finished answer.
enum Halt {
    Premature(Premature),
    /// Every nudge to stop thinking was spent and the output still went to thought.
    ThinkCeiling,
    OutputCeiling,
    CutsExhausted,
    Budget,
}

/// What a run learns about its endpoint along the way. Each stays for the rest of the reply.
#[derive(Default)]
struct Lane {
    /// The endpoint refuses "reasoning off": minimal effort is sent instead.
    mandatory: bool,
    /// The pinned OpenRouter endpoint turned the run away.
    unpinned: bool,
    /// Each tool turn's reasoning is replayed in OpenRouter's `reasoning` field (DeepSeek models behind it need it back).
    replay: bool,
    /// Rounds that only got through with their tools stripped.
    degraded: u32,
}

/// The workspace listing the model was last shown in full, and what has changed since.
#[derive(Default)]
struct Tree {
    tracker: TreeTracker,
    shown: String,
}

impl Tree {
    /// Every file but LESSONS.md, which is already in the prompt as text.
    fn list(root: &Path) -> (Vec<(String, u64)>, Vec<TreeEntry>) {
        let mut files = tokio::task::block_in_place(|| tools::files::walk(root, root));
        files.retain(|(path, _)| path != "LESSONS.md");
        let entries = files.iter().map(|(path, size)| TreeEntry { path: path.clone(), size: *size }).collect();
        (files, entries)
    }

    /// Puts a full listing at the end, in place of any older one and the deltas that described changes to it.
    /// It rides at the end so everything before it stays byte-identical for the provider's cache. The wording is the web's.
    fn show(&mut self, text: String, messages: &mut Vec<Value>) {
        messages.retain(|m| !(m["role"] == "system" && m["content"].as_str().is_some_and(|c| c.starts_with("Current workspace contents") || c.starts_with("Workspace changes since"))));
        messages.push(json!({ "role": "system", "content": format!("Current workspace contents (refreshed after every action — this replaces any earlier listing):{text}") }));
        self.shown = text;
    }

    /// The opening listing. The tracker is seeded with it, so the first delta describes changes from what the model saw.
    fn open(root: &Path, messages: &mut Vec<Value>) -> Tree {
        let (files, entries) = Tree::list(root);
        let mut tree = Tree::default();
        tree.show(build_workspace_context(Some(&files)), messages);
        tree.tracker.update(&entries);
        tree
    }

    /// After a round's tools: nothing, a short delta appended, or a fresh listing once the deltas outgrow one.
    fn refresh(&mut self, root: &Path, messages: &mut Vec<Value>) {
        let (files, entries) = Tree::list(root);
        let step = self.tracker.update(&entries);
        match step.kind {
            StepKind::None => {}
            StepKind::Delta => messages.push(json!({ "role": "system", "content": step.text })),
            StepKind::Baseline => {
                let next = build_workspace_context(Some(&files));
                if next != self.shown {
                    self.show(next, messages);
                }
            }
        }
    }
}

/// What a run starts from besides its opening messages.
#[derive(Default)]
struct Start {
    tree: Tree,
    /// This message's text and the question before it: what the goal pin restates.
    user_text: String,
    history_last_user: Option<String>,
    /// What a resumed reply had already spent: tool rounds, continuations against the output ceiling, nudges to stop thinking, tokens.
    tool_rounds: usize,
    continuations: u32,
    think_nudges: u32,
    usage: Usage,
    /// What a resumed reply had already written, and the tools it had really run: closing claims are held against both.
    answer: String,
    tools_used: Vec<String>,
}

/// The opening messages of a resumed reply: its saved transcript (the web's `resumeState`) in place of the fresh ones,
/// or the fresh ones followed by a transcript rebuilt from what the reply stored; then the brief to carry on.
/// With nothing to carry forward the fresh messages come back untouched and the question is simply answered again.
/// `findings` is the current findings block. The wording is the web's.
fn resume_transcript(mut resume: Resume, mut messages: Vec<Value>, start: &mut Start, findings: &str) -> Vec<Value> {
    let saved = serde_json::from_value::<ResumeState>(resume.prior["resumeState"].take()).ok().filter(|state| !state.messages.is_empty());
    let brief = match saved {
        Some(state) => {
            (start.tool_rounds, start.continuations, start.think_nudges) = (state.tool_rounds as usize, state.continuations, state.think_nudges.unwrap_or(0));
            messages = state.messages;
            EXACT_RESUME_INSTRUCTION.to_string()
        }
        None => {
            let Some(rebuilt) = rebuild_resume_from_stored(&resume.prior) else { return messages };
            // Unknown for a reply without a saved transcript: counted from the calls it made, so the run's length is not silently reset.
            start.tool_rounds = resume.prior["toolEvents"].as_array().map_or(0, Vec::len);
            // Some results above are placeholders, and the brief says which: telling the model everything is intact is how it describes a file it never saw.
            let brief = rebuilt_resume_instruction(&rebuilt);
            messages.extend(rebuilt.messages);
            brief
        }
    };
    // Anything typed next to "resume" goes last: the final thing read before continuing is where a course correction belongs.
    let note = resume.note.trim();
    messages.push(user(if note.is_empty() { brief } else { format!("{brief}\n\nThe user added this instruction for the rest of the work — follow it:\n{note}") }));
    if note.to_ascii_lowercase().contains("do not think more") {
        start.think_nudges = start.think_nudges.max(1);
    }
    // Conclusions recorded during the interrupted run are on disk but not in the saved first system message.
    if let Some(first) = messages.iter_mut().find(|m| m["role"] == "system" && m["content"].is_string()).filter(|_| !findings.is_empty()) {
        first["content"] = json!(findings::replace_findings(first["content"].as_str().unwrap_or(""), findings));
    }
    start.usage = resume.usage;
    start.answer = resume.prior["content"].as_str().unwrap_or("").to_string();
    start.tools_used = resume.prior["toolEvents"].as_array().into_iter().flatten().filter_map(|step| step["name"].as_str().map(str::to_string)).collect();
    messages
}

/// The run's state after a tool round, as the web saves it on an unfinished reply.
fn checkpoint(messages: &[Value], tool_rounds: usize, continuations: u32, think_nudges: u32) -> Value {
    json!({ "toolRounds": tool_rounds, "continuations": continuations, "thinkNudges": think_nudges, "messages": messages })
}

/// Runs a round's `delegate` calls at once: `jobs` are (call id, brief, round bound). Each is a read-only helper with a
/// context of its own, on the reply's model with thinking off, and only its report comes back. `left` is what remains of
/// the spending limit: a helper is never free money outside it. Returns each call's result by id, and what the helpers
/// used and cost between them. Stopping the reply drops them mid-request.
async fn run_helpers(target: &Target, ctx: &Ctx, tool_defs: &[Value], listing: &str, jobs: Vec<(String, String, Option<f64>)>, lane: &Lane, left: Option<f64>) -> (HashMap<String, tools::Output>, Usage, f64) {
    // The helpers' tools get a context of their own: the same folder, keys and limits, none of the reply's plan or file memory.
    let own = Arc::new(Ctx {
        root: ctx.root.clone(),
        state_dir: ctx.state_dir.clone(),
        settings: ctx.settings.clone(),
        client: ctx.client.clone(),
        read_chars: ctx.read_chars,
        limits: ctx.limits,
        memory: Default::default(),
        emit: ctx.emit.clone(),
        chat: Default::default(),
        procs: ctx.procs.clone(),
        planner: ctx.planner.clone(),
    });
    let run_tool: ToolRunner = Arc::new(move |name, args| {
        let own = own.clone();
        Box::pin(async move { tools::run(&name, &Value::Object(args), &own).await.text })
    });
    let openrouter = target.provider == ProviderId::Openrouter;
    let mut extra_body = Map::new();
    if let Some(pinned) = provider::openrouter_provider_for(&target.model.id).filter(|_| openrouter && !lane.unpinned) {
        extra_body.insert("provider".into(), pinned);
    }
    provider::apply_thinking(&mut extra_body, target.style, false, "none", lane.mandatory);
    let mut headers = vec![("Authorization".to_string(), format!("Bearer {}", target.api_key))];
    if openrouter {
        headers.extend([("HTTP-Referer".to_string(), "https://github.com/rottenvia/apiM".to_string()), ("X-Title".to_string(), "apiM".to_string())]);
    }
    let to = subagent::Target { base_url: target.base_url.clone(), api_model: target.api_model.clone(), headers, extra_body };
    // A helper may use the read-only tools the reply itself was offered, nothing more.
    let available: HashSet<String> = tool_defs.iter().filter_map(|t| t["function"]["name"].as_str().map(str::to_string)).collect();
    let customs = &ctx.settings.custom_models;
    let cap = subagent::helper_context_cap(models::context_window(&target.model.id, customs));
    let bill = Arc::new(Mutex::new((Usage::default(), 0.0f64)));
    let helpers = jobs.into_iter().map(|(id, task, max_rounds)| {
        let mut opts = subagent::Options::new(task, to.clone(), tool_defs.to_vec(), available.clone(), Stop::new(), run_tool.clone());
        opts.tree = listing.to_string();
        opts.max_rounds = max_rounds;
        opts.context_cap_chars = Some(cap);
        let (model, customs, counted) = (target.model.id.clone(), customs.clone(), bill.clone());
        opts.on_usage = Some(Arc::new(move |u: &Value| {
            let used = Usage::from_wire(u);
            let mut bill = counted.lock().unwrap();
            bill.1 += used.cost(&model, &customs).unwrap_or(0.0);
            bill.0.add(used);
        }));
        let spent = bill.clone();
        opts.should_stop = Some(Arc::new(move || left.is_some_and(|left| spent.lock().unwrap().1 >= left)));
        let (emit, row) = (ctx.emit.clone(), id.clone());
        opts.on_progress = Some(Arc::new(move |p: &subagent::Progress| emit.send(Event::ToolProgress { id: row.clone(), text: subagent::progress_text(p) })));
        async move {
            let result = subagent::run_sub_agent(&ctx.client, opts).await;
            let (text, summary) = subagent::format_sub_agent_result(&result);
            (id, tools::Output { ok: result.ok, text, summary, ..Default::default() })
        }
    });
    let done = futures_util::future::join_all(helpers).await.into_iter().collect();
    let (used, cost) = *bill.lock().unwrap();
    (done, used, cost)
}

/// After a reply: a cheap model reads what the tools did and writes what that proved into the workspace's LESSONS.md.
/// Runs on its own once the reply is over, so nothing here can hold the reply up or change it. Every failure is silence.
async fn learn(client: reqwest::Client, helper: Target, workspace: PathBuf, outcomes: Vec<Outcome>, known: Vec<Lesson>) {
    let known: Vec<KnownLesson> = known.into_iter().map(|l| KnownLesson { id: l.id, text: l.text, superseded_by: l.superseded_by }).collect();
    let style = match helper.style {
        ThinkingStyle::Deepseek => "deepseek",
        ThinkingStyle::Qwen => "qwen",
        _ => "openai",
    };
    let pass = refine::run_refine(&client, &outcomes, &known, &helper.api_key, &helper.base_url, None, Some(&helper.api_model), Some(style));
    let Ok(refined) = tokio::time::timeout(Duration::from_secs(120), pass).await else { return };
    if refined.lessons.is_empty() && refined.confirms.is_empty() {
        return;
    }
    let updates: Vec<lessons::LessonUpdate> = refined.lessons.into_iter().map(|l| lessons::LessonUpdate { text: l.text, evidence: l.evidence, replaces: l.replaces }).collect();
    let _ = tokio::task::spawn_blocking(move || lessons::apply_lessons(&workspace, &updates, &refined.confirms)).await;
}

// ponytail: no run registry (the web's runs.begin / touch / end, `context::runs`). Stop aborts this task from the window, and
// Resume reads the transcript saved on the reply, so nothing here has to find a run by its message id. Wire it in when a run
// can outlive the window that started it: the registry's idle and age limits are then what stops a wedged one.
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

/// A line for the diagnostics log. That log is the user's own: tests leave it alone.
fn log(kind: &str, subject: &str, detail: &str) {
    if cfg!(not(test)) {
        diagnostics::record(kind, subject, detail);
    }
}

fn log_with(kind: &str, subject: &str, detail: &str, context: Value) {
    if cfg!(not(test)) {
        diagnostics::record_with(kind, subject, detail, context);
    }
}

fn user(text: impl Into<String>) -> Value {
    json!({ "role": "user", "content": text.into() })
}

fn assistant(content: &str, reasoning: &str) -> Value {
    let mut turn = json!({ "role": "assistant", "content": content });
    if !reasoning.is_empty() {
        turn["reasoning_content"] = json!(reasoning);
    }
    turn
}

/// A blank line before a note the loop appends, when the reply already has text.
fn gap_after(answer: &str) -> &'static str {
    if answer.trim().is_empty() { "" } else { "\n\n" }
}

/// Asks the spending limit whether another step may run. Warns once near it; true means the run stops here.
fn over_budget(spend: &mut Budget, last_round_cost: f64, rounds: usize, emit: &Emitter) -> bool {
    let Some(limit) = spend.limit else { return false };
    match spend.check(last_round_cost) {
        Verdict::Continue => false,
        Verdict::Warn => {
            emit.send(Event::Notice(format!("Spending limit approaching — ${} of ${} used on this reply", fixed(spend.spent, 4), fixed(limit, 2))));
            false
        }
        Verdict::Stop(reason) => {
            log_with("run_stopped", "spending limit", reason, json!({ "spentUsd": spend.spent, "limitUsd": limit, "rounds": rounds }));
            true
        }
    }
}

async fn run_inner(mut req: Request, emit: &Emitter, procs: Arc<Procs>) -> Result<Ending, String> {
    let resume = req.resume.take();
    let s = &req.settings;
    let target = provider::resolve_target(&s.model, s)?;
    // The in-app sidecar is started on demand, and its window checked, before the request goes out (chat/route.ts:822-841).
    if target.provider == ProviderId::Local && local::engine::is_managed_engine_url(&target.base_url) {
        local::engine::chat_ready().await?;
    }
    let customs = &s.custom_models;

    let effort = if s.effort == "auto" { prompt::auto_effort(&req.text) } else { s.effort.as_str() };
    // Local models on a CPU cannot spend the top effort: thinking fills the output budget and no answer comes.
    let effort = if target.style == ThinkingStyle::Qwen && s.effort == "auto" && effort == "max" { "high" } else { effort };

    std::fs::create_dir_all(&req.workspace).map_err(|e| format!("Cannot open the workspace folder {}: {e}", req.workspace.display()))?;
    let native_vision = target.model.vision == Vision::Native;
    let web_search = s.web_mode() != "off" && (!s.tavily().is_empty() || !s.exa().is_empty());
    let git_repo = req.workspace.join(".git").exists();
    // About 3.5 characters per token.
    let window_chars = models::context_window(&target.model.id, customs) as usize * 7 / 2;

    // The model's ceilings, wider for a custom model saved with open limits. A single read may still use only a quarter of the window.
    let limits = tool_limits_for(customs.iter().any(|c| c.open_limits && c.id() == target.model.id));
    let ctx = Ctx {
        root: req.workspace.clone(),
        state_dir: req.state_dir.clone(),
        settings: s.clone(),
        client: provider::client(),
        read_chars: (window_chars / 4).clamp(20_000, limits.read_chars as usize),
        limits,
        memory: Default::default(),
        emit: emit.clone(),
        chat: Arc::new(Mutex::new(req.chat.clone())),
        procs,
        planner: provider::helper_target(s).map(|h| crate::search::Planner { api_key: h.api_key, base_url: h.base_url, api_model: h.api_model, deepseek: h.style == ThinkingStyle::Deepseek }),
    };

    let every = plugins::all(&s.custom_plugins);
    // On for every chat, and on for this one alone.
    let plugins_on = plugins::enabled_for(&s.enabled_plugins, &req.chat.skills);
    let directives = plugins::directives(&every, &plugins_on);
    // A repository connected through the GitHub dialog, and whether there is a token to push with.
    let github = crate::github::read_connection(&tools::github::ws(&ctx));
    let github_token = github.as_ref().map(|_| matches!(crate::github::resolve_token(&s.github_token), Ok(Some(_))));
    let mut system = prompt::system(&plugins::legacy_prompt(&every, &plugins_on), web_search, native_vision, git_repo, github.as_ref());
    // What earlier turns established rides in the system prompt, read fresh from the workspace's store (the web app's file).
    let findings_path = findings::store_path(&req.workspace);
    if !findings_path.exists() {
        // Findings this chat recorded before the store was shared lived only in the chat file: they move over once.
        for old in req.chat.findings.iter().filter(|f| f.active) {
            let _ = findings::add_finding(&findings_path, &NewFinding { claim: old.claim.clone(), refs: old.refs.clone(), evidence: old.evidence.clone() });
        }
    }
    if findings::shared_findings_enabled() {
        system.push_str(&findings::format_machine_findings_for_prompt(&findings::read_store(&findings::machine_store_path(&crate::store::data_dir()))));
    }
    let findings_block = findings::format_findings_for_prompt(&findings::read_store(&findings_path));
    system.push_str(&findings_block);
    // Binaries already inspected in this workspace, so the model does not analyse them again.
    system.push_str(&crate::binary::ledger::format_binary_ledger_for_prompt(&crate::binary::ledger::read_binary_ledger(&req.workspace)));
    // What earlier work in this workspace proved, when lessons are switched on.
    let known_lessons = if s.lessons_enabled { lessons::read_lessons(&req.workspace) } else { Vec::new() };
    system.push_str(&lessons::format_lessons_for_prompt(&known_lessons));
    // Standing orders go at the start of the first system message: some lanes only honour that one.
    if !directives.is_empty() {
        system = format!("{directives}\n\n{system}");
    }

    let mut messages: Vec<Value> = vec![json!({ "role": "system", "content": system })];
    if let Some(summary) = req.summary.as_deref().filter(|s| !s.trim().is_empty()) {
        messages.push(json!({ "role": "system", "content": summary }));
    }
    messages.extend(crate::context::transcript::wire_turns(&req.history, &req.text, &req.images, target.model.vision));
    // The enabled plugins' reminders ride at the end of the newest message, where a model that has drifted reads them last.
    remind(&mut messages, &plugins::reminders(&every, &plugins_on));

    let mut start = Start { user_text: req.text.clone(), history_last_user: req.history_last_user.clone(), ..Default::default() };
    if let Some(resume) = resume {
        messages = resume_transcript(resume, messages, &mut start, &findings_block);
    }
    // A current listing, last: the files have moved on since a resumed reply stopped, and its saved listing goes.
    start.tree = Tree::open(&req.workspace, &mut messages);

    let mut all_tools = tools::definitions(web_search, native_vision, git_repo, github_token);
    // Read-only helpers with their own context.
    all_tools.push(delegate_tool());
    all_tools.push(tools::skills::schema());
    // Tools lent by the MCP servers switched on in Settings ride after the built-in ones.
    all_tools.extend(mcp::tools_for_model(&ctx.client, &crate::store::data_dir()).await);
    // Not all of them are sent (`tools::groups`): the everyday ones, and the groups this chat has loaded, a
    // connected repository calls for, or the message names.
    let mut groups = req.chat.groups.clone();
    for group in github.iter().map(|_| "git".to_string()).chain(tools::groups::hinted(&req.text)) {
        tools::groups::add(&mut groups, &group);
    }
    let mut end = drive(&target, &ctx, messages, all_tools, groups, effort, &req.conv_id, &req.notes, start).await?;
    // The lessons pass: skipped when nothing ran, since nothing was demonstrated. Detached, so the reply ends without waiting for it.
    let outcomes = std::mem::take(&mut end.outcomes);
    if let (false, Some(helper)) = (outcomes.is_empty(), provider::helper_target(s)) {
        tokio::spawn(learn(ctx.client.clone(), helper, req.workspace.clone(), outcomes, known_lessons));
    }
    Ok(end)
}

/// The loop itself, once the endpoint, the tools and the opening messages are settled.
#[allow(clippy::too_many_arguments)]
async fn drive(target: &Target, ctx: &Ctx, mut messages: Vec<Value>, all_tools: Vec<Value>, mut groups: Vec<String>, effort: &str, conv_id: &str, notes: &Mutex<Vec<String>>, start: Start) -> Result<Ending, String> {
    let Start { mut tree, user_text, history_last_user, tool_rounds: resumed_rounds, continuations: resumed_continuations, think_nudges: resumed_think_nudges, usage: resumed_usage, answer: resumed_answer, tools_used: resumed_tools } = start;
    // The newest note the user added mid-run: it becomes the goal the pin restates.
    let mut steering: Option<String> = None;
    let (emit, s, chat) = (&ctx.emit, &ctx.settings, &ctx.chat);
    let customs = &s.custom_models;
    let thinking = effort != "none";
    let qwen = target.style == ThinkingStyle::Qwen;
    let openrouter = target.provider == ProviderId::Openrouter;
    let window = models::context_window(&target.model.id, customs);
    let window_chars = window as usize * 7 / 2;
    // What is sent of the tools: the everyday ones and the groups loaded so far. `groups_sent` tells when that has grown.
    let mut tool_defs = tools::groups::offered(&all_tools, &groups);
    let mut tools_chars = json!(tool_defs).to_string().len();
    let mut groups_sent = ctx.chat.lock().unwrap().groups.len();
    let output_rate = models::rates(&target.model.id, customs).map(|rates| rates.2);
    let notice = |text: &str| emit.send(Event::Notice(text.to_string()));
    let done_steps = || chat.lock().unwrap().plan.as_ref().map_or(0, |p| plan::progress(p).done);
    let started = Instant::now();

    // A resumed reply keeps counting its tokens from where it stopped. The spending limit starts over: Resume is how a run stopped by it goes on.
    let mut usage = resumed_usage;
    let mut spend = Budget::new(s.budget_usd);
    let mut last_round_cost = 0.0;
    let mut last_finish = None;
    let mut lane = Lane {
        mandatory: openrouter && provider::openrouter_reasoning_mandatory(&target.model.id),
        replay: openrouter && target.api_model.to_ascii_lowercase().starts_with("deepseek/"),
        ..Default::default()
    };
    // The round cap, a guard against a model that never stops calling tools (a run that is getting somewhere earns
    // extensions, `stall::should_extend_round_cap`), and what the run has done since it was last checked.
    let mut round_cap = ctx.limits.agent_rounds as usize;
    let (mut cap_extensions, mut changes_since_check, mut steps_at_check) = (0u32, 0u32, done_steps());
    // How often each kind of rescue has been used on this reply.
    let (mut continuations, mut stream_cuts, mut think_nudges, mut draft_cutovers, mut auto_revives, mut refusal_reopens) = (resumed_continuations, 0u32, 0u32, 0u32, 0u32, 0u32);
    // Thinking is off for the rest of the run, or for the next round only; the next round continues cut-off prose.
    // A reply that already burned its output on thinking is not told it may think again when resumed.
    let (mut force_no_thinking, mut no_think_next, mut continuation_pending) = (resumed_think_nudges > 0, false, false);
    let (mut claim_retried, mut asked_early, mut nudged_incomplete, mut ran_without_tools) = (false, false, false, false);
    // The guards: one call failing identically, calls that add nothing, a read-only streak, whole-file rewrites, a preview taken for an edit.
    let mut breaker = LoopBreaker::default();
    let mut stalls = StallTracker::default();
    let mut gather = GatherTracker::default();
    let mut churn = ChurnTracker::default();
    let mut previews = PreviewTracker::default();
    let mut step_watch = None;
    let mut rounds_since_plan_update = 0;
    // Everything this reply has written and thought so far, across rounds, and the tools it really ran.
    let mut answer = resumed_answer;
    let mut thought = String::new();
    let mut fields_seen: BTreeSet<String> = BTreeSet::new();
    let mut tools_used = resumed_tools;
    let mut outcomes: Vec<Outcome> = Vec::new();
    let mut tool_rounds = resumed_rounds;
    // Notes from the loop to the model that ride in the next request only: a stale plan, a step over its budget, code drafted in thought.
    // ponytail: the web pushes these as system messages and removes them by marker a round later; here they join the tail the same request already ends with.
    let mut harness: Vec<String> = Vec::new();
    let mut halt = None;
    let mut round = 0;

    loop {
        round += 1;
        if round > round_cap {
            let done = done_steps();
            if stall::should_extend_round_cap(cap_extensions, done.saturating_sub(steps_at_check) as u32, changes_since_check) {
                cap_extensions += 1;
                round_cap += stall::CAP_EXTENSION_ROUNDS;
                (steps_at_check, changes_since_check) = (done, 0);
            } else {
                log("limit_hit", "tool rounds", &format!("Stopped after {} tool rounds.", round - 1));
                halt = Some(Halt::Premature(Premature::RoundCap));
                break;
            }
        }
        if round > 1 && last_round_cost > 0.0 && over_budget(&mut spend, last_round_cost, tool_rounds, emit) {
            halt = Some(Halt::Budget);
            break;
        }

        // A group loaded last round is sent from this one on, and kept with the chat.
        if groups.len() != groups_sent {
            groups_sent = groups.len();
            tool_defs = tools::groups::offered(&all_tools, &groups);
            tools_chars = json!(tool_defs).to_string().len();
            emit.send(Event::Groups(groups.clone()));
        }
        // Anything the user said in passing joins the conversation before the next request.
        for note in std::mem::take(&mut *notes.lock().unwrap()) {
            emit.send(Event::NoteRead { note: note.clone(), round });
            steering = Some(note.trim().to_string());
            messages.push(user(format!("[Note from the user while you work. Take it into account and carry on; do not start over.]\n{note}")));
        }
        // Old tool output collapses to a line saying what it was, and fat call arguments to a stub; files still being worked from stay whole.
        // ponytail: the web prunes the copy it sends and keeps its transcript whole; here the result is kept, like the fold below.
        // Its `context_pruned` event is ignored by its page, so nothing is shown here either.
        let pruned = match prune_transcript(&messages, &if qwen { QWEN_PRUNE } else { pruning::Options::default() }).0 {
            Cow::Owned(pruned) => Some(pruned),
            Cow::Borrowed(_) => None,
        };
        if let Some(pruned) = pruned {
            messages = pruned;
        }
        // The valve: finished rounds fold into one line each once the run passes 65% of the window.
        let folded = compact::fold(&mut messages, window);
        if folded.rounds > 0 {
            notice(&format!("Context compacted · {} steps summarised · about {} tokens saved", folded.rounds, folded.tokens_saved));
        }
        // Still too big after that (huge tool results in the rounds kept): collapse the oldest of them.
        let collapsed = prune(&mut messages, window_chars * 8 / 10);
        if collapsed > 0 {
            notice(&format!("Trimmed {collapsed} older tool results to fit the context window"));
        }

        // The plan rides at the end, so the start of the request stays byte-identical and the provider's prompt cache keeps hitting.
        let tail = {
            let mut t: Vec<String> = chat.lock().unwrap().plan.iter().map(tools::plan::format_plan).collect();
            t.append(&mut harness);
            t.join("\n\n")
        };
        // DeepSeek takes each tool turn's reasoning back as `reasoning_content`. OpenRouter's validators reject
        // the field, so its lanes get `reasoning` where a model needs it and the end of the thought as plain text elsewhere.
        let reasoning_field = if !openrouter { Some("reasoning_content") } else if lane.replay { Some("reasoning") } else { None };
        // Videos ride once: the clip's pixels go on the request that introduces it, and every later round gets a reference line.
        let mut wire = transcript::wire(&strip_ride_along_videos(&messages, tool_rounds == 0), reasoning_field);
        if qwen {
            // Qwen's template only accepts a system message at index 0: the listing, its deltas and the tail all join the first one.
            let (systems, rest): (Vec<Value>, Vec<Value>) = wire.into_iter().partition(|m| m["role"] == "system");
            let text: Vec<&str> = systems.iter().filter_map(|m| m["content"].as_str()).chain([tail.as_str()]).filter(|c| !c.is_empty()).collect();
            wire = std::iter::once(json!({ "role": "system", "content": text.join("\n\n") })).chain(rest).collect();
            // The 80K sidecar window: only the copy on the wire is fitted, so the stored transcript keeps every round (route.ts 2778-2788).
            // ponytail: the web passes whether the workspace is on; here any tool definition sent counts toward the tool reserve.
            wire = local::context::fit_for_local_context(wire, local::context::local_message_budget(!tool_defs.is_empty())).messages;
        } else if !tail.is_empty() {
            wire.push(json!({ "role": "system", "content": tail }));
        }

        let thinking_now = thinking && !force_no_thinking && !no_think_next;
        let no_think_round = std::mem::take(&mut no_think_next);
        let mut body = Map::new();
        body.insert("model".into(), json!(target.api_model));
        body.insert("messages".into(), json!(wire));
        body.insert("stream".into(), json!(true));
        body.insert("stream_options".into(), json!({ "include_usage": true }));
        // The limit is enforced inside the round too: the model cannot write what it is not allowed to.
        body.insert("max_tokens".into(), json!(spend.max_tokens(output_rate, local::shared::output_ceiling(qwen, target.model.max_output_tokens as u64))));
        body.insert("tools".into(), json!(tool_defs));
        body.insert("tool_choice".into(), json!("auto"));
        if openrouter {
            // Pins every round of this chat to one endpoint, so its prompt cache stays warm.
            body.insert("session_id".into(), json!(format!("conv-{conv_id}")));
            if let Some(pinned) = provider::openrouter_provider_for(&target.model.id).filter(|_| !lane.unpinned) {
                body.insert("provider".into(), pinned);
            }
        }
        provider::apply_thinking(&mut body, target.style, thinking_now, effort, lane.mandatory);
        emit.send(Event::Context(compact::breakdown(&wire, tools_chars)));

        emit.send(Event::Status(if round > 1 { "Working" } else if thinking_now { "Thinking" } else { "Writing" }));
        // A round that continues cut-off prose has any sentence it restarts trimmed as it streams.
        let dedup = std::mem::take(&mut continuation_pending).then(|| ContinuationDedup::new(&answer));
        // Two thinks in a row would otherwise run together in the thought box.
        let gap = !thought.is_empty() && !thought.trim_end_matches([' ', '\t', '\r']).ends_with('\n');
        let cut_drafts = thinking_now && draft_cutovers < stall::MAX_DRAFT_CUTOVERS;
        let (result, without_tools) = call_model(&ctx.client, target, &mut body, &mut lane, dedup, cut_drafts, gap, emit).await.inspect_err(|e| log("api_error", &target.model.id, e))?;
        ran_without_tools = without_tools;

        let provider::Round { content, reasoning, tool_calls: calls, finish, usage: round_usage, fields, draft_cut } = result;
        // A think stopped by the loop never reached its usage frame: about four characters per token, none of it cached.
        let round_usage = round_usage.or_else(|| {
            draft_cut.map(|_| {
                let prompt = ((chars_of(&wire) + tools_chars) as u64).div_ceil(4);
                Usage { prompt, completion: (reasoning.chars().count() as u64).div_ceil(4), cache_miss: prompt, ..Default::default() }
            })
        });
        if let Some(u) = round_usage {
            last_round_cost = u.cost(&target.model.id, customs).unwrap_or(0.0);
            spend.spent += last_round_cost;
            usage.add(u);
            emit.send(Event::Usage(usage));
        }
        fields_seen.extend(fields);
        if !reasoning.is_empty() {
            thought.push_str(if gap { "\n\n" } else { "" });
            thought.push_str(&reasoning);
        }
        answer.push_str(&content);
        last_finish = finish.clone();
        let finish = finish.unwrap_or_default().to_ascii_lowercase();

        // The think was drafting a whole program: hand it back as the model's own words and have it write the files, without another think.
        if let Some(lines) = draft_cut {
            draft_cutovers += 1;
            messages.push(assistant(&stall::draft_carry(&reasoning, None), ""));
            messages.push(user(stall::draft_cutover_text(lines)));
            no_think_next = true;
            notice("It was writing the whole program in its head — stopped the think, writing the draft to files now");
            continue;
        }

        // Cut by the output limit, or by a stream that ended without saying why.
        let hard = matches!(finish.as_str(), "length" | "max_tokens");
        let stream_cut = !hard && calls.is_empty() && (!content.is_empty() || !reasoning.is_empty()) && !matches!(finish.as_str(), "stop" | "tool_calls" | "content_filter");
        if stream_cut && content.is_empty() && stream_cuts < MAX_STREAM_CUTS {
            // Dropped mid-think. A long think is handed back so the analysis is not started over; a short one is simply asked again.
            stream_cuts += 1;
            no_think_next = no_think_round;
            if reasoning.chars().count() >= stall::DROPPED_THINK_CARRY_CHARS {
                messages.push(assistant(&stall::draft_carry(&reasoning, Some("the connection dropped mid-thought")), ""));
                messages.push(user(stall::DROPPED_THINK_TEXT));
            }
            notice(&format!("The model stopped mid-task — continuing from where it left off ({stream_cuts}/{MAX_STREAM_CUTS})"));
            continue;
        }
        if hard && calls.is_empty() && reasoning.chars().count() >= 80 && content.trim().chars().count() < 40 {
            // The whole output went to thinking. The think is not replayed: it is what filled the budget.
            messages.push(assistant(&content, &format!("[thinking produced no output — {} chars trimmed]", reasoning.chars().count())));
            if think_nudges >= MAX_THINK_NUDGES {
                halt = Some(Halt::ThinkCeiling);
                break;
            }
            messages.push(user(THINK_ONLY[think_nudges as usize]));
            think_nudges += 1;
            force_no_thinking = true;
            notice("Used the thinking budget — answering now, without another think");
            continue;
        }
        if (hard || stream_cut) && calls.is_empty() {
            // Cut mid-answer: ask for the rest, with thinking off for that one round.
            messages.push(assistant(&content, &reasoning));
            if hard && continuations < MAX_CONTINUATIONS {
                continuations += 1;
                notice(&format!("Answer was longer than one response allows — continuing ({continuations}/{MAX_CONTINUATIONS})"));
            } else if !hard && stream_cuts < MAX_STREAM_CUTS {
                stream_cuts += 1;
                notice(&format!("The model stopped mid-task — continuing from where it left off ({stream_cuts}/{MAX_STREAM_CUTS})"));
            } else {
                halt = Some(if hard { Halt::OutputCeiling } else { Halt::CutsExhausted });
                break;
            }
            (continuation_pending, no_think_next) = (true, true);
            messages.push(user(format!("{}{CARRY_ON}", if hard { "You reached the output limit mid-answer. " } else { "Your previous reply was cut off mid-answer before it finished. " })));
            continue;
        }

        if calls.is_empty() {
            // The model stopped. Before taking that as the end: is the answer honest, is the plan done, did it mean to stop?
            messages.push(assistant(&content, &reasoning));
            if !claim_retried && plan::check_answer_claims(&answer, &tools_used).is_some() {
                claim_retried = true;
                messages.push(user(CLAIM_RETRY));
                notice("That reply claimed work that did not run — it is redoing it for real");
                continue;
            }
            let current = chat.lock().unwrap().plan.clone();
            let progress = current.as_ref().map(plan::progress);
            if current.is_none() && !asked_early && tool_rounds >= 8 && !tools_used.iter().any(|tool| tool == "ask_user") {
                // A long build with no plan and no question asked rests on an interpretation nobody confirmed. Said once.
                asked_early = true;
                messages.push(user(format!(
                    "You are {tool_rounds} rounds in, you have not written a plan, and you have not asked anything. If any part of what you are building rests on a guess about what was wanted — the platform, the shape of the interface, what \"done\" means — call ask_user NOW, with concrete options. One question here is far cheaper than continuing in the wrong direction. If nothing is genuinely ambiguous, ignore this and carry on."
                )));
                continue;
            }
            if let (Some(current), Some(p), false) = (&current, &progress, nudged_incomplete) {
                let stuck = p.blocked > 0;
                let untried = p.done == 0 && tool_rounds <= 2;
                let refused = current.steps.iter().any(|step| step.state == "blocked" && plan::looks_like_refusal_blocker(&step.note));
                if stuck && (untried || refused) && refusal_reopens < MAX_REFUSAL_REOPENS {
                    // "Blocked" used to decline the task, or before anything was tried: the steps are put back.
                    refusal_reopens += 1;
                    let state = {
                        let mut state = chat.lock().unwrap();
                        for step in state.plan.iter_mut().flat_map(|p| p.steps.iter_mut()).filter(|step| step.state == "blocked") {
                            step.state = "todo".into();
                            step.note.clear();
                        }
                        state.clone()
                    };
                    emit.state(state);
                    messages.push(user(REOPEN_BLOCKED));
                    continue;
                }
                if stuck && untried {
                    nudged_incomplete = true;
                    messages.push(user(BLOCKED_UNTRIED));
                    continue;
                }
                if let (false, false, Some(next)) = (p.complete, stuck, p.next) {
                    nudged_incomplete = true;
                    let narrated = if revive::describes_imminent_action(&content) { NARRATED } else { "" };
                    messages.push(user(format!(
                        "Your plan is not finished — {} of {} steps are done, and you stopped before step {} ({}).\n\nEither carry on with it, or if it genuinely cannot be done, mark that step blocked with update_plan and tell the user what is in the way. Do not present unfinished work as complete.{narrated}",
                        p.done, p.total, next.id, next.text
                    )));
                    continue;
                }
            }
            let stop = revive::Stop {
                content: &answer,
                round_content: &content,
                reasoning: &thought,
                tool_rounds,
                plan_complete: progress.as_ref().map(|p| p.complete),
                plan_blocked: progress.as_ref().is_some_and(|p| p.blocked > 0),
                finish_reason: &finish,
            };
            match revive::detect_premature_stop(&stop) {
                // A cut think is not asked again where switching thinking off cannot be the cure.
                Some(Premature::ThinkingCut) if qwen || force_no_thinking => halt = Some(Halt::Premature(Premature::ThinkingCut)),
                Some(reason) if auto_revives < revive::MAX_AUTO_REVIVES => {
                    auto_revives += 1;
                    messages.push(user(revive::revive_instruction(reason, ran_without_tools)));
                    log_with("run_stopped", "premature stop", &format!("Auto-continued a mid-task stop ({}).", reason.key()), json!({ "n": auto_revives, "rounds": tool_rounds }));
                    notice(&format!("The model stopped mid-task — continuing from where it left off ({auto_revives}/{})", revive::MAX_AUTO_REVIVES));
                    continue;
                }
                reason => halt = reason.map(Halt::Premature),
            }
            break;
        }

        // The limit is asked again before the tools run: one round can cross it on its own.
        if over_budget(&mut spend, last_round_cost, tool_rounds, emit) {
            // ponytail: the web keeps this turn and answers each pending call "Not run — the spending limit for this reply was reached …".
            // Here the turn is left out of the transcript instead, so a resumed one stays legal and the model asks for those calls again.
            halt = Some(Halt::Budget);
            break;
        }
        tool_rounds += 1;
        if tool_rounds >= tools::groups::LONG_WORK_ROUNDS {
            tools::groups::FOR_LONG_WORK.iter().for_each(|group| drop(tools::groups::add(&mut groups, group)));
        }
        let mut turn = assistant(&content, &reasoning);
        turn["tool_calls"] = calls.iter().map(|c| json!({ "id": c.id, "type": "function", "function": { "name": c.name, "arguments": if c.args.trim().is_empty() { "{}" } else { &c.args } } })).collect();
        messages.push(turn);
        let turn_at = messages.len() - 1;

        emit.send(Event::Status("Working"));
        let mut looks: Vec<PathBuf> = Vec::new();
        let mut finished = false;
        let mut plan_touched = false;
        // A guard that ends the run, and the note the user reads about it.
        let mut stopped: Option<(Premature, String)> = None;
        // The reports of this round's delegate calls, by call id, once the first of them has been reached.
        let mut reports: Option<HashMap<String, tools::Output>> = None;
        for (n, call) in calls.iter().enumerate() {
            let args_text = if call.args.trim().is_empty() { "{}" } else { call.args.as_str() };
            // A helper started with an earlier delegate call already has its row.
            if !reports.as_ref().is_some_and(|r| r.contains_key(&call.id)) {
                emit.send(Event::ToolStart(ToolEvent { id: call.id.clone(), name: call.name.clone(), args: args_text.to_string(), ..Default::default() }));
            }
            let parsed = serde_json::from_str::<Value>(args_text);
            // The instructions name tools whose group may not be loaded yet: such a call runs, and brings its group.
            tools::groups::note_use(&call.name, &mut groups);
            let out = match &parsed {
                Ok(args) if call.name == "load_tools" => {
                    tools_used.push(call.name.clone());
                    tools::groups::load(args, &all_tools, &mut groups)
                }
                Ok(args) if call.name == "delegate" => {
                    tools_used.push(call.name.clone());
                    if reports.is_none() {
                        // Several delegate calls in one round work at the same time: the first one reached starts every one still to come.
                        let mut jobs = Vec::new();
                        for other in calls[n..].iter().filter(|c| c.name == "delegate") {
                            let Some((task, max_rounds)) = serde_json::from_str::<Value>(&other.args).ok().and_then(|a| parse_delegate_args(&a).ok()) else { continue };
                            if other.id != call.id {
                                emit.send(Event::ToolStart(ToolEvent { id: other.id.clone(), name: other.name.clone(), args: other.args.clone(), ..Default::default() }));
                            }
                            jobs.push((other.id.clone(), task, max_rounds));
                        }
                        // A helper has a context of its own: it is offered everything, as it always was.
                        let (done, used, cost) = run_helpers(target, ctx, &all_tools, &tree.shown, jobs, &lane, spend.limit.map(|limit| limit - spend.spent)).await;
                        // What the helpers used is the reply's: its totals show it and its spending limit counts it.
                        // Its window is the helpers' own, not this reply's.
                        usage.add(Usage { context: 0, ..used });
                        spend.spent += cost;
                        emit.send(Event::Usage(usage));
                        reports = Some(done);
                    }
                    reports.as_mut().and_then(|r| r.remove(&call.id)).unwrap_or_else(|| match parse_delegate_args(args) {
                        Err((text, summary)) => tools::Output { summary, ..tools::Output::fail(text) },
                        Ok(_) => tools::Output { summary: "Helper failed".into(), ..tools::Output::fail("Error: helper failed") },
                    })
                }
                Ok(args) => {
                    tools_used.push(call.name.clone());
                    tools::run(&call.name, args, ctx).await
                }
                Err(e) if hard || e.is_eof() => {
                    // The broken half of a huge call is not sent back with every later request.
                    // ponytail: the web first salvages the whole files or batch items that did arrive (transcript.ts salvageToolArguments); here the call is redone in parts.
                    messages[turn_at]["tool_calls"][n]["function"]["arguments"] = json!("{}");
                    let text = format!("Error: this {} call was cut off by the output limit — its arguments are incomplete, so nothing was written.\n\nThe content was too large for one call. Do NOT resend it whole. Instead:\n  1. write_file with the FIRST part only (aim for under 1500 lines).\n  2. Then append each following part with edit_file, using the last few lines of what you just wrote as old_text.\nKeep going until the file is complete. Say nothing else until it is.", call.name);
                    tools::Output { summary: "Cut off mid-call — splitting into parts".into(), ..tools::Output::fail(text) }
                }
                Err(e) => tools::Output { summary: "Invalid tool arguments".into(), ..tools::Output::fail(format!("Error: arguments were not valid JSON ({e})")) },
            };
            if !out.ok {
                // Which model, and the names of what it passed (never the values): "path,new_text" explains a refused edit.
                let passed = serde_json::from_str::<Value>(args_text).ok().and_then(|v| v.as_object().map(|map| map.keys().cloned().collect::<Vec<_>>().join(","))).unwrap_or_default();
                log_with("tool_failed", &call.name, if out.summary.is_empty() { &out.text } else { &out.summary }, json!({ "model": target.model.id, "args": passed, "round": tool_rounds }));
            }
            emit.send(Event::ToolDone { id: call.id.clone(), ok: out.ok, summary: out.summary.clone(), image: out.image.clone(), changed: out.changed.clone() });
            if let Some(found) = out.search.as_ref().filter(|_| out.ok) {
                emit.send(Event::WebSearch(found.clone()));
            }
            if s.lessons_enabled {
                outcomes.push(Outcome { name: call.name.clone(), args: args_text.to_string(), ok: out.ok, summary: out.summary.clone() });
            }

            // The guards read every result. A warning rides in the result itself: the text the model is sure to read next.
            let key = match &parsed {
                Ok(args) => args.clone(),
                Err(_) => json!(args_text),
            };
            let mut text = out.text.clone();
            let strike = breaker.observe(&call.name, &key, out.ok);
            if out.ok && (out.changed.is_some() || matches!(call.name.as_str(), "run_command" | "build_project" | "write_files" | "edit_files" | "apply_patch" | "extract_archive" | "download_file")) {
                breaker.workspace_changed(call.name != "run_command" && call.name != "build_project");
            }
            if strike.trip {
                text.push_str(&loop_breaker::loop_trip_marker(&call.name));
                let last_error = if out.summary.is_empty() { head(&out.text, 300) } else { out.summary.as_str() };
                stopped = Some((Premature::LoopBreaker, loop_breaker::loop_trip_user_note(&call.name, last_error)));
            } else {
                if strike.warn {
                    text.push_str(&loop_breaker::loop_warning_text(&call.name));
                }
                let seen = stalls.observe(&call.name, &key, out.ok, &out.text);
                let (_, gathering) = gather.observe(&call.name, &key, out.ok);
                if let Some(note) = previews.observe(&call.name, out.ok, &out.summary) {
                    text.push_str(&note);
                }
                let churned = churn.observe(&call.name, &key, out.ok);
                if seen.repeat_trip {
                    text.push_str(&stall::reread_trip_marker(seen.repeat_total));
                    stopped = Some((Premature::NoProgress, stall::reread_trip_user_note(seen.repeat_total, seen.top_repeat_target.as_deref(), stalls.recent_actions())));
                } else if seen.trip {
                    text.push_str(&stall::stall_trip_marker());
                    stopped = Some((Premature::NoProgress, stall::stall_trip_user_note(stalls.recent_actions())));
                } else if seen.repeat_warn {
                    text.push_str(&stall::reread_warning_text(seen.repeat_total, seen.top_repeat_target.as_deref()));
                } else if seen.warn {
                    text.push_str(&stall::stall_warning_text(seen.stall_calls));
                } else if let Some((path, count)) = churned {
                    text.push_str(&stall::churn_nudge_text(&path, count));
                } else if gathering {
                    text.push_str(&gather.nudge_text());
                } else if out.ok && !seen.progress && stall::is_read_tool(&call.name) {
                    text.push_str(stall::unchanged_read_text());
                }
            }
            messages.push(json!({ "role": "tool", "tool_call_id": call.id, "content": text }));
            if stopped.is_some() {
                break;
            }
            if out.ok && stall::is_world_changing(&call.name) {
                changes_since_check += 1;
            }
            plan_touched |= out.ok && matches!(call.name.as_str(), "make_plan" | "update_plan");
            looks.extend(out.look);
            if out.finish {
                // The receipt becomes the closing text, so a reply never ends on a bare tool step.
                let args: Value = serde_json::from_str(args_text).unwrap_or_default();
                let field = |key: &str| args[key].as_str().unwrap_or("").trim().to_string();
                emit.send(Event::Content(format!("{}\n\nVerified: {}", field("result"), field("verified"))));
            }
            finished |= out.finish;
        }
        if let Some((reason, note)) = stopped {
            // Every call left unrun still gets an answer, so the transcript a Resume replays stays legal.
            let answered = messages.len() - 1 - turn_at;
            for call in &calls[answered..] {
                messages.push(json!({ "role": "tool", "tool_call_id": call.id, "content": "Not run — the run was halted before this call ran." }));
            }
            log("run_stopped", reason.key(), &note);
            emit.send(Event::Content(format!("{}{note}", gap_after(&answer))));
            halt = Some(Halt::Premature(reason));
            break;
        }
        // Pictures the model asked to see follow the tool results as a user message: a tool result cannot carry one.
        let parts: Vec<Value> = looks.iter().filter_map(|p| image_part(p)).collect();
        if !parts.is_empty() {
            let mut content = vec![json!({ "type": "text", "text": "[tool image] The image(s) you asked to view:" })];
            content.extend(parts);
            messages.push(json!({ "role": "user", "content": content }));
        }
        if finished {
            return Ok(Ending { finish: Some("stop".into()), incomplete: false, stop_reason: None, outcomes });
        }
        // The next round must see the workspace as it is now, not as it was before these tools ran.
        tree.refresh(&ctx.root, &mut messages);
        // The request is restated at the end every round, so a long run cannot drift back to an older task from the history or the summary.
        messages.retain(|m| !(m["role"] == "system" && m["content"].as_str().is_some_and(|c| c.starts_with(GOAL_PIN_MARKER))));
        if let Some(goal) = resolve_run_goal(&user_text, history_last_user.as_deref(), steering.as_deref()) {
            messages.push(json!({ "role": "system", "content": render_goal_pin(&goal, tool_rounds > 0) }));
        }
        // Saved once per tool round, where the expensive, hard-to-redo work happens: a reply stopped or failed after this resumes from here.
        emit.send(Event::Checkpoint(checkpoint(&messages, tool_rounds, continuations, think_nudges.max(resumed_think_nudges))));

        // The plan goes stale while the work moves on, or the prose just claimed a step the plan does not show.
        let current = chat.lock().unwrap().plan.clone();
        rounds_since_plan_update = if plan_touched { 0 } else { rounds_since_plan_update + 1 };
        let claimed = plan::step_claimed_complete(&content);
        if current.as_ref().is_some_and(|p| !plan::progress(p).complete) && (rounds_since_plan_update >= plan::PLAN_STALE_AFTER_TOOL_ROUNDS || claimed) {
            harness.push(plan::build_stale_plan_nudge(rounds_since_plan_update, claimed));
        }
        // One step that has run a long time gets a checkpoint, then another, then the run pauses for the user.
        let (watch, due) = plan::watch_step(step_watch.take(), current.as_ref(), tool_rounds, started.elapsed().as_millis() as u64);
        step_watch = watch;
        if let Some(due) = due {
            if due.halt {
                emit.send(Event::Content(format!("{}{}", gap_after(&answer), plan::step_budget_user_note(&due))));
                halt = Some(Halt::Premature(Premature::StepBudget));
                break;
            }
            log_with("run_stopped", "step budget checkpoint", &format!("Step {}: {} rounds, {} min (checkpoint {}).", due.id, due.rounds, due.minutes, due.level), json!({ "rounds": tool_rounds }));
            harness.push(plan::step_budget_nudge(&due));
        }
        // Code drafted in thought is paid for again as the file's content: say so, with the count.
        let drafted = stall::drafted_code_lines(&reasoning);
        if drafted >= stall::CODE_DRAFT_LINES {
            harness.push(stall::code_draft_nudge_text(drafted));
        }
    }

    // The closing text is held against what actually ran: a claim no tool backs is marked, not hidden.
    let mut gap = gap_after(&answer);
    if let Some(issue) = plan::check_answer_claims(&answer, &tools_used) {
        emit.send(Event::Content(format!("{gap}_{issue}_")));
        log_with("unverified_claim", "closing summary", &issue, json!({ "toolsUsed": tools_used.len() }));
        gap = "\n\n";
    }
    if let (Some(Halt::Budget), Some(limit)) = (&halt, spend.limit) {
        emit.send(Event::Content(format!("{gap}{}", budget::budget_stop_message(spend.spent, limit, true))));
    }
    if thinking && thought.is_empty() {
        // ponytail: the web also shows "No plain-text reasoning was present in the upstream stream…" in the thought box;
        // a notice in every reply of a model that never thinks would be noise, so only the diagnostics keep it.
        let seen = if fields_seen.is_empty() { "none".to_string() } else { fields_seen.iter().cloned().collect::<Vec<_>>().join(", ") };
        log_with("api_error", "reasoning stream", "Thinking was enabled but no plain-text reasoning field was received.", json!({ "model": target.api_model, "effort": effort, "fieldsSeen": seen }));
    }
    // A reply cut at the output ceiling is half-finished evidence: nothing is learned from it.
    if matches!(halt, Some(Halt::OutputCeiling)) {
        outcomes.clear();
    }
    let mut stop_reason = halt.map(|halt| match halt {
        Halt::Premature(reason) => revive::premature_stop_notice(reason).to_string(),
        Halt::ThinkCeiling => "It thought through the whole output budget three times without writing anything — Resume continues with thinking switched off".to_string(),
        Halt::OutputCeiling => "The answer hit the output limit before it finished".to_string(),
        Halt::CutsExhausted => "The connection kept dropping before the answer finished".to_string(),
        Halt::Budget => format!("Stopped at your ${} spending limit — the work so far is saved, use Resume to continue", fixed(spend.limit.unwrap_or(0.0), 2)),
    });
    if let (Some(reason), true) = (&mut stop_reason, lane.degraded > 0) {
        reason.push_str(&format!(" — {} round{} ran without tools after rejections", lane.degraded, if lane.degraded == 1 { "" } else { "s" }));
    }
    if stop_reason.is_some() {
        // An unfinished reply keeps everything up to its last word.
        emit.send(Event::Checkpoint(checkpoint(&messages, tool_rounds, continuations, think_nudges.max(resumed_think_nudges))));
    }
    Ok(Ending { finish: last_finish, incomplete: stop_reason.is_some(), stop_reason, outcomes })
}

/// Folds the oldest plain turns of a request away. Returns how many went.
fn fold_body(body: &mut Map<String, Value>) -> usize {
    let Some(Value::Array(messages)) = body.get("messages") else { return 0 };
    let (folded, dropped) = transcript::fold_oldest_history(messages, FOLD_RETRY_TARGET_CHARS);
    if dropped > 0 {
        body.insert("messages".into(), Value::Array(folded));
    }
    dropped
}

fn strip_media_body(body: &mut Map<String, Value>) -> bool {
    body.get_mut("messages").and_then(Value::as_array_mut).is_some_and(|messages| transcript::strip_media(messages))
}

/// Adds a line to the newest user message: its text, or the text part of one that carries pictures.
fn remind(messages: &mut [Value], line: &str) {
    if line.is_empty() {
        return;
    }
    let Some(newest) = messages.iter_mut().rev().find(|m| m["role"] == "user") else { return };
    let text = match &mut newest["content"] {
        Value::Array(parts) => parts.iter_mut().rev().find(|part| part["type"] == "text").map(|part| &mut part["text"]),
        content => Some(content),
    };
    if let Some(Value::String(text)) = text {
        text.push_str("\n\n");
        text.push_str(line);
    }
}

/// Text that took over four seconds and came at under 15 characters a second (four tokens): too slow to read along with.
fn crawled(secs: f64, chars: usize) -> bool {
    secs >= 4.0 && (chars as f64) < secs * 15.0
}

/// One model round, with what the web does around the request: backoff on transient failures, a second shape
/// for a body the host rejected, patience with a rate limit, and another try for a stream that never said
/// anything. Returns the round and whether it had to run without its tools.
#[allow(clippy::too_many_arguments)]
async fn call_model(client: &reqwest::Client, target: &Target, body: &mut Map<String, Value>, lane: &mut Lane, mut dedup: Option<ContinuationDedup>, cut_drafts: bool, mut gap: bool, emit: &Emitter) -> Result<(provider::Round, bool), String> {
    let openrouter = target.provider == ProviderId::Openrouter;
    // Three tries, five on OpenRouter, whose shared pool answers 503 several times a day.
    let policy = if openrouter { &retry::OPENROUTER } else { &retry::DEFAULT };
    let name = target.provider.name();
    let original = body.clone();
    let (mut attempt, mut waits, mut empties, mut reshapes) = (1u32, 0u32, 0u32, 0u32);
    // The status the first reshaped retry answered, and what the diagnostics say if a reshaped request gets through.
    let mut first_status = 0;
    let mut recovered: Option<(u16, String)> = None;
    loop {
        let mut announced = "";
        let mut shown = String::new();
        // When text first and last came in this round, and how much of it.
        let mut pace: Option<(Instant, Instant, usize)> = None;
        let mut heard = |text: &str| {
            let now = Instant::now();
            let (_, last, chars) = pace.get_or_insert((now, now, 0));
            (*last, *chars) = (now, *chars + text.chars().count());
        };
        // A paragraph of the answer the model labelled as its carried thought is thinking, and goes where thinking goes.
        let mut carried = transcript::CarriedEcho::default();
        let mut thought_aloud = String::new();
        let mut echo = dedup.as_mut();
        let wire = Value::Object(body.clone());
        let result = provider::stream(client, target, &wire, cut_drafts, |delta| match delta {
            Delta::Reasoning(t) => {
                heard(t);
                if std::mem::take(&mut gap) {
                    emit.send(Event::Reasoning("\n\n".into()));
                }
                emit.send(Event::Reasoning(t.to_string()))
            }
            Delta::Content(t) => {
                heard(t);
                let (said, aside) = carried.push(t);
                if !aside.is_empty() {
                    thought_aloud.push_str(&aside);
                    emit.send(Event::Reasoning(aside));
                }
                let text = match echo.as_mut() {
                    Some(dedup) => dedup.push(&said),
                    None => said,
                };
                if !text.is_empty() {
                    if announced != "Writing" {
                        announced = "Writing";
                        emit.send(Event::Status("Writing"));
                    }
                    shown.push_str(&text);
                    emit.send(Event::Content(text));
                }
            }
            Delta::ToolDraft { name, chars, args } => emit.send(Event::ToolDraft { name: name.to_string(), chars, path: draft_path(args) }),
        })
        .await;
        let e = match result {
            Ok(mut round) => {
                // A reply that crawled in (a busy provider) reads as the app being slow: it goes in the problem
                // report under the provider, so the two can be told apart afterwards.
                if let Some((secs, chars)) = pace.map(|(first, last, chars)| (last.duration_since(first).as_secs_f64(), chars)).filter(|(secs, chars)| crawled(*secs, *chars)) {
                    log_with("api_error", "slow stream", &format!("The model sent {chars} characters of text in {secs:.0} s."), json!({ "model": target.api_model, "charsPerSecond": (chars as f64 / secs).round() }));
                }
                let (said, aside) = carried.finish();
                if !aside.is_empty() {
                    thought_aloud.push_str(&aside);
                    emit.send(Event::Reasoning(aside));
                }
                let rest = match echo {
                    // The web never releases a continuation shorter than 24 characters; here what is held comes out when the round ends.
                    Some(dedup) => dedup.push(&said) + &dedup.finish(),
                    None => said,
                };
                if !rest.is_empty() {
                    shown.push_str(&rest);
                    emit.send(Event::Content(rest));
                }
                round.content = shown;
                if !thought_aloud.is_empty() {
                    // It is carried to the next round as the thought it was.
                    round.reasoning = [round.reasoning.trim_end(), thought_aloud.as_str()].iter().filter(|part| !part.is_empty()).copied().collect::<Vec<_>>().join("\n\n");
                }
                let without_tools = !body.contains_key("tools");
                if let Some((status, detail)) = recovered {
                    log_with("api_error", "openrouter_rejection_recovery", &detail, json!({ "status": status }));
                    lane.degraded += without_tools as u32;
                }
                return Ok((round, without_tools));
            }
            Err(e) => e,
        };
        let status = e.status;
        let detail = retry::extract_rejection_detail(&e.detail, 300);
        let said = detail.to_lowercase();

        // The cheap pinned endpoint is rate limited: any other one beats no answer, for the rest of the run.
        if status == 429 && body.remove("provider").is_some() {
            lane.unpinned = true;
            emit.send(Event::Notice("This model's usual provider is busy, so OpenRouter picks another one for this reply. It can cost a little more.".into()));
            continue;
        }

        // A stream that opened and then never said anything: two more tries, a little apart.
        if matches!(e.kind, Failure::Empty | Failure::NoFirstToken) {
            if empties == 2 {
                // The web's wording names OpenRouter's shared pool; other providers keep their own line.
                return Err(if openrouter { format!("{name} returned an empty response after 3 attempt(s). The host is overloaded or down right now — this is their pool, not your key. Wait a minute and try again, or switch to a DeepSeek model in Settings.") } else { e.message });
            }
            let wait = Duration::from_millis(if empties == 0 { 1_500 } else { 4_000 });
            empties += 1;
            emit.send(Event::Retry { reason: if e.kind == Failure::Empty { "empty reply" } else { "no first token" }.into(), attempt: empties as usize + 1, attempts: 3, wait });
            tokio::time::sleep(wait).await;
            continue;
        }

        // Transient: wait and send the same request again.
        if e.retryable && attempt < policy.attempts {
            let reason = match e.kind {
                Failure::TimedOut => "timed out".to_string(),
                Failure::Unreachable => "connection lost".to_string(),
                _ => retry::status_reason(if status == 0 { 500 } else { status }),
            };
            let wait = Duration::from_millis(retry::wait_ms(policy, attempt, e.retry_after));
            emit.send(Event::Retry { reason, attempt: attempt as usize + 1, attempts: policy.attempts as usize, wait });
            tokio::time::sleep(wait).await;
            attempt += 1;
            continue;
        }

        // OpenRouter turned the body itself away: send it once more in a shape it may take, and once more after that, smaller still.
        let rejected = matches!(status, 400 | 413 | 422) || (status >= 500 && said.contains("endpoint is unavailable"));
        if openrouter && rejected && reshapes < 2 && !retry::is_unknown_model_rejection(&detail) {
            let size = retry::is_size_rejection(status, &detail);
            let mandatory_said = said.contains("reasoning is mandatory");
            let turns = |n: usize| format!("{n} older turn{}", if n == 1 { "" } else { "s" });
            let reason = if reshapes == 1 {
                // Not when the tools were kept and it is still too large: taking them out would not make it fit.
                if !matches!(status, 400 | 413 | 422) || (size && body.contains_key("tools")) {
                    None
                } else {
                    *body = original.clone();
                    if lane.mandatory && body.remove("reasoning").is_some() {
                        body.insert("reasoning_effort".into(), json!("low"));
                    }
                    fold_body(body);
                    body.remove("tools");
                    body.remove("tool_choice");
                    strip_media_body(body);
                    Some("still rejected — retrying once more, smaller and without tools".to_string())
                }
            } else if status == 400 && lane.replay && !mandatory_said && !size && body.get_mut("messages").and_then(Value::as_array_mut).is_some_and(|m| transcript::condense_reasoning(m)) {
                lane.replay = false;
                Some("endpoint rejected replayed reasoning — retrying with its condensed form".to_string())
            } else if status == 400 && mandatory_said && body.get("reasoning").is_some_and(|r| r["effort"] == "none") {
                // An endpoint that refuses "reasoning off" gets minimal effort instead, for the rest of the run.
                lane.mandatory = true;
                body.remove("reasoning");
                body.insert("reasoning_effort".into(), json!("low"));
                Some("endpoint requires reasoning — retrying with minimal thinking instead of none".to_string())
            } else {
                // Size wants the history folded and the tools kept; shape wants the tools and media gone.
                let (dropped, media) = if size { (fold_body(body), strip_media_body(body)) } else { (0, false) };
                if dropped > 0 || media {
                    Some(format!("payload too large — retrying with {} folded, tools kept", turns(dropped)))
                } else if body.remove("tools").is_some() | body.remove("tool_choice").is_some() | strip_media_body(body) {
                    Some("host rejected the payload — retrying without tools and media".to_string())
                } else {
                    Some(fold_body(body)).filter(|dropped| *dropped > 0).map(|dropped| format!("host rejected the payload — retrying with {} folded", turns(dropped)))
                }
            };
            if let Some(reason) = reason {
                reshapes += 1;
                recovered = Some((status, if reshapes == 1 { format!("Recovered on rejection retry after HTTP {status}: {reason} — {}", head(&detail, 160)) } else { format!("Recovered on composed retry after HTTP {first_status} then {status}: {}", head(&detail, 160)) }));
                first_status = status;
                // The reshaped request gets one try, not another round of backoff.
                attempt = policy.attempts;
                let tries = (policy.attempts + reshapes) as usize;
                emit.send(Event::Retry { reason, attempt: tries, attempts: tries, wait: Duration::ZERO });
                continue;
            }
        }

        // Still rate limited after the retries: the pool is busy, not broken. Wait it out, up to six times.
        if status == 429 && waits < MAX_RATE_LIMIT_WAITS {
            waits += 1;
            // The web reads a missing Retry-After header as zero and does not wait at all; the doubling wait its own comment describes runs here.
            let wait = Duration::from_millis(e.retry_after.unwrap_or(5_000 << (waits - 1)).min(60_000));
            emit.send(Event::Retry { reason: "service busy".into(), attempt: waits as usize, attempts: MAX_RATE_LIMIT_WAITS as usize, wait });
            tokio::time::sleep(wait).await;
            continue;
        }

        return Err(match e.kind {
            Failure::Unreachable if e.retryable => provider::unreachable_message(name, attempt),
            Failure::TimedOut => provider::timed_out_message(name, attempt),
            _ => e.message,
        });
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
    use std::io::{Read, Write};

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

    /// A stand-in provider on 127.0.0.1: answers each request with the next scripted reply, closes, and keeps what it was sent.
    fn stub(replies: Vec<String>) -> (String, Arc<Mutex<Vec<Value>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for reply in replies {
                let Ok((mut socket, _)) = listener.accept() else { return };
                let (mut raw, mut chunk) = (Vec::new(), [0u8; 16_384]);
                let body = loop {
                    let n = socket.read(&mut chunk).unwrap_or(0);
                    raw.extend_from_slice(&chunk[..n]);
                    if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&raw[..at]).to_lowercase();
                        let length: usize = headers.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                        if raw.len() >= at + 4 + length {
                            break raw[at + 4..at + 4 + length].to_vec();
                        }
                    }
                    if n == 0 {
                        break Vec::new();
                    }
                };
                log.lock().unwrap().push(serde_json::from_slice(&body).unwrap_or(Value::Null));
                let _ = socket.write_all(reply.as_bytes());
            }
        });
        (base, seen)
    }

    fn sse(frames: &[Value]) -> String {
        let body = frames.iter().map(|f| format!("data: {f}\n\n")).collect::<String>() + "data: [DONE]\n\n";
        format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len())
    }

    fn refuse(status: u16, headers: &str, body: &str) -> String {
        format!("HTTP/1.1 {status} No\r\nContent-Type: application/json\r\nConnection: close\r\n{headers}Content-Length: {}\r\n\r\n{body}", body.len())
    }

    fn says(text: &str, finish: Option<&str>) -> Value {
        json!({ "choices": [{ "delta": { "content": text }, "finish_reason": finish }] })
    }

    fn request(messages: Value) -> Value {
        json!({ "model": "stub", "messages": messages, "stream": true, "tools": [{ "type": "function", "function": { "name": "read_file" } }], "tool_choice": "auto" })
    }

    /// One `call_model` against the stub: the outcome, and the reason of every retry it announced.
    async fn ask(base: &str, provider: ProviderId, body: Value, lane: &mut Lane, dedup: Option<ContinuationDedup>) -> (Result<(provider::Round, bool), String>, Vec<String>) {
        let (tx, rx) = mpsc::channel();
        let emit = Emitter::new(tx, || {});
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let target = Target { model: models::resolve("deepseek-v4-flash", &[]), provider, style: if provider == ProviderId::Openrouter { ThinkingStyle::Openai } else { ThinkingStyle::Deepseek }, api_key: "test".into(), base_url: base.to_string(), api_model: "stub".into() };
        let mut body = body.as_object().unwrap().clone();
        let result = call_model(&client, &target, &mut body, lane, dedup, false, false, &emit).await;
        drop(emit);
        let retries = rx.try_iter().filter_map(|event| if let Event::Retry { reason, .. } = event { Some(reason) } else { None }).collect();
        (result, retries)
    }

    #[tokio::test]
    async fn a_rate_limit_is_retried_then_waited_out() {
        let mut replies = vec![refuse(429, "Retry-After: 0\r\n", "{}"); 5];
        replies.push(sse(&[says("hi", Some("stop"))]));
        let (base, seen) = stub(replies);
        let (result, retries) = ask(&base, ProviderId::Openrouter, request(json!([{ "role": "user", "content": "q" }])), &mut Lane::default(), None).await;
        assert_eq!(result.unwrap().0.content, "hi");
        assert_eq!(retries, ["rate limited", "rate limited", "rate limited", "rate limited", "service busy"]);
        assert_eq!(seen.lock().unwrap().len(), 6);
    }

    #[tokio::test]
    async fn a_server_error_backs_off_then_gives_up() {
        let (base, _) = stub(vec![refuse(503, "Retry-After: 0\r\n", ""); 3]);
        let (result, retries) = ask(&base, ProviderId::Deepseek, request(json!([{ "role": "user", "content": "q" }])), &mut Lane::default(), None).await;
        assert!(result.unwrap_err().contains("temporarily unavailable (503)"));
        assert_eq!(retries, ["inference unavailable", "inference unavailable"]);
    }

    #[tokio::test]
    async fn a_size_rejection_folds_history_and_keeps_the_tools() {
        let too_big = refuse(400, "", r#"{"error":{"message":"This endpoint's maximum context length is 1000 tokens."}}"#);
        let (base, seen) = stub(vec![too_big, sse(&[says("ok", Some("stop"))])]);
        let messages = json!([{ "role": "system", "content": "rules" }, { "role": "user", "content": "u".repeat(200_000) }, { "role": "assistant", "content": "a".repeat(200_000) }, { "role": "user", "content": "live" }]);
        let mut lane = Lane::default();
        let (result, retries) = ask(&base, ProviderId::Openrouter, request(messages), &mut lane, None).await;
        assert!(!result.unwrap().1, "the tools stay");
        assert_eq!(retries, ["payload too large — retrying with 1 older turn folded, tools kept"]);
        let seen = seen.lock().unwrap();
        assert!(seen[1]["messages"][1]["content"].as_str().unwrap().starts_with("[1 older history turn omitted"));
        assert!(seen[1]["tools"].is_array() && lane.degraded == 0);
    }

    #[tokio::test]
    async fn a_shape_rejection_strips_the_tools_and_counts_the_round() {
        let (base, seen) = stub(vec![refuse(400, "", r#"{"error":{"message":"Invalid API parameter"}}"#), sse(&[says("ok", Some("stop"))])]);
        let mut lane = Lane::default();
        let (result, retries) = ask(&base, ProviderId::Openrouter, request(json!([{ "role": "user", "content": "q" }])), &mut lane, None).await;
        assert!(result.unwrap().1, "the round ran without tools");
        assert_eq!(retries, ["host rejected the payload — retrying without tools and media"]);
        assert!(seen.lock().unwrap()[1].get("tools").is_none() && lane.degraded == 1);
    }

    #[tokio::test]
    async fn mandatory_reasoning_gets_minimal_effort() {
        let (base, seen) = stub(vec![refuse(400, "", r#"{"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled."}}"#), sse(&[says("ok", Some("stop"))])]);
        let mut body = request(json!([{ "role": "user", "content": "q" }]));
        body["reasoning"] = json!({ "effort": "none" });
        let mut lane = Lane::default();
        let (result, retries) = ask(&base, ProviderId::Openrouter, body, &mut lane, None).await;
        assert!(result.is_ok() && lane.mandatory);
        assert_eq!(retries, ["endpoint requires reasoning — retrying with minimal thinking instead of none"]);
        let seen = seen.lock().unwrap();
        assert!(seen[1].get("reasoning").is_none() && seen[1]["reasoning_effort"] == "low" && seen[1]["tools"].is_array());
    }

    #[tokio::test]
    async fn an_empty_stream_is_asked_again() {
        let (base, seen) = stub(vec![sse(&[]), sse(&[says("there", Some("stop"))])]);
        let (result, retries) = ask(&base, ProviderId::Deepseek, request(json!([{ "role": "user", "content": "q" }])), &mut Lane::default(), None).await;
        assert_eq!(result.unwrap().0.content, "there");
        assert_eq!((retries, seen.lock().unwrap().len()), (vec!["empty reply".to_string()], 2));
    }

    #[tokio::test]
    async fn a_dropped_stream_comes_back_as_a_cut_reply() {
        // The headers promise more than arrives: the connection closes mid-reply.
        let dropped = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: 9999\r\n\r\ndata: {}\n\n", says("partial", None));
        let (base, _) = stub(vec![dropped]);
        let (result, retries) = ask(&base, ProviderId::Deepseek, request(json!([{ "role": "user", "content": "q" }])), &mut Lane::default(), None).await;
        let round = result.unwrap().0;
        assert_eq!((round.content.as_str(), round.finish, retries.len()), ("partial", None, 0));
    }

    #[tokio::test]
    async fn a_continuation_that_restarts_its_sentence_is_trimmed() {
        let frames = [says("The chain is closed and the pawn ", None), says("handle now resolves through m_hPawn = controller + 0x8", None), says(" and that is all.", Some("stop"))];
        let (base, _) = stub(vec![sse(&frames)]);
        let dedup = ContinuationDedup::new("The chain is closed and the pawn handle now resolves through m_hPawn = ");
        let (result, _) = ask(&base, ProviderId::Deepseek, request(json!([{ "role": "user", "content": "q" }])), &mut Lane::default(), Some(dedup)).await;
        assert_eq!(result.unwrap().0.content, "controller + 0x8 and that is all.");
    }

    fn calls(name: &str, args: &str) -> Value {
        call_as("call_1", name, args)
    }

    fn call_as(id: &str, name: &str, args: &str) -> Value {
        json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": id, "function": { "name": name, "arguments": args } }] }, "finish_reason": "tool_calls" }] })
    }

    /// The system messages of a request after the first that start with `prefix`.
    fn sent_systems(request: &Value, prefix: &str) -> Vec<String> {
        request["messages"].as_array().unwrap().iter().skip(1).filter(|m| m["role"] == "system").filter_map(|m| m["content"].as_str()).filter(|c| c.starts_with(prefix)).map(str::to_string).collect()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_listing_is_shown_once_and_later_rounds_get_what_changed() {
        let write = |id: &str, path: &str| sse(&[call_as(id, "write_file", &json!({ "path": path, "content": "hello" }).to_string())]);
        let (_, _, _, sent) = reply(vec![write("w1", "a.txt"), write("w2", "b.txt"), sse(&[says("Here is what I did: wrote a.txt and b.txt.", Some("stop"))])], "none", None).await;
        let listing = "Current workspace contents (refreshed after every action — this replaces any earlier listing):\n\nThe workspace is currently empty.";
        for request in &sent {
            assert_eq!(sent_systems(request, "Current workspace contents"), [listing]);
        }
        let deltas = sent_systems(&sent[2], "Workspace changes since");
        assert_eq!(sent_systems(&sent[0], "Workspace changes since").len(), 0);
        assert_eq!(sent_systems(&sent[1], "Workspace changes since"), deltas[..1]);
        assert!(deltas.len() == 2 && deltas[0].ends_with("  + a.txt  (5B)") && deltas[1].ends_with("  + b.txt  (5B)"), "{deltas:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_stopped_reply_is_resumed_from_its_saved_transcript() {
        let ask = "Write the release notes into notes.txt";
        let args = r#"{"path":"notes.txt","content":"v1"}"#;
        let checkpoints = run_with(vec![sse(&[call_as("w1", "write_file", args)]), sse(&[says("Here is what I did: wrote notes.txt.", Some("stop"))])], "none", None, |dir| opening(dir, ask)).await.checkpoints;
        // What a Stop during the second request leaves on the reply: the transcript after the first tool round.
        let prior = json!({ "role": "assistant", "content": "", "resumeState": checkpoints[0], "toolEvents": [{ "id": "w1", "name": "write_file", "args": args, "ok": true, "summary": "Wrote notes.txt" }] });
        let resume = Resume { prior, note: " keep it short ".into(), usage: Usage { prompt: 7, ..Default::default() } };
        let Ran { text, end, sent, .. } = run_with(vec![sse(&[says("Here is what I did: carried on, and notes.txt is written.", Some("stop"))])], "none", None, |dir| {
            let mut start = Start { user_text: ask.into(), ..Default::default() };
            let mut messages = resume_transcript(resume, vec![json!({ "role": "system", "content": "fresh rules" }), user(ask)], &mut start, "");
            assert_eq!((start.tool_rounds, start.usage.prompt), (1, 7));
            start.tree = Tree::open(dir, &mut messages);
            (messages, start)
        })
        .await;
        assert_eq!((text.as_str(), end.incomplete), ("Here is what I did: carried on, and notes.txt is written.", false));
        // The saved round is replayed under the prompt it ran with: the call, its result, then the brief ending in the user's note.
        let messages = sent[0]["messages"].as_array().unwrap();
        assert_eq!((messages[0]["content"].as_str(), sent_args(&sent[0])), (Some("rules"), vec![args.to_string()]));
        assert!(last_result(&sent[0]).starts_with("Wrote notes.txt"));
        let brief = messages.iter().rev().find(|m| m["role"] == "user").unwrap()["content"].as_str().unwrap();
        assert!(brief.starts_with(EXACT_RESUME_INSTRUCTION) && brief.ends_with("follow it:\nkeep it short"), "{brief}");
        // One listing, of the workspace as it is now, in place of the saved one and its delta.
        assert_eq!(sent_systems(&sent[0], "Workspace changes since").len(), 0);
        assert_eq!(sent_systems(&sent[0], "Current workspace contents"), [messages.last().unwrap()["content"].as_str().unwrap()]);
    }

    #[test]
    fn a_reply_with_no_saved_transcript_is_rebuilt_from_its_steps() {
        let fresh = || vec![json!({ "role": "system", "content": "rules" }), user("q")];
        let prior = json!({ "role": "assistant", "content": "Half an answer", "toolEvents": [{ "id": "t1", "name": "write_file", "args": "{\"path\":\"a.txt\",\"content\":\"x\"}", "ok": true, "summary": "Wrote a.txt" }] });
        let mut start = Start::default();
        let messages = resume_transcript(Resume { prior, note: String::new(), usage: Usage::default() }, fresh(), &mut start, "");
        assert_eq!((messages[..2].to_vec(), start.tool_rounds), (fresh(), 1));
        assert!(messages.len() > 3 && messages.last().unwrap()["content"].as_str().unwrap().starts_with("You were interrupted before finishing. Everything above is your own work from that attempt"));
        assert!(crate::context::prune::tool_calls_are_balanced(&messages));
        // Nothing arrived at all: there is nothing to carry forward, and the question is answered normally.
        let empty = Resume { prior: json!({ "role": "assistant", "content": "" }), note: String::new(), usage: Usage::default() };
        assert_eq!(resume_transcript(empty, fresh(), &mut Start::default(), ""), fresh());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn delegate_calls_in_one_round_run_as_helpers_and_report_back() {
        let call = |index: u32, id: &str, args: &str| json!({ "index": index, "id": id, "function": { "name": "delegate", "arguments": args } });
        let round = json!({ "choices": [{ "delta": { "tool_calls": [call(0, "d1", r#"{"task":"Find where the parser lives"}"#), call(1, "d2", r#"{"task":" Find where the lexer lives "}"#), call(2, "d3", "{}")] }, "finish_reason": "tool_calls" }] });
        let report = || refuse(200, "", &json!({ "choices": [{ "message": { "role": "assistant", "content": "It lives in src/parse.rs:10." } }], "usage": { "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120 } }).to_string());
        let ran = run_with(vec![sse(&[round]), report(), report(), sse(&[says("Here is what I did: asked two helpers, and both point at src/parse.rs.", Some("stop"))])], "none", None, |dir| opening(dir, "q")).await;
        assert_eq!(ran.sent.len(), 4);
        // Each helper is its own conversation: the research prompt, the brief, the reply's read-only tools, thinking off.
        let mut briefs = Vec::new();
        for helper in &ran.sent[1..3] {
            assert!(helper["messages"][0]["content"].as_str().unwrap().starts_with("You are a research helper") && helper["messages"].as_array().unwrap().len() == 2);
            assert_eq!((helper["stream"].as_bool(), helper["thinking"]["type"].as_str(), helper["tools"][0]["function"]["name"].as_str()), (Some(false), Some("disabled"), Some("read_file")));
            briefs.push(helper["messages"][1]["content"].as_str().unwrap().to_string());
        }
        briefs.sort();
        assert_eq!(briefs, ["Find where the lexer lives", "Find where the parser lives"]);
        // The reply reads the two reports and the refusal of the call that had no brief, in call order.
        let results: Vec<&str> = ran.sent[3]["messages"].as_array().unwrap().iter().filter(|m| m["role"] == "tool").map(|m| m["content"].as_str().unwrap()).collect();
        assert!(results.len() == 3 && results[..2].iter().all(|r| r.starts_with("Helper report (1 round, 0 tool calls).\n\nIt lives in src/parse.rs:10.")), "{results:?}");
        assert!(results[2].starts_with("Error: task is required — the helper's complete brief."), "{}", results[2]);
        assert_eq!(ran.steps, [("d1", "Helper finished · 1 round, 0 tool calls"), ("d2", "Helper finished · 1 round, 0 tool calls"), ("d3", "No task given")].map(|(id, summary)| (id.to_string(), summary.to_string())));
        // What the helpers used is counted on the reply.
        assert_eq!((ran.usage.prompt, ran.usage.completion), (200, 40));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_request_is_pinned_after_each_tool_round() {
        let ask = "Write the release notes into notes.txt";
        let write = |id: &str, text: &str| sse(&[call_as(id, "write_file", &json!({ "path": "notes.txt", "content": text }).to_string())]);
        let (_, _, _, sent) = reply_to(ask, vec![write("w1", "v1"), write("w2", "v2"), sse(&[says("Here is what I did: wrote notes.txt.", Some("stop"))])], "none", None).await;
        assert!(sent_systems(&sent[0], GOAL_PIN_MARKER).is_empty());
        for request in &sent[1..] {
            // One pin however many rounds ran, and it is the last thing read.
            let pins = sent_systems(request, GOAL_PIN_MARKER);
            assert!(pins.len() == 1 && pins[0].contains("You are mid-task on this request") && pins[0].ends_with(ask), "{pins:?}");
            assert_eq!(request["messages"].as_array().unwrap().last().unwrap()["content"], pins[0]);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_picture_reaches_a_model_that_cannot_see_as_its_description() {
        let picture = Attachment { name: "ui.png".into(), kind: "image".into(), data_url: Some("data:image/png;base64,AQID".into()), description: Some("A red button labelled Save.".into()), description_source: Some("ocr".into()), ..Default::default() };
        let question = "What does the button say?";
        let ran = run_with(vec![sse(&[says("It says Save.", Some("stop"))])], "none", None, |dir| {
            let mut messages = vec![json!({ "role": "system", "content": "rules" })];
            messages.extend(crate::context::transcript::wire_turns(&[], question, std::slice::from_ref(&picture), Vision::Helper));
            let tree = Tree::open(dir, &mut messages);
            (messages, Start { tree, user_text: question.into(), ..Default::default() })
        })
        .await;
        // The description rides in the request, and the raw picture does not.
        let sent = ran.sent[0]["messages"].to_string();
        assert!(sent.contains("A red button labelled Save.") && !sent.contains("data:image/png;base64,AQID"), "{sent}");
    }

    #[test]
    fn only_the_two_newest_pictures_in_history_ride_in_full() {
        let turn = |text: &str, data: &str| (Role::User, text.to_string(), vec![Attachment { name: "p.png".into(), kind: "image".into(), data_url: Some(data.into()), ..Default::default() }]);
        let history = vec![turn("one", "data:a"), turn("two", "data:b"), turn("three", "data:c")];
        let sent = Value::Array(crate::context::transcript::wire_turns(&history, "now", &[], Vision::Native)).to_string();
        assert!(sent.contains("data:b") && sent.contains("data:c") && !sent.contains("data:a"), "{sent}");
        assert!(sent.contains("kept in the conversation, not re-sent"), "{sent}");
    }

    /// An earlier reply's tool work is not sent with the next request: its prose is, and nothing the run did with it.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_earlier_replys_tool_work_stays_out_of_the_request() {
        let earlier = [crate::store::Message::from_web(&json!({
            "id": "a1", "role": "assistant", "content": "There are three files.", "reasoningContent": "list first",
            "toolEvents": [{ "id": "t1", "name": "list_files", "args": "{}", "ok": true, "summary": "Listed src" }]
        }))];
        let history = crate::context::transcript::history(&earlier, None);
        let ran = run_with(vec![sse(&[says("Done.", Some("stop"))])], "none", None, move |dir| {
            let mut messages = vec![json!({ "role": "system", "content": "rules" })];
            messages.extend(crate::context::transcript::wire_turns(&history, "next", &[], Vision::None));
            let tree = Tree::open(dir, &mut messages);
            (messages, Start { tree, user_text: "next".into(), ..Default::default() })
        })
        .await;
        let sent = ran.sent[0]["messages"].to_string();
        assert!(sent.contains("There are three files."), "{sent}");
        assert!(!sent.contains("list_files") && !sent.contains("Listed src") && !sent.contains("list first") && !sent.contains("Steps taken"), "{sent}");
    }

    /// The newest tool result in a request.
    fn last_result(request: &Value) -> String {
        request["messages"].as_array().unwrap().iter().rev().find(|m| m["role"] == "tool").unwrap()["content"].as_str().unwrap().to_string()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_file_this_reply_wrote_is_read_back_from_memory_until_it_changes() {
        // 30,000 characters: more than this test's 20,000-character read budget.
        let body = "line of text\n".repeat(2_308);
        let write = sse(&[call_as("w1", "write_file", &json!({ "path": "big.txt", "content": body }).to_string())]);
        let read = |id: &str| sse(&[call_as(id, "read_file", r#"{"path":"big.txt"}"#)]);
        let edit = sse(&[call_as("e1", "edit_file", r#"{"path":"big.txt","start_line":1,"end_line":1,"new_text":"changed"}"#)]);
        let (_, _, _, sent) = reply(vec![write, read("r1"), edit, read("r2"), sse(&[says("Here is what I did: wrote big.txt, read it and edited it.", Some("stop"))])], "none", None).await;
        let recalled = last_result(&sent[2]);
        assert!(recalled.starts_with("big.txt: EXACT, all 2308 lines, 30004 chars — served from the run's own write") && !recalled.contains("CUT SHORT"), "{}", &recalled[..200]);
        // After the edit the memory no longer matches the disk: an ordinary read, cut at the budget.
        let fresh = last_result(&sent[4]);
        assert!(fresh.starts_with("big.txt: lines 1-") && fresh.contains("CUT SHORT"), "{}", &fresh[..200]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn what_a_run_proved_is_written_to_the_lessons_file() {
        let answer = json!({ "lessons": [{ "text": "Tests here run with cargo test -j 3", "evidence": "run_tests passed with it" }, { "text": "A guess", "evidence": "" }], "confirms": [] });
        let (base, seen) = stub(vec![refuse(200, "", &json!({ "choices": [{ "message": { "content": answer.to_string() } }] }).to_string())]);
        let dir = std::env::temp_dir().join(format!("apim-learn-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let helper = Target { model: models::resolve("deepseek-v4-flash", &[]), provider: ProviderId::Deepseek, style: ThinkingStyle::Deepseek, api_key: "test".into(), base_url: base, api_model: "stub".into() };
        let outcomes = vec![Outcome { name: "run_tests".into(), args: "{}".into(), ok: true, summary: "12 passed".into() }];
        learn(reqwest::Client::builder().no_proxy().build().unwrap(), helper, dir.clone(), outcomes, Vec::new()).await;
        let saved = lessons::read_lessons(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        // The one with evidence is kept; the guess is refused.
        assert_eq!(saved.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["Tests here run with cargo test -j 3"]);
        assert!(seen.lock().unwrap()[0]["messages"][1]["content"].as_str().unwrap().contains("run_tests"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_finding_is_filed_in_the_workspace_store_and_can_be_retired() {
        let note = sse(&[call_as("n1", "note_finding", r#"{"claim":"The parser lives in src/parse.rs","refs":["src/parse.rs"]}"#)]);
        let again = sse(&[call_as("n2", "note_finding", r#"{"claim":"done","id":"nope","status":"disproved"}"#)]);
        let (_, _, _, sent) = reply(vec![note, again, sse(&[says("Here is what I did: noted where the parser lives.", Some("stop"))])], "none", None).await;
        assert!(last_result(&sent[1]).starts_with("Finding recorded ["), "{}", last_result(&sent[1]));
        assert!(last_result(&sent[2]).starts_with("No active finding with id nope was found to revise."), "{}", last_result(&sent[2]));
    }

    /// The arguments of every tool call in a request, oldest first.
    fn sent_args(request: &Value) -> Vec<String> {
        request["messages"].as_array().unwrap().iter().filter(|m| m["tool_calls"].is_array()).map(|m| m["tool_calls"][0]["function"]["arguments"].as_str().unwrap().to_string()).collect()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fat_arguments_of_superseded_writes_are_stubbed() {
        let write = |id: &str, fill: &str| sse(&[call_as(id, "write_file", &json!({ "path": "a.txt", "content": fill.repeat(10_000) }).to_string())]);
        let (_, end, _, sent) = reply(vec![write("w1", "a"), write("w2", "b"), write("w3", "c"), sse(&[says("Here is what I did: wrote a.txt three times.", Some("stop"))])], "none", None).await;
        assert!(!end.incomplete);
        // Two writes are under the pruning threshold; with the third, the two it replaced lose their content.
        assert!(sent_args(&sent[2]).iter().all(|a| a.len() > 10_000));
        let last = sent_args(&sent[3]);
        assert!(last[0].starts_with(r#"{"_trimmed":true"#) && last[1].starts_with(r#"{"_trimmed":true"#) && last[2].len() > 10_000, "{:?}", last.iter().map(String::len).collect::<Vec<_>>());
    }

    /// One whole reply against the stub, driven the way `run` drives it: what it wrote, how it ended, its notices, and every request sent.
    async fn reply(replies: Vec<String>, effort: &str, budget: Option<f64>) -> (String, Ending, Vec<String>, Vec<Value>) {
        reply_to("q", replies, effort, budget).await
    }

    /// The same, for a question of the test's choosing.
    async fn reply_to(question: &str, replies: Vec<String>, effort: &str, budget: Option<f64>) -> (String, Ending, Vec<String>, Vec<Value>) {
        let ran = run_with(replies, effort, budget, |dir| opening(dir, question)).await;
        (ran.text, ran.end, ran.notices, ran.sent)
    }

    /// The local Qwen wire is fitted to the 80K window (route.ts 2778-2788); another model's wire is sent whole.
    #[tokio::test(flavor = "multi_thread")]
    async fn only_the_local_model_fits_its_wire_copy() {
        let done = || vec![sse(&[says("Done.", Some("stop"))])];
        let local = run_on(done(), "none", None, long_system_opening, local_target).await;
        let other = run_on(done(), "none", None, long_system_opening, deepseek_target).await;
        let (local_wire, other_wire) = (local.sent[0]["messages"].as_array().unwrap(), other.sent[0]["messages"].as_array().unwrap());
        assert!(crate::local::context::estimate_tokens(local_wire) <= crate::local::context::local_message_budget(true), "the local wire fits its window");
        assert!(local_wire[0]["content"].as_str().unwrap().len() < 300_000, "the local system prompt was clipped");
        assert!(other_wire[0]["content"].as_str().unwrap().len() >= 300_000, "the other model's system prompt was sent whole");
    }

    /// Everything a test may ask about one run.
    struct Ran {
        text: String,
        end: Ending,
        notices: Vec<String>,
        /// Every request the stub was sent, in order.
        sent: Vec<Value>,
        /// The resume states saved along the way.
        checkpoints: Vec<Value>,
        /// The last token totals reported.
        usage: Usage,
        /// (call id, summary) of every finished step.
        steps: Vec<(String, String)>,
    }

    /// What `run_inner` opens an ordinary reply with: the prompt, the question, the listing.
    fn opening(dir: &Path, question: &str) -> (Vec<Value>, Start) {
        let mut messages = vec![json!({ "role": "system", "content": "rules" }), user(question)];
        let tree = Tree::open(dir, &mut messages);
        (messages, Start { tree, user_text: question.into(), ..Default::default() })
    }

    /// A reply from opening messages of the test's making (given the workspace folder).
    async fn run_with(replies: Vec<String>, effort: &str, budget: Option<f64>, open: impl FnOnce(&Path) -> (Vec<Value>, Start)) -> Ran {
        run_on(replies, effort, budget, open, deepseek_target).await
    }

    fn deepseek_target(base: String) -> Target {
        Target { model: models::resolve("deepseek-v4-flash", &[]), provider: ProviderId::Deepseek, style: ThinkingStyle::Deepseek, api_key: "test".into(), base_url: base, api_model: "stub".into() }
    }

    fn local_target(base: String) -> Target {
        Target { model: models::resolve("qwen-3.8-27b", &[]), provider: ProviderId::Local, style: ThinkingStyle::Qwen, api_key: "local".into(), base_url: base, api_model: "stub".into() }
    }

    /// A system prompt too long for any window. Nothing old is there to drop, so only the fit can shorten it.
    fn long_system_opening(dir: &Path) -> (Vec<Value>, Start) {
        let mut messages = vec![json!({ "role": "system", "content": "x".repeat(300_000) }), user("q")];
        let tree = Tree::open(dir, &mut messages);
        (messages, Start { tree, user_text: "q".into(), ..Default::default() })
    }

    /// The loop against a stub that answers as the target `target_for` makes of its address.
    async fn run_on(replies: Vec<String>, effort: &str, budget: Option<f64>, open: impl FnOnce(&Path) -> (Vec<Value>, Start), target_for: fn(String) -> Target) -> Ran {
        let (base, seen) = stub(replies);
        let (tx, rx) = mpsc::channel();
        let dir = std::env::temp_dir().join(format!("apim-loop-{}-{}", std::process::id(), base.rsplit(':').next().unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        let ctx = Ctx {
            root: dir.clone(),
            state_dir: dir.clone(),
            settings: Settings { budget_usd: budget, ..Settings::default() },
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            read_chars: 20_000,
            limits: tool_limits_for(false),
            memory: Default::default(),
            emit: Emitter::new(tx, || {}),
            chat: Arc::new(Mutex::new(ChatState::default())),
            procs: Arc::new(Procs::default()),
            planner: None,
        };
        let target = target_for(base);
        let (opening, start) = open(&dir);
        let end = drive(&target, &ctx, opening, vec![json!({ "type": "function", "function": { "name": "read_file" } })], Vec::new(), effort, "test", &Mutex::new(Vec::new()), start).await.unwrap();
        drop(ctx);
        let mut ran = Ran { text: String::new(), end, notices: Vec::new(), sent: Vec::new(), checkpoints: Vec::new(), usage: Usage::default(), steps: Vec::new() };
        for event in rx.try_iter() {
            match event {
                Event::Content(t) => ran.text.push_str(&t),
                Event::Notice(n) => ran.notices.push(n),
                Event::Checkpoint(state) => ran.checkpoints.push(state),
                Event::Usage(usage) => ran.usage = usage,
                Event::ToolDone { id, summary, .. } => ran.steps.push((id, summary)),
                _ => {}
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        ran.sent = seen.lock().unwrap().clone();
        ran
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_reply_cut_by_the_output_limit_is_continued() {
        let (text, end, notices, sent) = reply(vec![sse(&[says("The first half of the answer", Some("length"))]), sse(&[says(" and the second half.", Some("stop"))])], "none", None).await;
        assert_eq!(text, "The first half of the answer and the second half.");
        assert_eq!(notices, ["Answer was longer than one response allows — continuing (1/16)"]);
        assert!(!end.incomplete && end.stop_reason.is_none());
        assert!(sent[1]["messages"][4]["content"].as_str().unwrap().starts_with("You reached the output limit mid-answer. Continue from exactly where you stopped"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_same_failing_call_three_times_stops_the_run() {
        let failing = || sse(&[calls("read_file", r#"{"path":"missing.txt"}"#)]);
        let (text, end, _, sent) = reply(vec![failing(), failing(), failing()], "none", None).await;
        assert!(text.starts_with("Stopped by the loop breaker: `read_file` failed three times with identical arguments"), "{text}");
        assert_eq!(end.stop_reason.as_deref(), Some(revive::premature_stop_notice(Premature::LoopBreaker)));
        // The second failure carried the warning in the result the model read before its third try.
        let read = sent[2]["messages"].as_array().unwrap().iter().rev().find(|m| m["role"] == "tool").unwrap()["content"].as_str().unwrap().to_string();
        assert!(read.contains("[Harness: this exact `read_file` call has now failed twice"), "{read}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_stop_after_tools_with_no_answer_is_picked_up() {
        let (text, end, notices, sent) = reply(vec![sse(&[calls("list_files", "{}")]), sse(&[says("", Some("stop"))]), sse(&[says("Here is what I did: listed the folder, and it is empty.", Some("stop"))])], "none", None).await;
        assert_eq!(text, "Here is what I did: listed the folder, and it is empty.");
        assert_eq!(notices, ["The model stopped mid-task — continuing from where it left off (1/2)"]);
        assert!(!end.incomplete);
        let shove = sent[2]["messages"].as_array().unwrap().iter().rev().find(|m| m["role"] == "user").unwrap()["content"].as_str().unwrap().to_string();
        assert!(shove.starts_with("You stopped before the task was finished — you called tools and then produced no closing answer."), "{shove}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_think_that_fills_the_output_is_told_to_answer_without_one() {
        let think = json!({ "choices": [{ "delta": { "reasoning_content": "r".repeat(100) }, "finish_reason": "length" }] });
        let (text, end, notices, sent) = reply(vec![sse(&[think]), sse(&[says("Short answer.", Some("stop"))])], "high", None).await;
        assert_eq!((text.as_str(), end.incomplete), ("Short answer.", false));
        assert_eq!(notices, ["Used the thinking budget — answering now, without another think"]);
        assert_eq!((sent[0]["thinking"]["type"].as_str(), sent[1]["thinking"]["type"].as_str()), (Some("enabled"), Some("disabled")));
        assert_eq!(sent[1]["messages"][4]["content"], THINK_ONLY[0]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_spending_limit_stops_the_run_before_its_tools() {
        let costly = json!({ "choices": [], "usage": { "prompt_tokens": 10_000_000, "completion_tokens": 1_000, "total_tokens": 10_001_000 } });
        let (text, end, _, sent) = reply(vec![sse(&[calls("list_files", "{}"), costly])], "none", Some(0.01)).await;
        assert!(text.starts_with("Stopped at your spending limit — this reply has cost $"), "{text}");
        assert_eq!(end.stop_reason.as_deref(), Some("Stopped at your $0.01 spending limit — the work so far is saved, use Resume to continue"));
        // One cent buys at most 35,714 output tokens of this model: the request was capped to that.
        assert!(end.incomplete && sent.len() == 1 && sent[0]["max_tokens"].as_u64().unwrap() <= 35_714);
    }
}

//! Sub-agents: read-only helpers with their own context. Port of src/lib/subagent.ts.
//! The main agent's context is its most expensive resource: "find where auth is handled" costs dozens of reads that stay
//! in the transcript for the rest of the run. `delegate` hands such a job to a helper that explores in a SEPARATE context
//! (its brief, the workspace tree, the read-only tools, a round budget) and returns only a report, which the main agent
//! reads as one tool result. Several delegate calls in one round run at the same time (the round loop starts them together).
//! Read-only by construction: the helper is only offered read tools, its calls are refused by name if a model invents one
//! anyway, and it cannot delegate further.
//! The tools themselves are the caller's: pass a `ToolRunner` that runs a read-only tool and returns its text (the git
//! read tools included), turning a failure into "Error: <message>". No dependency on tools/ or agent.rs.

use super::{js_head, js_len, js_round, js_trim, js_truthy, post_json, Stop};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

/// Tools a helper may use. Everything here only reads.
pub const SUBAGENT_TOOLS: [&str; 16] = ["list_files", "read_file", "read_files", "search_files", "read_symbol", "find_references", "query_data", "read_document", "analyze_log", "git_status", "git_diff", "git_log", "fetch_url", "inspect_page", "web_search", "search_conversation"];

/// The `delegate` tool as the main agent sees it.
pub fn delegate_tool() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "delegate",
            "description": concat!(
                "Hand a self-contained research job to a helper agent that works in its OWN context and returns only its conclusions. ",
                "Use it for broad exploration (\"find everything involved in X\", \"how is Y wired end to end\"), reviewing many files, ",
                "or looking something up on the web — work whose reads you would otherwise carry in your context for the rest of the task. ",
                "The helper can read, search and browse but cannot change files or run commands. It cannot see this conversation, ",
                "so the brief must say everything it needs: the goal, what to look at, and what the report must contain. ",
                "Several delegate calls in the same round run in parallel — split independent questions across them. ",
                "Do not delegate a single known file read or an edit; do those yourself."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "task": { "type": "string", "description": "The complete brief: what to find out, where to look, and exactly what the report should contain (e.g. file:line for every call site)." },
                    "max_rounds": { "type": "number", "description": "Upper bound on the helper's tool rounds (default 12, max 24). Raise only for genuinely large surveys." }
                },
                "required": ["task"]
            }
        }
    })
}

/// Validates the main agent's `delegate` call: the trimmed brief and the optional round bound, or the (content, summary) of the refusal.
pub fn parse_delegate_args(args: &Value) -> Result<(String, Option<f64>), (String, String)> {
    let task = args["task"].as_str().map_or("", js_trim);
    if task.is_empty() {
        return Err(("Error: task is required — the helper's complete brief.".to_string(), "No task given".to_string()));
    }
    Ok((task.to_string(), args["max_rounds"].as_f64()))
}

const SYSTEM: &str = "You are a research helper working for a coding agent. You can only READ: you have no way to change files, run commands or ask anyone anything.

Do the task you are given by reading and searching the workspace (and the web, if a tool for it is offered), then reply with your report. The agent that sent you sees NOTHING you read — only your final report — so the report must stand on its own:
- concrete findings with file paths and line numbers (path:line),
- short quoted snippets only where the exact text matters,
- what you could not find or could not verify, said plainly — never guess and present it as fact.

Work efficiently: read several files at once with read_files, locate things with search_files / find_references / read_symbol rather than opening files one by one, and stop as soon as you can answer. Make reasonable assumptions instead of asking, and state them. Keep the report under about 800 words unless the task needs more. Your final message is the report — no tool call in it.";

/// Per tool result, inside the helper's own context.
const RESULT_MAX_CHARS: usize = 24_000;
/// Past this the helper is told to write up what it has.
const CONTEXT_SOFT_CAP_CHARS: usize = 420_000;
const REPORT_MAX_CHARS: usize = 16_000;
const DEFAULT_ROUNDS: f64 = 12.0;
const MAX_ROUNDS: f64 = 24.0;
const REQUEST_TIMEOUT: Duration = Duration::from_millis(180_000);

/// Where to send the helper's requests.
#[derive(Clone)]
pub struct Target {
    pub base_url: String,
    pub api_model: String,
    pub headers: Vec<(String, String)>,
    /// Thinking switches, endpoint pins: merged into every request body.
    pub extra_body: Map<String, Value>,
}

/// Runs one read-only tool for the helper: (name, parsed arguments) to the text the helper reads.
pub type ToolFuture = Pin<Box<dyn Future<Output = String> + Send>>;
pub type ToolRunner = Arc<dyn Fn(String, Map<String, Value>) -> ToolFuture + Send + Sync>;
/// Callbacks: token usage of each request, the spending-cap check, and round progress.
pub type UsageFn = Arc<dyn Fn(&Value) + Send + Sync>;
pub type StopFn = Arc<dyn Fn() -> bool + Send + Sync>;
pub type ProgressFn = Arc<dyn Fn(&Progress) + Send + Sync>;

/// Progress for the UI: round number and the tools just used.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub round: u32,
    pub tool_calls: usize,
    pub tools: Vec<String>,
}

/// The line under the delegate row in the chat while the helper works.
pub fn progress_text(p: &Progress) -> String {
    let mut seen: Vec<&str> = Vec::new();
    for t in &p.tools {
        if !seen.contains(&t.as_str()) {
            seen.push(t);
        }
    }
    format!("round {} · {} tool call{} · {}", p.round, p.tool_calls, if p.tool_calls == 1 { "" } else { "s" }, seen.join(", "))
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StoppedBecause {
    Rounds,
    Context,
    Budget,
    Stopped,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubAgentResult {
    pub ok: bool,
    pub report: String,
    pub rounds: u32,
    pub tool_calls: usize,
    /// Paths the helper read, for the summary line.
    pub files_read: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_because: Option<StoppedBecause>,
}

pub struct Options {
    pub task: String,
    /// `workspace_context::build_workspace_context` for the helper's system prompt ("" is fine: it can still list_files).
    pub tree: String,
    pub target: Target,
    /// Every candidate tool definition (the workspace and GitHub schemas); narrowed to the read-only ones that are `available`.
    pub tools: Vec<Value>,
    /// Names of tools the main agent has this round (web_search, git...): a helper is never free money outside the limit.
    pub available: HashSet<String>,
    pub signal: Stop,
    pub max_rounds: Option<f64>,
    /// Context budget in chars. Derive it from the model's window with `helper_context_cap`: a fixed 420k overflowed an 80K-token local model.
    pub context_cap_chars: Option<usize>,
    pub run_tool: ToolRunner,
    /// Every request's usage, so the reply's total and spending cap include it.
    pub on_usage: Option<UsageFn>,
    /// Checked before each request; true stops the helper (spending cap).
    pub should_stop: Option<StopFn>,
    pub on_progress: Option<ProgressFn>,
    /// Waits before the second and third attempt of a 429, 5xx or dropped connection (the web uses 1.5 s and 5 s).
    pub retry_delays_ms: [u64; 2],
}

impl Options {
    pub fn new(task: String, target: Target, tools: Vec<Value>, available: HashSet<String>, signal: Stop, run_tool: ToolRunner) -> Options {
        Options { task, tree: String::new(), target, tools, available, signal, max_rounds: None, context_cap_chars: None, run_tool, on_usage: None, should_stop: None, on_progress: None, retry_delays_ms: [1500, 5000] }
    }
}

/// Soft context cap for a model window of `tokens` (about 60% of it).
pub fn helper_context_cap(tokens: u64) -> usize {
    ((tokens as f64 * 3.2 * 0.6).floor() as usize).clamp(40_000, CONTEXT_SOFT_CAP_CHARS)
}

fn clip(text: &str, max: usize) -> String {
    if js_len(text) <= max {
        text.to_string()
    } else {
        format!("{}\n…[{} more chars not shown to keep the helper's context small — read a narrower range if you need it]", js_head(text, max), js_len(text) - max)
    }
}

/// `parseToolArguments` of src/lib/transcript.ts: blank is `{}`, anything but an object is refused.
// ponytail: a malformed-JSON error carries serde's wording, not V8's "Expected property name or '}' in JSON at position 1"; the model only reads it to fix its call.
fn parse_tool_arguments(raw: &str) -> Result<Map<String, Value>, String> {
    if js_trim(raw).is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(o)) => Ok(o),
        Ok(_) => Err("Arguments must be a JSON object".to_string()),
        Err(e) => Err(e.to_string()),
    }
}

/// One request with retries: Ok is the reply message and its usage. Err is "stopped", an `HTTP 4xx...` (never retried),
/// or the last transient failure after three attempts.
async fn complete(client: &reqwest::Client, opts: &Options, body: &Value) -> Result<(Value, Option<Value>), String> {
    let url = format!("{}/chat/completions", opts.target.base_url);
    let mut last_error = String::new();
    for attempt in 0..3 {
        if opts.signal.is_stopped() {
            return Err("stopped".to_string());
        }
        if attempt > 0 {
            tokio::select! { _ = tokio::time::sleep(Duration::from_millis(opts.retry_delays_ms[attempt - 1])) => {}, _ = opts.signal.stopped() => {} }
        }
        if opts.signal.is_stopped() {
            return Err("stopped".to_string());
        }
        match post_json(client, &url, &opts.target.headers, body, Some(REQUEST_TIMEOUT), Some(&opts.signal)).await {
            Err(e) => {
                if opts.signal.is_stopped() {
                    return Err("stopped".to_string());
                }
                last_error = e;
            }
            Ok((status, text)) => {
                if status == 429 || status >= 500 {
                    last_error = format!("HTTP {status}");
                } else if !(200..300).contains(&status) {
                    let detail = js_head(&text, 300);
                    let msg = format!("HTTP {status}{}", if detail.is_empty() { String::new() } else { format!(": {detail}") });
                    if (400..500).contains(&status) {
                        return Err(msg);
                    }
                    last_error = msg;
                } else {
                    match serde_json::from_str::<Value>(&text) {
                        Err(e) => last_error = e.to_string(),
                        Ok(json) if json["choices"][0]["message"].is_null() => last_error = "empty response".to_string(),
                        Ok(json) => return Ok((json["choices"][0]["message"].clone(), Some(json["usage"].clone()).filter(|u| !u.is_null()))),
                    }
                }
            }
        }
    }
    Err(if last_error.is_empty() { "request failed".to_string() } else { last_error })
}

fn context_len(messages: &[Value]) -> usize {
    messages.iter().map(|m| m["content"].as_str().map_or(0, js_len)).sum()
}

fn ready(text: String) -> ToolFuture {
    Box::pin(async move { text })
}

/// Runs one helper to completion and returns its report. Never panics or errors: a failure is a result with `ok: false`.
pub async fn run_sub_agent(client: &reqwest::Client, opts: Options) -> SubAgentResult {
    let rounds = js_round(opts.max_rounds.unwrap_or(DEFAULT_ROUNDS)).clamp(1.0, MAX_ROUNDS) as u32;
    let tools: Vec<Value> = opts.tools.iter().filter(|t| t["function"]["name"].as_str().is_some_and(|n| SUBAGENT_TOOLS.contains(&n) && opts.available.contains(n))).cloned().collect();
    let allowed: HashSet<&str> = tools.iter().filter_map(|t| t["function"]["name"].as_str()).collect();
    let mut messages: Vec<Value> = vec![json!({ "role": "system", "content": format!("{SYSTEM}{}", opts.tree) }), json!({ "role": "user", "content": opts.task })];
    let mut files_read: Vec<String> = Vec::new();
    let mut tool_calls = 0usize;
    let mut context_chars = context_len(&messages);
    let mut stopped_because: Option<StoppedBecause> = None;
    let cap = opts.context_cap_chars.unwrap_or(CONTEXT_SOFT_CAP_CHARS);
    let mut salvaged = false;

    let mut round = 1u32;
    while round <= rounds + 1 {
        if opts.signal.is_stopped() {
            stopped_because = Some(StoppedBecause::Stopped);
            break;
        }
        if opts.should_stop.as_ref().is_some_and(|f| f()) {
            stopped_because = Some(StoppedBecause::Budget);
            break;
        }
        // The last pass (round budget or context cap) must answer, not explore.
        let final_pass = round > rounds || context_chars > cap;
        if final_pass {
            stopped_because = Some(if round > rounds { StoppedBecause::Rounds } else { StoppedBecause::Context });
            messages.push(json!({ "role": "user", "content": "Stop exploring now. Write your report from what you have found, and say what is left unchecked." }));
        }
        let mut body = Map::new();
        body.insert("model".into(), json!(opts.target.api_model));
        body.insert("messages".into(), Value::Array(messages.clone()));
        body.insert("max_tokens".into(), json!(8192));
        body.insert("stream".into(), json!(false));
        body.extend(opts.target.extra_body.clone());
        if !tools.is_empty() {
            body.insert("tools".into(), Value::Array(tools.clone()));
            body.insert("tool_choice".into(), json!(if final_pass { "none" } else { "auto" }));
        }

        let (message, usage) = match complete(client, &opts, &Value::Object(body)).await {
            Ok(r) => r,
            Err(msg) => {
                if msg == "stopped" {
                    stopped_because = Some(StoppedBecause::Stopped);
                    break;
                }
                // A 4xx after some work is usually the context overflowing the model's window. Shrink every tool
                // result and ask for the report once before giving up, so the helper's reads are not thrown away.
                if (msg.starts_with("HTTP 400") || msg.starts_with("HTTP 413")) && !salvaged && tool_calls > 0 {
                    salvaged = true;
                    for m in messages.iter_mut().filter(|m| m["role"] == "tool") {
                        if let Some(c) = m["content"].as_str().filter(|c| js_len(c) > 1500) {
                            m["content"] = Value::String(format!("{}\n…[shortened to fit the model's context]", js_head(c, 1500)));
                        }
                    }
                    context_chars = context_len(&messages);
                    round = rounds + 1; // the next pass is the final one
                    continue;
                }
                return SubAgentResult { ok: false, report: format!("The helper failed: {msg}. Nothing it found so far is available — do the research yourself or try a narrower brief."), rounds: round, tool_calls, files_read, stopped_because: Some(StoppedBecause::Error) };
            }
        };
        if let (Some(u), Some(f)) = (usage.as_ref().filter(|u| js_truthy(u)), &opts.on_usage) {
            f(u);
        }

        let calls: Vec<Value> = message["tool_calls"].as_array().map_or_else(Vec::new, |a| a.iter().filter(|c| js_truthy(&c["function"]["name"])).cloned().collect());
        if calls.is_empty() || final_pass {
            let text = js_trim(message["content"].as_str().unwrap_or(""));
            return SubAgentResult { ok: !text.is_empty(), report: if text.is_empty() { "The helper finished without writing a report.".to_string() } else { clip(text, REPORT_MAX_CHARS) }, rounds: round, tool_calls, files_read, stopped_because };
        }
        messages.push(json!({
            "role": "assistant",
            "content": message["content"].clone(),
            "tool_calls": calls.iter().map(|c| json!({ "id": c["id"], "type": "function", "function": { "name": c["function"]["name"], "arguments": if c["function"]["arguments"].is_null() { json!("{}") } else { c["function"]["arguments"].clone() } } })).collect::<Vec<_>>(),
        }));

        // Reads touch nothing shared, so a round's calls run together.
        let mut futs: Vec<ToolFuture> = Vec::new();
        for call in &calls {
            let name = call["function"]["name"].as_str().unwrap_or("").to_string();
            if !allowed.contains(name.as_str()) {
                futs.push(ready(format!("Error: {name} is not available to a read-only helper. Use the read and search tools, and put anything that needs a change in your report.")));
                continue;
            }
            let args = match parse_tool_arguments(call["function"]["arguments"].as_str().unwrap_or("{}")) {
                Ok(a) => a,
                Err(e) => {
                    futs.push(ready(format!("Error: the arguments were not valid JSON ({e}).")));
                    continue;
                }
            };
            let mut note = |p: &str| {
                if !files_read.iter().any(|f| f == p) {
                    files_read.push(p.to_string());
                }
            };
            args.get("path").and_then(Value::as_str).into_iter().for_each(&mut note);
            args.get("paths").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).for_each(&mut note);
            futs.push((opts.run_tool)(name, args));
        }
        let results = join_all(futs).await;
        tool_calls += calls.len();
        // A round's results share what is left of the budget, so one round of many large reads cannot blow far past it before the cap is checked.
        let share = (((cap as f64 - context_chars as f64) / calls.len() as f64).floor().max(2000.0)) as usize;
        for (call, result) in calls.iter().zip(results) {
            let content = clip(&result, RESULT_MAX_CHARS.min(share));
            context_chars += js_len(&content) + call["function"]["arguments"].as_str().map_or(0, js_len);
            messages.push(json!({ "role": "tool", "tool_call_id": call["id"], "content": content }));
        }
        if let Some(f) = &opts.on_progress {
            f(&Progress { round, tool_calls, tools: calls.iter().map(|c| c["function"]["name"].as_str().unwrap_or("").to_string()).collect() });
        }
        round += 1;
    }
    SubAgentResult {
        ok: false,
        report: if stopped_because == Some(StoppedBecause::Budget) { "The helper stopped: the spending limit for this reply was reached.".to_string() } else { "The helper was stopped before it could report.".to_string() },
        rounds,
        tool_calls,
        files_read,
        stopped_because,
    }
}

/// What the main agent reads back as the delegate tool result, and the one-line summary for its row in the chat.
pub fn format_sub_agent_result(r: &SubAgentResult) -> (String, String) {
    let plural = |n: usize| if n == 1 { "" } else { "s" };
    let files = r.files_read.len();
    let stats = format!("{} round{}, {} tool call{}{}", r.rounds, plural(r.rounds as usize), r.tool_calls, plural(r.tool_calls), if files > 0 { format!(", {files} file{} read", plural(files)) } else { String::new() });
    let note = match r.stopped_because {
        Some(StoppedBecause::Rounds) => " It hit its round limit, so the report may be incomplete.",
        Some(StoppedBecause::Context) => " It filled its context, so the report may be incomplete.",
        _ => "",
    };
    (format!("Helper report ({stats}).{note}\n\n{}", r.report), if r.ok { format!("Helper finished · {stats}") } else { format!("Helper did not finish · {stats}") })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::testkit::{cases, check, client, compact, expand, sha_marker, stub, sys0};
    use std::sync::Mutex;

    fn runner(text: &'static str) -> ToolRunner {
        Arc::new(move |_, _| ready(text.to_string()))
    }
    fn target(base: &str, extra: Map<String, Value>) -> Target {
        Target { base_url: base.to_string(), api_model: "helper-model".into(), headers: vec![("Authorization".into(), "Bearer k".into())], extra_body: extra }
    }
    fn tool_defs(names: &[&str]) -> Vec<Value> {
        names.iter().map(|n| json!({ "type": "function", "function": { "name": n } })).collect()
    }

    #[test]
    fn replays_the_pure_functions() {
        check("subagent.helperContextCap", |t| json!(helper_context_cap(t.as_u64().unwrap())));
        check("subagent.formatSubAgentResult", |r| {
            let (content, summary) = format_sub_agent_result(&serde_json::from_value(r.clone()).unwrap());
            json!({ "content": content, "summary": summary })
        });
        check("subagent.consts", |_| {
            let mut names: Vec<&str> = SUBAGENT_TOOLS.to_vec();
            names.sort();
            json!({ "tools": names, "delegate": delegate_tool() })
        });
    }

    #[test]
    fn delegate_arguments_and_progress_lines() {
        assert_eq!(parse_delegate_args(&json!({ "task": "  look  ", "max_rounds": 5 })), Ok(("look".to_string(), Some(5.0))));
        assert_eq!(parse_delegate_args(&json!({ "task": "  " })), Err(("Error: task is required — the helper's complete brief.".to_string(), "No task given".to_string())));
        assert_eq!(progress_text(&Progress { round: 2, tool_calls: 3, tools: vec!["read_file".into(), "read_file".into(), "search_files".into()] }), "round 2 · 3 tool calls · read_file, search_files");
        assert_eq!(progress_text(&Progress { round: 1, tool_calls: 1, tools: vec!["list_files".into()] }), "round 1 · 1 tool call · list_files");
    }

    /// The request the generator recorded, with the tool list as a hash of its names and (brief) only a message count.
    fn norm_req(body: &Value, brief: bool) -> Value {
        let mut out = if brief { body.clone() } else { sys0(body) };
        if brief {
            out["messages"] = json!({ "n": body["messages"].as_array().unwrap().len() });
        }
        match body["tools"].as_array() {
            Some(t) => out["tools"] = sha_marker(&t.iter().map(|t| t["function"]["name"].as_str().unwrap()).collect::<Vec<_>>().join(",")),
            None => {
                out.as_object_mut().unwrap().remove("tools");
            }
        }
        out
    }

    #[tokio::test]
    async fn replays_the_loop_against_a_stub() {
        let all_names: Vec<String> = cases("subagent.consts")[0].0["allNames"].as_array().unwrap().iter().map(|n| n.as_str().unwrap().to_string()).collect();
        let all_tools = tool_defs(&all_names.iter().map(String::as_str).collect::<Vec<_>>());
        for (i, (spec, want)) in cases("subagent.run").iter().enumerate() {
            let spec = expand(spec);
            let replies = spec["script"].as_array().unwrap().iter().map(|s| (s["status"].as_u64().unwrap() as u16, s["body"].to_string())).collect();
            let server = stub(replies);
            let seen = server.seen.clone();
            let usages = Arc::new(Mutex::new(Vec::<Value>::new()));
            let progress = Arc::new(Mutex::new(Vec::<Progress>::new()));
            let mut o = Options::new(spec["task"].as_str().unwrap().to_string(), target(&server.base, spec["extraBody"].as_object().cloned().unwrap_or_default()), all_tools.clone(), spec["available"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect(), Stop::new(), runner("unused"));
            o.tree = cases("subagent.consts")[0].0["tree"].as_str().unwrap().to_string();
            o.max_rounds = spec["maxRounds"].as_f64();
            o.context_cap_chars = spec["cap"].as_u64().map(|c| c as usize);
            o.retry_delays_ms = [5, 5];
            if let Some(n) = spec["stopAfter"].as_u64() {
                o.should_stop = Some(Arc::new(move || seen.lock().unwrap().len() as u64 >= n));
            }
            let u = usages.clone();
            o.on_usage = Some(Arc::new(move |v| u.lock().unwrap().push(v.clone())));
            let p = progress.clone();
            o.on_progress = Some(Arc::new(move |v| p.lock().unwrap().push(v.clone())));
            let result = run_sub_agent(&client(), o).await;
            let brief = spec["brief"].as_bool().unwrap_or(false);
            let requests: Vec<Value> = server.requests().iter().map(|r| norm_req(&r["body"], brief)).collect();
            let got = compact(&json!({ "result": result, "requests": requests, "usages": *usages.lock().unwrap(), "progress": *progress.lock().unwrap() }));
            assert_eq!(&got, want, "subagent.run case {i}: task {}", spec["task"]);
        }
    }

    #[tokio::test]
    async fn runs_allowed_tools_in_parallel_and_reports_what_it_read() {
        let call = |id: &str, name: &str, args: &str| json!({ "id": id, "type": "function", "function": { "name": name, "arguments": args } });
        let first = json!({ "choices": [{ "message": { "content": null, "tool_calls": [call("a", "read_file", "{\"path\":\"src/a.rs\"}"), call("b", "read_files", "{\"paths\":[\"x.rs\",\"src/a.rs\"]}"), call("c", "read_file", "{broken"), call("d", "write_file", "{}")] } }] });
        let last = json!({ "choices": [{ "message": { "content": "  Found it in src/a.rs:3  " } }], "usage": { "prompt_tokens": 9, "completion_tokens": 4 } });
        let server = stub(vec![(200, first.to_string()), (200, last.to_string())]);
        let ran = Arc::new(Mutex::new(Vec::<String>::new()));
        let log = ran.clone();
        let run_tool: ToolRunner = Arc::new(move |name, args| {
            log.lock().unwrap().push(format!("{name} {}", Value::Object(args)));
            ready(format!("RESULT {name}"))
        });
        let names = ["read_file", "read_files", "write_file"];
        let o = Options::new("find a".into(), target(&server.base, Map::new()), tool_defs(&names), names.iter().map(|s| s.to_string()).collect(), Stop::new(), run_tool);
        let r = run_sub_agent(&client(), o).await;
        assert_eq!((r.ok, r.report.as_str(), r.rounds, r.tool_calls, r.files_read.clone()), (true, "Found it in src/a.rs:3", 2, 4, vec!["src/a.rs".to_string(), "x.rs".to_string()]));
        assert_eq!(ran.lock().unwrap().len(), 2, "write_file is refused and the broken call never runs");
        let second = &server.seen.lock().unwrap()[1].body;
        let replies: Vec<&str> = second["messages"].as_array().unwrap().iter().filter(|m| m["role"] == "tool").map(|m| m["content"].as_str().unwrap()).collect();
        assert_eq!(replies[0], "RESULT read_file");
        assert!(replies[2].starts_with("Error: the arguments were not valid JSON ("), "{replies:?}");
        assert_eq!(replies[3], "Error: write_file is not available to a read-only helper. Use the read and search tools, and put anything that needs a change in your report.");
        let (content, summary) = format_sub_agent_result(&r);
        assert_eq!(summary, "Helper finished · 2 rounds, 4 tool calls, 2 files read");
        assert!(content.starts_with("Helper report (2 rounds, 4 tool calls, 2 files read).\n\nFound it"));
    }

    #[tokio::test]
    async fn a_stopped_signal_ends_the_helper_before_any_request() {
        let server = stub(vec![(200, "{}".into())]);
        let stop = Stop::new();
        stop.stop();
        let o = Options::new("t".into(), target(&server.base, Map::new()), vec![], HashSet::new(), stop, runner("x"));
        let r = run_sub_agent(&client(), o).await;
        assert_eq!((r.ok, r.stopped_because, r.report.as_str()), (false, Some(StoppedBecause::Stopped), "The helper was stopped before it could report."));
        assert!(server.seen.lock().unwrap().is_empty());
    }
}

//! The agent's tools. Schemas come from assets/tools.json (synced from the web
//! app); only tools with a handler here are offered to the model.

pub mod binary;
pub mod browser;
pub mod build;
pub mod code;
pub mod data;
pub mod documents;
pub mod exec;
pub mod files;
pub mod git;
pub mod github;
pub mod plan;
pub mod recall;
pub mod testing;
pub mod web;

use crate::agent::Emitter;
use crate::store::{Finding, Plan, Settings};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};

/// Plan and findings of the chat being worked on. The UI saves them with the chat.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChatState {
    pub plan: Option<Plan>,
    pub findings: Vec<Finding>,
    /// `finish` was already bounced once for open plan steps.
    pub finish_bounced: bool,
}

/// Everything a tool may touch.
pub struct Ctx {
    /// The chat's workspace folder. File tools cannot leave it.
    pub root: PathBuf,
    /// Undo history and other per-chat files kept out of the workspace.
    pub state_dir: PathBuf,
    pub settings: Settings,
    pub client: reqwest::Client,
    /// Character budget for one read, sized to the model's context window.
    pub read_chars: usize,
    /// The model's ceilings: files per call, characters per page, search hits. Wider for a custom model saved with open limits.
    pub limits: &'static crate::context::tool_limits::ToolLimits,
    /// The files this reply wrote, so reading one straight back is answered without a cut.
    pub memory: crate::context::run_memory::RunFileMemory,
    pub emit: Emitter,
    pub chat: Arc<Mutex<ChatState>>,
    pub procs: Arc<exec::Procs>,
    /// The cheap model that plans web searches, when there is one.
    pub planner: Option<crate::search::Planner>,
}

/// What a tool hands back.
#[derive(Debug, Default)]
pub struct Output {
    pub ok: bool,
    /// For the model.
    pub text: String,
    /// One line for the step row in the chat.
    pub summary: String,
    /// An image to show the user under the step.
    pub image: Option<PathBuf>,
    /// An image the model itself should look at (native vision only).
    pub look: Option<PathBuf>,
    /// A workspace file this call changed.
    pub changed: Option<String>,
    /// The run ends after this call.
    pub finish: bool,
}

impl Output {
    pub fn ok(text: impl Into<String>, summary: impl Into<String>) -> Output {
        Output { ok: true, text: text.into(), summary: summary.into(), ..Default::default() }
    }
    pub fn fail(text: impl Into<String>) -> Output {
        let text = text.into();
        Output { ok: false, summary: text.lines().next().unwrap_or("").chars().take(160).collect(), text, ..Default::default() }
    }
    pub fn changed(mut self, rel: &str) -> Output {
        self.changed = Some(rel.to_string());
        self
    }
}

pub fn str_arg<'a>(args: &'a Value, key: &str) -> &'a str {
    args[key].as_str().unwrap_or("")
}
pub fn bool_arg(args: &Value, key: &str) -> bool {
    args[key].as_bool().unwrap_or_else(|| args[key].as_str() == Some("true"))
}
/// Numbers sometimes arrive as strings or floats; accept both.
pub fn num_arg(args: &Value, key: &str) -> Option<u64> {
    let v = &args[key];
    v.as_u64().or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)).or_else(|| v.as_str()?.trim().parse().ok())
}
pub fn list_arg(args: &Value, key: &str) -> Vec<String> {
    args[key].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

/// Keeps the head and tail of long output: errors are usually at the end, the command at the start.
pub fn clip(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max / 4).collect();
    let tail_start = text.len() - (max * 3 / 4);
    let tail_start = (tail_start..text.len()).find(|&i| text.is_char_boundary(i)).unwrap_or(text.len());
    format!("{head}\n… [{} characters left out] …\n{}", text.len() - head.len() - (text.len() - tail_start), &text[tail_start..])
}

/// Tools with a handler in this build.
const IMPLEMENTED: &[&str] = &[
    "list_files", "read_file", "read_files", "write_file", "write_files", "edit_file", "edit_files", "replace_in_files",
    "search_files", "delete_file", "move_file", "undo_file", "run_command", "run_tests", "start_process", "read_process",
    "write_process", "stop_process", "list_processes", "wait_for_output", "fetch_url", "http_request", "download_file",
    "web_search", "make_plan", "update_plan", "ask_user", "finish", "note_finding", "view_image", "show_image", "browse", "inspect_page", "screenshot_window",
    "git_status", "git_diff", "git_log", "git_commit", "git_branch", "apply_patch", "verify_file", "read_symbol", "find_references",
    "analyze_log", "extract_archive", "query_data", "list_snapshots", "restore_snapshot", "search_conversation",
    "git_pull_base", "github_push", "github_create_pr", "github_pr_status", "read_document", "build_project", "inspect_binary", "note_binary",
];

static SCHEMAS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    let mut all: Vec<Value> = serde_json::from_str(include_str!("../../assets/tools.json")).expect("assets/tools.json is valid");
    all.retain(|t| IMPLEMENTED.contains(&t["function"]["name"].as_str().unwrap_or("")));
    // Without a browser on this computer `browse` is withheld, as the web app does.
    if !crate::browser::available() {
        all.retain(|t| t["function"]["name"] != "browse");
    }
    for t in &mut all {
        // Options this build cannot honour are removed, so the model never asks for them.
        if t["function"]["name"] == "start_process" {
            if let Some(props) = t["function"]["parameters"]["properties"].as_object_mut() {
                props.remove("hidden");
            }
        }
    }
    all
});

#[cfg(test)]
pub fn implemented(name: &str) -> bool {
    IMPLEMENTED.contains(&name)
}

/// The tool list for one request. A tool that cannot work is withheld rather than
/// offered: a model given one calls it, gets an error, and tries something worse.
/// `github` is None for a workspace with no connected repository, else whether a GitHub token is at hand.
pub fn definitions(web_search: bool, native_vision: bool, git_repo: bool, github: Option<bool>) -> Vec<Value> {
    SCHEMAS
        .iter()
        .filter(|t| match t["function"]["name"].as_str().unwrap_or("") {
            "web_search" => web_search,
            "view_image" => native_vision,
            "git_pull_base" => github.is_some(),
            // Push and pull requests need the token as well as the connection.
            n if n.starts_with("github_") => github == Some(true),
            n if n.starts_with("git_") => git_repo,
            _ => true,
        })
        .cloned()
        .collect()
}

/// A tool lent by an MCP server: every call asks first, unless commands run automatically.
async fn mcp_call(name: &str, args: &Value, ctx: &Ctx) -> Output {
    use crate::mcp;
    let result = match mcp::bridged(&crate::store::data_dir(), name, args) {
        None => mcp::unavailable(),
        Some(call) if ctx.settings.approval == crate::store::Approval::Auto || ctx.emit.approve_mcp(&call.display, &call.remember_key).await => mcp::call_bridged(&ctx.client, &call).await,
        Some(call) => mcp::declined(&call.display, "The user declined this call."),
    };
    Output { ok: result.ok, text: result.content, summary: result.summary, ..Default::default() }
}

pub async fn run(name: &str, args: &Value, ctx: &Ctx) -> Output {
    // File work is plain blocking I/O; tell the runtime so other tasks keep moving.
    let sync = |f: fn(&Ctx, &Value) -> Output| tokio::task::block_in_place(|| f(ctx, args));
    let at_root = |f: fn(&std::path::Path, &Value) -> Output| tokio::task::block_in_place(|| f(&ctx.root, args));
    if name.starts_with("mcp__") {
        return mcp_call(name, args, ctx).await;
    }
    // A command may rewrite, reformat or generate anything: after one the disk is the only truth.
    if matches!(name, "run_command" | "run_tests" | "start_process" | "build_project") {
        ctx.memory.invalidate_all();
    }
    match name {
        "list_files" => sync(files::list_files),
        "read_file" => sync(files::read_file),
        "read_files" => sync(files::read_files),
        "write_file" => sync(files::write_file),
        "write_files" => sync(files::write_files),
        "edit_file" => sync(files::edit_file),
        "edit_files" => sync(files::edit_files),
        "replace_in_files" => sync(files::replace_in_files),
        "search_files" => sync(files::search_files),
        "delete_file" => sync(files::delete_file),
        "move_file" => sync(files::move_file),
        "undo_file" => sync(files::undo_file),
        "apply_patch" => at_root(code::apply_patch),
        "verify_file" => at_root(code::verify_file),
        "read_symbol" => at_root(code::read_symbol),
        "find_references" => at_root(code::find_references),
        "analyze_log" => at_root(code::analyze_log),
        "extract_archive" => at_root(data::extract_archive),
        "read_document" => tokio::task::block_in_place(|| documents::read_document_limited(&ctx.root, args, ctx.limits.doc_chars as usize)),
        "query_data" => at_root(data::query_data),
        "list_snapshots" => at_root(recall::list_snapshots),
        "restore_snapshot" => at_root(recall::restore_snapshot),
        "search_conversation" => sync(search_conversation),
        "make_plan" => sync(plan::make_plan),
        "update_plan" => sync(plan::update_plan),
        "note_finding" => sync(plan::note_finding),
        "finish" => sync(plan::finish),
        "view_image" => sync(plan::view_image),
        "show_image" => sync(plan::show_image),
        "ask_user" => plan::ask_user(ctx, args).await,
        "run_command" => exec::run_command(ctx, args).await,
        "run_tests" => exec::run_tests(ctx, args).await,
        "build_project" => build::build_project(ctx, args).await,
        "inspect_binary" => binary::inspect_binary(&ctx.root, args).await,
        "note_binary" => at_root(binary::note_binary),
        "start_process" => exec::start_process(ctx, args).await,
        "read_process" => exec::read_process(ctx, args),
        "write_process" => exec::write_process(ctx, args).await,
        "stop_process" => exec::stop_process(ctx, args),
        "list_processes" => exec::read_process(ctx, &Value::Null),
        "wait_for_output" => exec::wait_for_output(ctx, args).await,
        "fetch_url" => web::fetch_url(ctx, args).await,
        "inspect_page" => browser::inspect_page(ctx, args).await,
        "browse" => browser::browse(ctx, args).await,
        "screenshot_window" => browser::screenshot_window(ctx, args).await,
        "http_request" => web::http_request(ctx, args).await,
        "download_file" => web::download_file(ctx, args).await,
        "web_search" => web::web_search(ctx, args).await,
        "git_pull_base" | "github_push" | "github_create_pr" | "github_pr_status" => github::run(ctx, name, args).await,
        n if n.starts_with("git_") => git::run(ctx, n, args).await,
        _ => Output::fail(format!("Unknown tool: {name}. Use one of the tools you were given.")),
    }
}

/// `search_conversation` reads the chat as stored, so turns folded out of the model's view are still found.
fn search_conversation(ctx: &Ctx, args: &Value) -> Output {
    let chat = crate::store::data_dir().join("chats").join(ctx.state_dir.file_name().unwrap_or_default()).join("chat.json");
    let Some(stored) = std::fs::read(chat).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()) else {
        return Output { ok: false, text: "Error: no conversation scope for this search.".into(), summary: "No conversation scope".into(), ..Default::default() };
    };
    let said: Vec<&Value> = stored["messages"].as_array().into_iter().flatten().filter(|m| matches!(m["role"].as_str(), Some("user" | "assistant"))).collect();
    fn name_and_note(a: &Value) -> (&str, &str) {
        (a["name"].as_str().unwrap_or(""), a["description"].as_str().unwrap_or(""))
    }
    let turns: Vec<crate::find::Turn> = said.iter().map(|m| crate::find::Turn { content: m["content"].as_str().unwrap_or(""), attachments: m["attachments"].as_array().into_iter().flatten().map(name_and_note).collect() }).collect();
    let roles: Vec<&str> = said.iter().map(|m| m["role"].as_str().unwrap_or("")).collect();
    recall::search_conversation(&ctx.root, args, &turns, &roles)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_implemented_tool_has_a_schema() {
        for name in IMPLEMENTED {
            assert!(SCHEMAS.iter().any(|t| t["function"]["name"] == *name), "{name} is missing from assets/tools.json");
        }
        assert!(definitions(false, false, false, None).iter().all(|t| t["function"]["name"] != "web_search"));
        // GitHub tools: none without a connected repository, the remote ones only with a token as well.
        let offered = |github| definitions(false, false, true, github).iter().filter_map(|t| t["function"]["name"].as_str().map(str::to_string)).filter(|n| n == "git_pull_base" || n.starts_with("github_")).collect::<Vec<_>>();
        assert!(offered(None).is_empty());
        assert_eq!(offered(Some(false)), ["git_pull_base"]);
        assert_eq!(offered(Some(true)).len(), 4);
        let start = SCHEMAS.iter().find(|t| t["function"]["name"] == "start_process").unwrap();
        assert!(start["function"]["parameters"]["properties"].get("hidden").is_none());
    }

    #[test]
    fn clip_keeps_both_ends() {
        let long = format!("START{}END", "x".repeat(10_000));
        let c = clip(&long, 1_000);
        assert!(c.starts_with("START") && c.ends_with("END") && c.len() < 1_200);
        assert_eq!(clip("short", 100), "short");
    }
}

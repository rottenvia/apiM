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
pub mod groups;
pub mod plan;
pub mod recall;
pub mod sandbox;
pub mod skills;
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
    /// The plugins on for this chat alone and for every chat, as this reply knows them (`skills` changes both).
    pub skills: Vec<String>,
    pub skills_all: Vec<String>,
    /// The tool groups this chat has loaded (`groups`).
    pub groups: Vec<String>,
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
    /// A web search this call ran: its sources, queries and cost, for the reply it belongs to.
    pub search: Option<crate::search::SearchOutcome>,
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
/// A line number. Lines count from 1, so 0 is a field filled in for the sake of filling it (GPT-6 Luna sends every
/// optional field, `"start_line":0,"end_line":0` among them, and its edits were "Lines 0-0 are out of range").
pub fn line_arg(args: &Value, key: &str) -> Option<u64> {
    num_arg(args, key).filter(|n| *n > 0)
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
    "git_pull_base", "github_push", "github_create_pr", "github_pr_status", "read_document", "build_project", "inspect_binary", "note_binary", "sandbox_run", "sandbox_screenshot",
];

static SCHEMAS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    let mut all: Vec<Value> = serde_json::from_str(include_str!("../../assets/tools.json")).expect("assets/tools.json is valid");
    all.retain(|t| IMPLEMENTED.contains(&t["function"]["name"].as_str().unwrap_or("")));
    // Without a browser on this computer `browse` is withheld, as the web app does.
    if !crate::browser::available() {
        all.retain(|t| t["function"]["name"] != "browse");
    }
    for t in &mut all {
        // What this build does beyond the web's wording: it runs on the user's own computer and can look at all of it.
        let more = match t["function"]["name"].as_str().unwrap_or("") {
            "list_files" | "read_file" | "read_files" => " A path written in full (C:\\..., ~/..., %LOCALAPPDATA%\\...) reaches anywhere on the user's computer, to look only; list_files then shows that one folder, newest files first.",
            "delete_file" => " A folder inside the workspace is deleted with everything in it.",
            // Asked for in the tool's wording to be in both, it was: the closing answer said how it was checked twice.
            "finish" => " `result` and `verified` are shown to the user one after the other: how the work was checked goes into `verified` only.",
            // It reads what was said, not what tools answered: a reply looked here for a command's output and lost five rounds on it.
            "search_conversation" => " It searches what you and the user wrote, never the results of tools: a command's output is in the file its result named.",
            "run_command" if cfg!(windows) => " For questions about the computer itself there are the system's own looking tools (tasklist, systeminfo, wevtutil qe, reg query, sc query) and PowerShell, given as one string: {\"command\":\"powershell\",\"args\":[\"Get-WinEvent -LogName Application -MaxEvents 20 | Format-List TimeCreated,ProviderName,Message\"]}.",
            "run_command" => " For questions about the computer itself there are the system's own looking tools (ps, uname, df, free, uptime).",
            _ => "",
        };
        // Said of every system: a reply that did not know this ran its long programs a second time to get a file.
        let kept = if t["function"]["name"] == "run_command" { " A long output is shown with its middle cut, and ALL of it is kept in a file that the result names in its first line (.outputs/...), as is any output you may need again after it has left your context: never redirect a program's output to a file yourself, and never run a program again to see what it printed. Take what you need from the file: search_files with it as path, read_file with start_line and end_line, or a script that reads it. A long one read whole only fills your context." } else { "" };
        let folded = if t["function"]["name"] == "list_files" { " A tree of more than a few hundred files is listed by its folders, each with the files in it and below it: pass a folder as path to see inside it." } else { "" };
        let more = format!("{more}{kept}{folded}");
        if !more.is_empty() {
            t["function"]["description"] = Value::String(format!("{}{more}", t["function"]["description"].as_str().unwrap_or("")));
        }
        // Options this build cannot honour are removed, so the model never asks for them.
        if t["function"]["name"] == "start_process" {
            if let Some(props) = t["function"]["parameters"]["properties"].as_object_mut() {
                props.remove("hidden");
            }
        }
    }
    all
});

/// A tool context for tests. Nobody listens for approval cards, so every one of them is declined.
#[cfg(test)]
pub fn test_ctx(root: &std::path::Path, approval: crate::store::Approval) -> Ctx {
    let (tx, _) = std::sync::mpsc::channel();
    Ctx {
        root: root.to_path_buf(),
        state_dir: root.to_path_buf(),
        settings: Settings { approval, ..Settings::default() },
        client: reqwest::Client::builder().no_proxy().build().unwrap(),
        read_chars: 20_000,
        emit: Emitter::new(tx, || {}),
        chat: Arc::new(Mutex::new(ChatState::default())),
        procs: Arc::new(exec::Procs::default()),
        planner: None,
        limits: crate::context::tool_limits::tool_limits_for(false),
        memory: Default::default(),
    }
}

/// An empty folder of its own for one test.
#[cfg(test)]
pub fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("apim-tools-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// One tool's definition as the model is sent it.
pub fn schema(name: &str) -> Option<&'static Value> {
    SCHEMAS.iter().find(|t| t["function"]["name"] == name)
}

/// A call's arguments, read. GLM writes a call as `<arg_key>name</arg_key><arg_value>value</arg_value>` pairs, and some
/// endpoints turn that into JSON badly when a list comes before a text: the rest of the call arrives inside one value
/// (`"args": "[\"-\"]<arg_key>command</arg_key><arg_value>python"`), or loose in the JSON, which then does not parse.
/// Both are put back, and only for names that are arguments of the tool: a file's own text may hold the same markup.
/// A call whose name carries the model's own markup after it (`read_files</arg_key>paths</arg_key><arg_value>["a"]`,
/// met on a free coding model: "Unknown tool", and the round was lost). The name is the part before the markup and
/// the rest is its arguments, taken only for names the tool has. None when the name is a tool's as it stands.
pub fn marked_name(name: &str) -> Option<(String, String)> {
    let (base, rest) = name.split_once('<')?;
    let tool = schema(base.trim())?;
    // The opening `<arg_key>` is what the name swallowed.
    let rest = format!("<{rest}");
    let rest = rest.strip_prefix("</arg_key>").map(|r| format!("<arg_key>{r}")).unwrap_or(rest);
    let mut args = serde_json::Map::new();
    for part in rest.split("<arg_key>").skip(1) {
        let Some((key, value)) = part.split_once("</arg_key><arg_value>") else { continue };
        let value = value.split("</arg_value>").next().unwrap_or(value).trim();
        if !tool["function"]["parameters"]["properties"][key.trim()].is_null() {
            args.insert(key.trim().to_string(), serde_json::from_str(value).unwrap_or_else(|_| Value::from(value)));
        }
    }
    Some((base.trim().to_string(), Value::Object(args).to_string()))
}

pub fn parse_call(name: &str, raw: &str) -> Result<Value, serde_json::Error> {
    const KEY: &str = "<arg_key>";
    const VALUE: &str = "</arg_key><arg_value>";
    let parsed = serde_json::from_str::<Value>(raw).or_else(|e| {
        static LOOSE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r#"<arg_key>(\w+)</arg_key><arg_value>([^,"}<]*)(?:</arg_value>)?"#).unwrap());
        if !raw.contains(KEY) {
            return Err(e);
        }
        serde_json::from_str(&LOOSE.replace_all(raw, |c: &regex::Captures| format!(", {}: {}", Value::from(&c[1]), Value::from(c[2].trim()))))
    })?;
    let kind = |arg: &str| schema(name).and_then(|t| t["function"]["parameters"]["properties"][arg]["type"].as_str());
    let read = |arg: &str, text: &str| Some(text).filter(|_| kind(arg) != Some("string")).and_then(|t| serde_json::from_str(t).ok()).unwrap_or_else(|| Value::from(text));
    let Value::Object(map) = parsed else { return Ok(parsed) };
    let mut out = serde_json::Map::new();
    for (key, value) in map {
        let text = match &value {
            Value::String(s) => Some(s.as_str()),
            Value::Array(a) if a.len() == 1 => a[0].as_str(),
            _ => None,
        };
        let parts: Vec<&str> = text.filter(|t| t.contains(KEY)).map(|t| t.split(KEY).collect()).unwrap_or_default();
        let pairs: Vec<(&str, &str)> = parts.iter().skip(1).filter_map(|p| p.split_once(VALUE)).filter(|(arg, _)| kind(arg).is_some()).collect();
        if pairs.is_empty() || pairs.len() + 1 != parts.len() {
            // A list or an object sent as its own JSON text (`"files": "[{...}]"`) is read as what it is.
            let unwrapped = match (kind(&key), &value) {
                (Some("array"), Value::String(text)) => serde_json::from_str::<Value>(text).ok().filter(Value::is_array),
                (Some("object"), Value::String(text)) => serde_json::from_str::<Value>(text).ok().filter(Value::is_object),
                _ => None,
            };
            out.insert(key, unwrapped.unwrap_or(value));
            continue;
        }
        out.insert(key.clone(), read(&key, parts[0]));
        for (arg, text) in pairs {
            out.insert(arg.to_string(), read(arg, text.trim_end_matches("</arg_value>")));
        }
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
#[test]
fn a_tool_name_with_markup_after_it_is_the_name_and_its_arguments() {
    let (name, args) = marked_name(r#"read_files</arg_key>paths</arg_key><arg_value>["shop/utils.py", "tests/test_shop.py"]"#).unwrap();
    assert_eq!((name.as_str(), serde_json::from_str::<Value>(&args).unwrap()), ("read_files", serde_json::json!({ "paths": ["shop/utils.py", "tests/test_shop.py"] })));
    let (name, args) = marked_name("read_file<arg_key>path</arg_key><arg_value>a.py</arg_value><arg_key>nonsense</arg_key><arg_value>1</arg_value>").unwrap();
    assert_eq!((name.as_str(), serde_json::from_str::<Value>(&args).unwrap()), ("read_file", serde_json::json!({ "path": "a.py" })));
    assert_eq!(marked_name("read_file"), None);
    assert_eq!(marked_name("no_such_tool<arg_key>x</arg_key><arg_value>1"), None);
}

#[test]
fn a_call_with_the_models_markup_in_it_is_put_back() {
    let whole = serde_json::json!({ "args": ["-"], "command": "python3", "stdin": "print(1)\nprint(2)" });
    for broken in [
        r#"{"args": "[\"-\"]<arg_key>command</arg_key><arg_value>python3", "stdin": "print(1)\nprint(2)"}"#,
        r#"{"args": ["[\"-\"]<arg_key>command</arg_key><arg_value>python3"], "stdin": "print(1)\nprint(2)"}"#,
        r#"{"args": ["-"]<arg_key>command</arg_key><arg_value>python3, "stdin": "print(1)\nprint(2)"}"#,
    ] {
        assert_eq!(parse_call("run_command", broken).unwrap(), whole, "{broken}");
    }
    // A file about the markup keeps it, and a call that is whole is not touched.
    let file = r#"{"path": "a.md", "content": "x<arg_key>command</arg_key><arg_value>y"}"#;
    assert_eq!(parse_call("write_file", file).unwrap(), serde_json::from_str::<Value>(file).unwrap());
    assert!(parse_call("run_command", "{\"args\": [").is_err());
    // A list sent as text is a list; a text argument that looks like a list stays text.
    assert_eq!(parse_call("run_command", r#"{"command": "python", "args": "[\"a.py\", \"-v\"]", "stdin": "[1]"}"#).unwrap(), serde_json::json!({ "command": "python", "args": ["a.py", "-v"], "stdin": "[1]" }));
}

#[cfg(test)]
pub fn implemented(name: &str) -> bool {
    IMPLEMENTED.contains(&name)
}

/// The tool list for one request. A tool that cannot work is withheld rather than
/// offered: a model given one calls it, gets an error, and tries something worse.
/// `github` is None for a workspace with no connected repository, else whether a GitHub token is at hand.
pub fn add_model_schema() -> Value {
    serde_json::json!({ "type": "function", "function": {
        "name": "add_model",
        "description": "Adds a model to the user's model list in this app, so they can pick it in the model menu: an OpenRouter model (an openrouter.ai link, or an id author/model-name, optionally with :free), or a Claude model on the user's own Anthropic key (Anthropic's id, such as claude-sonnet-5-5; the user names it in words, you give the id). Call it when the user asks to add, install or try a model. The app checks the id with OpenRouter or Anthropic and takes the context window, prices and abilities from there; an unknown Claude id comes back with the ids the key has. This conversation stays on its current model.",
        "parameters": {
            "type": "object",
            "properties": {
                "model": { "type": "string", "description": "The model's openrouter.ai link or id (author/model-name), or a Claude model id (claude-...)." },
                "name": { "type": "string", "description": "A display name, if the user asked for one. Default: the provider's name for the model." }
            },
            "required": ["model"]
        }
    } })
}

/// `add_model`: checks the id with OpenRouter or Anthropic and hands the app the entry for its list (`Event::ModelAdded`).
async fn add_model(ctx: &Ctx, args: &Value) -> Output {
    let asked = args["model"].as_str().unwrap_or("");
    let slug = crate::provider::slug_from_link(asked);
    if let Some(have) = crate::models::all(&[]).into_iter().find(|m| m.api_model == slug) {
        return Output::ok(format!("{} is already in the model list, as one of the app's own models. Nothing was added.", have.label), format!("{} is already there", have.label));
    }
    let found = match crate::provider::verify_model(asked, &ctx.settings.openrouter(), &ctx.settings.anthropic()).await {
        Ok(found) => found,
        Err(why) => return Output::fail(why),
    };
    let old = ctx.settings.custom_models.iter().find(|c| c.api_model == found.id.trim());
    let Some(model) = found.custom(args["name"].as_str().unwrap_or(""), old) else { return Output::fail(format!("{}'s id \"{}\" cannot be used as a model id here.", found.provider.name(), found.id)) };
    ctx.emit.send(crate::agent::Event::ModelAdded(model.clone()));
    let claude = found.provider == crate::models::ProviderId::Anthropic;
    let price = match (found.input_price, found.output_price) {
        (Some(i), Some(o)) if i == 0.0 && o == 0.0 => "free".to_string(),
        (Some(i), Some(o)) if claude => format!("${i} in and ${o} out per million tokens, billed by Anthropic on the user's key"),
        (Some(i), Some(o)) => format!("${i} in and ${o} out per million tokens at list price; the app picks the cheapest fast endpoint when it is first used"),
        _ => "price not listed".to_string(),
    };
    let window = found.context_length.map_or("window not listed".to_string(), |n| format!("{n} tokens of context"));
    let tools = if found.supports_tools { "" } else { " OpenRouter lists no tool support for it: it can chat here, and its tool calls will be refused." };
    let verb = if old.is_some() { "Updated" } else { "Added" };
    Output::ok(format!("{verb} {} ({}) in the model list: {window}, {price}.{tools} The user picks it in the model menu or with /model. This conversation stays on its current model.", model.label, model.api_model), format!("{verb} {}", model.label))
}

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
    // The stand-in the app leaves for an old call's long arguments, sent back as a new call's arguments (Qwen 3.8
    // Flash copied one; the answer then was "No command was given", which said nothing about what was wrong).
    if args.get("_note").is_some() && args.get("_head").is_some() {
        return Output::fail("These are not arguments. `_note` and `_head` are what the app leaves in place of an old call's long arguments once it has run. Send this call's own arguments, in full.");
    }
    // A command may rewrite, reformat or generate anything: after one the disk is the only truth.
    if matches!(name, "run_command" | "run_tests" | "start_process" | "build_project") {
        ctx.memory.invalidate_all();
    }
    if matches!(name, "list_files" | "read_file" | "read_files") {
        if let Err(why) = files::may_look(ctx, args).await {
            return Output::fail(why);
        }
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
        "sandbox_run" => sandbox::sandbox_run(ctx, args).await,
        "sandbox_screenshot" => sandbox::sandbox_screenshot(ctx, args).await,
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
        "skills" => skills::run(ctx, args).await,
        "add_model" => add_model(ctx, args).await,
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

//! The agent's tools. Schemas come from assets/tools.json (synced from the web
//! app); only tools with a handler here are offered to the model.

pub mod binary;
pub mod browser;
pub mod build;
pub mod clock;
pub mod code;
pub mod computer;
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
pub mod video;
pub mod web;
pub mod winproc;

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
    /// The tools earlier replies in this chat ran. A closing summary of work an earlier reply did was marked as
    /// invented: only this reply's tools were counted, and the model wrote correction notes instead of finishing.
    pub tools_run: Vec<String>,
    /// The countdowns and stopwatches the model set for the user (`clock::timer`).
    pub timers: Vec<clock::Timer>,
    /// When the question was sent and when the user's message before it was, and when the answer to that one
    /// ended, in ms since the epoch (0: unknown). Timers count from the first; the note says the gaps.
    pub asked_at: u64,
    pub previous_at: u64,
    pub answered_at: u64,
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
    /// What the user has said while this reply runs, waiting for the next round to read it. A tool that waits a long
    /// while (`wait_for_output`) gives up as soon as something is here, so a question is answered in a moment rather
    /// than when the program it watches finally closes.
    pub notes: Arc<Mutex<Vec<String>>>,
}

impl Ctx {
    /// The user said something while this reply runs and the next round has not read it yet.
    pub fn spoken_to(&self) -> bool {
        !self.notes.lock().unwrap().is_empty()
    }
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
        // Cut short, it says so: the step showed "…pass the whole scr" as if that were all.
        let first = text.lines().next().unwrap_or("");
        let summary = match first.char_indices().nth(160) {
            Some((at, _)) => format!("{}…", first[..at].trim_end()),
            None => first.to_string(),
        };
        Output { ok: false, summary, text, ..Default::default() }
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
    "analyze_log", "extract_archive", "query_data", "list_snapshots", "restore_snapshot", "search_conversation", "read_chat",
    "git_pull_base", "github_push", "github_create_pr", "github_pr_status", "read_document", "build_project", "inspect_binary", "note_binary", "sandbox_run", "sandbox_screenshot",
    "timer",
];

/// `read_chat` is this app's own, not in the web's tools.json, so its schema is built here (like the winproc tools).
/// It lets a reading model pull a whole past chat in one of two methods; the description is the one place the model is
/// told that a long duration in the Trace view is an external wait, not a stall — the misread this tool exists to end.
fn read_chat_schema() -> Value {
    serde_json::json!({ "type": "function", "function": {
        "name": "read_chat",
        "description": "Read a past chat from this app so you understand exactly what happened in it, in one of two methods you pick with `mode`. `read`: the chat as prose — every message, the model's thinking, and each tool step shown inline in the order it ran. `trace`: the tool timeline only, with the wall-clock time each call took, one after another. Use `trace` when timing matters: in it a LONG duration is time the app spent WAITING on something outside the model — a command finishing, a process that had already closed and answered late, a slow network read, a window being captured — NOT the model stalling, looping, or an error. A tool row is a failure only when it is marked FAIL. Read the same chat again in the other method whenever you want the other view. By default this reads the current chat; pass `chat` to read a different one.",
        "parameters": { "type": "object", "properties": {
            "mode": { "type": "string", "enum": ["read", "trace"], "description": "`read` for the chat as prose with its steps inline (the default), `trace` for the tool timeline with each call's duration." },
            "chat": { "type": "string", "description": "A chat title (full or part) or its id. Omit to read the current chat." }
        }, "required": [] }
    }})
}

static SCHEMAS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    let mut all: Vec<Value> = serde_json::from_str(include_str!("../../assets/tools.json")).expect("assets/tools.json is valid");
    all.extend(winproc::schemas());
    all.push(read_chat_schema());
    all.push(clock::schema());
    all.extend(computer::schemas());
    all.extend(video::schemas());
    all.retain(|t| implemented(t["function"]["name"].as_str().unwrap_or("")));
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
            // Told only that PowerShell answers questions about the computer, a reply ran forty commands one per call that one script does in five.
            "run_command" if cfg!(windows) => " PowerShell is the shell here, given the whole script as one string: {\"command\":\"powershell\",\"args\":[\"python gen.py; python check.py | Select-Object -Last 20\"]}. Pipes, `;`, redirects, loops and variables work in it, so steps that go together (build, run, read what came out) take one call, not one each. It also asks the computer itself, as do the system's own looking tools (tasklist, systeminfo, wevtutil qe, reg query, sc query): Get-WinEvent -LogName Application -MaxEvents 20 | Format-List TimeCreated,ProviderName,Message.",
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
        // Waiting on a program the agent did not start: a game opened by its launcher, which `id` cannot name.
        if t["function"]["name"] == "wait_for_output" {
            let f = &mut t["function"];
            f["parameters"]["properties"]["process"] = serde_json::json!({ "type": "string", "description": "A program's name (RobloxStudioBeta, notepad) or pid: the wait also ends the moment it closes, its window or its process, whichever goes first. Without `id`, that is all it waits for. Use it for a program a launcher, Start-Process or computer_act opened, rather than Start-Process -Wait (which also waits for every helper the program left behind) or a script that polls." });
            f["parameters"]["required"] = serde_json::json!([]);
            f["description"] = Value::String(format!("{} With `process` it also watches a program you did not start here, and returns as soon as it closes. It also comes back the moment the user says something while you wait, so a long wait never leaves them unanswered: answer them, then call it again to go on waiting.", f["description"].as_str().unwrap_or("")));
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
        notes: Default::default(),
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
                (Some("array"), Value::String(text)) => inner_json(text).filter(Value::is_array),
                (Some("object"), Value::String(text)) => inner_json(text).filter(Value::is_object),
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

/// JSON sent as the text of an argument. A model that wraps a list in a string often leaves the line breaks of a file's
/// text in it raw, which JSON does not allow inside a string (Claude Haiku 5.5, `write_files`: the round was lost, twice
/// in one task): inside strings, they are escaped and the text read again.
fn inner_json(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok().or_else(|| {
        let (mut fixed, mut in_string, mut escaped) = (String::with_capacity(text.len() + 64), false, false);
        for c in text.chars() {
            match c {
                '\n' if in_string => fixed.push_str("\\n"),
                '\r' if in_string => fixed.push_str("\\r"),
                '\t' if in_string => fixed.push_str("\\t"),
                _ => {
                    fixed.push(c);
                    if c == '"' && !escaped {
                        in_string = !in_string;
                    }
                    escaped = in_string && !escaped && c == '\\';
                    continue;
                }
            }
            escaped = false;
        }
        serde_json::from_str(&fixed).ok()
    })
}

#[cfg(test)]
#[test]
fn a_list_sent_as_text_with_raw_line_breaks_is_read() {
    let raw = "{\"files\": \"[{\\\"path\\\": \\\"a.md\\\", \\\"content\\\": \\\"# A\\n\\n\\tsay \\\\\\\"hi\\\\\\\"\\n\\\"}]\"}";
    assert_eq!(parse_call("write_files", raw).unwrap(), serde_json::json!({ "files": [{ "path": "a.md", "content": "# A\n\n\tsay \"hi\"\n" }] }));
    // Line breaks between the items are JSON's own, and stay.
    assert_eq!(inner_json("[\n  1,\n  2\n]"), Some(serde_json::json!([1, 2])));
    assert_eq!(inner_json("[\"a\\\\\", \"b\nc\"]"), Some(serde_json::json!(["a\\", "b\nc"])));
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

pub fn implemented(name: &str) -> bool {
    IMPLEMENTED.contains(&name) || winproc::NAMES.contains(&name) || computer::NAMES.contains(&name) || video::NAMES.contains(&name)
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

/// `computer`: the Computer toggle is on. Its tools need a model that sees the screenshots they send back.
pub fn definitions(web_search: bool, native_vision: bool, git_repo: bool, github: Option<bool>, computer: bool) -> Vec<Value> {
    SCHEMAS
        .iter()
        .filter(|t| match t["function"]["name"].as_str().unwrap_or("") {
            "web_search" => web_search,
            "view_image" => native_vision,
            // The two that are only pictures; the overview, the scenes and the transcript are text as well, and serve any model.
            "video_look" | "video_frame" => native_vision,
            "git_pull_base" => github.is_some(),
            // Push and pull requests need the token as well as the connection.
            n if n.starts_with("github_") => github == Some(true),
            n if winproc::NAMES.contains(&n) => cfg!(windows),
            n if computer::NAMES.contains(&n) => computer && native_vision && cfg!(windows),
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
    // Cut like a file read: an outside tool's answer went in whole, however long, and filled the context in one round.
    Output { ok: result.ok, text: clip(&result.content, ctx.read_chars), summary: result.summary, ..Default::default() }
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
        "read_chat" => sync(read_chat),
        "make_plan" => sync(plan::make_plan),
        "update_plan" => sync(plan::update_plan),
        "note_finding" => sync(plan::note_finding),
        "finish" => sync(plan::finish),
        "timer" => sync(clock::timer),
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
        "computer_look" => computer::look(ctx, args).await,
        "computer_act" => computer::act(ctx, args).await,
        n if video::NAMES.contains(&n) => video::run(n, ctx, args).await,
        "http_request" => web::http_request(ctx, args).await,
        "download_file" => web::download_file(ctx, args).await,
        "web_search" => web::web_search(ctx, args).await,
        "skills" => skills::run(ctx, args).await,
        "add_model" => add_model(ctx, args).await,
        "git_pull_base" | "github_push" | "github_create_pr" | "github_pr_status" => github::run(ctx, name, args).await,
        n if n.starts_with("git_") => git::run(ctx, n, args).await,
        n if winproc::NAMES.contains(&n) => {
            // Changing a process the app did not start is a critical action: it asks first in every mode but "Run automatically".
            if let Some(what) = winproc::changes_a_process(n).filter(|_| ctx.settings.approval.asks_critical()) {
                let target = args["pid"].as_u64().map(|p| format!(" (pid {p})")).or_else(|| args.get("tids").or_else(|| args.get("tid")).map(|t| format!(" ({t})"))).unwrap_or_default();
                if !ctx.emit.approve_keyed(&format!("{n}: {what}{target}"), "This changes a running process the app did not start.", &format!("winproc_change:{n}{target}")).await {
                    return Output::fail(format!("The user did not allow {n}."));
                }
            }
            winproc::run(n, args)
        }
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

/// `read_chat` loads a whole chat and renders it in the chosen method. Default target is the current chat, found by the
/// folder its state lives in; otherwise a title (full or part) or an id. The two methods are `read` and `trace` (see `export`).
fn read_chat(ctx: &Ctx, args: &Value) -> Output {
    let mode = if str_arg(args, "mode") == "trace" { "trace" } else { "read" };
    let target = str_arg(args, "chat").trim();
    let metas = crate::store::Conversation::list();
    let found = if target.is_empty() {
        let slug = ctx.state_dir.file_name().and_then(|s| s.to_str()).unwrap_or("");
        metas.iter().find(|m| m.slug == slug)
    } else {
        let lower = target.to_lowercase();
        metas.iter().find(|m| m.id == target).or_else(|| metas.iter().find(|m| m.title.eq_ignore_ascii_case(target))).or_else(|| metas.iter().find(|m| m.title.to_lowercase().contains(&lower)))
    };
    let Some(meta) = found else {
        return Output::fail(if target.is_empty() { "No current chat to read.".to_string() } else { format!("No chat matches \"{target}\". Pass a chat title or id, or omit it for the current chat.") });
    };
    let Some(conv) = crate::store::Conversation::load(&meta.id) else {
        return Output::fail(format!("Could not read the chat \"{}\".", meta.title));
    };
    let text = crate::export::render(&conv, mode);
    Output::ok(text, format!("Read \"{}\" in {mode} ({} messages)", conv.title, conv.messages.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wording in assets/tools.json that is this build's own: `sync-from-web.mts` writes the web's back over it. The web
    /// asks before every command and has no PowerShell; told the same here, a model priced every look as an approval it never got.
    #[test]
    fn the_desktop_wording_of_commands_survives_a_sync() {
        let said = |name: &str| SCHEMAS.iter().find(|t| t["function"]["name"] == name).unwrap()["function"].to_string();
        let run = said("run_command");
        assert!(run.contains("Whether the user is asked first is said in the system prompt") && !run.contains("has to approve") && run.contains("Capped at 10 minutes"), "{run}");
        assert!(cfg!(not(windows)) || run.contains("PowerShell is the shell here"), "{run}");
        assert!(said("wait_for_output").contains("max 600000"));
    }

    #[test]
    fn every_implemented_tool_has_a_schema() {
        for name in IMPLEMENTED {
            assert!(SCHEMAS.iter().any(|t| t["function"]["name"] == *name), "{name} is missing from assets/tools.json");
        }
        assert!(definitions(false, false, false, None, false).iter().all(|t| t["function"]["name"] != "web_search"));
        // The Computer toggle: off, or a model that cannot see the screenshots, and the tools are not offered.
        let computer = |on, vision| definitions(false, vision, false, None, on).iter().filter(|t| t["function"]["name"].as_str().is_some_and(|n| n.starts_with("computer_"))).count();
        assert_eq!((computer(false, true), computer(true, false), computer(true, true)), (0, 0, if cfg!(windows) { 2 } else { 0 }));
        // GitHub tools: none without a connected repository, the remote ones only with a token as well.
        let offered = |github| definitions(false, false, true, github, false).iter().filter_map(|t| t["function"]["name"].as_str().map(str::to_string)).filter(|n| n == "git_pull_base" || n.starts_with("github_")).collect::<Vec<_>>();
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

//! Tools on demand. Every request used to carry all sixty tool descriptions: 57,000 characters, some
//! 14,000 tokens, sent again on every round, so a "hi" cost 15,760 tokens to answer in 52. Now a request
//! carries the everyday tools, and the rest come in groups that the model loads when a task calls for one
//! (`load_tools`). A group, once loaded, stays for the chat, and is added after everything already sent,
//! so the start of the request does not change from round to round.

use super::{Output, video, winproc};
use serde_json::{Value, json};

pub struct Group {
    pub name: &'static str,
    /// What it is for, in the loader's list.
    pub what: &'static str,
    pub tools: &'static [&'static str],
    /// Words in a message that call for it: such a group is loaded before the model has to ask.
    hints: &'static [&'static str],
}

/// Every tool not named here is an everyday one and always sent (as is any tool an MCP server lends).
pub const GROUPS: &[Group] = &[
    Group {
        name: "files",
        what: "more file work: several files in one call, rename, delete, undo, patches",
        tools: &["write_files", "edit_files", "replace_in_files", "move_file", "delete_file", "undo_file", "apply_patch"],
        hints: &["rename", "move the", "delete the", "remove the file", "undo", "revert", "refactor", "scaffold", "patch", "replace all", "everywhere"],
    },
    Group {
        name: "code",
        what: "code navigation and builds: a symbol's definition, every use of a name, a syntax check, log analysis, test and build runners",
        tools: &["read_symbol", "find_references", "verify_file", "analyze_log", "build_project"],
        hints: &["compile", "cmake", "cargo", "gradle", "msbuild", "stack trace", "the log", "references to"],
    },
    // Its own group: "tests" in a request used to load all of code navigation with it, 6.9K characters of tools a
    // round for a plain pytest task (2026-10-28).
    Group {
        name: "tests",
        what: "the project's test suite: run it and get the failures back with why they failed",
        tools: &["run_tests"],
        hints: &["tests", "unit test", "pytest", "jest", "vitest", "test suite", "cargo test"],
    },
    Group {
        name: "processes",
        what: "programs that keep running: start one, read and wait for its output, send it input, stop it",
        tools: &["start_process", "read_process", "write_process", "stop_process", "list_processes", "wait_for_output"],
        hints: &["server", "localhost", "watcher", "keeps running", "keep running", "in the background", "port ", "daemon"],
    },
    Group {
        name: "web",
        what: "more of the live web: call an API, download a file, look at a page's structure, drive a browser",
        // fetch_url is an everyday tool: reading the source a search found is the step after every search, and a model
        // that had to load a group for it first answered from the search's extracts or from memory instead.
        tools: &["http_request", "download_file", "inspect_page", "browse"],
        hints: &["http://", "https://", "www.", " url", "website", "web page", "webpage", "scrape", "download", " api", "endpoint", "browser"],
    },
    Group {
        name: "pictures",
        what: "pictures: show the user an image from the workspace, look at one yourself, capture a window on their screen",
        tools: &["show_image", "view_image", "screenshot_window"],
        hints: &["image", "picture", "screenshot", "photo", ".png", ".jpg", "show me"],
    },
    Group {
        name: "video",
        what: "watching a video file or URL by navigating it: an overview with a contact sheet, a stretch, one frame in detail, scene changes, the transcript",
        tools: video::NAMES,
        hints: &["video", ".mp4", ".mkv", ".webm", ".mov", "youtube", "youtu.be", "footage"],
    },
    Group {
        name: "git",
        what: "version control: status, diff, log, commit, branch, and GitHub pushes and pull requests when connected",
        tools: &["git_status", "git_diff", "git_log", "git_commit", "git_branch", "git_pull_base", "github_push", "github_create_pr", "github_pr_status"],
        hints: &["git", "commit", "branch", "pull request", "merge"],
    },
    Group {
        name: "sandbox",
        what: "the Linux sandbox: run programs that open windows, away from the user's desktop, and capture what they show",
        tools: &["sandbox_run", "sandbox_screenshot"],
        hints: &["sandbox", "gui", "tkinter", "pygame", "desktop app", "linux", "screenshot"],
    },
    Group {
        name: "data",
        what: "documents and data: PDF, Word and Excel files, archives, queries over CSV, JSON and SQLite",
        tools: &["read_document", "extract_archive", "query_data"],
        hints: &[".pdf", ".docx", ".xlsx", ".pptx", ".csv", ".zip", ".7z", ".rar", ".tar", "sqlite", "spreadsheet", "archive", "unzip"],
    },
    Group {
        name: "memory",
        what: "memory: record a finding for later turns, search what was said earlier in this chat, read a whole chat as prose or as a timed tool trace, list and restore snapshots of the workspace",
        tools: &["note_finding", "search_conversation", "read_chat", "list_snapshots", "restore_snapshot"],
        hints: &["remember", "earlier you", "snapshot", "restore", "previous version", "last time", "read the chat", "read my chat", "trace the chat", "tool timing", "how long each", "read this chat"],
    },
    Group {
        name: "binary",
        what: "compiled programs: inspect an EXE, DLL or other binary and keep notes on it",
        tools: &["inspect_binary", "note_binary"],
        hints: &[".exe", ".dll", "a binary", "decompile", "disassembl", "reverse engineer", "malware", "deobfuscat"],
    },
    Group {
        name: "winproc",
        what: "Windows processes you did not start: list them with thread wait reasons, open and probe rights, suspend and resume threads, read and set registers, read, write, query, protect, allocate and free memory, list modules",
        tools: winproc::NAMES,
        hints: &["attach", "suspend", "thread context", "process memory", "debugger", "inject", "virtualalloc", "ntreadvirtualmemory", " pid "],
    },
    Group {
        name: "models",
        what: "the app's model list: add an OpenRouter model from its link or id, or a Claude model on the user's Anthropic key",
        tools: &["add_model"],
        hints: &["openrouter.ai/", "add model", "add this model", "add the model", "install model", "install this model", "model list", "add claude", "claude-"],
    },
    Group {
        name: "time",
        what: "a countdown or a stopwatch for the user, counted from their message",
        tools: &["timer"],
        hints: &["timer", "stopwatch", "count down", "countdown", "minutes", "seconds", "seccond", "count it", "start counting", "how long did", "how much time", "be back", "come back", "comeback", "remind me", "alarm"],
    },
    Group {
        name: "helpers",
        what: "a helper with a context of its own, for broad surveys, research, and running something to see what happens; it reads, searches, browses and runs commands and tests, but does not edit files",
        tools: &["delegate"],
        hints: &["research", "survey", "audit", "whole codebase", "across the codebase"],
    },
];

/// Offered to every reply from its first request: the system prompt tells it to keep findings and to hand broad
/// reading to a helper. Added at the third tool round instead, they changed the tool list in the middle of the reply,
/// and the provider's cache of everything after the tools went with it: the next round read nothing from its cache,
/// on DeepSeek and on Claude alike (2026-10-25).
pub const STANDING: [&str; 2] = ["memory", "helpers"];

fn name(tool: &Value) -> &str {
    tool["function"]["name"].as_str().unwrap_or("")
}

fn group_of(tool: &str) -> Option<&'static Group> {
    GROUPS.iter().find(|group| group.tools.contains(&tool))
}

/// The groups with at least one tool this chat may use (no git group outside a repository).
fn open<'a>(all: &'a [Value]) -> impl Iterator<Item = (&'static Group, Vec<&'a str>)> {
    GROUPS.iter().map(|group| (group, all.iter().map(name).filter(|tool| group.tools.contains(tool)).collect::<Vec<_>>())).filter(|(_, tools)| !tools.is_empty())
}

/// The groups a message asks for by its words.
// ponytail: plain words, in English. A request put another way costs one `load_tools` round, no more.
pub fn hinted(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    GROUPS.iter().filter(|group| group.hints.iter().any(|hint| lower.contains(hint))).map(|group| group.name.to_string()).collect()
}

/// Adds `group` to those loaded. False when it was there already.
pub fn add(loaded: &mut Vec<String>, group: &str) -> bool {
    let new = !loaded.iter().any(|have| have == group);
    if new {
        loaded.push(group.to_string());
    }
    new
}

/// A tool was called whose group was never loaded (the instructions name it, so a model may just call it):
/// the call is let through, and the group counts as loaded from here on.
pub fn note_use(tool: &str, loaded: &mut Vec<String>) {
    if let Some(group) = group_of(tool) {
        add(loaded, group.name);
    }
}

/// The tools to send out of `all` this chat may use: the everyday ones in their usual order, the loader, then
/// each loaded group in the order it was loaded.
pub fn offered(all: &[Value], loaded: &[String]) -> Vec<Value> {
    let mut out: Vec<Value> = all.iter().filter(|tool| group_of(name(tool)).is_none()).cloned().collect();
    if open(all).next().is_some() {
        out.push(loader(all));
    }
    for group in loaded.iter().filter_map(|have| GROUPS.iter().find(|group| group.name == have)) {
        out.extend(all.iter().filter(|tool| group.tools.contains(&name(tool))).cloned());
    }
    out
}

/// `load_tools` as the model sees it. Its text is the same whatever is loaded, so it never unsettles the prompt cache.
fn loader(all: &[Value]) -> Value {
    let groups: Vec<(&Group, Vec<&str>)> = open(all).collect();
    let list: Vec<String> = groups.iter().map(|(group, tools)| format!("- {}: {} ({})", group.name, group.what, tools.join(", "))).collect();
    let description = format!(
        "Only your everyday tools are listed in full. The rest come in groups: call this with the names of the groups you need and their tools are yours from your next step on, for the rest of the chat. Load a group as soon as a task calls for one of its tools, and never tell the user something cannot be done before checking this list.\n{}",
        list.join("\n")
    );
    json!({ "type": "function", "function": { "name": "load_tools", "description": description, "parameters": {
        "type": "object",
        "properties": { "groups": { "type": "array", "items": { "type": "string", "enum": groups.iter().map(|(group, _)| group.name).collect::<Vec<_>>() }, "description": "The groups to load." } },
        "required": ["groups"]
    } } })
}

/// What `load_tools` answers.
pub fn load(args: &Value, all: &[Value], loaded: &mut Vec<String>) -> Output {
    // One name is taken as well as a list: models pass both.
    let mut asked = super::list_arg(args, "groups");
    asked.extend(["groups", "group"].iter().filter_map(|key| args[*key].as_str().map(str::to_string)));
    let known: Vec<(&Group, Vec<&str>)> = open(all).collect();
    let (mut said, mut names) = (Vec::new(), Vec::new());
    for want in &asked {
        match known.iter().find(|(group, _)| group.name == want.trim()) {
            None => return Output::fail(format!("There is no tool group \"{want}\". The groups are: {}.", known.iter().map(|(group, _)| group.name).collect::<Vec<_>>().join(", "))),
            Some((group, tools)) => {
                let fresh = add(loaded, group.name);
                said.push(format!("{}{}: {}", if fresh { "Loaded " } else { "Already loaded " }, group.name, tools.join(", ")));
                names.push(group.name);
            }
        }
    }
    if said.is_empty() {
        return Output::fail(format!("Name the groups to load. The groups are: {}.", known.iter().map(|(group, _)| group.name).collect::<Vec<_>>().join(", ")));
    }
    Output::ok(format!("{}.\nThey are in your tool list from your next step on. Carry on with the task.", said.join(".\n")), names.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str) -> Value {
        json!({ "type": "function", "function": { "name": name, "description": "d" } })
    }

    fn names(tools: &[Value]) -> Vec<&str> {
        tools.iter().map(name).collect()
    }

    /// The everyday set is what no group claims. A tool that arrives with a sync from the web lands in it, and
    /// this fails until someone decides whether it belongs there.
    #[test]
    fn the_everyday_tools_are_few_and_every_other_has_one_group() {
        let all = crate::tools::definitions(true, true, true, Some(true), true);
        let everyday: Vec<&str> = names(&all).into_iter().filter(|tool| group_of(tool).is_none()).collect();
        // web_search and the computer's tools come only with their toggle on, and then with every request: the user
        // switched them on to have them used.
        let mut expected = vec!["list_files", "read_file", "write_file", "edit_file", "search_files", "read_files", "run_command", "make_plan", "update_plan", "ask_user", "finish", "fetch_url", "web_search"];
        if cfg!(windows) {
            expected.extend(["computer_look", "computer_act"]);
        }
        assert_eq!(everyday, expected);
        for group in GROUPS {
            for tool in group.tools {
                assert_eq!(GROUPS.iter().filter(|other| other.tools.contains(tool)).count(), 1, "{tool} is in two groups");
                // `delegate` and `add_model` are the desktop's own: their schemas are not in the list shared with the web.
                assert!(["delegate", "add_model"].contains(tool) || crate::tools::implemented(tool), "{tool} has no handler");
            }
        }
        // What a first request carries: under a third of what all sixty descriptions weighed.
        let (whole, lean) = (json!(all).to_string().len(), json!(offered(&all, &[])).to_string().len());
        assert!(lean * 3 < whole, "{lean} of {whole} characters");
    }

    #[test]
    fn groups_load_once_stay_in_order_and_follow_what_was_sent() {
        let all: Vec<Value> = ["read_file", "http_request", "browse", "git_status", "mcp__notes__add", "delegate"].map(tool).to_vec();
        let mut loaded = Vec::new();
        assert_eq!(names(&offered(&all, &loaded)), ["read_file", "mcp__notes__add", "load_tools"]);
        let lists = |tools: &[Value]| tools.iter().find(|t| name(t) == "load_tools").unwrap()["function"]["description"].as_str().unwrap().to_string();
        let before = lists(&offered(&all, &loaded));
        // Only groups with something to give are listed: no sandbox here.
        assert!(before.contains("- web: ") && before.contains("(http_request, browse)") && !before.contains("- sandbox"));

        let out = load(&json!({ "groups": ["git", "web"] }), &all, &mut loaded);
        assert!(out.ok && out.text.starts_with("Loaded git: git_status.\nLoaded web: http_request, browse.") && out.summary == "git, web");
        // What was already sent keeps its place; a group comes after it, in the order it was loaded.
        assert_eq!(names(&offered(&all, &loaded)), ["read_file", "mcp__notes__add", "load_tools", "git_status", "http_request", "browse"]);
        assert_eq!(lists(&offered(&all, &loaded)), before);
        assert!(load(&json!({ "group": "web" }), &all, &mut loaded).text.starts_with("Already loaded web"));
        assert_eq!(loaded, ["git", "web"]);
        let wrong = load(&json!({ "groups": ["sandbox"] }), &all, &mut loaded);
        assert!(!wrong.ok && wrong.text.contains("The groups are: web, git, helpers."));

        // A tool called before its group was loaded brings the group with it.
        note_use("delegate", &mut loaded);
        note_use("read_file", &mut loaded);
        assert_eq!(loaded, ["git", "web", "helpers"]);
    }

    #[test]
    fn a_message_brings_the_groups_it_names() {
        assert_eq!(hinted("hi"), Vec::<String>::new());
        assert_eq!(hinted("Fetch https://example.com and save its picture"), ["web", "pictures"]);
        assert_eq!(hinted("Make a tkinter calculator and commit it"), ["git", "sandbox"]);
    }
}

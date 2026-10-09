//! A record of what actually went wrong, so it can be fixed: a capped,
//! append-only log of failed tools, refused commands, API errors, runs that
//! hit a ceiling, crashes and frames that froze the window. Nothing leaves the
//! machine. The log itself is src/lib/diagnostics.ts's (both apps share
//! data/diagnostics.jsonl); the reading of it is this app's own.
//!
//! Most of what lands here is not a bug. A model asks for a file that is not
//! there, tries a command that is not allowed, writes a search that matches
//! nothing, and puts it right on the next step. So every event is given a
//! likely cause, and the report leads with the ones that point at the app,
//! then at this PC and the provider; a model's slip is shown only when the
//! same one keeps happening, which says a tool is described badly.

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// Old entries are the least useful: a problem still happening is recorded again.
pub const MAX_ENTRIES: usize = 2000;
/// Groups the Settings panel and the Markdown table show.
const MAX_GROUPS: usize = 40;

/// One line of the log. Field order is the order the web app writes.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Diagnostic {
    pub at: String,
    /// tool_failed | command_refused | browser_blocked | api_error | limit_hit | run_stopped | unverified_claim | ui_error
    pub kind: String,
    /// Short and stable, so events group: the tool or command name.
    pub subject: String,
    /// What happened, in one line. Never a file body.
    pub detail: String,
    /// Extra small facts (status, rounds).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<Value>,
}

/// Whose problem an event most likely is, in the order worth reading.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Cause {
    /// A crash, a frozen window, something the app itself could not do.
    App,
    /// Something this PC lacks or blocks: the sandbox, a program, the network.
    Setup,
    Provider,
    /// The model's own slip. Ordinary; worth a look only when it repeats.
    Model,
    /// Not a problem at all: the user's own choice (a command declined, a question skipped), or a command
    /// that ran and exited with an error. Never recorded, never shown.
    Routine,
}

impl Cause {
    pub fn label(self) -> &'static str {
        match self {
            Cause::App => "App",
            Cause::Setup => "This PC",
            Cause::Provider => "Provider",
            Cause::Model => "Model",
            Cause::Routine => "Routine",
        }
    }
}

/// A model's slip is shown once it has happened this often in the same way.
const HABIT: usize = 3;
/// Habits the export lists.
const MAX_HABITS: usize = 15;

#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    pub kind: String,
    pub subject: String,
    pub cause: Cause,
    pub count: usize,
    /// Most recent occurrence.
    pub last_at: String,
    /// The newest detail, which is usually the clearest.
    pub example: String,
    /// The newest event's small facts ("model glm-5.3-flash · args path,new_text"), when it has any.
    pub facts: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub total: usize,
    /// Events not shown: one-off slips of the model, which are how it works.
    pub left_out: usize,
    pub groups: Vec<Group>,
}

/// The likely cause, read from what was recorded. A guess from the wording, so that old lines and the web
/// app's lines are sorted too.
// ponytail: phrase lists. A failure worded in a new way counts as the model's slip until its phrase is added here,
// so a new kind of app bug shows only once it repeats; crashes and frozen frames are told apart by kind and never missed.
pub fn cause(kind: &str, subject: &str, detail: &str) -> Cause {
    let text = detail.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|word| text.contains(word));
    let starts = |words: &[&str]| words.iter().any(|word| text.starts_with(word));
    match kind {
        "ui_error" | "ui_freeze" => Cause::App,
        "api_error" => Cause::Provider,
        "run_stopped" if subject == "spending limit" => Cause::Routine,
        "unverified_claim" | "limit_hit" | "browser_blocked" | "run_stopped" => Cause::Model,
        // A command that ran and failed has given its answer: that is the work, not a fault in it.
        _ if starts(&["failed: ", "exit ", "sandbox exit", "timed out: ", "skipped"]) || has(&["declined", "no answer", "skipped the question"]) => Cause::Routine,
        _ if has(&["background is not available", "not implemented", "not supported yet", "internal error", "panicked", "ebusy", "resource busy"]) => Cause::App,
        _ if has(&["cut off mid-call"]) => Cause::Provider,
        // A name the model asked for may hold any word ("No run_in_sandbox in x.cpp"): read by how the line opens.
        _ if starts(&["no ", "line ", "old_text", "start_anchor", "end_anchor", "invalid", "missing", "unknown"]) => Cause::Model,
        _ if has(&[
            "sandbox", "wsl", "not installed", "not set up", "could not capture", "failed to start", "could not run", "not on path", "not recognized", "did not respond", "timeout", "timed out",
            "could not reach", "fetch failed", "connection", "network", "dns", "http 5", "search failed", "not connected",
        ]) => Cause::Setup,
        _ => Cause::Model,
    }
}

/// What an event says with its particulars taken out, so the same failure on another file or line counts as
/// the same failure (a path and a bare file name read alike): "a.rs has 463 lines, so line 1380 does not exist" and its kin are one group.
fn shape(detail: &str) -> String {
    static RULES: LazyLock<[(Regex, &str); 4]> = LazyLock::new(|| {
        [(r#""[^"]*"|`[^`]*`"#, "\"…\""), (r"[A-Za-z]:\\\S+|\S*[/\\]\S+", "<file>"), (r"\b[\w-]+\.[A-Za-z][A-Za-z0-9]{0,4}\b", "<file>"), (r"\d+", "#")].map(|(pattern, to)| (Regex::new(pattern).expect("valid pattern"), to))
    });
    // Which program would not start is in the example: they are one failure.
    if detail.to_lowercase().starts_with("failed to start:") {
        return "Failed to start".into();
    }
    RULES.iter().fold(detail.to_string(), |text, (rule, to)| rule.replace_all(&text, *to).into_owned())
}

/// The small facts of an event on one line: "model glm-5.3-flash · args path,new_text".
fn facts(context: Option<&Value>) -> String {
    let Some(Value::Object(map)) = context else { return String::new() };
    map.iter().map(|(key, value)| format!("{key} {}", value.as_str().map_or_else(|| value.to_string(), str::to_string))).collect::<Vec<_>>().join(" · ")
}

fn log_path() -> PathBuf {
    crate::store::data_dir().join("diagnostics.jsonl")
}

/// One line, cut at `max` characters: the first line of an error is nearly always the useful part.
// ponytail: counts characters where the web counts UTF-16 units. The cut lands a little later on text with emoji; count units if the two logs must match there.
fn trim(text: &str, max: usize) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match one_line.char_indices().nth(max) {
        Some((cut, _)) => format!("{}…", &one_line[..cut]),
        None => one_line,
    }
}

/// Anything that could carry a secret is dropped before it is written: the log is meant to be pasteable.
fn scrub(text: &str) -> String {
    static RULES: LazyLock<[(Regex, &str); 4]> = LazyLock::new(|| {
        [
            (r"sk-[A-Za-z0-9_-]{8,}", "sk-***"),
            (r"tvly-[A-Za-z0-9_-]{8,}", "tvly-***"),
            (r"(?i:Bearer)\s+[A-Za-z0-9._-]{8,}", "Bearer ***"),
            (r"([?&](?i:api_?key|token|secret)=)[^&\s]+", "${1}***"),
        ]
        .map(|(pattern, to)| (Regex::new(pattern).expect("valid pattern"), to))
    });
    RULES.iter().fold(text.to_string(), |text, (rule, to)| rule.replace_all(&text, *to).into_owned())
}

/// Records one event. Never panics and never fails the caller: a diagnostic
/// that broke the thing it was observing would be worse than no diagnostic.
pub fn record(kind: &str, subject: &str, detail: &str) {
    record_with(kind, subject, detail, Value::Null);
}

/// `record` with extra small facts, stored as `context` (pass a JSON object of scalars).
/// What is routine (the user's own choice, a command's failing exit) is not a problem and is not written down.
pub fn record_with(kind: &str, subject: &str, detail: &str, context: Value) {
    if cause(kind, subject, detail) != Cause::Routine {
        append(&log_path(), kind, subject, detail, context);
    }
}

/// A crash is written down before the program goes: where it happened and what it said.
pub fn watch_for_crashes() {
    let usual = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let at = info.location().map_or(String::new(), |l| format!("{}:{}", l.file().replace('\\', "/"), l.line()));
        let said = info.payload().downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| info.payload().downcast_ref::<String>().cloned()).unwrap_or_default();
        record("ui_error", &at, &format!("Crashed: {said}"));
        usual(info);
    }));
}

fn append(path: &Path, kind: &str, subject: &str, detail: &str, context: Value) {
    let entry = Diagnostic {
        at: crate::store::iso(crate::store::now_ms()),
        kind: kind.to_string(),
        subject: trim(subject, 80),
        detail: scrub(&trim(detail, 300)),
        context: (!context.is_null()).then_some(context),
    };
    let Ok(mut line) = serde_json::to_string(&entry) else { return };
    line.push('\n');
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// The log, newest last. Trims the file once it has grown past `MAX_ENTRIES`.
pub fn read() -> Vec<Diagnostic> {
    read_at(&log_path())
}

fn read_at(path: &Path) -> Vec<Diagnostic> {
    let Ok(bytes) = std::fs::read(path) else { return Vec::new() };
    let raw = String::from_utf8_lossy(&bytes);
    // A torn final line from an interrupted write does not parse, and is skipped.
    let mut entries: Vec<(&str, Diagnostic)> = raw.lines().filter_map(|line| Some((line, serde_json::from_str(line).ok()?))).collect();
    if entries.len() > MAX_ENTRIES {
        entries.drain(..entries.len() - MAX_ENTRIES);
        // Trimming is housekeeping, not correctness: a failed write changes nothing.
        let _ = std::fs::write(path, entries.iter().map(|(line, _)| format!("{line}\n")).collect::<String>());
    }
    entries.into_iter().map(|(_, entry)| entry).collect()
}

pub fn clear() {
    let _ = std::fs::remove_file(log_path());
}

/// Groups events that are the same failure (kind, where, and what it said with the particulars taken out), and
/// keeps the groups worth reading: the app's first, then this PC's, the provider's, and the model's habits; within
/// each the most frequent first and the most recent first among equals. The second number is how many events
/// were left out as ordinary: forty lines of "file not found" are how a model looks for a file, not a bug.
pub fn summarise(entries: &[Diagnostic]) -> (Vec<Group>, usize) {
    let mut index: HashMap<(&str, &str, String), usize> = HashMap::new();
    let mut groups: Vec<Group> = Vec::new();
    for e in entries {
        match index.entry((e.kind.as_str(), e.subject.as_str(), shape(&e.detail))) {
            std::collections::hash_map::Entry::Occupied(at) => {
                let group = &mut groups[*at.get()];
                group.count += 1;
                // `>=`, not `>`: a burst of failures lands in one millisecond, and later in the file is later in time.
                if e.at >= group.last_at {
                    (group.last_at, group.example, group.facts) = (e.at.clone(), e.detail.clone(), facts(e.context.as_ref()));
                }
            }
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(groups.len());
                groups.push(Group { kind: e.kind.clone(), subject: e.subject.clone(), cause: cause(&e.kind, &e.subject, &e.detail), count: 1, last_at: e.at.clone(), example: e.detail.clone(), facts: facts(e.context.as_ref()) });
            }
        }
    }
    let ordinary = |g: &Group| g.cause == Cause::Routine || (g.cause == Cause::Model && g.count < HABIT);
    let left_out = groups.iter().filter(|g| ordinary(g)).map(|g| g.count).sum();
    groups.retain(|g| !ordinary(g));
    groups.sort_by(|a, b| a.cause.cmp(&b.cause).then_with(|| b.count.cmp(&a.count)).then_with(|| b.last_at.cmp(&a.last_at)));
    (groups, left_out)
}

/// What the Settings panel shows: the totals and the top groups.
pub fn report() -> Report {
    let entries = read();
    let (mut groups, left_out) = summarise(&entries);
    groups.truncate(MAX_GROUPS);
    Report { total: entries.len(), left_out, groups }
}

/// The export: a report someone who has never seen this PC can act on.
pub fn markdown() -> String {
    render_report(&read())
}

/// The label the Settings panel shows for a kind (src/components/DiagnosticsPanel.tsx).
pub fn kind_label(kind: &str) -> &str {
    match kind {
        "tool_failed" => "Tool failed",
        "command_refused" => "Command refused",
        "browser_blocked" => "Browser blocked",
        "api_error" => "API error",
        "limit_hit" => "Hit a limit",
        "run_stopped" => "Stopped early",
        "ui_error" => "Crash",
        "ui_freeze" => "Window froze",
        "unverified_claim" => "Claimed work no tool did",
        other => other,
    }
}

/// The Markdown export words two kinds differently from the panel.
fn export_label(kind: &str) -> &str {
    match kind {
        "browser_blocked" => "Browser action blocked",
        "run_stopped" => "Run stopped early",
        other => kind_label(other),
    }
}

/// The report as Markdown, ready to paste into a chat. It is written for a reader with nothing else to go on:
/// which program and system, what each section means, and with each problem the facts recorded beside it.
pub fn render_report(entries: &[Diagnostic]) -> String {
    let about = format!("apiM desktop {} on {}.", env!("CARGO_PKG_VERSION"), std::env::consts::OS);
    if entries.is_empty() {
        return format!("# apiM diagnostics\n\n{about} Nothing recorded. Either everything has worked, or nothing has been run since the log was last cleared.\n");
    }
    let part = |text: &str, from: usize, to: usize| text.chars().skip(from).take(to - from).collect::<String>();
    let minute = |at: &str| part(at, 0, 16).replacen('T', " ", 1);
    let cell = |text: &str| text.replace('|', "\\|");
    let total = entries.len();
    let (groups, left_out) = summarise(entries);

    let mut lines = vec![
        "# apiM diagnostics".to_string(),
        String::new(),
        format!("{about} {total} event{} recorded, from {} to {} (UTC). Keys are stripped before anything is written.", if total == 1 { "" } else { "s" }, minute(&entries[0].at), minute(&entries[total - 1].at)),
    ];
    let sections = [
        (Cause::App, "Likely app bugs", "A crash, a frame that froze the window, or something the app itself could not do. Start here."),
        (Cause::Setup, "This PC", "Something the machine lacks or blocks: the sandbox, a program that is not installed, a site that did not answer."),
        (Cause::Provider, "Provider", "The model's API misbehaved: an error status, a reply cut short, thinking that never arrived."),
        (Cause::Model, "Model habits", "The model's own slips, listed only because each happened at least three times in the same way. A slip that repeats usually means a tool's description or its error message misleads the model."),
    ];
    for (cause, title, meaning) in sections {
        // The model's habits are many and alike: the commonest say enough.
        let of_cause: Vec<&Group> = groups.iter().filter(|g| g.cause == cause).take(if cause == Cause::Model { MAX_HABITS } else { MAX_GROUPS }).collect();
        if of_cause.is_empty() {
            continue;
        }
        lines.extend([String::new(), format!("## {title}"), String::new(), meaning.to_string(), String::new(), "| # | What | Where | Newest example | Last seen | Facts |".to_string(), "| --- | --- | --- | --- | --- | --- |".to_string()]);
        for g in of_cause {
            lines.push(format!("| {} | {} | `{}` | {} | {} | {} |", g.count, export_label(&g.kind), cell(&g.subject), cell(&g.example), minute(&g.last_at), cell(&g.facts)));
        }
    }
    if groups.is_empty() {
        lines.extend([String::new(), "Nothing that looks like a problem.".to_string()]);
    }
    let unlisted = groups.iter().filter(|g| g.cause == Cause::Model).count().saturating_sub(MAX_HABITS);
    if unlisted > 0 {
        lines.extend([String::new(), format!("{unlisted} rarer model habit{} not listed.", if unlisted == 1 { " is" } else { "s are" })]);
    }
    if left_out > 0 {
        lines.extend([String::new(), format!("{left_out} more event{} left out as ordinary: a wrong path, a search with no match, a command that exited with an error, each put right on the next step.", if left_out == 1 { " was" } else { "s were" })]);
    }
    // The order things went wrong in, without the ordinary ones.
    let shown: std::collections::HashSet<(&str, &str, String)> = groups.iter().map(|g| (g.kind.as_str(), g.subject.as_str(), shape(&g.example))).collect();
    let recent: Vec<&Diagnostic> = entries.iter().rev().filter(|e| shown.contains(&(e.kind.as_str(), e.subject.as_str(), shape(&e.detail)))).take(25).collect();
    if !recent.is_empty() {
        lines.extend([String::new(), "## Most recent of these, in order".to_string(), String::new()]);
        for e in recent.iter().rev() {
            lines.push(format!("- `{}` **{}** `{}` — {}", minute(&e.at), export_label(&e.kind), e.subject, e.detail));
        }
    }
    lines.push(String::new());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(at: &str, kind: &str, subject: &str, detail: &str) -> Diagnostic {
        Diagnostic { at: format!("2026-10-08T10:00:{at}Z"), kind: kind.into(), subject: subject.into(), detail: detail.into(), context: None }
    }

    #[test]
    fn the_report_leads_with_what_points_at_the_app() {
        let entries = [
            entry("01.000", "api_error", "deepseek", "HTTP 500"),
            // The same slip on three files is one habit; a single wrong path is how a model works and is left out.
            entry("02.000", "tool_failed", "read_file", "src/a.rs has 463 lines, so line 1380 does not exist"),
            entry("03.000", "tool_failed", "read_file", "lib/b.luau has 12 lines, so line 90 does not exist"),
            entry("04.000", "tool_failed", "read_file", "c.py has 7 lines, so line 8 does not exist"),
            entry("05.000", "tool_failed", "read_file", "No such file: notes.md"),
            entry("06.000", "command_refused", "git", "The user declined this command."),
            entry("07.000", "tool_failed", "sandbox_run", "Sandbox background is not available"),
            entry("08.000", "tool_failed", "screenshot_window", "Could not capture the window"),
            // Same millisecond as the one before, same failure: the later line wins the example.
            entry("08.000", "tool_failed", "screenshot_window", "Could not capture the window"),
            entry("09.000", "ui_freeze", "during a reply", "One frame took 412 ms."),
            entry("09.500", "tool_failed", "new_tool", "it broke in a way nobody listed"),
            entry("09.600", "tool_failed", "run_command", "Exit 1: 3 tests failed"),
        ];
        let (groups, left_out) = summarise(&entries);
        let order: Vec<(Cause, &str, usize)> = groups.iter().map(|g| (g.cause, g.subject.as_str(), g.count)).collect();
        assert_eq!(
            order,
            [(Cause::App, "during a reply", 1), (Cause::App, "sandbox_run", 1), (Cause::Setup, "screenshot_window", 2), (Cause::Provider, "deepseek", 1), (Cause::Model, "read_file", 3)]
        );
        // The wrong path, the declined command, the failure seen once and the tests that failed.
        assert_eq!(left_out, 4);
        assert_eq!(groups[4].example, "c.py has 7 lines, so line 8 does not exist");
        assert_eq!(shape(r#"C:\Users\x\a.rs and src/b.rs: 12 of 40 `edits` to "old text" in notes.md"#), r#"<file> and <file> # of # "…" to "…" in <file>"#);

        let text = render_report(&entries);
        let at = |needle: &str| text.find(needle).unwrap_or_else(|| panic!("{needle} is missing from:\n{text}"));
        assert!(text.starts_with(&format!("# apiM diagnostics\n\napiM desktop {} on {}. 12 events recorded, from 2026-10-08 10:00 to 2026-10-08 10:00 (UTC).", env!("CARGO_PKG_VERSION"), std::env::consts::OS)));
        assert!(at("## Likely app bugs") < at("## This PC") && at("## This PC") < at("## Provider") && at("## Provider") < at("## Model habits"));
        assert!(text.contains("| 3 | Tool failed | `read_file` | c.py has 7 lines, so line 8 does not exist | 2026-10-08 10:00 |  |"));
        assert!(text.contains("4 more events were left out as ordinary") && !text.contains("declined") && !text.contains("No such file") && !text.contains("tests failed"));
        assert!(render_report(&[]).ends_with("Nothing recorded. Either everything has worked, or nothing has been run since the log was last cleared.\n"));
        assert_eq!((kind_label("run_stopped"), kind_label("ui_freeze"), kind_label("mystery")), ("Stopped early", "Window froze", "mystery"));
    }

    /// The report for a real log: `APIM_DATA_DIR=<data> cargo test real_report -- --ignored --nocapture`.
    #[test]
    #[ignore = "reads the real data folder"]
    fn real_report() {
        eprintln!("{}", markdown());
    }

    #[test]
    fn causes() {
        let of = |kind: &str, subject: &str, detail: &str| cause(kind, subject, detail);
        assert_eq!(of("tool_failed", "run_command", "Exit 128: fatal: not a git repository"), Cause::Routine);
        // A command line may say anything: it is read as a failed command, not for the words in it.
        assert_eq!(of("tool_failed", "run_command", "Failed: python3 -c \"open('screenshots/sandbox-gui.png')\""), Cause::Routine);
        assert_eq!(of("tool_failed", "inspect_binary", "EBUSY: resource busy or locked, unlink 'x.c'"), Cause::App);
        assert_eq!(of("tool_failed", "read_symbol", "No launchApp in scripts/lib/proc.mjs"), Cause::Model);
        assert_eq!(of("tool_failed", "edit_file", "calculator.py: Name the region: old_text, start_anchor (+ end_anchor), or start_line (+ end_line)."), Cause::Model);
        assert_eq!(of("tool_failed", "start_process", r"Failed to start: C:\x\python.exe calc.py"), Cause::Setup);
        assert_eq!(of("tool_failed", "fetch_url", "api.example.com did not respond within 25 seconds."), Cause::Setup);
        assert_eq!(of("tool_failed", "write_file", "Cut off mid-call — splitting into parts"), Cause::Provider);
        assert_eq!(of("tool_failed", "ask_user", "No answer"), Cause::Routine);
        assert_eq!(of("run_stopped", "spending limit", "Stopped at $2.00"), Cause::Routine);
        assert_eq!(of("command_refused", "grep", "\"grep\" is not an allowed command."), Cause::Model);
        assert_eq!(of("ui_error", "src/ui/chat.rs:40", "Crashed: index out of bounds"), Cause::App);
    }

    #[test]
    fn trims_and_scrubs() {
        assert_eq!(trim("  a\n\tb  c ", 300), "a b c");
        assert_eq!(trim(&"é".repeat(400), 300), format!("{}…", "é".repeat(300)));
        assert_eq!(
            scrub("key sk-abcdefgh1234 tvly-ABCDEFGH_1 bearer abcdefgh.ijk https://x.test/?a=1&API_KEY=s3cret&b=2 sk-short"),
            "key sk-*** tvly-*** Bearer *** https://x.test/?a=1&API_KEY=***&b=2 sk-short"
        );
    }

    #[test]
    fn log_round_trip_and_cap() {
        let root = std::env::temp_dir().join(format!("apim-test-{}", std::process::id()));
        // SAFETY: every test here sets the same value, and the checks below use their own path.
        unsafe { std::env::set_var("APIM_DATA_ROOT", &root) };
        let path = root.join("diagnostics-test").join("diagnostics.jsonl");
        let _ = std::fs::remove_file(&path);

        append(&path, "tool_failed", "run_command", "exit 1\nBearer abcdefghijkl", serde_json::json!({ "rounds": 3 }));
        assert_eq!(facts(Some(&serde_json::json!({ "model": "glm-5.3-flash", "rounds": 3 }))), "model glm-5.3-flash · rounds 3");
        append(&path, "tool_failed", "run_command", "exit 2", Value::Null);
        let raw = std::fs::read_to_string(&path).unwrap();
        let first = raw.lines().next().unwrap();
        // The web app's key order, so either app can read the other's lines.
        assert!(first.starts_with("{\"at\":\"20") && first.ends_with("Z\",\"kind\":\"tool_failed\",\"subject\":\"run_command\",\"detail\":\"exit 1 Bearer ***\",\"context\":{\"rounds\":3}}"), "{first}");
        assert!(!raw.lines().nth(1).unwrap().contains("context"));

        // A torn last line is skipped, and an overgrown file is cut back to the newest entries.
        let mut big: String = (0..MAX_ENTRIES + 5).map(|i| format!("{{\"at\":\"t\",\"kind\":\"api_error\",\"subject\":\"s{i}\",\"detail\":\"d\"}}\n")).collect();
        big.push_str("{\"at\":\"t\",\"kind\"");
        std::fs::write(&path, big).unwrap();
        let entries = read_at(&path);
        assert_eq!((entries.len(), entries[0].subject.as_str()), (MAX_ENTRIES, "s5"));
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), MAX_ENTRIES);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}

//! A record of what actually went wrong, so it can be fixed: a capped,
//! append-only log of failed tools, refused commands, API errors and runs that
//! hit a ceiling. Nothing leaves the machine. Port of src/lib/diagnostics.ts
//! and src/app/api/diagnostics/route.ts; both apps share data/diagnostics.jsonl.

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

#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    pub kind: String,
    pub subject: String,
    pub count: usize,
    /// Most recent occurrence.
    pub last_at: String,
    /// The newest detail, which is usually the clearest.
    pub example: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub total: usize,
    pub groups: Vec<Group>,
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
pub fn record_with(kind: &str, subject: &str, detail: &str, context: Value) {
    append(&log_path(), kind, subject, detail, context);
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

/// Groups by kind and subject, most frequent first and the most recent first among equals.
/// Forty lines of "run_command failed" is noise; "failed 40 times, all `npm install`" is a bug report.
pub fn summarise(entries: &[Diagnostic]) -> Vec<Group> {
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut groups: Vec<Group> = Vec::new();
    for e in entries {
        match index.get(&format!("{}::{}", e.kind, e.subject)) {
            Some(&i) => {
                let group = &mut groups[i];
                group.count += 1;
                // `>=`, not `>`: a burst of failures lands in one millisecond, and later in the file is later in time.
                if e.at >= group.last_at {
                    group.last_at = e.at.clone();
                    group.example = e.detail.clone();
                }
            }
            None => {
                index.insert(format!("{}::{}", e.kind, e.subject), groups.len());
                groups.push(Group { kind: e.kind.clone(), subject: e.subject.clone(), count: 1, last_at: e.at.clone(), example: e.detail.clone() });
            }
        }
    }
    groups.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| b.last_at.cmp(&a.last_at)));
    groups
}

/// What the Settings panel shows: the total and the top groups.
pub fn report() -> Report {
    let entries = read();
    let mut groups = summarise(&entries);
    groups.truncate(MAX_GROUPS);
    Report { total: entries.len(), groups }
}

/// The export: the same text as the web app's `/api/diagnostics?format=md`.
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
        "ui_error" => "Interface error",
        other => other,
    }
}

/// The Markdown export words three kinds differently from the panel.
fn export_label(kind: &str) -> &str {
    match kind {
        "browser_blocked" => "Browser action blocked",
        "run_stopped" => "Run stopped early",
        "unverified_claim" => "Claimed work no tool did",
        other => kind_label(other),
    }
}

/// The report as Markdown, ready to paste into a chat.
pub fn render_report(entries: &[Diagnostic]) -> String {
    if entries.is_empty() {
        return "# apiM diagnostics\n\nNothing recorded. Either everything has worked, or nothing has been run since the log was last cleared.\n".to_string();
    }
    let part = |text: &str, from: usize, to: usize| text.chars().skip(from).take(to - from).collect::<String>();
    let minute = |at: &str| part(at, 0, 16).replacen('T', " ", 1);
    let cell = |text: &str| text.replace('|', "\\|");
    let total = entries.len();

    let mut lines = vec![
        "# apiM diagnostics".to_string(),
        String::new(),
        format!("{total} event{} recorded, from {} to {}.", if total == 1 { "" } else { "s" }, minute(&entries[0].at), minute(&entries[total - 1].at)),
        String::new(),
        "Grouped by what happened, most frequent first. Nothing here leaves your machine unless you share it, and keys are stripped before writing.".to_string(),
        String::new(),
        "| # | What | Where | Most recent example |".to_string(),
        "| --- | --- | --- | --- |".to_string(),
    ];
    for g in summarise(entries).iter().take(MAX_GROUPS) {
        lines.push(format!("| {} | {} | `{}` | {} |", g.count, export_label(&g.kind), cell(&g.subject), cell(&g.example)));
    }
    lines.extend([String::new(), "## Most recent, in order".to_string(), String::new()]);
    for e in &entries[total.saturating_sub(25)..] {
        lines.push(format!("- `{}` **{}** `{}` — {}", part(&e.at, 11, 19), export_label(&e.kind), e.subject, e.detail));
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
    fn groups_by_frequency_then_recency() {
        let entries = [
            entry("01.000", "api_error", "deepseek", "HTTP 500"),
            entry("02.000", "tool_failed", "run_command", "npm install failed"),
            entry("03.000", "command_refused", "rm", "not allowed"),
            entry("04.000", "tool_failed", "run_command", "first wording"),
            // Same millisecond as the one before: the later line still wins the example.
            entry("04.000", "tool_failed", "run_command", "clearer wording"),
        ];
        let groups = summarise(&entries);
        let order: Vec<(&str, usize)> = groups.iter().map(|g| (g.subject.as_str(), g.count)).collect();
        // One group of three, then the two singles with the newer one first.
        assert_eq!(order, [("run_command", 3), ("rm", 1), ("deepseek", 1)]);
        assert_eq!((groups[0].example.as_str(), groups[0].last_at.as_str()), ("clearer wording", "2026-10-08T10:00:04.000Z"));
    }

    #[test]
    fn markdown_matches_the_web_export() {
        assert_eq!(render_report(&[]), "# apiM diagnostics\n\nNothing recorded. Either everything has worked, or nothing has been run since the log was last cleared.\n");
        let entries = [entry("01.000", "run_stopped", "spending limit", "a|b"), entry("02.500", "mystery", "x", "y")];
        let expected = "# apiM diagnostics\n\n2 events recorded, from 2026-10-08 10:00 to 2026-10-08 10:00.\n\n\
            Grouped by what happened, most frequent first. Nothing here leaves your machine unless you share it, and keys are stripped before writing.\n\n\
            | # | What | Where | Most recent example |\n| --- | --- | --- | --- |\n\
            | 1 | mystery | `x` | y |\n| 1 | Run stopped early | `spending limit` | a\\|b |\n\n\
            ## Most recent, in order\n\n\
            - `10:00:01` **Run stopped early** `spending limit` — a|b\n- `10:00:02` **mystery** `x` — y\n";
        assert_eq!(render_report(&entries), expected);
        assert_eq!((kind_label("run_stopped"), kind_label("browser_blocked"), kind_label("mystery")), ("Stopped early", "Browser blocked", "mystery"));
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

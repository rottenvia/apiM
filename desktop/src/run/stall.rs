//! Port of `src/lib/stall.ts`: halting a run that moves without advancing.
//!
//! A tool call is progress when it adds something new: bytes on disk changed, the
//! world was run, or text arrived that was not already in context. Two meters watch
//! for the lack of it: calls in a row that add nothing (warn at 4, halt at 6), and
//! byte-identical re-fetches in total, which novelty does not reset (warn at 8, halt
//! at 12). Around them: a nudge for long read-only streaks, one for rewriting a whole
//! file over and over, the round-cap extension rule, and the texts for a think that
//! drafted a whole program.

use super::loop_breaker::fingerprint;
use super::tail;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::LazyLock;

/// Stall calls before the model gets warned.
pub const STALL_WARN_CALLS: u32 = 4;
/// Stall calls before the run halts.
pub const STALL_TRIP_CALLS: u32 = 6;
/// Identical re-fetches in total before the model gets warned.
pub const REPEAT_WARN_TOTAL: u32 = 8;
/// Identical re-fetches in total before the run halts.
pub const REPEAT_TRIP_TOTAL: u32 = 12;
/// How many recent tool names the trip note can quote.
const RECENT_KEPT: usize = 8;

/// Watching a quiet process is waiting, not spinning.
const REPEAT_EXEMPT: &[&str] = &["read_process", "list_processes", "wait_for_output"];
/// Tools whose success changes the world, so the next read is fresh even for a path read before.
const WORLD_CHANGING: &[&str] = &[
    "write_file", "write_files", "edit_file", "edit_files", "apply_patch", "replace_in_files", "move_file", "delete_file", "undo_file", "restore_snapshot", "download_file",
    "run_command", "run_tests", "build_project", "start_process", "stop_process", "write_process", "github_push", "github_create_pr", "git_commit", "git_branch", "git_pull_base",
];
const READ_TOOLS: &[&str] = &["read_file", "read_files", "read_document"];

/// Did this successful call change the world (files, processes, a run) or get an answer from the user?
pub fn is_world_changing(name: &str) -> bool {
    WORLD_CHANGING.contains(&name) || name == "ask_user"
}

/// Is this one of the file-reading tools?
pub fn is_read_tool(name: &str) -> bool {
    READ_TOOLS.contains(&name)
}

/// "read_file(src/x.ts)": what the notes quote for a repeated call.
fn target_of(name: &str, args: &Value) -> String {
    let parsed;
    let args = match args {
        Value::String(raw) => match serde_json::from_str::<Value>(raw) {
            Ok(value) => {
                parsed = value;
                &parsed
            }
            Err(_) => return name.to_string(),
        },
        other => other,
    };
    let Some(record) = args.as_object() else { return name.to_string() };
    let target = match ["path", "paths", "query", "command", "symbol"].iter().filter_map(|key| record.get(*key)).find(|v| !v.is_null()) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items.iter().take(2).map(|v| v.as_str().map_or_else(|| if v.is_null() { String::new() } else { v.to_string() }, str::to_string)).collect::<Vec<_>>().join(", "),
        _ => String::new(),
    };
    if target.is_empty() { name.to_string() } else { format!("{name}({target})") }
}

#[derive(Debug, Default, PartialEq)]
pub struct StallObservation {
    /// True when this call added something new.
    pub progress: bool,
    /// Stall calls in a row, this one included (0 after progress).
    pub stall_calls: u32,
    /// True exactly on the warning call.
    pub warn: bool,
    /// True on the trip call and while the stall continues.
    pub trip: bool,
    /// Identical re-fetches so far with nothing landing between them.
    pub repeat_total: u32,
    pub repeat_warn: bool,
    pub repeat_trip: bool,
    /// The most repeated call so far, for the notes.
    pub top_repeat_target: Option<String>,
}

/// One per reply.
#[derive(Default)]
pub struct StallTracker {
    /// Call fingerprint to a hash of the text it last returned.
    seen: HashMap<String, u64>,
    stalls: u32,
    recent: Vec<String>,
    repeat_total: u32,
    /// (fingerprint, identical repeats, quoted target), in first-seen order.
    repeats: Vec<(String, u32, String)>,
}

impl StallTracker {
    pub fn observe(&mut self, name: &str, args: &Value, ok: bool, content: &str) -> StallObservation {
        self.recent.push(name.to_string());
        if self.recent.len() > RECENT_KEPT {
            self.recent.remove(0);
        }
        if !ok {
            return self.stalled(false);
        }
        // A user's answer unblocks the run: that is forward motion too.
        if is_world_changing(name) {
            self.seen.clear();
            self.stalls = 0;
            self.repeat_total = 0;
            self.repeats.clear();
            return self.fresh();
        }
        // Planning without doing is the narration loop in tool form.
        if name == "make_plan" || name == "update_plan" {
            return self.stalled(false);
        }
        let key = fingerprint(name, args);
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        content.hash(&mut hasher);
        let hash = hasher.finish();
        if self.seen.get(&key) == Some(&hash) {
            if !REPEAT_EXEMPT.contains(&name) {
                self.repeat_total += 1;
                match self.repeats.iter_mut().find(|r| r.0 == key) {
                    Some(entry) => entry.1 += 1,
                    None => self.repeats.push((key, 1, target_of(name, args))),
                }
            }
            return self.stalled(true);
        }
        self.seen.insert(key, hash);
        self.stalls = 0;
        self.fresh()
    }

    fn top_target(&self) -> Option<String> {
        let mut best: Option<&(String, u32, String)> = None;
        for entry in &self.repeats {
            if best.is_none_or(|b| entry.1 > b.1) {
                best = Some(entry);
            }
        }
        best.map(|b| b.2.clone())
    }

    fn fresh(&self) -> StallObservation {
        StallObservation { progress: true, stall_calls: self.stalls, repeat_total: self.repeat_total, repeat_trip: self.repeat_total >= REPEAT_TRIP_TOTAL, top_repeat_target: self.top_target(), ..Default::default() }
    }

    fn stalled(&mut self, counted_repeat: bool) -> StallObservation {
        self.stalls += 1;
        StallObservation {
            progress: false,
            stall_calls: self.stalls,
            warn: self.stalls == STALL_WARN_CALLS,
            trip: self.stalls >= STALL_TRIP_CALLS,
            repeat_total: self.repeat_total,
            repeat_warn: counted_repeat && self.repeat_total == REPEAT_WARN_TOTAL,
            repeat_trip: self.repeat_total >= REPEAT_TRIP_TOTAL,
            top_repeat_target: self.top_target(),
        }
    }

    /// The last tool names, oldest first, for the trip note.
    pub fn recent_actions(&self) -> &[String] {
        &self.recent
    }
}

fn plural(n: i64, one: &'static str, many: &'static str) -> &'static str {
    if n == 1 { one } else { many }
}

/// Appended to the tool result carrying the warning call.
pub fn stall_warning_text(stall_calls: u32) -> String {
    let left = STALL_TRIP_CALLS as i64 - stall_calls as i64;
    format!(
        "\n\n[Harness: {stall_calls} tool calls with no forward motion — nothing written, and every read/fetch returned text already in context. Stop re-reading: fetch something NEW (different files, run the code, search the web), or state what is missing and ask the user. {left} more unchanged call{} stop{} the run.]",
        plural(left, "", "s"),
        plural(left, "s", "")
    )
}

/// The warning of the cumulative meter. The opposite advice from the one above: here re-fetching is the disease.
pub fn reread_warning_text(total: u32, target: Option<&str>) -> String {
    let left = REPEAT_TRIP_TOTAL as i64 - total as i64;
    let most = target.map(|t| format!(" — most-repeated: {t}")).unwrap_or_default();
    format!(
        "\n\n[Harness: {total} tool calls re-fetched byte-identical text with nothing written, run, or answered since{most}. The text is already in context; fetching it again teaches nothing and every round re-bills the whole transcript. Bank durable facts with note_finding so compaction cannot eat them, then ACT on what you have: edit, run, or state what is missing and ask the user. {left} more identical re-fetch{} stop{} the run.]",
        plural(left, "", "es"),
        plural(left, "s", "")
    )
}

pub fn reread_trip_marker(total: u32) -> String {
    format!("\n\n[Harness: the run was stopped after {total} identical re-fetches with nothing written, run, or answered. On Resume, bank findings first, then act — the details are in the reply text.]")
}

/// "read_file ×3, edit_file ×2, read_file" over the last six names.
fn compress_actions(names: &[String]) -> String {
    let mut parts: Vec<(&str, u32)> = Vec::new();
    for name in &names[names.len().saturating_sub(STALL_TRIP_CALLS as usize)..] {
        match parts.last_mut() {
            Some(last) if last.0 == name => last.1 += 1,
            _ => parts.push((name, 1)),
        }
    }
    parts.iter().map(|(name, n)| if *n > 1 { format!("{name} ×{n}") } else { name.to_string() }).collect::<Vec<_>>().join(", ")
}

fn last_actions(recent: &[String]) -> String {
    if recent.is_empty() { String::new() } else { format!(" (last actions: {})", compress_actions(recent)) }
}

/// The note the user reads when the cumulative meter halts the run.
pub fn reread_trip_user_note(total: u32, target: Option<&str>, recent: &[String]) -> String {
    let most = target.map(|t| format!(" (most: {t})")).unwrap_or_default();
    format!("Stalled and halted: {total} tool calls re-fetched identical text without writing, running, or asking anything{most}{}. The run was stopped instead of burning more rounds — say what to try differently and Resume to carry on.", last_actions(recent))
}

pub fn stall_trip_marker() -> String {
    format!("\n\n[Harness: the run was stopped after {STALL_TRIP_CALLS} tool calls with no forward motion. On Resume, try a different approach — the details are in the reply text.]")
}

/// The note the user reads when the consecutive meter halts the run.
pub fn stall_trip_user_note(recent: &[String]) -> String {
    format!("Stalled and halted: {STALL_TRIP_CALLS} tool calls changed nothing on disk and fetched no new information{}. The run was stopped instead of burning more rounds — say what to try differently and Resume to carry on.", last_actions(recent))
}

/// Read-only calls in a row before the model is told to start doing.
pub const GATHER_NUDGE_CALLS: u32 = 10;

/// Counts calls in a row that neither changed the world nor asked the user, and remembers what they read.
#[derive(Default)]
pub struct GatherTracker {
    streak: u32,
    files: Vec<String>,
}

impl GatherTracker {
    /// The streak so far and whether this call carries the nudge (every tenth of the streak).
    pub fn observe(&mut self, name: &str, args: &Value, ok: bool) -> (u32, bool) {
        if ok && is_world_changing(name) {
            self.streak = 0;
            self.files.clear();
            return (0, false);
        }
        self.streak += 1;
        if is_read_tool(name) && args.is_object() {
            let raw = if args["paths"].is_null() { &args["path"] } else { &args["paths"] };
            for path in raw.as_array().map_or(std::slice::from_ref(raw), Vec::as_slice) {
                if let Some(path) = path.as_str().map(str::trim).filter(|p| !p.is_empty() && !self.files.iter().any(|f| f == p)) {
                    self.files.push(path.to_string());
                }
            }
        }
        (self.streak, self.streak % GATHER_NUDGE_CALLS == 0)
    }

    /// Appended to the tool result on a gathering nudge.
    pub fn nudge_text(&self) -> String {
        let shown = &self.files[self.files.len().saturating_sub(12)..];
        let list = if shown.is_empty() {
            String::new()
        } else {
            let more = if self.files.len() > shown.len() { format!(" (+{} more)", self.files.len() - shown.len()) } else { String::new() };
            format!(" You already have {}{more} — their text is kept in your context, so do not read them again.", shown.join(", "))
        };
        format!("\n\n[Harness: {} tool calls in a row without writing, running or asking anything.{list} Stop gathering and do the current step now: write or edit the code. If one specific thing you need is genuinely missing, name it in a line and fetch only that.]", self.streak)
    }
}

/// Appended when a file is read again with byte-identical content.
pub fn unchanged_read_text() -> &'static str {
    "\n\n[Harness: you already read this in this run and it has not changed — the earlier copy is still in your context. Do not read it again; work from what you have.]"
}

/// Whole rewrites of one file, with no passing run between them, before the nudge.
pub const CHURN_NUDGE_REWRITES: u32 = 3;

/// Every write resets the meters above, so "rewrite the whole file, run, fail, rewrite" needs its own count.
#[derive(Default)]
pub struct ChurnTracker(HashMap<String, u32>);

impl ChurnTracker {
    /// The path being churned, and how often, when this call should carry the nudge.
    pub fn observe(&mut self, name: &str, args: &Value, ok: bool) -> Option<(String, u32)> {
        if matches!(name, "run_command" | "run_tests" | "build_project") {
            if ok {
                self.0.clear();
            }
            return None;
        }
        if !ok || (name != "write_file" && name != "write_files") {
            return None;
        }
        let mut paths: Vec<&str> = args["path"].as_str().into_iter().collect();
        paths.extend(args["files"].as_array().into_iter().flatten().filter_map(|f| f["path"].as_str()));
        let mut hit = None;
        for path in paths {
            let key = path.trim().replace('\\', "/");
            let key = key.strip_prefix("./").unwrap_or(&key).to_string();
            let count = self.0.entry(key.clone()).or_insert(0);
            *count += 1;
            if *count >= CHURN_NUDGE_REWRITES && hit.is_none() {
                hit = Some((key, *count));
            }
        }
        hit
    }
}

pub fn churn_nudge_text(path: &str, count: u32) -> String {
    format!("\n\n[Harness: {path} has now been rewritten whole {count} times with no passing run in between. Rewriting the entire file again is not converging and re-sends all of it each time. Read the exact error from the last run, find the line it names, and fix THAT with edit_file.]")
}

/// Extra rounds granted per extension when the cap hits mid-progress.
pub const CAP_EXTENSION_ROUNDS: usize = 32;
/// Extensions per reply: at most 64 + 3 × 32 = 160 rounds.
pub const MAX_CAP_EXTENSIONS: u32 = 3;
/// Successful world-changing calls since the last check that count as progress.
pub const CAP_PROGRESS_CHANGES: u32 = 3;

/// Should a run that just hit its round cap keep going? Real progress since the last check earns another block.
pub fn should_extend_round_cap(extensions_used: u32, steps_done_since_check: u32, changes_since_check: u32) -> bool {
    extensions_used < MAX_CAP_EXTENSIONS && (steps_done_since_check > 0 || changes_since_check >= CAP_PROGRESS_CHANGES)
}

pub const CODE_DRAFT_NUDGE_MARKER: &str = "[Harness: code drafted in reasoning]";
/// Lines of drafted code in a round's reasoning before it is worth a nudge.
pub const CODE_DRAFT_LINES: usize = 60;
/// Drafted code lines in one live think before the stream is cut over.
pub const DRAFT_CUTOVER_LINES: usize = 150;
/// Cut-overs per run. Past this the model is left to think its own way.
pub const MAX_DRAFT_CUTOVERS: u32 = 3;
/// How much of the think rides back into the transcript (newest kept).
pub const DRAFT_CARRY_CHARS: usize = 48_000;
/// A think the connection dropped is worth carrying past this size; a shorter one is simply asked again.
pub const DROPPED_THINK_CARRY_CHARS: usize = 2_000;
pub const DROPPED_THINK_TEXT: &str = "The connection dropped while you were still thinking, before you had answered or called a tool. Your reasoning so far is above, verbatim. Carry on from where it stopped — do not start the analysis over.";

fn is_fence(line: &str) -> bool {
    line.trim_start().starts_with("```")
}

/// Counts code-looking lines inside the fenced blocks of a reasoning text.
pub fn drafted_code_lines(reasoning: &str) -> usize {
    let mut in_fence = false;
    let mut lines = 0;
    for line in reasoning.split('\n') {
        if is_fence(line) {
            in_fence = !in_fence;
        } else if in_fence && !line.trim().is_empty() {
            lines += 1;
        }
    }
    lines
}

/// System note for the round after one that drafted its code in thought.
pub fn code_draft_nudge_text(lines: usize) -> String {
    format!("{CODE_DRAFT_NUDGE_MARKER}\nYour last round drafted about {lines} lines of code inside your reasoning before writing anything. That code is paid for twice — once as thought, once again as the write_file argument — and delays every action. Decide the structure in a few sentences, then put the code DIRECTLY into write_file/edit_file: the file is the draft. Run it, and fix what fails with edit_file.")
}

/// The think handed back as the model's own words: newest text kept under the cap, and a fence the cut landed inside closed and marked.
pub fn draft_carry(reasoning: &str, why: Option<&str>) -> String {
    let mut text = reasoning.trim_end();
    let mut dropped = 0;
    let total = text.chars().count();
    if total > DRAFT_CARRY_CHARS {
        dropped = total - DRAFT_CARRY_CHARS;
        text = tail(text, DRAFT_CARRY_CHARS);
        // Start on a whole line when one begins soon.
        if let Some(nl) = text.find('\n').map(|i| text[..i].chars().count()).filter(|nl| *nl > 0 && *nl < 400) {
            dropped += nl + 1;
            text = &text[text.find('\n').unwrap() + 1..];
        }
    }
    let open = text.split('\n').filter(|line| is_fence(line)).count() % 2 == 1;
    let omitted = if dropped > 0 { format!("(…{dropped} earlier chars omitted)\n") } else { String::new() };
    format!("[My reasoning so far, verbatim — {}:]\n{omitted}{text}{}", why.unwrap_or("stopped so I write the code to files instead"), if open { "\n```  (my draft was cut off here — finish it in the file)" } else { "" })
}

/// The instruction that follows a think cut over for drafting a whole program.
pub fn draft_cutover_text(lines: usize) -> String {
    format!("Your thinking had drafted about {lines} lines of code without writing a single file, so it was stopped there — at this endpoint's speed that think was many minutes of waiting, and every line would be paid for again as the file's content. Your reasoning is above, verbatim, and this turn has no thinking: act on it. Call write_files now with the files straight from the draft, finishing any cut-off part directly in the file. Then run it and fix what fails with edit_files.")
}

/// Remembers an edit that was only previewed, so the next run after it carries a reminder that nothing was written.
#[derive(Default)]
pub struct PreviewTracker(Option<String>);

impl PreviewTracker {
    /// A note to append to this result, if any.
    pub fn observe(&mut self, name: &str, ok: bool, summary: &str) -> Option<String> {
        static PREVIEW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^Preview(?:ed)?\b").unwrap());
        if matches!(name, "edit_file" | "edit_files" | "replace_in_files") && ok && PREVIEW.is_match(summary) {
            self.0 = Some(summary.to_string());
            return None;
        }
        if matches!(name, "edit_file" | "edit_files" | "replace_in_files" | "apply_patch" | "write_file" | "write_files") && ok {
            self.0 = None;
            return None;
        }
        if matches!(name, "run_command" | "sandbox_run" | "run_tests" | "build_project" | "start_process") {
            let was = self.0.take()?;
            return Some(format!("\n\n[Harness: your last edit call was a PREVIEW ({was}) — nothing was written, so this run used the files as they were before it. Re-send that edit without preview to apply it.]"));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::cases;

    fn names(value: &Value) -> Vec<String> {
        value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn stall_meters_match_the_web() {
        let mut tracker = StallTracker::default();
        for (n, (i, o)) in cases("stall_observe").into_iter().enumerate() {
            let seen = tracker.observe(i[0].as_str().unwrap(), &i[1], i[2].as_bool().unwrap(), i[3].as_str().unwrap());
            let want = StallObservation {
                progress: o["progress"].as_bool().unwrap(),
                stall_calls: o["stallCalls"].as_u64().unwrap() as u32,
                warn: o["warn"].as_bool().unwrap(),
                trip: o["trip"].as_bool().unwrap(),
                repeat_total: o["repeatTotal"].as_u64().unwrap() as u32,
                repeat_warn: o["repeatWarn"].as_bool().unwrap(),
                repeat_trip: o["repeatTrip"].as_bool().unwrap(),
                top_repeat_target: o["topRepeatTarget"].as_str().map(str::to_string),
            };
            assert_eq!(seen, want, "call {n}: {i}");
            assert_eq!(tracker.recent_actions(), names(&o["recent"]), "call {n}");
        }
    }

    #[test]
    fn texts_match_the_web() {
        let o = &cases("stall_texts")[0].1;
        let recent = names(&serde_json::json!(["read_file", "read_file", "search_files", "read_file", "read_file", "read_file", "list_files", "list_files"]));
        let mixed = names(&serde_json::json!(["update_plan", "read_file", "read_file", "read_file", "edit_file", "edit_file", "read_file"]));
        let got = [
            stall_warning_text(4),
            stall_warning_text(5),
            reread_warning_text(8, Some("read_file(src/a.ts)")),
            reread_warning_text(11, None),
            reread_trip_marker(12),
            reread_trip_user_note(12, Some("read_file(a)"), &recent),
            reread_trip_user_note(12, None, &[]),
            stall_trip_marker(),
            stall_trip_user_note(&mixed),
            stall_trip_user_note(&[]),
            unchanged_read_text().to_string(),
            churn_nudge_text("src/app.py", 3),
            code_draft_nudge_text(75),
            draft_cutover_text(162),
            DROPPED_THINK_TEXT.to_string(),
        ];
        for (n, text) in got.iter().enumerate() {
            assert_eq!(text, o[n].as_str().unwrap(), "text {n}");
        }
    }

    #[test]
    fn side_trackers_match_the_web() {
        let mut gather = GatherTracker::default();
        for (i, o) in cases("gather_observe") {
            let (streak, nudge) = gather.observe(i[0].as_str().unwrap(), &i[1], i[2].as_bool().unwrap());
            assert_eq!((streak as u64, nudge), (o["streak"].as_u64().unwrap(), o["nudge"].as_bool().unwrap()), "{i}");
            assert_eq!(gather.files, names(&o["files"]), "{i}");
            if nudge {
                assert_eq!(gather.nudge_text(), o["text"].as_str().unwrap());
            }
        }
        let mut churn = ChurnTracker::default();
        for (i, o) in cases("churn_observe") {
            let hit = churn.observe(i[0].as_str().unwrap(), &i[1], i[2].as_bool().unwrap());
            assert_eq!(hit, o["path"].as_str().map(|p| (p.to_string(), o["count"].as_u64().unwrap() as u32)), "{i}");
        }
        let mut preview = PreviewTracker::default();
        for (i, o) in cases("preview_observe") {
            assert_eq!(preview.observe(i[0].as_str().unwrap(), i[1].as_bool().unwrap(), i[2].as_str().unwrap()).as_deref(), o.as_str(), "{i}");
        }
        for (i, o) in cases("should_extend_round_cap") {
            let n = |k: usize| i[k].as_u64().unwrap() as u32;
            assert_eq!(should_extend_round_cap(n(0), n(1), n(2)), o, "{i}");
        }
    }

    #[test]
    fn drafts_match_the_web() {
        for (i, o) in cases("drafted_code_lines") {
            assert_eq!(drafted_code_lines(i.as_str().unwrap()) as u64, o.as_u64().unwrap());
        }
        for (i, o) in cases("draft_carry") {
            let carried = draft_carry(i[0].as_str().unwrap(), i[1].as_str());
            assert_eq!(carried.chars().count() as u64, o["len"].as_u64().unwrap());
            assert_eq!(crate::run::head(&carried, 200), o["head"].as_str().unwrap());
            assert_eq!(tail(&carried, 80), o["tail"].as_str().unwrap());
        }
    }
}

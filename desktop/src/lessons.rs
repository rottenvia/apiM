//! What the agent has learned about a project, and how it unlearns it:
//! LESSONS.md in the workspace. A lesson must come from something that
//! actually happened (an exit code, a tool error) and keeps that evidence, so
//! a later run can disprove it instead of it sitting there wrong forever.
//! Port of src/lib/lessons.ts; same file, same format.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex};

/// Where the file lives. Visible in the file panel on purpose.
pub const LESSONS_FILE: &str = "LESSONS.md";
/// A lesson has to be cheaper than the mistake it prevents, and the file is
/// carried on every round. Forty short lines is a few hundred tokens.
pub const MAX_LESSONS: usize = 40;
/// One line's ceiling, so a lesson cannot become an essay.
pub const MAX_LESSON_CHARS: usize = 240;

/// Field order is the order the web app writes them in the hidden comment.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Lesson {
    /// Stable, so a later pass can revise this exact lesson.
    pub id: String,
    /// How many times reality has since agreed with it.
    pub confirmed: u32,
    /// How many times reality has since contradicted it.
    pub contradicted: u32,
    /// Set when a later run disproved it: the id of what replaced it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// What proved it: a command and its exit code, a tool error, a test result.
    pub evidence: String,
    /// What was learned, in one line.
    pub text: String,
}

/// One thing a refine pass wants written down.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LessonUpdate {
    pub text: String,
    /// Required: a lesson without evidence is a guess, and guesses are refused.
    pub evidence: String,
    /// Id of a lesson this disproves. The old one is superseded, not deleted, so
    /// the record shows what was believed, what happened and what replaced it.
    pub replaces: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Rejected {
    pub text: String,
    /// "empty" or "no evidence".
    pub reason: &'static str,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ApplyResult {
    pub added: usize,
    pub revised: usize,
    pub confirmed: usize,
    pub rejected: Vec<Rejected>,
    pub total: usize,
}

/// "high" | "medium" | "low", from how reality has voted. Deliberately not the
/// model's own estimate: a count of how often a command worked cannot be talked into anything.
pub fn confidence_of(lesson: &Lesson) -> &'static str {
    if lesson.contradicted > lesson.confirmed {
        "low"
    } else if lesson.confirmed >= 2 {
        "high"
    } else {
        "medium"
    }
}

const HEADER: &str = "# What I've learned about this project\n\n\
Written by the agent from things that actually happened — a command that\n\
failed, a test that passed, a tool that errored. Each entry keeps the\n\
evidence behind it. When Learning is enabled, a later completed run can\n\
revise a contradicted entry. Safe to edit or delete by hand.\n\n";

/// Markdown, because the file is meant to be read. The structured fields ride
/// along in an HTML comment, which Markdown hides.
fn serialise(lessons: &[Lesson]) -> String {
    let mut out = HEADER.to_string();
    for l in lessons {
        let mark = if l.superseded_by.is_some() { "~~" } else { "" };
        out.push_str(&format!("- {mark}{}{mark}  <sub>{} confidence · {}</sub>\n", l.text, confidence_of(l), l.evidence));
        out.push_str(&format!("  <!--lesson {}-->\n", serde_json::to_string(l).unwrap_or_default()));
    }
    out
}

fn parse(raw: &str) -> Vec<Lesson> {
    static COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<!--lesson (.*?)-->").expect("valid pattern"));
    let now = crate::store::iso(crate::store::now_ms());
    COMMENT
        .captures_iter(raw)
        .filter_map(|found| {
            // A hand-edited file with a broken comment loses one lesson, not the whole file.
            let mut lesson: Lesson = serde_json::from_str(&found[1]).ok()?;
            if lesson.id.is_empty() || lesson.text.is_empty() {
                return None;
            }
            lesson.superseded_by = lesson.superseded_by.filter(|id| !id.is_empty());
            for stamp in [&mut lesson.created_at, &mut lesson.updated_at] {
                if stamp.is_empty() {
                    *stamp = now.clone();
                }
            }
            Some(lesson)
        })
        .collect()
}

/// The workspace's lessons. No file yet is the normal case, and is empty.
pub fn read_lessons(workspace: &Path) -> Vec<Lesson> {
    std::fs::read_to_string(workspace.join(LESSONS_FILE)).map(|raw| parse(&raw)).unwrap_or_default()
}

/// Temp file then rename: a half-written lesson file parses into *some*
/// lessons, which is worse than none, since the model would trust a truncated set.
fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    static N: AtomicU32 = AtomicU32::new(0);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}.{}.tmp", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Drops the least useful lessons once over the cap: disproved ones first (the
/// model would read and believe them), then the least confirmed, then the oldest.
fn cap(mut lessons: Vec<Lesson>) -> Vec<Lesson> {
    if lessons.len() <= MAX_LESSONS {
        return lessons;
    }
    let score = |l: &Lesson| i64::from(l.confirmed) - i64::from(l.contradicted);
    lessons.sort_by(|a, b| a.superseded_by.is_some().cmp(&b.superseded_by.is_some()).then_with(|| score(b).cmp(&score(a))).then_with(|| b.updated_at.cmp(&a.updated_at)));
    lessons.truncate(MAX_LESSONS);
    lessons
}

/// Loose match, so "use pnpm install" and "Use pnpm install." are one lesson.
fn normalise(text: &str) -> String {
    text.to_lowercase().split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit()).filter(|word| !word.is_empty()).collect::<Vec<_>>().join(" ")
}

// ponytail: counts characters where the web counts UTF-16 units; the cap lands a little later on text with emoji.
fn head(text: &str, max: usize) -> String {
    text.trim().chars().take(max).collect()
}

fn base36(mut n: u64) -> String {
    let mut digits = Vec::new();
    loop {
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize] as char);
        n /= 36;
        if n == 0 {
            return digits.iter().rev().collect();
        }
    }
}

/// Applies a refine pass to `lessons` and returns what is kept. Defensive about
/// the model's output throughout: it is writing durable state that steers its
/// own later behaviour, which is where an unchecked hallucination compounds.
pub fn merge(mut lessons: Vec<Lesson>, updates: &[LessonUpdate], confirmed_ids: &[String], now_ms: u64) -> (Vec<Lesson>, ApplyResult) {
    let now = crate::store::iso(now_ms);
    let mut result = ApplyResult::default();

    // Reality agreed with these, so they get more trustworthy.
    for id in confirmed_ids {
        if let Some(lesson) = lessons.iter_mut().rev().find(|l| &l.id == id).filter(|l| l.superseded_by.is_none()) {
            lesson.confirmed += 1;
            lesson.updated_at = now.clone();
            result.confirmed += 1;
        }
    }

    for update in updates {
        let text = head(&update.text, MAX_LESSON_CHARS);
        let evidence = head(&update.evidence, MAX_LESSON_CHARS);
        if text.is_empty() {
            result.rejected.push(Rejected { text, reason: "empty" });
            continue;
        }
        // No evidence, no lesson: otherwise this degrades into speculative advice.
        if evidence.is_empty() {
            result.rejected.push(Rejected { text, reason: "no evidence" });
            continue;
        }
        let fresh = Lesson { id: format!("l{}{}", base36(now_ms), lessons.len()), confirmed: 1, contradicted: 0, superseded_by: None, created_at: now.clone(), updated_at: now.clone(), evidence, text };

        // Self-correction. The old lesson is marked wrong rather than erased, so
        // one that keeps flip-flopping is visible as such. A `replaces` naming no
        // lesson falls through and is treated as new: the content may still be worth keeping.
        if let Some(old) = update.replaces.as_deref().and_then(|id| lessons.iter_mut().rev().find(|l| l.id == id)) {
            old.contradicted += 1;
            old.updated_at = now.clone();
            old.superseded_by = Some(fresh.id.clone());
            lessons.push(fresh);
            result.revised += 1;
            continue;
        }
        // Learning the same thing twice is confirmation, not a second entry.
        if let Some(same) = lessons.iter_mut().find(|l| l.superseded_by.is_none() && normalise(&l.text) == normalise(&fresh.text)) {
            same.confirmed += 1;
            same.updated_at = now.clone();
            result.confirmed += 1;
            continue;
        }
        lessons.push(fresh);
        result.added += 1;
    }

    let kept = cap(lessons);
    result.total = kept.len();
    (kept, result)
}

/// Reads LESSONS.md, applies the pass and writes it back. One pass at a time:
/// two finishing together would both read the old file, and the second would
/// discard the first's lessons.
// ponytail: one lock for every workspace. Lock per workspace if refine passes ever queue behind each other.
pub fn apply_lessons(workspace: &Path, updates: &[LessonUpdate], confirmed_ids: &[String]) -> std::io::Result<ApplyResult> {
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (kept, result) = merge(read_lessons(workspace), updates, confirmed_ids, crate::store::now_ms());
    write_atomic(&workspace.join(LESSONS_FILE), &serialise(&kept))?;
    Ok(result)
}

/// The block added to the system prompt, or "" when there is nothing to say.
/// Disproved lessons are left out entirely: sending the model something known
/// to be false would be actively harmful. Low-confidence ones are marked, not
/// hidden, so the model can weigh them.
pub fn format_lessons_for_prompt(lessons: &[Lesson]) -> String {
    let lines: Vec<String> = lessons
        .iter()
        .filter(|l| l.superseded_by.is_none())
        .map(|l| format!("- [{}] {}{}", l.id, l.text, if confidence_of(l) == "low" { " (unverified — check before relying on it)" } else { "" }))
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "\n\nWhat you have already learned about this project, from things that actually happened here:\n\n{}\n\n\
        These came from real command output and tool results in this workspace. \
        Use them instead of rediscovering the same facts. If one turns out to be \
        wrong, say so plainly and quote its [id] — it will be corrected.",
        lines.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_759_881_600_000; // 2025-10-08T00:00:00.000Z

    fn update(text: &str, evidence: &str, replaces: Option<&str>) -> LessonUpdate {
        LessonUpdate { text: text.into(), evidence: evidence.into(), replaces: replaces.map(String::from) }
    }

    #[test]
    fn merge_adds_confirms_and_corrects() {
        let (lessons, first) = merge(Vec::new(), &[update("  Use pnpm, not npm  ", "npm install exited 1", None), update("guess", " ", None), update("", "x", None)], &[], NOW);
        assert_eq!((first.added, first.total, lessons[0].id.as_str(), lessons[0].text.as_str()), (1, 1, "lmgh82dc00", "Use pnpm, not npm"));
        assert_eq!(first.rejected, [Rejected { text: "guess".into(), reason: "no evidence" }, Rejected { text: String::new(), reason: "empty" }]);

        // The same fact again is a confirmation; a confirmed id is another; a replacement supersedes.
        let again = [update("use PNPM not npm.", "pnpm install exited 0", None), update("Tests need --run", "vitest hung without it", Some("lmgh82dc00")), update("Port 3000 is taken", "EADDRINUSE", Some("nope"))];
        let (lessons, second) = merge(lessons, &again, &["lmgh82dc00".into(), "missing".into()], NOW + 1);
        assert_eq!((second.added, second.revised, second.confirmed, second.total), (1, 1, 2, 3));
        let old = &lessons[0];
        assert_eq!((old.confirmed, old.contradicted, old.superseded_by.as_deref(), confidence_of(old)), (3, 1, Some("lmgh82dc11"), "high"));
        assert_eq!((lessons[1].text.as_str(), lessons[2].id.as_str()), ("Tests need --run", "lmgh82dc12"));

        // Disproved lessons stay in the file, struck through, and out of the prompt.
        let prompt = format_lessons_for_prompt(&lessons);
        assert!(prompt.starts_with("\n\nWhat you have already learned about this project, from things that actually happened here:\n\n- [lmgh82dc11] Tests need --run\n- [lmgh82dc12] Port 3000 is taken\n\nThese came from real command output"));
        assert!(prompt.ends_with("quote its [id] — it will be corrected.") && !prompt.contains("pnpm"));
        assert!(serialise(&lessons).contains("- ~~Use pnpm, not npm~~  <sub>high confidence · npm install exited 1</sub>\n"));
        assert_eq!(format_lessons_for_prompt(&lessons[..1]), "");
    }

    #[test]
    fn file_format_matches_the_web() {
        let lesson = Lesson { id: "l1".into(), confirmed: 1, contradicted: 2, superseded_by: None, created_at: "2026-10-08T00:00:00.000Z".into(), updated_at: "2026-10-08T00:00:00.000Z".into(), evidence: "exit \"1\" — pnpm\ttab".into(), text: "Use pnpm, not npm".into() };
        let text = serialise(std::slice::from_ref(&lesson));
        // The comment is byte-for-byte what JSON.stringify writes in src/lib/lessons.ts.
        let expected = format!(
            "{HEADER}- Use pnpm, not npm  <sub>low confidence · exit \"1\" — pnpm\ttab</sub>\n  <!--lesson {}-->\n",
            r#"{"id":"l1","confirmed":1,"contradicted":2,"createdAt":"2026-10-08T00:00:00.000Z","updatedAt":"2026-10-08T00:00:00.000Z","evidence":"exit \"1\" — pnpm\ttab","text":"Use pnpm, not npm"}"#
        );
        assert_eq!(text, expected);
        assert!(text.starts_with("# What I've learned about this project\n\nWritten by the agent") && HEADER.ends_with("by hand.\n\n"));
        assert_eq!(parse(&text), [lesson.clone()]);
        assert_eq!(format_lessons_for_prompt(&[lesson]), format_lessons_for_prompt(&parse(&text)));
        assert!(format_lessons_for_prompt(&parse(&text)).contains("- [l1] Use pnpm, not npm (unverified — check before relying on it)"));
        // A broken comment loses that lesson only.
        let damaged = format!("{text}  <!--lesson {{\"id\":\"l2\",\"text\":-->\n  <!--lesson {{\"id\":\"l3\",\"text\":\"kept\",\"supersededBy\":null}}-->");
        assert_eq!(parse(&damaged).iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), ["l1", "l3"]);
    }

    #[test]
    fn cap_keeps_the_proven() {
        let lesson = |i: usize, confirmed: u32, dead: bool| Lesson { id: format!("l{i}"), text: format!("fact {i}"), evidence: "e".into(), confirmed, superseded_by: dead.then(|| "x".to_string()), updated_at: format!("2026-01-01T00:{:02}:00.000Z", i % 60), ..Default::default() };
        let mut lessons: Vec<Lesson> = (0..MAX_LESSONS).map(|i| lesson(i, 1, false)).collect();
        lessons.push(lesson(100, 9, true));
        lessons.push(lesson(101, 5, false));
        let kept = cap(lessons);
        // The proven one moves to the front; the disproved one goes, and so does the least recently updated of the rest.
        assert_eq!((kept.len(), kept[0].id.as_str()), (MAX_LESSONS, "l101"));
        assert!(!kept.iter().any(|l| l.id == "l100" || l.id == "l0") && kept.iter().any(|l| l.id == "l28"));
        assert_eq!((normalise("Use pnpm install."), head(&"é".repeat(300), MAX_LESSON_CHARS).chars().count()), ("use pnpm install".to_string(), MAX_LESSON_CHARS));
    }

    #[test]
    fn workspace_round_trip() {
        let root = std::env::temp_dir().join(format!("apim-test-{}", std::process::id()));
        // SAFETY: every test here sets the same value, and this one works in its own folder.
        unsafe { std::env::set_var("APIM_DATA_ROOT", &root) };
        let workspace = root.join("lessons-workspace");
        let _ = std::fs::remove_dir_all(&workspace);

        assert!(read_lessons(&workspace).is_empty());
        let result = apply_lessons(&workspace, &[update("cargo test needs -j 1 here", "the linker ran out of memory", None)], &[]).unwrap();
        assert_eq!((result.added, result.total), (1, 1));
        let saved = read_lessons(&workspace);
        let result = apply_lessons(&workspace, &[], &[saved[0].id.clone()]).unwrap();
        assert_eq!((result.confirmed, read_lessons(&workspace)[0].confirmed), (1, 2));
        // Only LESSONS.md is left behind: no temp file.
        assert_eq!(std::fs::read_dir(&workspace).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&workspace);
    }
}

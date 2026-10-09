//! The parts of `src/lib/plan.ts` the loop itself uses: how far the plan is, a
//! "blocker" that is really a refusal, a closing answer that claims work no tool
//! did, a plan going stale while the work moves on, and a step that has run a
//! long time without closing.
//!
//! `checkEvidence` and the make_plan / update_plan / finish checks live with the tools.

use super::head;
use crate::store::{Plan, PlanStep};
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

fn compile(patterns: &[&str]) -> Vec<Regex> {
    patterns.iter().map(|p| Regex::new(p).unwrap()).collect()
}

fn any(patterns: &[Regex], text: &str) -> bool {
    patterns.iter().any(|re| re.is_match(text))
}

pub struct Progress<'a> {
    pub done: usize,
    pub total: usize,
    pub blocked: usize,
    pub complete: bool,
    /// The step the run is on: the first in progress, else the first not started.
    pub next: Option<&'a PlanStep>,
}

pub fn progress(plan: &Plan) -> Progress<'_> {
    let count = |state: &str| plan.steps.iter().filter(|s| s.state == state).count();
    let next = plan.steps.iter().find(|s| s.state == "doing").or_else(|| plan.steps.iter().find(|s| s.state == "todo"));
    Progress { done: count("done"), total: plan.steps.len(), blocked: count("blocked"), complete: count("done") == plan.steps.len(), next }
}

/// Is this "blocker" the model declining the task rather than naming an obstacle?
/// Anchored to "I" on purpose: "the build can't provide a symbol" is a real blocker.
pub fn looks_like_refusal_blocker(blocker: &str) -> bool {
    static MARKERS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        compile(&[
            r"\bI\s+(?:cannot|can'?t|won'?t|will\s+not|am\s+not\s+able\s+to)(?:\s+be\s+able\s+to)?\s+(?:help|assist|comply|do\b|create|write|generate|fulfill|fulfil)\b",
            r"\bI'?m\s+unable\s+to\s+(?:help|assist|comply|create|write|generate|fulfill|fulfil)\b",
            r"\bI\s+decline\b",
            r"\bdecline\s+to\s+(?:help|assist|comply|create|write|generate|fulfill|fulfil)\b",
            r"\b(?:against|violates?)\s+(?:my|the|our|content|safety)\s+?(?:policy|policies|guidelines?|principles?)\b",
            r"\b(?:my|the|our)\s+(?:policy|guidelines?|principles?)\s+(?:don'?t|do\s+not|prevent|prohibit)\b",
            r"(?i)\bas\s+an\s+ai\b",
            r"(?i)\bi'?m\s+just\s+an?\s",
            r"\b(?:not\s+)?(?:appropriate|suitable|advisable)\s+(?:to\s+|for\s+me\s+to\s+)(?:help|assist|create|write|generate|provide|fulfill|fulfil|continue|proceed|do)\b",
            r"\bethical(?:ly)?\s+(?:cannot|can'?t|unable\s+to|concern|reason|issue|problem)\b",
        ])
    });
    any(&MARKERS, blocker)
}

/// Tools that actually touch files.
const FILE_TOOLS: &[&str] = &[
    "read_file", "read_files", "write_file", "write_files", "edit_file", "edit_files", "apply_patch", "replace_in_files", "move_file", "delete_file", "undo_file", "list_files", "search_files", "read_document", "inspect_binary",
    "restore_snapshot",
];

/// Claims of a file operation. An "Actions taken:" block only counts when it names one, within 400 characters.
static FILE_CLAIMS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    compile(&[
        r"(?i)\b(read|opened)\s+(the\s+)?(file|files)\b",
        r"(?i)\b(edited|modified|updated|patched|rewrote|wrote)\s+(the\s+)?(file|files)\b",
        r"(?i)\b(created|added|deleted|removed|renamed|moved)\s+(the\s+)?(file|files)\b",
        r"(?is)\bactions?\s+taken\s*:.{0,400}?\b(read|wrote|write|edit|edited|created|deleted|removed|renamed|moved|patched)\b",
        r"(?i)\b(I|I've|I have)\s+(read|edited|created|written|wrote|updated|deleted)\b",
    ])
});

/// Groups of tools that do the same job, and the phrases asserting one of them was used. A past-tense frame
/// is required: "I could use web_search here" claims nothing.
static TOOL_CLAIMS: LazyLock<Vec<(&'static [&'static str], Vec<Regex>)>> = LazyLock::new(|| {
    vec![
        (
            &["web_search"][..],
            compile(&[
                r"(?i)\bweb_search\b[^.\n]{0,40}\b(returned|came back|gave|found|failed|errored|empty|no results)",
                r"(?i)\b(ran|used|tried|called|performed|attempted)\s+(a\s+|the\s+)?web[_ ]search\b",
                r"(?i)\b(I|I've|I have)\s+(ran|run|used|tried|performed)\s+(a\s+|the\s+)?(web\s+)?search\b",
                r"(?i)\bsearch(ed)?\s+(returned|came back|gave)\b",
            ]),
        ),
        (
            &["fetch_url", "browse", "inspect_page", "http_request", "download_file"][..],
            compile(&[
                r"(?i)\b(fetch_url|inspect_page|http_request)\b[^.\n]{0,40}\b(returned|came back|gave|responded|failed)",
                r"(?i)\b(ran|used|tried|called|fetched with)\s+(a\s+|the\s+)?(fetch_url|inspect_page|http_request|browse)\b",
                r"(?i)\bHTTP\s+\d{3}\b[^.\n]{0,30}\b(response|status|came back)",
            ]),
        ),
        (
            &["run_command", "run_tests", "start_process", "write_process", "read_process"][..],
            compile(&[
                r"(?i)\b(run_command|run_tests|write_process)\b[^.\n]{0,40}\b(returned|came back|gave|exited|failed|passed)",
                r"(?i)\b(ran|executed)\s+(the\s+)?(tests?|command|script)\b[^.\n]{0,30}\b(and|which|it)\b",
                r"(?i)\bexit(ed)?\s+(code\s+)?[01]\b",
            ]),
        ),
        (
            &["inspect_binary"][..],
            compile(&[
                r"(?i)\binspect_binary\b[^.\n]{0,60}\b(returned|found|reported|decompiled|failed|completed)",
                r"(?i)\b(I|I've|I have)\s+(used|ran|called)\s+inspect_binary\b",
                r"(?i)\b(I|I've|I have)\s+(decompiled|inspected)\s+(the\s+)?(executable|binary|EXE|DLL)\b",
            ]),
        ),
    ]
});

/// Did the closing answer claim work that no tool performed? Returns the note to show when it did.
///
/// Deliberately narrow: it fires only when the named tool is completely absent from the run. A false accusation
/// is worse than a missed one, because the first time this warning is wrong the user stops reading it.
pub fn check_answer_claims(answer: &str, tools_used: &[String]) -> Option<String> {
    static ACTIONS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)\bactions?\s+taken\s*:(.{0,400})").unwrap());
    if answer.trim().is_empty() {
        return None;
    }
    let used = |tool: &str| tools_used.iter().any(|t| t == tool);
    // "Drop the dump here and I read it" offers work, it does not report any: "read" is its own past tense, so a
    // sentence that is an offer or a condition is left out before the claims are looked for. The web lacks this:
    // it took that sentence for a claim, had the reply written twice, and marked the second one too.
    static OFFER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(if|once|when|then|will|would|could|can|shall|going to|want me to|let me)\b|'ll\b").unwrap());
    let reported: String = answer.split_inclusive(['.', '!', '?', '\n']).filter(|sentence| !OFFER.is_match(sentence)).collect();
    if !FILE_TOOLS.iter().any(|t| used(t)) && any(&FILE_CLAIMS, &reported) {
        return Some("This reply describes reading or changing files, but no file tool ran in it — nothing on disk was touched. Treat the summary above as a proposal, not a record of work done.".into());
    }
    // An "Actions taken:" block that names a tool is a claim it ran, with no verb needed.
    if let Some(block) = ACTIONS.captures(answer) {
        for (tools, _) in TOOL_CLAIMS.iter().filter(|(tools, _)| !tools.iter().any(|t| used(t))) {
            if let Some(named) = tools.iter().find(|t| Regex::new(&format!(r"(?i)\b{t}\b")).unwrap().is_match(&block[1])) {
                return Some(format!("This reply lists {named} under \"Actions taken\", but {named} did not run in this reply — nothing was actually called. Treat that line as invented."));
            }
        }
    }
    // Any tool of a group having run is enough: "I looked it up" is true whether it was fetch_url or browse.
    let (tools, _) = TOOL_CLAIMS.iter().find(|(tools, patterns)| !tools.iter().any(|t| used(t)) && any(patterns, answer))?;
    let named = tools[0];
    Some(format!("This reply describes using {named} and reports what it returned, but {named} did not run in this reply — the result described above was not produced by a tool. Treat it as invented until it is actually run."))
}

pub const PLAN_NUDGE_MARKER: &str = "[Harness: plan update overdue]";
/// Tool rounds without an update_plan call before the plan is called stale.
pub const PLAN_STALE_AFTER_TOOL_ROUNDS: usize = 6;

/// Prose claiming a step finished ("step 2 is done") while the plan may still show it open.
pub fn step_claimed_complete(round_text: &str) -> bool {
    static CLAIM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bsteps?\s*\d+[^.\n]{0,60}\b(done|complete|completed|finished|verified|implemented|fixed)\b").unwrap());
    static NEGATION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(not|n't|never|no longer|isn't|aren't|wasn't|weren't)\b").unwrap());
    CLAIM.find(round_text).is_some_and(|claim| !NEGATION.is_match(claim.as_str()))
}

/// System note for the next round: names the count and demands the tool call, since prose does not count.
pub fn build_stale_plan_nudge(rounds_since_update: usize, claimed: bool) -> String {
    let claim = if claimed { " You just claimed a finished step in prose; record it with evidence via update_plan, or retract it." } else { "" };
    format!("{PLAN_NUDGE_MARKER}\n{rounds_since_update} tool rounds since your last update_plan call, and the plan is going stale while you work. Call update_plan with verified states IN THE SAME TURN as your next real tool call (tools can be called together) — never as a turn of its own. Prose claims (\"step 2 done\") do not count, only update_plan counts.{claim}")
}

fn step_words(text: &str) -> HashSet<String> {
    const STOPWORDS: &[&str] = &[
        "the", "and", "for", "with", "that", "this", "then", "into", "from", "its", "all", "any", "each", "every", "our", "your", "are", "was", "will", "make", "sure", "step", "also", "using", "use", "via", "out",
    ];
    text.to_lowercase()
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.' | '/' | '-')))
        .map(|word| word.trim_matches(['.', '/', '-']))
        .filter(|word| word.len() >= 2 && !STOPWORDS.contains(word))
        .map(str::to_string)
        .collect()
}

/// Jaccard overlap of the meaningful words in two step texts, 0 to 1.
pub fn step_similarity(a: &str, b: &str) -> f64 {
    if a.trim().to_lowercase() == b.trim().to_lowercase() {
        return 1.0;
    }
    let (wa, wb) = (step_words(a), step_words(b));
    if wa.is_empty() || wb.is_empty() {
        return 0.0;
    }
    let shared = wa.intersection(&wb).count();
    shared as f64 / (wa.len() + wb.len() - shared) as f64
}

pub const STEP_BUDGET_MARKER: &str = "[Harness: step budget]";
pub const STEP_BUDGET_ROUNDS: usize = 40;
pub const STEP_BUDGET_MS: u64 = 45 * 60_000;
/// Checkpoints before the run pauses for the user.
pub const STEP_BUDGET_HALT_AT: u32 = 3;

/// The step the run is on, and since when.
#[derive(Clone, Debug, PartialEq)]
pub struct StepWatch {
    pub text: String,
    pub id: u32,
    pub since_round: usize,
    pub since_ms: u64,
    pub checkpoints: u32,
}

/// A checkpoint that came due this round.
pub struct StepDue {
    pub level: u32,
    pub rounds: usize,
    pub minutes: u64,
    pub id: u32,
    pub text: String,
    pub halt: bool,
}

/// Advances the watch by one round. A step counts as the same one while its text stays at least 60% alike, so
/// rewording it does not reset the clock. A checkpoint is due every 40 rounds or 45 minutes on one step.
pub fn watch_step(watch: Option<StepWatch>, plan: Option<&Plan>, round: usize, now_ms: u64) -> (Option<StepWatch>, Option<StepDue>) {
    let Some(step) = plan.and_then(|p| progress(p).next) else { return (None, None) };
    let Some(mut watch) = watch.filter(|w| w.text == step.text || step_similarity(&w.text, &step.text) >= 0.6) else {
        return (Some(StepWatch { text: step.text.clone(), id: step.id, since_round: round, since_ms: now_ms, checkpoints: 0 }), None);
    };
    let (rounds, ms, level) = (round - watch.since_round, now_ms - watch.since_ms, watch.checkpoints + 1);
    (watch.text, watch.id) = (step.text.clone(), step.id);
    if rounds < STEP_BUDGET_ROUNDS * level as usize && ms < STEP_BUDGET_MS * level as u64 {
        return (Some(watch), None);
    }
    watch.checkpoints = level;
    (Some(watch), Some(StepDue { level, rounds, minutes: (ms + 30_000) / 60_000, id: step.id, text: step.text.clone(), halt: level >= STEP_BUDGET_HALT_AT }))
}

/// What the model is told at a checkpoint (levels 1 and 2).
pub fn step_budget_nudge(due: &StepDue) -> String {
    let second = if due.level >= 2 { " This is the second checkpoint: in your next message, tell the user in a few lines what works, what is left, and how you will finish — then continue. The next checkpoint pauses the run for them." } else { "" };
    format!(
        "{STEP_BUDGET_MARKER}\nStep {} (\"{}\") has taken {} tool rounds ({} min) without being completed. Before another round, hold the work against that step's own check: (1) what does the check require, (2) what is verified so far, (3) is this approach converging on the check, or fixing symptoms of a wrong model? Proxy wins (valid syntax, a clean parse, a run with exit 0) do not complete a step whose check asks for something else. If it is not converging, change approach or split the step into smaller steps whose checks you can meet — and do not switch hypotheses again without a test that decides between them.{second}",
        due.id,
        head(&due.text, 160),
        due.rounds,
        due.minutes
    )
}

/// What the user is shown when the run pauses at the last checkpoint.
pub fn step_budget_user_note(due: &StepDue) -> String {
    format!("Paused: step {} (\"{}\") ran {} tool rounds ({} min) through {} checkpoints without being completed. Read where it got to above, then press Resume to let it carry on, or tell it which way to go.", due.id, head(&due.text, 120), due.rounds, due.minutes, due.level)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::cases;
    use serde_json::{Value, json};

    #[test]
    fn claims_and_refusals_match_the_web() {
        // An offer is not a report: the reply that set this off in a real chat, and its rewrite.
        for offer in ["Send me the dump name, and I read the dump if you drop it in this workspace.", "Drop the .dmp into this workspace and I read it with real tools then.", "I'll read the file once you attach it."] {
            assert_eq!(check_answer_claims(offer, &[]), None, "{offer}");
        }
        assert!(check_answer_claims("I read the file and fixed the bug.", &[]).is_some());
        for (i, o) in cases("check_answer_claims") {
            let used: Vec<String> = i[1].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect();
            assert_eq!(check_answer_claims(i[0].as_str().unwrap(), &used).as_deref(), o.as_str(), "{i}");
        }
        for (i, o) in cases("looks_like_refusal_blocker") {
            assert_eq!(looks_like_refusal_blocker(i.as_str().unwrap()), o, "{i}");
        }
        for (i, o) in cases("step_claimed_complete") {
            assert_eq!(step_claimed_complete(i.as_str().unwrap()), o, "{i}");
        }
        for (i, o) in cases("stale_plan_nudge") {
            assert_eq!(build_stale_plan_nudge(i[0].as_u64().unwrap() as usize, i[1].as_bool().unwrap()), o.as_str().unwrap());
        }
        for (i, o) in cases("step_similarity") {
            assert!((step_similarity(i[0].as_str().unwrap(), i[1].as_str().unwrap()) - o.as_f64().unwrap()).abs() < 1e-9, "{i}");
        }
    }

    #[test]
    fn progress_and_step_budget_match_the_web() {
        for (i, o) in cases("plan_progress") {
            let plan: Plan = serde_json::from_value(i).unwrap();
            let p = progress(&plan);
            assert_eq!(json!({ "done": p.done, "total": p.total, "blocked": p.blocked, "complete": p.complete }), json!({ "done": o["done"], "total": o["total"], "blocked": o["blocked"], "complete": o["complete"] }));
            assert_eq!(p.next.map(|s| json!(s.id)).unwrap_or(Value::Null), o["next"]["id"]);
        }
        let mut watch = None;
        for (n, (i, o)) in cases("watch_step").into_iter().enumerate() {
            let plan: Option<Plan> = serde_json::from_value(i[0].clone()).unwrap();
            let (next, due) = watch_step(watch.take(), plan.as_ref(), i[1].as_u64().unwrap() as usize, i[2].as_u64().unwrap());
            let shown = next.as_ref().map(|w| json!({ "text": w.text, "id": w.id, "sinceRound": w.since_round, "sinceMs": w.since_ms, "checkpoints": w.checkpoints }));
            assert_eq!(shown.unwrap_or(Value::Null), o["watch"], "round {n}");
            match &due {
                None => assert!(o["due"].is_null(), "round {n}"),
                Some(d) => {
                    assert_eq!(json!({ "level": d.level, "rounds": d.rounds, "minutes": d.minutes, "step": { "id": d.id, "text": d.text }, "halt": d.halt }), o["due"], "round {n}");
                    if d.halt {
                        assert_eq!(step_budget_user_note(d), o["note"].as_str().unwrap());
                    } else {
                        assert_eq!(step_budget_nudge(d), o["nudge"].as_str().unwrap());
                    }
                }
            }
            watch = next;
        }
    }
}

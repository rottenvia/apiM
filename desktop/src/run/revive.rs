//! Port of `src/lib/revive.ts`: noticing a model that stopped mid-task, and the
//! one short message that picks it back up.
//!
//! Models halt for reasons the app never imposed: an inner token budget, a habit
//! of writing "say continue", or deciding the work so far looks finished. The
//! transcript already holds every tool result, so a revive appends one message and
//! the loop goes on. Conservative on purpose: a false continue on a finished
//! answer costs a whole round of padding.

use super::tail;
use regex::Regex;
use std::sync::LazyLock;

/// Times one reply is picked back up before it is left stopped.
pub const MAX_AUTO_REVIVES: u32 = 2;

/// Why a reply ended short of its task.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Premature {
    LimitLanguage,
    EmptyAfterWork,
    MidSentence,
    UnfinishedPlan,
    DanglingNext,
    ProviderAbort,
    RoundCap,
    ThinkingCut,
    LoopBreaker,
    NoProgress,
    StepBudget,
}

impl Premature {
    /// The web's name for the reason, as the diagnostics record it.
    pub fn key(self) -> &'static str {
        match self {
            Premature::LimitLanguage => "limit_language",
            Premature::EmptyAfterWork => "empty_after_work",
            Premature::MidSentence => "mid_sentence",
            Premature::UnfinishedPlan => "unfinished_plan",
            Premature::DanglingNext => "dangling_next",
            Premature::ProviderAbort => "provider_abort",
            Premature::RoundCap => "round_cap",
            Premature::ThinkingCut => "thinking_cut",
            Premature::LoopBreaker => "loop_breaker",
            Premature::NoProgress => "no_progress",
            Premature::StepBudget => "step_budget",
        }
    }
}

static LIMIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:hit|reached|hitting|ran out of) (?:the |my |an )?(?:token |context |output |length |character |internal )?limit\b").unwrap());
/// Names a limit or an abort outright. "I have to stop" is a declaration, not a sign-off.
static LIMIT_EXTRA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:context window|token budget|max tokens|output limit|inner limit|internal limit|due to (?:length|limits?)|I(?:(?:'ll| will| must)| have) to stop|I cannot continue)\b").unwrap());
/// Casual sign-offs. They only count when the reply is also cut mid-word or the round is nearly empty.
static SOFT_STOP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:(?:I(?:'m| am) )?(?:stopping|pausing) (?:here|for now)|stop(?:ping)? here(?: for now)?|continue in (?:the )?(?:next|another) (?:message|reply|turn)|to be continued|say (?:"|')?(?:continue|resume)|type (?:"|')?(?:continue|resume)|ask me to (?:continue|resume)|pick this up|please (?:send|type) (?:continue|resume))\b"#).unwrap()
});
static COMPLETION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:all (?:done|finished)|task is complete|everything (?:is |looks )?(?:done|working|finished)|here(?:'s| is) what I (?:changed|did|built|fixed)|verified (?:it |that )?(?:works|passed))\b").unwrap());

// Prose promising an action that never came ("let me read main.cpp"). A closed verb list: presentation verbs
// (explain, show) and idioms ("let me know") must never read as intent. JS excludes "make sure / make sense /
// make a note" with a lookahead; this engine has none, so "make" has its own pattern and the words after it are checked by hand.
static DANGLING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:I(?:'ll| will) (?:now |first )?(?:write|edit|fix|run|test|implement|create|continue with|keep going)|next I(?:'ll| will)|let me now (?:write|edit|fix|run|implement)|(?:let me|I(?:'ll| will| need to| have to| must))(?: (?:now|first|just|quickly|start by|begin by))? (?:read(?:ing)?|check(?:ing)?|look(?:ing)?(?: at| through| into)?|inspect(?:ing)?|examin(?:e|ing)|taking? a look|updat(?:e|ing)|add(?:ing)?|remov(?:e|ing)|delet(?:e|ing)|refactor(?:ing)?|rewrit(?:e|ing)|renam(?:e|ing)|mov(?:e|ing)|search(?:ing)?|verif(?:y|ying)|writ(?:e|ing)|edit(?:ing)?|fix(?:ing)?|run(?:ning)?|test(?:ing)?|implement(?:ing)?|creat(?:e|ing)|start(?:ing)?|continu(?:e|ing)|try(?:ing)?|appl(?:y|ying)|build(?:ing)?|compil(?:e|ing)|open(?:ing)?|load(?:ing)?))\b").unwrap()
});
static DANGLING_MAKE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:let me|I(?:'ll| will| need to| have to| must))(?: (?:now|first|just|quickly|start by|begin by))? make\b").unwrap());
static MAKE_IDIOM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(?: (?:sure|sense|certain)\b| a notes?\b)").unwrap());
static HEADING_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n#{1,6}\s+\S+$").unwrap());

fn dangling(text: &str) -> bool {
    DANGLING.is_match(text) || DANGLING_MAKE.find_iter(text).any(|m| !MAKE_IDIOM.is_match(&text[m.end()..]))
}

fn tail_of(text: &str) -> &str {
    tail(text.trim(), 1800)
}

/// Does this prose promise imminent action ("let me read…", "I'll fix…")?
pub fn describes_imminent_action(text: &str) -> bool {
    dangling(tail_of(text))
}

/// A closing question aimed at the user: they have to answer, not us.
fn looks_like_user_question(text: &str) -> bool {
    let last = text.trim().rsplit("\n\n").next().unwrap_or("").trim();
    !last.is_empty() && last.chars().count() < 400 && last.ends_with('?')
}

fn ends_mid_sentence(text: &str) -> bool {
    let t = text.trim();
    if t.chars().count() < 80 || t.ends_with("```") {
        return false;
    }
    let stripped = t.trim_end_matches(['"', '\'', '`', ')', ']']).trim_end();
    !stripped.ends_with(['.', '!', '?', ':']) && !HEADING_END.is_match(stripped)
}

pub struct Stop<'a> {
    /// The whole reply so far, earlier rounds included.
    pub content: &'a str,
    /// Prose from this round only: empty when the model just stopped.
    pub round_content: &'a str,
    /// The reply's thinking. The "I have to stop" excuse often lives only here.
    pub reasoning: &'a str,
    pub tool_rounds: usize,
    /// None when there is no plan.
    pub plan_complete: Option<bool>,
    pub plan_blocked: bool,
    pub finish_reason: &'a str,
}

/// Why this stop looks unfinished, or None when it should be left alone.
pub fn detect_premature_stop(input: &Stop) -> Option<Premature> {
    let chars = |t: &str| t.chars().count();
    let round = input.round_content.trim();
    let full = input.content.trim();
    let thinking = input.reasoning.trim();
    let shown = if round.is_empty() { full } else { round };
    let end = tail_of(shown);
    if looks_like_user_question(end) {
        return None;
    }

    // A finished answer is never an inner-limit stop, whatever its deliberation muttered on the way.
    let answered = COMPLETION.is_match(end) && input.plan_complete != Some(false);
    if !answered {
        if LIMIT.is_match(end) || LIMIT_EXTRA.is_match(end) {
            return Some(Premature::LimitLanguage);
        }
        if SOFT_STOP.is_match(end) && (ends_mid_sentence(full) || chars(round) < 40) {
            return Some(Premature::LimitLanguage);
        }
        if chars(round) < 40 && (LIMIT.is_match(thinking) || LIMIT_EXTRA.is_match(thinking) || SOFT_STOP.is_match(thinking)) {
            return Some(Premature::LimitLanguage);
        }
    }

    // An error-like finish is never a deliberate ending. A content filter is a verdict, not a failure:
    // re-asking only counts once tools have run.
    let finish = input.finish_reason.to_ascii_lowercase();
    let filtered = matches!(finish.as_str(), "content_filter" | "content-filter" | "contentfilter");
    if matches!(finish.as_str(), "content_filter" | "content-filter" | "model_error" | "error" | "timeout" | "max_tokens") && (input.tool_rounds >= 1 || !filtered) {
        return Some(Premature::ProviderAbort);
    }

    // Narrated intent outranks the unfinished plan, but never fires on plan-less chat, where "let me check…" is how an answer begins.
    if !COMPLETION.is_match(end) && (input.tool_rounds >= 1 || input.plan_complete == Some(false)) && dangling(end) {
        return Some(Premature::DanglingNext);
    }
    if input.plan_complete == Some(false) && !input.plan_blocked {
        return Some(Premature::UnfinishedPlan);
    }

    // Thinking ran, then nothing useful was written.
    if input.tool_rounds == 0 {
        let cut = chars(thinking) >= 200 && ((shown.is_empty() && !COMPLETION.is_match(thinking)) || (ends_mid_sentence(shown) && chars(shown) < 120 && !COMPLETION.is_match(shown)));
        return cut.then_some(Premature::ThinkingCut);
    }
    if COMPLETION.is_match(end) && input.plan_complete != Some(false) {
        return None;
    }
    if chars(round) < 40 && !COMPLETION.is_match(full) {
        return Some(Premature::EmptyAfterWork);
    }
    (ends_mid_sentence(if round.is_empty() { end } else { round }) && !COMPLETION.is_match(end)).then_some(Premature::MidSentence)
}

/// One short shove. Repeating the whole brief would invite a rewrite.
/// `had_no_tools`: the round ran with its tools stripped after a rejection, so no call was possible.
pub fn revive_instruction(reason: Premature, had_no_tools: bool) -> String {
    let stripped = if had_no_tools { "The last round ran without tools (the request was rejected and retried stripped), so nothing could be called then. Tools are offered again on the next round. " } else { "" };
    if reason == Premature::DanglingNext {
        return format!("{stripped}You described the next action and then stopped instead of doing it. Do not narrate, plan aloud, or repeat what you just said — call the tool in this response. Everything above is still valid: continue from exactly where you left off, no redo. If something is genuinely blocked, mark it blocked and tell the user why.");
    }
    let why = match reason {
        Premature::LimitLanguage => "you said you had to stop (a limit, or asking the user to say continue)",
        Premature::EmptyAfterWork => "you called tools and then produced no closing answer",
        Premature::MidSentence => "you stopped mid-sentence",
        Premature::UnfinishedPlan => "your plan still has unfinished steps",
        Premature::RoundCap => "this reply used every tool round it was allowed; work in bigger batches from here (read_files / edit_files / write_files in one call each) instead of one file per call",
        _ => "the provider ended the round before the task was finished",
    };
    format!("{stripped}You stopped before the task was finished — {why}. This is not a new request. Everything above is still valid: do not redo work that already landed, do not rewrite files that are already on disk, do not restart the plan. Continue from exactly where you left off. If something is genuinely blocked, mark it blocked and tell the user why.")
}

/// The closing line of a reply that stopped mid-task once the automatic continues ran out.
pub fn premature_stop_notice(reason: Premature) -> &'static str {
    match reason {
        Premature::LimitLanguage | Premature::ThinkingCut => "The model stopped on an inner limit before it finished",
        Premature::UnfinishedPlan => "The model stopped with steps still left on the plan",
        Premature::RoundCap => "The reply used every tool round it was allowed — Resume to carry on",
        Premature::LoopBreaker => "The same tool call failed three times with identical arguments — Resume to steer it another way",
        Premature::NoProgress => "The run stalled: tool calls kept coming but nothing advanced — Resume to steer it another way",
        Premature::StepBudget => "One plan step ran a long time without finishing — check where it got to, then Resume or steer it",
        Premature::DanglingNext => "The model kept describing its next action instead of doing it",
        Premature::ProviderAbort => "The provider ended the round before the task was finished — Resume to carry on",
        Premature::EmptyAfterWork | Premature::MidSentence => "The model stopped mid-task before it finished",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::cases;
    use serde_json::Value;

    const ALL: [Premature; 11] = [
        Premature::LimitLanguage, Premature::EmptyAfterWork, Premature::MidSentence, Premature::UnfinishedPlan, Premature::DanglingNext, Premature::ProviderAbort,
        Premature::RoundCap, Premature::ThinkingCut, Premature::LoopBreaker, Premature::NoProgress, Premature::StepBudget,
    ];

    fn text<'a>(input: &'a Value, key: &str) -> &'a str {
        input[key].as_str().unwrap_or("")
    }

    #[test]
    fn matches_the_web() {
        for (n, (i, o)) in cases("detect_premature_stop").into_iter().enumerate() {
            let stop = Stop {
                content: text(&i, "content"),
                round_content: text(&i, "roundContent"),
                reasoning: text(&i, "reasoning"),
                tool_rounds: i["toolRounds"].as_u64().unwrap() as usize,
                plan_complete: i["planComplete"].as_bool(),
                plan_blocked: i["planBlocked"].as_bool().unwrap(),
                finish_reason: text(&i, "finishReason"),
            };
            assert_eq!(detect_premature_stop(&stop).map(Premature::key), o.as_str(), "case {n}: {}", crate::run::head(text(&i, "content"), 90));
        }
        for (i, o) in cases("revive_texts") {
            let reason = *ALL.iter().find(|r| r.key() == i.as_str().unwrap()).unwrap();
            assert_eq!(revive_instruction(reason, false), o[0].as_str().unwrap());
            assert_eq!(revive_instruction(reason, true), o[1].as_str().unwrap());
            assert_eq!(premature_stop_notice(reason), o[2].as_str().unwrap());
        }
        for (i, o) in cases("describes_imminent_action") {
            assert_eq!(describes_imminent_action(i.as_str().unwrap()), o, "{i}");
        }
    }
}

//! Pinning the current goal at the tail of every round: port of src/lib/goal-pin.ts.
//! A long run can lose the plot and resurrect an older task from history or the summary. Every round therefore ends
//! with a short system message restating what THIS run is answering, resolved by precedence: a mid-run steering note
//! beats the run's request, which beats the newest history turn (the original request on a Resume or regenerate).

use super::history_summary::HISTORY_SUMMARY_MARKER;
use super::{JS_SPACE, js_head, js_len, js_trim};
use regex::Regex;
use std::sync::LazyLock;

/// First line of the injected goal block; the round loop removes any older block that starts with this before pushing a fresh one.
pub const GOAL_PIN_MARKER: &str = "[Current request — this is the task]";

/// Below this a user turn cannot be a goal ("continue", "ok", "go on"); pinning those would anchor the run to filler.
const MIN_GOAL_CHARS: usize = 30;
/// The pin quotes the goal's head, never a whole pasted file.
const MAX_GOAL_CHARS: usize = 1000;

/// Bare continuations, which carry no goal even at length. (JS `\s` and `/i`: Unicode spaces, ASCII-only case folding.)
static TRIVIAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"^(?i-u:continue|resume|go on|carry on|proceed|yes|okay|ok|sure|yep)[{JS_SPACE}.!]*$")).unwrap());

/// A user text worth pinning, or None when it says nothing goal-shaped.
pub fn substantive_user_text(text: Option<&str>) -> Option<String> {
    let trimmed = js_trim(text.unwrap_or(""));
    (js_len(trimmed) >= MIN_GOAL_CHARS && !TRIVIAL.is_match(trimmed)).then(|| trimmed.to_string())
}

/// What this run is answering: steering, then the run's own request, then the newest history turn.
pub fn resolve_run_goal(user_text: &str, history_last_user: Option<&str>, steering_text: Option<&str>) -> Option<String> {
    substantive_user_text(steering_text).or_else(|| substantive_user_text(Some(user_text))).or_else(|| substantive_user_text(history_last_user))
}

/// The tail block. Names the summary explicitly: without that sentence the pin and the summary read as two competing
/// goals, and the longer one wins ties in a weak model's head. Mid-run it reads as "the task you are IN", not a fresh
/// ask, so the model stops re-surveying the workspace every round.
pub fn render_goal_pin(goal: &str, mid_run: bool) -> String {
    let capped = if js_len(goal) > MAX_GOAL_CHARS { format!("{}\n…[request truncated — the full text is the newest user turn above]…", js_head(goal, MAX_GOAL_CHARS)) } else { goal.to_string() };
    let lead = if mid_run {
        format!("You are mid-task on this request — nothing new has been asked. Do not restart, re-survey or re-read to re-orient: your plan, notes, the files you read and your last steps are all above. Take the next step. Older turns and the {HISTORY_SUMMARY_MARKER} block are background for a different, finished task if they differ.")
    } else {
        format!("Answer THIS request. Older turns and the {HISTORY_SUMMARY_MARKER} block are background — if they describe a different task, that task is over or paused; do not resume it unasked.")
    };
    format!("{GOAL_PIN_MARKER}\n{lead}\n\n{capped}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::testkit::check;
    use serde_json::json;

    #[test]
    fn replays_the_web_functions() {
        check("goal_pin.substantiveUserText", |i| json!(substantive_user_text(i.as_str())));
        check("goal_pin.resolveRunGoal", |i| json!(resolve_run_goal(i["userText"].as_str().unwrap(), i["historyLastUser"].as_str(), i["steeringText"].as_str())));
        check("goal_pin.renderGoalPin", |i| json!(render_goal_pin(i["goal"].as_str().unwrap(), i["mid"].as_bool().unwrap())));
    }
}

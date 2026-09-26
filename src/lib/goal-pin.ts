/**
 * Pinning the current goal at the tail of every round.
 *
 * The failure mode: a long run loses the plot and resurrects an older
 * task. The user was making a script, then asked about a deobfuscator;
 * after two hours of failing at the deobfuscator the model decided the
 * script was the real task and went back to it. The history (and the
 * history summary) describe the old goal lucidly, the current goal sits
 * one short message far back, and a confused model follows the clearest
 * goal-shaped text it can find.
 *
 * The fix is structural, not a plea in the system prompt: every round ends
 * with a short system message restating what THIS run is answering, so the
 * last thing read before each decision is the current goal. Same mechanism
 * as the plan pin (removed and re-appended each round, so it costs once
 * and keeps the prefix cache-stable), and it resolves its text by
 * precedence — a mid-run steering note beats the run's request, which beats
 * the newest history turn — so Resume, regenerate, and steering all pin
 * the right thing without special cases.
 */

import { HISTORY_SUMMARY_MARKER } from "@/lib/history-summary";

/**
 * First line of the injected goal block, and the request-size bucket key.
 */
export const GOAL_PIN_MARKER = "[Current request — this is the task]";

/**
 * Below this a user turn cannot be a goal ("continue", "ok", "go on").
 * Pinning those would anchor the run to filler.
 */
const MIN_GOAL_CHARS = 30;

/** The pin quotes the goal's head, never a whole pasted file. */
const MAX_GOAL_CHARS = 1000;

/** Bare continuations, which carry no goal even at length. */
const TRIVIAL = /^(continue|resume|go on|carry on|proceed|yes|ok|okay|sure|yep)[\s.!]*$/i;

/** A user text worth pinning, or null when it says nothing goal-shaped. */
export function substantiveUserText(
  text: string | null | undefined
): string | null {
  const trimmed = (text ?? "").trim();
  if (trimmed.length < MIN_GOAL_CHARS) return null;
  if (TRIVIAL.test(trimmed)) return null;
  return trimmed;
}

export interface RunGoalSources {
  /** This run's request text (often "continue" on a resume). */
  userText: string;
  /** Newest user turn before this run — the original request on a resume. */
  historyLastUser: string | null;
  /** Latest mid-run steering note, when the user redirected the run. */
  steeringText: string | null;
}

/**
 * What this run is answering. Steering wins (it is newer than the
 * request), then the request itself, then the newest history turn — which
 * is exactly the original goal on a Resume or regenerate, where userText
 * is filler.
 */
export function resolveRunGoal(sources: RunGoalSources): string | null {
  return (
    substantiveUserText(sources.steeringText) ??
    substantiveUserText(sources.userText) ??
    substantiveUserText(sources.historyLastUser)
  );
}

/**
 * The tail block. Names the summary explicitly: without that sentence the
 * pin and the summary read as two competing goals, and the longer one
 * (the summary) wins ties in a weak model's head.
 */
export function renderGoalPin(goal: string, midRun = false): string {
  const capped =
    goal.length > MAX_GOAL_CHARS
      ? goal.slice(0, MAX_GOAL_CHARS) +
        "\n…[request truncated — the full text is the newest user turn above]…"
      : goal;
  /*
   * Mid-run, the pin must read as "the task you are IN", not a fresh ask.
   *
   * Restated every round as "Answer THIS request", it looked like new input
   * at the end of every request, and the model re-oriented from zero each
   * round — "Just me, Marsel, a big ask and a half-built workspace. Let me
   * look at what I've got…" — spending a round's reasoning re-surveying
   * instead of taking the next step.
   */
  const lead = midRun
    ? `You are mid-task on this request — nothing new has been asked. ` +
      `Do not restart, re-survey or re-read to re-orient: your plan, notes, ` +
      `the files you read and your last steps are all above. Take the next ` +
      `step. Older turns and the ${HISTORY_SUMMARY_MARKER} block are ` +
      `background for a different, finished task if they differ.`
    : `Answer THIS request. Older turns and the ${HISTORY_SUMMARY_MARKER} block are ` +
      `background — if they describe a different task, that task is over or ` +
      `paused; do not resume it unasked.`;
  return `${GOAL_PIN_MARKER}\n${lead}\n\n${capped}`;
}

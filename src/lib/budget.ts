/**
 * A hard ceiling on what one reply may cost.
 *
 * Everything else in this codebase makes tokens cheaper. This is the only
 * thing that makes them *bounded*, and it is the difference between a bad
 * afternoon and a bad bill.
 *
 * The failure it prevents is specific and has happened: a task the model
 * cannot finish. It reads a file, tries something, fails, reasons about why,
 * tries again, fails again. Every round is legitimate work by every measure
 * the app has — the tools succeed, the model is making sense, nothing errors.
 * It just never converges. Forty rounds at max effort on a large transcript
 * is real money, and nothing in the loop was watching the total.
 *
 * Design decisions worth stating:
 *
 *   - It stops BETWEEN rounds, never mid-stream. A reply cut off halfway
 *     through a sentence has been paid for and cannot be used. Stopping at a
 *     round boundary means the work so far is saved and resumable.
 *
 *   - It predicts the next round rather than only checking the last one. A
 *     round on a large transcript can cost several cents on its own, so
 *     "we're still under budget" is not the same as "one more is affordable".
 *
 *   - It warns before it stops. Being cut off with no notice is worse than
 *     being told at 80% that this is going to be close.
 *
 *   - Off by default. A cap that surprises someone mid-task is its own kind
 *     of failure; this has to be chosen.
 */

import { estimateCost, MODEL_RATES } from "@/lib/pricing";
import type { UsageLike } from "@/lib/pricing";
import type { DeepSeekPeriod } from "@/lib/deepseek-hours";

/** Warn once the run passes this share of its cap. */
export const WARN_AT_FRACTION = 0.8;

/**
 * Presets offered in the UI, in USD.
 *
 * Chosen against real figures rather than round numbers: a measured 40-round
 * task at max effort costs about $0.50, and an ordinary conversational reply
 * is well under a cent. $0.25 stops a runaway before it is expensive; $1.00
 * lets a genuinely large task finish.
 */
export const BUDGET_PRESETS = [0.1, 0.25, 0.5, 1, 2, 5] as const;

export interface BudgetState {
  /** Ceiling in USD. `null` means no cap. */
  limitUsd: number | null;
  /** Spent so far on this reply. */
  spentUsd: number;
  /** Whether the 80% warning has already been sent. */
  warned: boolean;
}

export function createBudget(limitUsd: number | null | undefined): BudgetState {
  // A zero or negative cap would stop the very first round, which is never
  // what someone means — it reads as "no cap" far more often than "spend
  // nothing".
  const limit =
    typeof limitUsd === "number" && limitUsd > 0 ? limitUsd : null;
  return { limitUsd: limit, spentUsd: 0, warned: false };
}

/**
 * Add one round's usage to the running total.
 *
 * `period` is the DeepSeek peak/off-peak window to bill at. Defaults to the
 * live clock — which is what the UI wants, since it shows what this round
 * actually cost right now. Pass it explicitly to bill at a known window
 * (tests do: the window is Beijing business hours, and a suite must not
 * start failing because the sandbox ran during it).
 */
export function chargeRound(
  budget: BudgetState,
  usage: UsageLike | null | undefined,
  model: string,
  period?: DeepSeekPeriod
): number {
  const cost = estimateCost(usage, model, period) ?? 0;
  budget.spentUsd += cost;
  return cost;
}

export type BudgetVerdict =
  | { action: "continue" }
  | { action: "warn"; spentUsd: number; limitUsd: number }
  | { action: "stop"; spentUsd: number; limitUsd: number; reason: string };

/**
 * Decide whether the loop may run another round.
 *
 * `lastRoundCost` is used as the estimate for the next one. It is not a
 * perfect predictor — the transcript grows, so the next round is usually a
 * little dearer — but it is measured rather than guessed, and erring toward
 * stopping slightly early is the right direction for a spending limit.
 */
export function checkBudget(
  budget: BudgetState,
  lastRoundCost: number
): BudgetVerdict {
  const { limitUsd, spentUsd } = budget;
  if (limitUsd === null) return { action: "continue" };

  if (spentUsd >= limitUsd) {
    return {
      action: "stop",
      spentUsd,
      limitUsd,
      reason: "the spending limit for this reply was reached",
    };
  }

  // Would one more round go over? Stopping here rather than after the fact is
  // what makes this a limit instead of a report.
  if (lastRoundCost > 0 && spentUsd + lastRoundCost > limitUsd) {
    return {
      action: "stop",
      spentUsd,
      limitUsd,
      reason:
        "the next step would cost more than the remaining budget for this reply",
    };
  }

  if (!budget.warned && spentUsd >= limitUsd * WARN_AT_FRACTION) {
    budget.warned = true;
    return { action: "warn", spentUsd, limitUsd };
  }

  return { action: "continue" };
}

/**
 * The largest reply the remaining budget can pay for, in tokens.
 *
 * Found by attacking the design: the cap was checked BETWEEN rounds, so a
 * single round could sail past it. Measured, a $0.10 cap was exceeded by
 * 4.8x — $0.4785 — because one round asked for the full 65k output allowance
 * and the check only ran afterwards.
 *
 * Between-round checking is still right for STOPPING; it is the only place a
 * run can end with its work saved. But the ceiling has to be enforced inside
 * the round too, and `max_tokens` is exactly that lever: the model cannot
 * generate what it is not allowed to generate.
 *
 * Deliberately generous within the remaining budget, and never below a floor.
 * A round capped at 200 tokens produces a truncated fragment that costs money
 * and cannot be used — at that point stopping cleanly is better, which the
 * between-round check then does.
 */
export function maxTokensFor(
  budget: BudgetState,
  model: string,
  ceiling: number
): number {
  if (budget.limitUsd === null) return ceiling;

  const rates = MODEL_RATES[model];
  if (!rates) return ceiling;
  // A free model (Ox Alpha during preview) has a zero output rate. Dividing
  // the remaining budget by zero is Infinity; the ceiling is the real cap.
  if (rates.output <= 0) return ceiling;

  const remaining = budget.limitUsd - budget.spentUsd;
  if (remaining <= 0) return MIN_USEFUL_OUTPUT_TOKENS;

  /*
   * Only the OUTPUT is bounded here. The input for this round is already
   * committed — the request is about to be sent — so the budget available
   * for generation is what is left after it.
   */
  const affordable = Math.floor((remaining / rates.output) * 1e6);
  return Math.max(MIN_USEFUL_OUTPUT_TOKENS, Math.min(ceiling, affordable));
}

/**
 * Below this, a capped reply is a truncated fragment rather than an answer.
 *
 * Paying for output that cannot be used is worse than stopping, so the
 * between-round check is left to end the run instead.
 */
export const MIN_USEFUL_OUTPUT_TOKENS = 1_000;

/** Plain-language explanation shown when a run is stopped by the cap. */
export function budgetStopMessage(
  spentUsd: number,
  limitUsd: number,
  resumable: boolean
): string {
  const spent = `$${spentUsd.toFixed(4)}`;
  const limit = `$${limitUsd.toFixed(2)}`;
  return (
    `Stopped at your spending limit — this reply has cost ${spent} of ${limit}. ` +
    `Everything done so far is saved` +
    (resumable
      ? `, and you can carry on with Resume (or by typing "resume"), which continues ` +
        `from here instead of starting again.`
      : `.`) +
    ` Raise or remove the limit in Settings if you want it to keep going.`
  );
}

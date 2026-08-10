/**
 * A plan the agent keeps, so it knows what it set out to do.
 *
 * ## The gap this fills
 *
 * The agent loop can run forty rounds. Everything it *did* survives — tool
 * calls are summarised into the transcript — but nothing records what it was
 * *trying* to do. Round thirty has an accurate log of twenty-nine actions and
 * no statement of the goal, so "am I finished?" is answered by re-reading its
 * own history and inferring, which is exactly the kind of reasoning that
 * drifts.
 *
 * Three failure modes come from that, all reported or observed:
 *
 *   - **Stopping early.** The model does the first recognisable chunk of work
 *     and writes a summary, because from inside round twelve that looks like
 *     a complete answer.
 *   - **Forgetting a requirement.** "Also make it work on mobile" was in the
 *     first message and nowhere in the last thirty rounds of context.
 *   - **Declaring success without checking.** Nothing distinguishes "wrote the
 *     file" from "verified the file works".
 *
 * A plan fixes all three cheaply, because it is *small*. It sits at the end
 * of the request where it can be rewritten without breaking the prompt cache
 * (see lib/tree-delta.ts for why that matters), and a ten-step plan is about
 * 150 tokens against the 9,000 a round of reasoning costs.
 *
 * ## Why steps carry a verification note
 *
 * "Done" is the word an agent over-claims. A step that has to say *how* it
 * was checked — the test that passed, the page that rendered, the endpoint
 * that returned 200 — cannot be closed by optimism alone. It is the same
 * reason `run_tests` refuses to report a pass it did not parse.
 */

export type StepState = "todo" | "doing" | "done" | "blocked";

export interface PlanStep {
  id: number;
  text: string;
  state: StepState;
  /** How this step was verified, when it is done. */
  verified?: string;
  /** Why it is blocked, when it is. */
  blocker?: string;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  /** Bumped on every change, so a stale write can be detected. */
  revision: number;
  /**
   * Steps that have ever been verified, across every version of the plan.
   *
   * Carried through replacements so progress cannot be erased by rewriting
   * the plan — see `replacePlan`.
   */
  history: { text: string; verified: string }[];
}

/** Enough for a real task, few enough that the plan stays readable. */
export const MAX_STEPS = 25;

export class PlanError extends Error {}

/**
 * Shortest a goal or a step may be.
 *
 * "x" is not a goal and "done" is not a step. A one-word entry passes every
 * structural check while carrying no information, which makes the plan look
 * legitimate to the loop and useless to a reader. Twelve characters is about
 * three words — enough to be a sentence fragment, short enough that nothing
 * real is rejected.
 */
export const MIN_TEXT = 12;

/**
 * Shortest acceptable evidence.
 *
 * Testing the plan adversarially, `verified: "."` was accepted. That defeats
 * the entire mechanism: the requirement exists so that closing a step costs
 * a moment of honesty, and a single character costs nothing. Evidence has to
 * describe something that happened.
 */
export const MIN_EVIDENCE = 15;

export function createPlan(goal: string, steps: string[]): Plan {
  const cleanGoal = goal.trim();
  if (!cleanGoal) throw new PlanError("A plan needs a goal.");
  if (cleanGoal.length < MIN_TEXT) {
    throw new PlanError(
      `"${cleanGoal}" is not a goal — say what finished actually looks like, ` +
        `in a sentence.`
    );
  }

  const cleaned = steps.map((s) => String(s).trim()).filter(Boolean);
  if (cleaned.length === 0) {
    throw new PlanError("A plan needs at least one step.");
  }
  if (cleaned.length > MAX_STEPS) {
    throw new PlanError(
      `${cleaned.length} steps is too many (max ${MAX_STEPS}). Group the small ` +
        `ones — a plan is a map, not a transcript.`
    );
  }

  const tooShort = cleaned.find((step) => step.length < MIN_TEXT);
  if (tooShort) {
    throw new PlanError(
      `"${tooShort}" is not a step — describe the actual work, not a label.`
    );
  }

  return {
    goal: cleanGoal,
    steps: cleaned.map((text, i) => ({ id: i + 1, text, state: "todo" })),
    revision: 1,
    history: [],
  };
}

/**
 * Replace a plan while keeping what was already proved.
 *
 * The hole this closes, found by attacking my own design: the loop refuses to
 * end while the plan is unfinished, and `make_plan` replaced the plan
 * outright. So the cheapest escape from "you have four steps left" was to
 * call make_plan again with one easy step, mark it done, and be complete.
 * Nothing malicious required — a model under pressure to finish will find
 * that path because it is the shortest one.
 *
 * Re-planning is legitimate: the shape of a task genuinely changes once you
 * start it. What is not legitimate is losing the record. Verified work is
 * carried into the new plan's history, and any step whose text matches
 * something already proved comes back already done — so a rewrite can
 * reorganise the remaining work but cannot un-know what happened.
 */
export function replacePlan(previous: Plan | null, next: Plan): Plan {
  if (!previous) return next;

  /*
   * A replacement must not be smaller than what was already outstanding.
   *
   * Carrying history forward was not enough on its own: the escape was to
   * replace a five-step plan with a one-step plan, mark that step done, and
   * be "complete". The history survived but nothing consulted it, so the loop
   * let go anyway.
   *
   * The rule is that unfinished work has to be accounted for. If the new plan
   * has fewer steps than the old one had REMAINING, the model is not
   * re-planning, it is discarding. That is refused, with the count, so the
   * correction is obvious.
   */
  const remaining = previous.steps.filter(
    (s) => s.state !== "done" && s.state !== "blocked"
  );
  if (remaining.length > 0 && next.steps.length < remaining.length) {
    throw new PlanError(
      `The new plan has ${next.steps.length} step` +
        `${next.steps.length === 1 ? "" : "s"} but ${remaining.length} were ` +
        `still outstanding:\n` +
        remaining.map((s) => `  - ${s.text}`).join("\n") +
        `\n\nRe-planning is fine, but the work does not disappear because ` +
        `the plan changed. Include what is left, or mark it blocked with a ` +
        `reason first.`
    );
  }

  const proved = [
    ...previous.history,
    ...previous.steps
      .filter((s) => s.state === "done" && s.verified)
      .map((s) => ({ text: s.text, verified: s.verified as string })),
  ];

  // Deduplicate by step text: re-planning several times must not multiply the
  // history.
  const seen = new Set<string>();
  const history = proved.filter((entry) => {
    const key = entry.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const byText = new Map(history.map((h) => [h.text.toLowerCase(), h]));

  return {
    ...next,
    history,
    steps: next.steps.map((step) => {
      const already = byText.get(step.text.toLowerCase());
      return already
        ? { ...step, state: "done" as const, verified: already.verified }
        : step;
    }),
  };
}

export interface StepUpdate {
  id: number;
  state: StepState;
  verified?: string;
  blocker?: string;
}

/**
 * Words that claim a check was performed.
 *
 * Used to decide whether a piece of evidence is a CLAIM about something that
 * ran, as opposed to a description of work done. "wrote the parser" is a fine
 * thing to say and needs no corroboration; "ran the tests, all passed" is a
 * factual assertion about a tool that either ran or did not.
 */
const CHECK_WORDS =
  /\b(ran|run|ok|passing|passed|tests?|pytest|jest|vitest|npm test|executed|verified by running)\b/i;

/**
 * Tools whose use constitutes an actual check.
 *
 * Deliberately short. These are the tools that return a fact from outside the
 * model — a test result, a status code, a rendered page — rather than
 * something the model decided.
 */
const VERIFYING_TOOLS = new Set([
  "run_tests",
  "run_command",
  "http_request",
  "browse",
  "read_file",
  "read_files",
  "read_process",
  "wait_for_output",
]);

/**
 * Did the agent actually do what its evidence claims?
 *
 * The deepest weakness in the plan mechanism, and I wrote it down as
 * unsolved: the agent supplies its own evidence, so "ran the tests, all
 * passed" is accepted whether or not anything ran.
 *
 * It cannot be solved completely — no amount of checking makes a model
 * honest — but the specific case of *claiming a tool ran when it did not* is
 * cheap to catch, because the tool calls of the current round are right
 * there. This does not judge whether the evidence is TRUE; it catches the
 * narrower and more common failure of evidence that is not even attached to
 * anything that happened.
 *
 * Returns a warning string, or null when the claim is consistent.
 */
export function checkEvidence(
  verified: string,
  toolsUsedThisRun: string[]
): string | null {
  if (!CHECK_WORDS.test(verified)) return null;

  const didVerify = toolsUsedThisRun.some((t) => VERIFYING_TOOLS.has(t));
  if (didVerify) return null;

  return (
    `You marked this done with "${verified}", which says something was run ` +
    `or checked — but no tool that could check anything has been used in ` +
    `this reply. Either actually run it (run_tests, run_command, ` +
    `http_request or browse), or describe what you did without claiming a ` +
    `check you did not perform.`
  );
}

/**
 * Apply updates to a plan.
 *
 * Returns a new plan rather than mutating, so a rejected update cannot leave
 * the plan half-changed.
 */
export function updatePlan(plan: Plan, updates: StepUpdate[]): Plan {
  const byId = new Map(plan.steps.map((s) => [s.id, s]));

  for (const update of updates) {
    const step = byId.get(update.id);
    if (!step) {
      throw new PlanError(
        `There is no step ${update.id}. The plan has steps 1-${plan.steps.length}.`
      );
    }
    /*
     * A step cannot be closed without saying how it was checked.
     *
     * This is the whole point of the tool. Without it, "done" means "I believe
     * I did this", which is precisely the claim that turns out to be wrong on
     * long tasks. Requiring one line of evidence is a small tax that makes
     * over-claiming take deliberate effort rather than happening by default.
     */
    const evidence = update.verified?.trim() ?? "";
    if (update.state === "done" && evidence.length < MIN_EVIDENCE) {
      throw new PlanError(
        `Step ${update.id} cannot be marked done on "${evidence}". Say what ` +
          `you actually did to check it — the command you ran and its result, ` +
          `the page you opened, the response you got. If you have not checked ` +
          `it, mark it "doing".`
      );
    }
    const blocker = update.blocker?.trim() ?? "";
    if (update.state === "blocked" && blocker.length < MIN_EVIDENCE) {
      throw new PlanError(
        `Step ${update.id} cannot be marked blocked on "${blocker}". Say what ` +
          `is actually in the way and what would unblock it — "blocked" is ` +
          `how you stop, so it has to be answerable by the user.`
      );
    }
  }

  const steps = plan.steps.map((step) => {
    const update = updates.find((u) => u.id === step.id);
    if (!update) return step;
    return {
      ...step,
      state: update.state,
      verified:
        update.state === "done" ? update.verified?.trim() : step.verified,
      blocker:
        update.state === "blocked" ? update.blocker?.trim() : undefined,
    };
  });

  return { ...plan, steps, revision: plan.revision + 1 };
}

export interface PlanProgress {
  done: number;
  total: number;
  blocked: number;
  /** True when every step is done. */
  complete: boolean;
  /** The next step that is not finished, if any. */
  next: PlanStep | null;
}

export function planProgress(plan: Plan): PlanProgress {
  const done = plan.steps.filter((s) => s.state === "done").length;
  const blocked = plan.steps.filter((s) => s.state === "blocked").length;
  const next =
    plan.steps.find((s) => s.state === "doing") ??
    plan.steps.find((s) => s.state === "todo") ??
    null;

  return {
    done,
    total: plan.steps.length,
    blocked,
    complete: done === plan.steps.length,
    next,
  };
}

const MARK: Record<StepState, string> = {
  todo: "[ ]",
  doing: "[~]",
  done: "[x]",
  blocked: "[!]",
};

/**
 * Render the plan for the model.
 *
 * Deliberately compact. This is appended to every request while a plan
 * exists, so its size is paid on each round — though at the very end of the
 * message list, where a change costs nothing against the prompt cache.
 */
/** First line of a rendered plan, used to find and replace it in a transcript. */
export const PLAN_MARKER = "Your plan for:";

export function formatPlan(plan: Plan): string {
  const progress = planProgress(plan);
  const lines = [
    `${PLAN_MARKER} ${plan.goal}`,
    `Progress: ${progress.done}/${progress.total} done` +
      (progress.blocked ? `, ${progress.blocked} blocked` : ""),
    "",
  ];

  for (const step of plan.steps) {
    let line = `${MARK[step.state]} ${step.id}. ${step.text}`;
    if (step.state === "done" && step.verified) {
      line += `\n      verified: ${step.verified}`;
    }
    if (step.state === "blocked" && step.blocker) {
      line += `\n      blocked: ${step.blocker}`;
    }
    lines.push(line);
  }

  lines.push("");
  if (progress.complete) {
    lines.push(
      "Every step is done and verified. Summarise what you built and stop."
    );
  } else if (progress.next) {
    lines.push(
      `Not finished. Next: ${progress.next.id}. ${progress.next.text}`,
      "Do not write a closing summary while steps remain — either continue, " +
        "or mark what is blocking you and say so plainly."
    );
  }

  return lines.join("\n");
}

/** Short line for the UI. */
export function planSummary(plan: Plan): string {
  const p = planProgress(plan);
  return `${p.done}/${p.total} steps${p.blocked ? `, ${p.blocked} blocked` : ""}`;
}

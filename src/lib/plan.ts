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
}

/** Enough for a real task, few enough that the plan stays readable. */
export const MAX_STEPS = 25;

export class PlanError extends Error {}

export function createPlan(goal: string, steps: string[]): Plan {
  const cleanGoal = goal.trim();
  if (!cleanGoal) throw new PlanError("A plan needs a goal.");

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

  return {
    goal: cleanGoal,
    steps: cleaned.map((text, i) => ({ id: i + 1, text, state: "todo" })),
    revision: 1,
  };
}

export interface StepUpdate {
  id: number;
  state: StepState;
  verified?: string;
  blocker?: string;
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
    if (update.state === "done" && !update.verified?.trim()) {
      throw new PlanError(
        `Step ${update.id} cannot be marked done without saying how you ` +
          `checked it. Give "verified": what you ran, what you saw, or what ` +
          `now works. If you have not checked it, mark it "doing".`
      );
    }
    if (update.state === "blocked" && !update.blocker?.trim()) {
      throw new PlanError(
        `Step ${update.id} cannot be marked blocked without saying why.`
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

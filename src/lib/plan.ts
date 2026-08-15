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

import { promises as fs } from "node:fs";
import path from "node:path";
import { normalisePlanStepText } from "@/lib/plan-view";

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

export function createPlan(goal: string, steps: unknown[]): Plan {
  const cleanGoal = goal.trim();
  if (!cleanGoal) throw new PlanError("A plan needs a goal.");
  if (cleanGoal.length < MIN_TEXT) {
    throw new PlanError(
      `"${cleanGoal}" is not a goal — say what finished actually looks like, ` +
        `in a sentence.`
    );
  }

  const cleaned = steps.map(normalisePlanStepText).filter(Boolean);
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
const CHECK_WORDS = [
  // A claim that something was executed. "ran"/"executed" followed by a word,
  // so "ran node greet.test.js" matches and "wrote the runner" does not.
  /\b(ran|executed|invoked)\s+\S/i,
  // A claim about a test outcome. The word "test" alone is not enough — it
  // appears in filenames constantly ("wrote greet.test.js"), and treating
  // that as a claim refused a model doing exactly the right thing. Caught by
  // the autonomy benchmark on its first run.
  /\btests?\s+(pass|passed|passing|fail|failed|green|succeed)/i,
  /\b(all|every)\s+tests?\b/i,
  /\b(pytest|jest|vitest|npm test|cargo test|go test)\b/i,
  // A claim about a live response.
  /\b(returned|responded with)\s+\d{3}\b/i,
  /\bverified by (running|calling|opening)/i,
];

/** Does this evidence assert that something was actually executed? */
function claimsACheck(text: string): boolean {
  return CHECK_WORDS.some((re) => re.test(text));
}

/**
 * Claims of a FILE operation, for checking the closing summary.
 *
 * Reported: the agent ended replies with lines like "Actions taken: [read
 * 3412321]" and "edited the file" on turns where no file tool had been called
 * at all. The work was never done and the tokens were spent anyway.
 */
const FILE_CLAIM_WORDS = [
  /\b(read|opened)\s+(the\s+)?(file|files)\b/i,
  /\b(edited|modified|updated|patched|rewrote|wrote)\s+(the\s+)?(file|files)\b/i,
  /\b(created|added|deleted|removed|renamed|moved)\s+(the\s+)?(file|files)\b/i,
  /*
   * "Actions taken:" is NOT a file claim on its own.
   *
   * It was in this list, so a reply ending "[Actions taken: web_search — ...]"
   * — after a web_search that really ran — was told "no file tool ran in it,
   * nothing on disk was touched". True, and completely beside the point: the
   * reply never claimed to touch disk.
   *
   * A warning that fires for the wrong reason is worse than one that misses,
   * because the next real one gets ignored. Reported immediately, which is
   * exactly what a false positive earns.
   *
   * The block only counts as a file claim when it NAMES a file operation,
   * which is what the original report ("Actions taken: [read 3412321]")
   * actually did.
   *
   * Scanned across newlines, up to 400 characters. My first attempt used
   * [^\n]* and so only looked at the heading LINE — which misses the common
   * shape entirely, because these blocks are usually a bulleted list on the
   * lines below. Caught by an existing fixture that used exactly that shape.
   * The 400-character bound keeps "Actions taken:" near the top of a long
   * reply from matching an unrelated "read" a page later.
   */
  /\bactions?\s+taken\s*:[\s\S]{0,400}?\b(read|wrote|write|edit|edited|created|deleted|removed|renamed|moved|patched)\b/i,
  /\b(I|I've|I have)\s+(read|edited|created|written|wrote|updated|deleted)\b/i,
];

/** Tools that actually touch files. */
const FILE_TOOLS = new Set([
  "read_file",
  "read_files",
  "write_file",
  "write_files",
  "edit_file",
  "edit_files",
  "apply_patch",
  "replace_in_files",
  "move_file",
  "delete_file",
  "undo_file",
  "list_files",
  "search_files",
  "read_document",
  "restore_snapshot",
]);

/**
 * Every tool, and the phrases that assert it was used.
 *
 * The file check above only covered files. Reported after asking the agent to
 * TEST a tool: it produced a detailed report — "Attempt 3: web_search came
 * back empty", a three-row table of results across attempts, a score of 2/10
 * — on a turn where no search ran at all. The user paid for the reasoning
 * that invented it, and the report was indistinguishable from a real one.
 *
 * That is the same failure as the file case, one category over, and the fix
 * generalises: if the answer names a tool as something it DID, that tool has
 * to appear in the list of what actually ran.
 *
 * Matching is on the tool's own name plus the few natural phrasings for it.
 * Deliberately not clever: a model writing "I could use web_search here" is
 * not claiming to have used it, so the patterns require a past-tense frame or
 * the bold-name convention the UI itself prints.
 */
const TOOL_CLAIM_PATTERNS: [string[], RegExp[]][] = [
  [
    ["web_search"],
    [
      /\bweb_search\b[^.\n]{0,40}\b(returned|came back|gave|found|failed|errored|empty|no results)/i,
      /\b(ran|used|tried|called|performed|attempted)\s+(a\s+|the\s+)?web[_ ]search\b/i,
      // "I ran the search and it returned nothing" — the bare word "search"
      // with a past-tense frame, which is how it reads in prose rather than
      // in a tool name.
      /\b(I|I've|I have)\s+(ran|run|used|tried|performed)\s+(a\s+|the\s+)?(web\s+)?search\b/i,
      /\bsearch(ed)?\s+(returned|came back|gave)\b/i,
    ],
  ],
  [
    ["fetch_url", "browse", "inspect_page", "http_request", "download_file"],
    [
      /\b(fetch_url|inspect_page|http_request)\b[^.\n]{0,40}\b(returned|came back|gave|responded|failed)/i,
      /\b(ran|used|tried|called|fetched with)\s+(a\s+|the\s+)?(fetch_url|inspect_page|http_request|browse)\b/i,
      /\bHTTP\s+\d{3}\b[^.\n]{0,30}\b(response|status|came back)/i,
    ],
  ],
  [
    ["run_command", "run_tests", "start_process", "write_process", "read_process"],
    [
      /\b(run_command|run_tests|write_process)\b[^.\n]{0,40}\b(returned|came back|gave|exited|failed|passed)/i,
      /\b(ran|executed)\s+(the\s+)?(tests?|command|script)\b[^.\n]{0,30}\b(and|which|it)\b/i,
      /\bexit(ed)?\s+(code\s+)?[01]\b/i,
    ],
  ],
];

/**
 * Did the closing answer claim work that no tool performed?
 *
 * Returns a note to append when the reply asserts it used something and that
 * something never ran. Two families are checked: file operations, and named
 * tools.
 *
 * Deliberately narrow, and this matters more than the detection. It fires
 * only when the named tool is COMPLETELY ABSENT from the run — a model that
 * searched once and describes two searches is not caught, and should not be.
 * A false accusation is worse than a missed one, because the first time this
 * warning is wrong the user stops reading it.
 *
 * This does not stop the model lying. It stops the lie being invisible, which
 * is the only part a program can actually do.
 */
export function checkAnswerClaims(
  answer: string,
  toolsUsedThisRun: string[]
): string | null {
  if (!answer.trim()) return null;

  const used = new Set(toolsUsedThisRun);

  // Files first: the original case, and the most common one.
  if (
    !toolsUsedThisRun.some((t) => FILE_TOOLS.has(t)) &&
    FILE_CLAIM_WORDS.some((re) => re.test(answer))
  ) {
    return (
      `This reply describes reading or changing files, but no file tool ran ` +
      `in it — nothing on disk was touched. Treat the summary above as a ` +
      `proposal, not a record of work done.`
    );
  }

  /*
   * An "Actions taken:" block that names a tool is a claim it ran.
   *
   * This is the most direct form of the fabrication and it needs no verb
   * around it: writing "[Actions taken: web_search — ...]" asserts the call
   * happened. Checked before the phrase patterns below because it is exact
   * — the tool's own name inside a block that exists to list what was done.
   */
  const actionsBlock = /\bactions?\s+taken\s*:([\s\S]{0,400})/i.exec(answer);
  if (actionsBlock) {
    for (const [tools] of TOOL_CLAIM_PATTERNS) {
      if (tools.some((t) => used.has(t))) continue;
      const named = tools.find((t) =>
        new RegExp(`\\b${t}\\b`, "i").test(actionsBlock[1])
      );
      if (!named) continue;
      return (
        `This reply lists ${named} under "Actions taken", but ${named} did ` +
        `not run in this reply — nothing was actually called. Treat that ` +
        `line as invented.`
      );
    }
  }

  for (const [tools, patterns] of TOOL_CLAIM_PATTERNS) {
    // Any tool in the group having run is enough: they are alternatives for
    // the same job, and "I looked it up" is true whether it was fetch_url or
    // browse.
    if (tools.some((t) => used.has(t))) continue;
    if (!patterns.some((re) => re.test(answer))) continue;

    const named = tools[0];
    return (
      `This reply describes using ${named} and reports what it returned, ` +
      `but ${named} did not run in this reply — the result described above ` +
      `was not produced by a tool. Treat it as invented until it is actually ` +
      `run.`
    );
  }

  return null;
}

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
  if (!claimsACheck(verified)) return null;

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

/* ------------------------------------------------------------------ *
 * Persistence
 *
 * The plan used to live in a `let` inside the request handler, with the
 * comment "lives for the duration of the run". That is precisely the bug
 * reported: pressing Stop, or a round failing, threw the plan away. The next
 * message started with no plan, so the agent either re-planned from nothing
 * — losing every step it had already verified — or carried on from memory,
 * which is the drift the plan exists to prevent.
 *
 * It is per-workspace, not per-conversation, for the same reason the files
 * are: the work being planned is the work in that folder.
 * ------------------------------------------------------------------ */

const PLAN_FILE = "plan.json";

function planPath(workspaceId: string): string {
  const root = process.env.APIM_DATA_ROOT
    ? path.resolve(process.env.APIM_DATA_ROOT)
    : path.join(process.cwd(), "data");
  return path.join(root, "plans", `${encodeURIComponent(workspaceId)}.json`);
}

/**
 * Read the saved plan, or null when there is none.
 *
 * Never throws: a plan that cannot be read must not take the reply down with
 * it. A corrupt file is treated as no plan, which is recoverable — the agent
 * makes a new one — where a thrown error is not.
 */
export async function readPlan(workspaceId: string): Promise<Plan | null> {
  try {
    const raw = await fs.readFile(planPath(workspaceId), "utf8");
    const parsed = JSON.parse(raw) as Plan;
    // Shape-check rather than trust: this file is on disk between runs and
    // an older or hand-edited one should degrade to "no plan", not crash.
    if (
      !parsed ||
      typeof parsed.goal !== "string" ||
      !Array.isArray(parsed.steps) ||
      parsed.steps.some((s) => typeof s?.id !== "number")
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Save the plan. Also never throws, for the same reason. */
export async function writePlan(
  workspaceId: string,
  plan: Plan | null
): Promise<void> {
  try {
    const file = planPath(workspaceId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (plan === null) {
      await fs.rm(file, { force: true });
      return;
    }
    await fs.writeFile(file, JSON.stringify(plan, null, 2), "utf8");
  } catch {
    /* A plan that cannot be saved is worse than one that can, but far
       better than a reply that dies because the disk was busy. */
  }
}

/**
 * Is this plan finished, so a new task should start clean?
 *
 * A completed plan left on disk would be handed to the next, unrelated
 * message as if it were still live.
 */
export function planIsComplete(plan: Plan): boolean {
  return planProgress(plan).complete;
}

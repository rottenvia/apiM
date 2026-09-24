/**
 * Pending command approvals.
 *
 * The chat request is a streaming response that has to stop and wait for the
 * user to click Run or Skip. That decision arrives on a *different* HTTP
 * request, so the two need somewhere to meet — this is that place.
 *
 * In memory on purpose: an approval only has meaning while the request that
 * is waiting for it is still alive. A restart drops both, which is correct.
 */

export interface PendingApproval {
  id: string;
  workspaceId: string;
  command: string;
  args: string[];
  reason: string;
  createdAt: number;
  resolve: (decision: Decision) => void;
}

export type Decision =
  | { approved: true; remember: boolean }
  | { approved: false; reason: string };

/** Nobody is coming back after this long; release the request. */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

const pending = new Map<string, PendingApproval>();

/**
 * Commands approved with "always allow", per workspace.
 *
 * Keyed by workspace so trusting `python3 app.py` in one chat does not
 * silently approve it everywhere.
 */
const remembered = new Map<string, Set<string>>();

function key(command: string, args: string[]): string {
  return JSON.stringify([command, ...args]);
}

export function isRemembered(
  workspaceId: string,
  command: string,
  args: string[]
): boolean {
  return remembered.get(workspaceId)?.has(key(command, args)) ?? false;
}

export function remember(
  workspaceId: string,
  command: string,
  args: string[]
): void {
  let set = remembered.get(workspaceId);
  if (!set) {
    set = new Set();
    remembered.set(workspaceId, set);
  }
  set.add(key(command, args));
}

export function forgetWorkspace(workspaceId: string): void {
  remembered.delete(workspaceId);
}

/**
 * Registers a request for approval and waits for the answer.
 *
 * Resolves rather than rejects on timeout or abort, so the agent loop can
 * report the refusal to the model and carry on instead of the whole reply
 * dying because a prompt was ignored.
 */
export function requestApproval(
  request: Omit<PendingApproval, "createdAt" | "resolve">,
  signal?: AbortSignal
): Promise<Decision> {
  return new Promise<Decision>((resolve) => {
    let settled = false;

    const done = (decision: Decision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      pending.delete(request.id);
      resolve(decision);
    };

    const timer = setTimeout(() => {
      done({
        approved: false,
        reason:
          "The user did not respond to the approval prompt within 5 minutes.",
      });
    }, APPROVAL_TIMEOUT_MS);

    // Stopping generation must also release anything waiting on approval, or
    // the request lingers holding a resolved-but-unread promise.
    const onAbort = () => {
      done({ approved: false, reason: "The user stopped the reply." });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    pending.set(request.id, {
      ...request,
      createdAt: Date.now(),
      resolve: done,
    });
  });
}

/** Applies the user's decision. Returns false if nothing was waiting. */
export function decide(id: string, decision: Decision): boolean {
  const entry = pending.get(id);
  if (!entry) return false;

  if (decision.approved && decision.remember) {
    remember(entry.workspaceId, entry.command, entry.args);
  }

  entry.resolve(decision);
  return true;
}

/** Visible for tests. */
export function pendingCount(): number {
  return pending.size;
}

/**
 * A mid-run note that means "don't run what's waiting".
 *
 * Matches only when the note OPENS with an explicit stop phrase — "dont
 * execute this now, I rejoined so there's new pid" skips the pending
 * approval and the rest of the note still lands next round as steering.
 * "Don't forget to run the tests" does not match: the verb after don't
 * must be a doing verb, and a bare "stop" must stand at the start. The
 * window is narrow by construction — this only ever fires while an
 * approval is actually pending — so a false positive costs one skipped
 * prompt, not a run.
 */
const STOP_NOTE =
  /^\s*(please\s+)?(don't|dont|do not)\s+(run|execute|do|send|push|commit|merge|apply)\b|^\s*(please\s+)?(stop|cancel|abort|skip(\s+(that|this|it))?)\b/i;

export function isStopNote(text: string): boolean {
  return STOP_NOTE.test(text);
}

/**
 * Decline every approval waiting for this workspace, crediting the note.
 * Returns how many were skipped. The agent loop sees an ordinary decline
 * and carries on — the note itself still lands next round, so "don't run
 * it, use pid 1234 instead" both stops the stale call and steers the run.
 */
export function skipPendingForWorkspace(
  workspaceId: string,
  note: string
): number {
  const reason = `Skipped per your note: "${note.trim().slice(0, 200)}"`;
  let skipped = 0;
  for (const entry of pending.values()) {
    if (entry.workspaceId !== workspaceId) continue;
    skipped += 1;
    // resolve() unregisters itself, exactly like decide().
    entry.resolve({ approved: false, reason });
  }
  return skipped;
}

/* ------------------------------------------------------------------------
   Questions from the model.

   Same shape as approvals: the reply has to stop while a decision arrives on
   a separate request. Kept apart from approvals so a question can never be
   answered by an approval id, and so the timeouts can differ — a question is
   worth waiting longer for than a command prompt.
   ------------------------------------------------------------------------ */

export const QUESTION_TIMEOUT_MS = 15 * 60 * 1000;

interface PendingQuestion {
  id: string;
  resolve: (answer: string | null) => void;
}

const questions = new Map<string, PendingQuestion>();

/**
 * Registers a question and waits for the answer.
 *
 * Resolves with null rather than rejecting on timeout or abort, so an ignored
 * question ends the tool call cleanly instead of killing the whole reply.
 */
export function askQuestion(
  id: string,
  signal?: AbortSignal
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;

    const done = (answer: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      questions.delete(id);
      resolve(answer);
    };

    const timer = setTimeout(() => done(null), QUESTION_TIMEOUT_MS);

    const onAbort = () => done(null);
    signal?.addEventListener("abort", onAbort, { once: true });

    questions.set(id, { id, resolve: done });
  });
}

/** Applies the user's answer. Returns false if nothing was waiting. */
export function answerQuestion(id: string, answer: string): boolean {
  const entry = questions.get(id);
  if (!entry) return false;
  entry.resolve(answer);
  return true;
}

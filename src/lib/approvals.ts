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

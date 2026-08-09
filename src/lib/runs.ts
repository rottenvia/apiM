/**
 * Keeping a reply alive after the tab that asked for it has gone.
 *
 * The chat route used `req.signal` for everything, and the browser aborts
 * that the moment its tab is closed. So closing the tab — or navigating away,
 * or a laptop sleeping — killed a run that was thirty rounds in and still
 * working. What was already written stayed on disk, but the task stopped, and
 * finishing it meant resuming and paying for the rest again.
 *
 * That conflated two different events:
 *
 *   - the user pressed Stop, which means stop
 *   - the connection went away, which means nobody is watching
 *
 * The first must halt the work. The second must not: the agent is writing
 * files into a workspace on the user's own machine, and those files are the
 * point. A run continues to completion and checkpoints as it goes, so
 * reopening the chat shows the finished reply.
 *
 * This registry is what makes the distinction possible. A run is keyed by the
 * assistant message id, so the Stop button can reach it from a different
 * request than the one streaming.
 */

interface ActiveRun {
  /** Aborted only by an explicit stop, never by a dropped connection. */
  controller: AbortController;
  conversationId: string;
  startedAt: number;
}

const runs = new Map<string, ActiveRun>();

/**
 * How long a run may live without being stopped.
 *
 * A safety net rather than a policy: the agent loop has its own round and
 * continuation limits, so reaching this means something is genuinely stuck.
 * Without it a wedged run would hold a controller for the life of the
 * process.
 */
export const MAX_RUN_MS = 30 * 60 * 1000;

/** Registers a run and returns the signal the work should watch. */
export function beginRun(
  messageId: string,
  conversationId: string
): AbortSignal {
  // A retry of the same message replaces the old entry rather than leaking it.
  runs.get(messageId)?.controller.abort();

  const controller = new AbortController();
  runs.set(messageId, {
    controller,
    conversationId,
    startedAt: Date.now(),
  });

  sweep();
  return controller.signal;
}

/** Called when the run finishes, however it finished. */
export function endRun(messageId: string): void {
  runs.delete(messageId);
}

/**
 * Stop a run on purpose.
 *
 * Returns false when there is nothing to stop, which the route reports rather
 * than pretending it worked — a Stop that silently did nothing is worse than
 * an honest "that reply already finished".
 */
export function stopRun(messageId: string): boolean {
  const run = runs.get(messageId);
  if (!run) return false;
  run.controller.abort();
  runs.delete(messageId);
  return true;
}

/** Runs still going in a conversation, so a reopened tab can find them. */
export function activeRuns(conversationId: string): string[] {
  sweep();
  const out: string[] = [];
  for (const [id, run] of runs) {
    if (run.conversationId === conversationId) out.push(id);
  }
  return out;
}

export function isRunning(messageId: string): boolean {
  return runs.has(messageId);
}

/** Drop anything that has outlived the ceiling. */
function sweep(): void {
  const now = Date.now();
  for (const [id, run] of runs) {
    if (now - run.startedAt > MAX_RUN_MS) {
      run.controller.abort();
      runs.delete(id);
    }
  }
}

/** Visible for tests. */
export function runCount(): number {
  return runs.size;
}

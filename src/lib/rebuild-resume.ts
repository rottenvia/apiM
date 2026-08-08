import type { TranscriptMessage, ToolCall } from "@/lib/transcript";
import type { StoredMessage } from "@/lib/store";

/**
 * Rebuilding enough of an interrupted reply to carry on with it.
 *
 * Replies produced before `resumeState` existed cannot be replayed exactly:
 * the transcript that was sent upstream was never written to disk. For a
 * while that was taken to mean they could not be resumed at all.
 *
 * That was wrong, and it is worth being precise about why. What a stored
 * reply keeps is nearly everything that matters:
 *
 *   - `reasoningContent` — the model's actual thinking, verbatim
 *   - `content` — the prose it had written when it stopped
 *   - `timeline` — the order text and actions happened in
 *   - `toolEvents[].args` — the COMPLETE arguments of every tool call,
 *     which for a write_file includes the entire file it wrote
 *   - `toolEvents[].summary` — the outcome of each call
 *
 * The one genuine gap is what a *read* returned: `read_file`'s output was
 * never stored. But those files are still on disk, so the model can simply
 * read them again — one cheap round instead of redoing the whole task.
 *
 * So this reconstructs a transcript that is faithful about what happened and
 * honest about what is missing, rather than refusing to resume.
 */

/** Tools whose result is recoverable by running them again. */
const RE_READABLE = new Set([
  "read_file",
  "read_files",
  "list_files",
  "search_files",
]);

/**
 * A placeholder standing in for a result that was never saved.
 *
 * Deliberately explicit. A vague note would let the model assume it still had
 * the contents and describe a file it can no longer see; naming the gap and
 * the remedy keeps it honest.
 */
function missingResult(name: string, summary: string | undefined): string {
  const what = summary ? `${summary}. ` : "";
  if (RE_READABLE.has(name)) {
    return (
      `[${what}This ran successfully, but its output was not kept when the ` +
      `reply was interrupted. The workspace still has the files — call the ` +
      `tool again if you need what it returned.]`
    );
  }
  return (
    `[${what}This ran successfully. Its output was not kept when the reply ` +
    `was interrupted, but the action itself took effect.]`
  );
}

export interface RebuiltResume {
  messages: TranscriptMessage[];
  /** Tool calls whose results had to be replaced with a placeholder. */
  lostResults: number;
  /** Tool calls whose effect is still visible (writes, edits, deletes). */
  keptActions: number;
}

/**
 * Turn a stored, interrupted reply back into a usable transcript.
 *
 * `system` and the user's question are supplied by the caller, since those
 * are rebuilt from the live prompt rather than from storage.
 */
export function rebuildResumeFromStored(
  prior: StoredMessage
): RebuiltResume | null {
  const events = prior.toolEvents ?? [];
  const hasText = Boolean(prior.content?.trim());

  // Nothing to carry forward: no partial answer, no actions. Resuming would
  // be indistinguishable from asking again, so the caller should do that.
  if (!hasText && events.length === 0 && !prior.reasoningContent?.trim()) {
    return null;
  }

  const messages: TranscriptMessage[] = [];
  let lostResults = 0;
  let keptActions = 0;

  /*
   * Replay in the order things happened.
   *
   * `timeline` records that order; without it the text would be lumped either
   * before or after every action, which misrepresents a reply that narrated
   * as it worked. Falling back to "all tools, then all text" is only used
   * when there is no timeline to consult.
   */
  const byId = new Map(events.map((e) => [e.id, e]));
  const order: (
    | { kind: "text"; text: string }
    | { kind: "tool"; id: string }
  )[] =
    prior.timeline && prior.timeline.length
      ? prior.timeline
      : [
          ...events.map((e) => ({ kind: "tool" as const, id: e.id })),
          ...(hasText ? [{ kind: "text" as const, text: prior.content }] : []),
        ];

  // The reasoning belongs to the first assistant turn, which is the one the
  // model will continue from. Replaying it verbatim is also required by the
  // API once tool calls are present.
  let reasoningPending = prior.reasoningContent ?? null;
  let pendingText = "";

  const flushInto = (calls: ToolCall[]) => {
    messages.push({
      role: "assistant",
      content: pendingText || null,
      reasoning_content: reasoningPending,
      tool_calls: calls.length ? calls : undefined,
    });
    pendingText = "";
    reasoningPending = null;
  };

  let i = 0;
  while (i < order.length) {
    const entry = order[i];

    if (entry.kind === "text") {
      pendingText += entry.text;
      i += 1;
      continue;
    }

    // Consecutive tool entries were one round, so they are replayed as one
    // assistant turn with several calls — matching how they were issued.
    const batch: ToolCall[] = [];
    while (i < order.length && order[i].kind === "tool") {
      const id = (order[i] as { kind: "tool"; id: string }).id;
      const event = byId.get(id);
      i += 1;
      if (!event) continue;
      batch.push({
        id: event.id,
        type: "function",
        function: { name: event.name, arguments: event.args },
      });
    }
    if (batch.length === 0) continue;

    flushInto(batch);

    for (const call of batch) {
      const event = byId.get(call.id);
      const ok = event?.ok !== false;
      if (ok) {
        if (RE_READABLE.has(call.function.name)) lostResults += 1;
        else keptActions += 1;
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: ok
          ? missingResult(call.function.name, event?.summary)
          : `[${event?.summary ?? "This call failed"}.]`,
      });
    }
  }

  // Trailing prose with no action after it — the sentence it was cut off in.
  if (pendingText || reasoningPending) flushInto([]);

  if (messages.length === 0) return null;

  return { messages, lostResults, keptActions };
}

/**
 * What to tell the model when resuming from a rebuilt transcript.
 *
 * Separate from the exact-replay instruction because the situation is
 * genuinely different: some results above are placeholders, and pretending
 * otherwise is how a model ends up describing a file it never actually saw.
 */
export function rebuiltResumeInstruction(info: RebuiltResume): string {
  const parts = [
    "You were interrupted before finishing. Everything above is your own " +
      "work from that attempt: your reasoning, and every tool call you made " +
      "with its full arguments.",
  ];

  if (info.keptActions > 0) {
    parts.push(
      `The ${info.keptActions} file change(s) above already took effect and ` +
        `are on disk — do not redo them.`
    );
  }

  if (info.lostResults > 0) {
    parts.push(
      `The output of ${info.lostResults} read/search call(s) was not kept, ` +
        `and is shown as a placeholder. If you need any of it, call the tool ` +
        `again — the files are still there. Never describe the contents of ` +
        `something you can no longer see.`
    );
  }

  parts.push(
    "Check the workspace listing below for the current state, then continue " +
      "from where you stopped. If a file was only partly written, finish it " +
      "with edit_file rather than starting it again."
  );

  return parts.join(" ");
}

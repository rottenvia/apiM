/**
 * Keeping a long agent transcript from growing without bound.
 *
 * Every round resends the whole conversation, so the full text of a file read
 * on round three is paid for again on rounds four through forty. Once the
 * model has acted on that content it is dead weight — but the fact that the
 * read happened, and what it found, still matters.
 *
 * So old tool results are collapsed to a one-line placeholder rather than
 * removed. The model can still see the shape of what it did; if it genuinely
 * needs the content again it re-reads the file, which costs one round and
 * happens rarely.
 *
 * Three invariants this must never break, all of which produce a 400 from
 * DeepSeek if violated:
 *
 *   - every `tool_call` keeps a matching `tool` reply
 *   - `reasoning_content` stays verbatim on tool-calling assistant turns
 *   - the system prompt and the user's question are never touched
 */

import type { TranscriptMessage } from "@/lib/transcript";

/**
 * Recent rounds stay verbatim.
 *
 * The model is usually working with what it just read, so collapsing the last
 * few results would force an immediate re-read and cost more than it saved.
 *
 * This was 12, which quietly capped how much of a project the agent could
 * describe at once. Asked "what is in this zip and what is its full
 * structure", it would read thirty or forty files, and by the time it came
 * to answer, everything but the last twelve had been replaced with
 * "[earlier read_file result … collapsed]". The model was not being lazy and
 * had not lost the thread: the content really was gone from the request, so
 * it answered about the handful it could still see. Worse, it then had no
 * reason to believe the files existed at all, which is how a follow-up
 * question ended in "No ZIP in the workspace".
 *
 * 80 is sized for the model actually in use. DeepSeek v4 has a 1M-token
 * window; eighty reads of a few thousand characters is a few percent of it.
 */
export const KEEP_VERBATIM_RESULTS = 80;

/**
 * Only results above this size are worth collapsing.
 *
 * A short "wrote 12 lines" confirmation is already smaller than the
 * placeholder that would replace it.
 */
export const MIN_COLLAPSE_CHARS = 400;

/**
 * Leave the transcript alone until it is actually large.
 *
 * Pruning a short conversation saves nothing and only risks dropping context
 * the model still wants.
 *
 * This was 900_000 chars (~250k tokens). That was safe for cache economics
 * but unsafe for the context window: combined with tool-result caps of
 * 400k/200k chars, a handful of large reads could push the whole request past
 * DeepSeek's limit before pruning ever fired — which surfaced to the user as
 * "chat is too big for the model" mid-task.
 *
 * 360_000 chars is ~100k tokens: still a tenth of the 1M window, well above
 * anything an ordinary multi-file task reaches, and low enough that old tool
 * results are collapsed before they can threaten the limit. The most recent
 * KEEP_VERBATIM_RESULTS results are never touched, so "read all of these and
 * compare them" keeps working; pruning only replaces results older than that
 * with a one-line placeholder the model can re-read if it needs them.
 */
export const PRUNE_THRESHOLD_CHARS = 360_000;

export interface PruneStats {
  /** Tool results replaced with a placeholder. */
  collapsed: number;
  /** Characters removed from the transcript. */
  charsSaved: number;
  /** Rough token saving, at ~3.6 chars per token. */
  tokensSaved: number;
}

/** Total size of a transcript, for deciding whether pruning is worthwhile. */
export function transcriptChars(messages: TranscriptMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") total += m.content.length;
    if (m.role === "assistant") {
      total += m.reasoning_content?.length ?? 0;
      for (const call of m.tool_calls ?? []) {
        total += call.function.arguments.length + call.function.name.length;
      }
    }
  }
  return total;
}

/** Name of the tool a result belongs to, for a more useful placeholder. */
function toolNameFor(
  messages: TranscriptMessage[],
  toolCallId: string
): string {
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const call of m.tool_calls ?? []) {
      if (call.id === toolCallId) return call.function.name;
    }
  }
  return "tool";
}

/**
 * Summarise a collapsed result.
 *
 * Keeps the first line, which is nearly always the useful part — a path, a
 * status, or the start of an error — plus the size so the model knows how
 * much it is choosing not to look at.
 */
function placeholder(name: string, content: string): string {
  const lines = content.split("\n");
  const firstMeaningful = lines.find((l) => l.trim().length > 0) ?? "";
  const head = firstMeaningful.slice(0, 120).trim();

  const detail = head ? ` — ${head}` : "";
  return `[earlier ${name} result, ${lines.length} lines / ${content.length} chars, collapsed to save context${detail}. Call the tool again if you need the full output.]`;
}

/**
 * Collapse old tool results, leaving structure and recent context intact.
 *
 * Returns a new array; the input is not modified, so the stored transcript
 * keeps everything and only the copy sent upstream is reduced.
 */
export function pruneTranscript(
  messages: TranscriptMessage[],
  options: {
    keepVerbatim?: number;
    minChars?: number;
    thresholdChars?: number;
    /** Collapse every eligible old result regardless of transcript size. */
    force?: boolean;
  } = {}
): { messages: TranscriptMessage[]; stats: PruneStats } {
  const {
    keepVerbatim = KEEP_VERBATIM_RESULTS,
    minChars = MIN_COLLAPSE_CHARS,
    thresholdChars = PRUNE_THRESHOLD_CHARS,
    force = false,
  } = options;

  const empty: PruneStats = { collapsed: 0, charsSaved: 0, tokensSaved: 0 };

  if (!force && transcriptChars(messages) < thresholdChars) {
    return { messages, stats: empty };
  }

  // Index every tool result, newest last.
  const resultIndices: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "tool") resultIndices.push(i);
  });

  if (resultIndices.length <= keepVerbatim) {
    return { messages, stats: empty };
  }

  // Everything except the most recent `keepVerbatim` is a candidate.
  const collapsible = new Set(
    resultIndices.slice(0, resultIndices.length - keepVerbatim)
  );

  let collapsed = 0;
  let charsSaved = 0;

  const out = messages.map((m, i) => {
    if (m.role !== "tool" || !collapsible.has(i)) return m;
    if (m.content.length < minChars) return m;

    const name = toolNameFor(messages, m.tool_call_id);
    const replacement = placeholder(name, m.content);

    // Never grow a message by "shrinking" it.
    if (replacement.length >= m.content.length) return m;

    collapsed += 1;
    charsSaved += m.content.length - replacement.length;

    // Same role and tool_call_id, so the call/reply pairing is preserved.
    return { ...m, content: replacement };
  });

  return {
    messages: out,
    stats: {
      collapsed,
      charsSaved,
      tokensSaved: Math.round(charsSaved / 3.6),
    },
  };
}

/**
 * Every tool call has a reply and vice versa.
 *
 * Exported so tests can assert the property directly — a mismatch here is the
 * exact shape of the 400 that pruning could introduce.
 */
export function toolCallsAreBalanced(messages: TranscriptMessage[]): boolean {
  const called = new Set<string>();
  const replied = new Set<string>();

  for (const m of messages) {
    if (m.role === "assistant") {
      for (const call of m.tool_calls ?? []) called.add(call.id);
    } else if (m.role === "tool") {
      replied.add(m.tool_call_id);
    }
  }

  if (called.size !== replied.size) return false;
  for (const id of called) if (!replied.has(id)) return false;
  return true;
}

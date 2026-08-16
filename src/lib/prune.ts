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
 * How many of the most recent agent rounds keep ALL their tool results
 * verbatim, regardless of size.
 *
 * This is the number that matters for "can the model see the whole files it
 * just read?". A round is one assistant turn that called tools plus its tool
 * replies. The model is actively reasoning over whatever its last reads
 * returned, so collapsing any of it — even a 150k-character file — forces an
 * immediate re-read and costs a whole extra round. Keeping the last two
 * rounds whole covers the common shape: read several files, then act on them.
 *
 * Older rounds are still collapsed (see below), which is where the real
 * token saving happens: that 150k file only rides along verbatim while it is
 * in the active window, then becomes a one-line placeholder once the model
 * has moved on.
 */
export const KEEP_VERBATIM_ROUNDS = 2;

/**
 * How many of the most recent individual tool results are kept verbatim even
 * when they belong to rounds older than KEEP_VERBATIM_ROUNDS.
 *
 * Small confirmations ("Edited main.py", "Ran: pytest") are useful to keep
 * and cost almost nothing; this stops them being replaced by a placeholder
 * longer than the original. It is a count of RESULTS, not rounds, so a round
 * that read forty files still has the oldest of those forty become eligible
 * for collapse once enough newer results exist.
 */
export const KEEP_RECENT_RESULTS = 12;

/**
 * Results older than the verbatim window are only collapsed when they are at
 * least this big. A short confirmation is already smaller than the
 * placeholder that would replace it, so collapsing it would grow the
 * transcript rather than shrink it.
 */
export const MIN_COLLAPSE_CHARS = 1_500;

/**
 * Leave the transcript alone until it is actually large.
 *
 * Pruning a short conversation saves nothing and only risks dropping context
 * the model still wants. This is a soft trigger: once the transcript passes
 * it, old *large* results are collapsed (small ones stay). The active window
 * — the last couple of rounds — is never affected by this threshold.
 */
export const PRUNE_THRESHOLD_CHARS = 200_000;

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
 * Collapse old tool results, leaving the active window and recent context intact.
 *
 * Returns a new array; the input is not modified, so the stored transcript
 * keeps everything and only the copy sent upstream is reduced.
 *
 * The rule, in order:
 *
 *   1. Every tool result from the most recent KEEP_VERBATIM_ROUNDS assistant
 *      turns that called tools stays byte-for-byte, however large. This is
 *      what lets read_file return a whole file: the model gets the full
 *      content on the round it needs it and the rounds immediately after.
 *   2. The most recent KEEP_RECENT_RESULTS individual results stay verbatim
 *      even if they are older, so small confirmations are not replaced by a
 *      longer placeholder.
 *   3. Everything older and at least MIN_COLLAPSE_CHARS becomes a one-line
 *      placeholder the model can re-read if it needs to.
 */
export function pruneTranscript(
  messages: TranscriptMessage[],
  options: {
    keepVerbatimRounds?: number;
    keepRecentResults?: number;
    minChars?: number;
    thresholdChars?: number;
    /** Collapse every eligible old result regardless of transcript size. */
    force?: boolean;
  } = {}
): { messages: TranscriptMessage[]; stats: PruneStats } {
  const {
    keepVerbatimRounds = KEEP_VERBATIM_ROUNDS,
    keepRecentResults = KEEP_RECENT_RESULTS,
    minChars = MIN_COLLAPSE_CHARS,
    thresholdChars = PRUNE_THRESHOLD_CHARS,
    force = false,
  } = options;

  const empty: PruneStats = { collapsed: 0, charsSaved: 0, tokensSaved: 0 };

  if (!force && transcriptChars(messages) < thresholdChars) {
    return { messages, stats: empty };
  }

  // Walk the messages and tag each tool result with the index of the assistant
  // turn (round) that produced its call. The most recent N such rounds define
  // the active window whose results are never touched.
  let activeRound = -1;
  let roundCounter = 0;
  const resultRound = new Map<number, number>(); // message index -> round number
  const roundOfAssistant = new Map<number, number>(); // assistant msg index -> round
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant" && m.tool_calls?.length) {
      const r = roundCounter++;
      roundOfAssistant.set(i, r);
      activeRound = r;
    } else if (m.role === "tool") {
      resultRound.set(i, activeRound);
    }
  }

  const oldestVerbatimRound = activeRound - keepVerbatimRounds + 1;

  // Index every tool result, newest last, for the recent-results window.
  const resultIndices: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "tool") resultIndices.push(i);
  });

  // Most recent KEEP_RECENT_RESULTS stay verbatim regardless of round.
  const recentVerdatim = new Set(
    resultIndices.slice(Math.max(0, resultIndices.length - keepRecentResults))
  );

  let collapsed = 0;
  let charsSaved = 0;

  const out = messages.map((m, i) => {
    if (m.role !== "tool") return m;

    const round = resultRound.get(i) ?? -1;
    // Active window: never touch.
    if (round >= oldestVerbatimRound) return m;
    // Recent small results: keep.
    if (recentVerdatim.has(i)) return m;
    // Only collapse big old results.
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

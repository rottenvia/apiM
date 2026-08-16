import type { TranscriptMessage } from "@/lib/transcript";

/**
 * Folding finished agent rounds into a short narrative.
 *
 * Pruning already collapses old tool *results*, which was aimed at the
 * obvious cost: the text of files the model read. Measuring an actual run
 * showed that was the wrong target. On max thinking the model writes ~9k
 * tokens of reasoning per round, so after twenty rounds the transcript is
 * roughly:
 *
 *     reasoning      180k tokens   93%
 *     file contents   11k tokens    6%
 *     system prompt    3k tokens    1%
 *
 * Reasoning was never pruned at all, and it is resent in full on every
 * subsequent round. That is the drain.
 *
 * It cannot simply be deleted. DeepSeek's rules are specific:
 *
 *   - an assistant turn carrying `tool_calls` MUST replay its
 *     `reasoning_content`, or the request is a 400
 *   - an assistant turn with no tool calls has its `reasoning_content`
 *     ignored entirely
 *
 * So the legal move is to remove the whole round as a unit: drop the
 * `tool_calls` and the matching `tool` replies together, and put a plain
 * assistant message in their place describing what was done. With no tool
 * calls on it, the reasoning is no longer required — and no longer sent.
 *
 * The model keeps a truthful account of its own history; it just stops
 * re-reading its own deliberations about decisions it already made and acted
 * on.
 */

/**
 * Rounds left completely untouched at the end of the transcript.
 *
 * The most recent reasoning is the part that matters — it is where "what was
 * I in the middle of" lives, and it is what makes a resumed reply pick up
 * mid-thought rather than restarting. Older rounds have already turned into
 * actions that are visible in the summary.
 */
export const KEEP_RECENT_ROUNDS = 4;

/**
 * When finished rounds are folded into a summary.
 *
 * This is the SAFETY valve, not an economic optimization. The old analysis
 * (kept in git history) proved that, at the pre-2026-08-16 rates where a
 * cache hit was 120x cheaper than a miss, compaction never paid for itself
 * inside the 40-round ceiling — rewriting the prefix cost more than the
 * removed reasoning saved. That ratio is now ~30x, which changes the math at
 * the margins, but reasoning in the cached prefix is still by far the
 * cheapest text in the transcript, so compaction stays conservative.
 *
 * What it must do is stop the request from exceeding DeepSeek's 1M-token
 * window, which fails the whole call (the "chat is too big for the model"
 * error). With the per-tool output caps lowered (read_file 60k, fetch 80k),
 * runaway growth is mostly old reasoning. 900_000 chars (~250k tokens) leaves
 * three quarters of the window for the current round, the tools, and the
 * reply — and folding the oldest rounds reclaims the bulk of a long run
 * before it can hit the wall. The hard ceiling below is a second, larger
 * net for transcripts that grow despite this.
 *
 * `compactForResume` ignores this and always compacts, because a resume
 * rewrites the prefix exactly once with no cache to thrash.
 */
export const COMPACT_THRESHOLD_CHARS = 900_000;

/**
 * How far the compaction boundary jumps at a time.
 *
 * This exists for the prompt cache, not for tidiness. DeepSeek matches a
 * prefix from the start of the messages array, so anything that rewrites an
 * earlier message costs a full-price re-read of the request.
 *
 * A boundary of "everything except the last four rounds" would move forward
 * by one every single round, rewriting history each time and missing the
 * cache on every request — which would cost far more than the reasoning it
 * saved. Quantising to a step means the boundary stays put for several rounds
 * and only jumps occasionally, so one miss buys many cheap rounds.
 */
export const COMPACT_STEP = 8;

export interface CompactStats {
  /** Agent rounds folded into a summary. */
  rounds: number;
  /** Characters removed. */
  charsSaved: number;
  /** Rough token saving, at ~3.6 chars per token. */
  tokensSaved: number;
  /** Characters of reasoning specifically, which is the bulk of it. */
  reasoningChars: number;
}

const EMPTY: CompactStats = {
  rounds: 0,
  charsSaved: 0,
  tokensSaved: 0,
  reasoningChars: 0,
};

function sizeOf(messages: TranscriptMessage[]): number {
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

/** A short, factual description of one tool call and how it turned out. */
function describeCall(
  name: string,
  args: string,
  result: string | undefined
): string {
  let target = "";
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const path = parsed.path ?? parsed.paths ?? parsed.query ?? parsed.command;
    if (typeof path === "string") target = path;
    else if (Array.isArray(path)) target = path.slice(0, 3).join(", ");
  } catch {
    /* unparseable arguments still get a useful name */
  }

  // The first line of a result is nearly always the outcome — a path, a
  // status, or the start of an error.
  const firstLine = (result ?? "").split("\n").find((l) => l.trim()) ?? "";
  const outcome = firstLine.startsWith("Error")
    ? ` — failed: ${firstLine.slice(0, 80)}`
    : "";

  return `${name}${target ? `(${target})` : ""}${outcome}`;
}

/**
 * Compact everything except the most recent rounds.
 *
 * Returns a new array; the input is never modified, so the stored transcript
 * keeps the full history and only the copy sent upstream is reduced.
 */
export function compactTranscript(
  messages: TranscriptMessage[],
  options: {
    keepRecentRounds?: number;
    thresholdChars?: number;
    step?: number;
    /**
     * Fold every compactable round regardless of size.
     *
     * Used to recover from a context-length error: the request was already
     * rejected for being too big, so the size threshold must be bypassed and
     * as much reclaimed as possible in one pass.
     */
    force?: boolean;
  } = {}
): { messages: TranscriptMessage[]; stats: CompactStats } {
  const {
    keepRecentRounds = KEEP_RECENT_ROUNDS,
    thresholdChars = COMPACT_THRESHOLD_CHARS,
    step = COMPACT_STEP,
    force = false,
  } = options;

  if (!force && sizeOf(messages) < thresholdChars) return { messages, stats: EMPTY };

  // Index every assistant turn that called tools — one per agent round.
  const roundIndices: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "assistant" && m.tool_calls?.length) roundIndices.push(i);
  });

  const compactable = roundIndices.length - keepRecentRounds;
  if (compactable <= 0) return { messages, stats: EMPTY };

  // Quantised so the boundary — and therefore the cached prefix — only moves
  // every `step` rounds instead of on every request.
  const boundary = Math.floor(compactable / step) * step;
  if (boundary <= 0) return { messages, stats: EMPTY };

  const cutoff = new Set(roundIndices.slice(0, boundary));

  // Tool replies are looked up by id so a round's calls and results can be
  // removed together, which is what keeps the transcript balanced.
  const resultById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "tool") resultById.set(m.tool_call_id, m.content);
  }

  const out: TranscriptMessage[] = [];
  const removedToolIds = new Set<string>();
  let rounds = 0;
  let reasoningChars = 0;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    if (m.role === "tool") {
      // Dropped only if its call was folded away; otherwise kept as-is.
      if (!removedToolIds.has(m.tool_call_id)) out.push(m);
      continue;
    }

    if (m.role !== "assistant" || !cutoff.has(i)) {
      out.push(m);
      continue;
    }

    // A round being folded away.
    rounds += 1;
    reasoningChars += m.reasoning_content?.length ?? 0;

    const lines: string[] = [];
    for (const call of m.tool_calls ?? []) {
      removedToolIds.add(call.id);
      lines.push(
        `- ${describeCall(
          call.function.name,
          call.function.arguments,
          resultById.get(call.id)
        )}`
      );
    }

    // No tool_calls and no reasoning_content: with the calls gone the API no
    // longer requires the reasoning, and would ignore it if sent.
    const narration = m.content?.trim() ? `${m.content.trim()}\n` : "";
    out.push({
      role: "assistant",
      content: `${narration}[Earlier step, summarised to save context:\n${lines.join(
        "\n"
      )}]`,
    });
  }

  const before = sizeOf(messages);
  const after = sizeOf(out);
  const charsSaved = Math.max(0, before - after);

  return {
    messages: out,
    stats: {
      rounds,
      charsSaved,
      tokensSaved: Math.round(charsSaved / 3.6),
      reasoningChars,
    },
  };
}

/**
 * Compact a transcript being resumed, in one pass.
 *
 * Distinct from the live path because the trade-off is different. A resume
 * replays a whole finished attempt at once — twenty rounds of reasoning
 * arriving in a single request — and then continues from there, so the
 * prefix is rewritten exactly once and stays stable for everything after.
 * There is no cache to thrash, which means it is worth compacting harder and
 * without waiting for a size threshold.
 */
export function compactForResume(
  messages: TranscriptMessage[]
): { messages: TranscriptMessage[]; stats: CompactStats } {
  return compactTranscript(messages, {
    keepRecentRounds: KEEP_RECENT_ROUNDS,
    // Always worth doing: this is a one-off rewrite with no cache cost.
    thresholdChars: 0,
    // No quantising either, for the same reason.
    step: 1,
  });
}

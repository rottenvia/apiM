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
 * Don't compact below this size — and know why it moved twice.
 *
 * It started at 120_000 chars (~33k tokens), on the reasoning that reasoning
 * is 93% of a transcript and therefore worth removing. The first half of that
 * is true; the conclusion was wrong. Measured (`npm run cost:lab`), compaction
 * at DeepSeek's rates made a 40-round task MORE expensive:
 *
 *     compaction on   $0.5236
 *     compaction off  $0.4929
 *
 * The arithmetic nobody did: old reasoning sits in the cached prefix at
 * $0.003625/M — a hundred and twenty times less than fresh input. It is the
 * largest thing in the transcript and very nearly the cheapest, and compaction
 * rewrites the middle of that prefix, so everything after the edit point is
 * re-read at full price, once. At a 120x cache discount, break-even is 120+
 * rounds — so the threshold climbed (1.8M, then 600k) and folding became a
 * pure window safety valve.
 *
 * But 600k was tuned for the wrong model. GLM 5.3 Flash — the default —
 * caches on OpenRouter at roughly 1/5th, not 1/120th, so folding a head
 * larger than the kept tail breaks even in a couple of rounds. And cost was
 * never the binding constraint on this model; latency is. Every round
 * prefills the whole transcript before the first token: OpenRouter's
 * pre-flight prices that body cache-blind (402ing balances below an estimate
 * the round does not actually bill), and a Flash-tier model crawls through
 * 166k tokens of its own old deliberations for minutes before emitting a
 * word. The valve therefore caps the prefill at a size that answers fast:
 *
 *     160_000 chars ≈ ~44k tokens of prefill — seconds on Flash, not minutes.
 */
export const COMPACT_THRESHOLD_CHARS = 160_000;

/**
 * How far the compaction boundary jumps at a time.
 *
 * This exists for the prompt cache, not for tidiness: anything that rewrites
 * an earlier message stops the prefix matching and costs a one-time re-read.
 * Quantising the boundary means it stays put for several rounds and only
 * jumps occasionally, so one miss buys several cheap rounds.
 *
 * It was 8 — which quietly disabled the valve. Compactable rounds are
 * `rounds - KEEP_RECENT_ROUNDS`, and floor(compactable / 8) is zero until
 * twelve rounds exist, so a fat nine-round transcript sat unshaved even past
 * the threshold, and bodies swung between "just folded" and "fattened again"
 * as the boundary jumped — the round-to-round fast/slow the user felt. At the
 * default model's ~5x cache discount the re-read a step costs is cheap, so
 * the step drops to 4: the valve can bite at eight rounds, while the
 * boundary still holds still for four rounds at a time.
 */
export const COMPACT_STEP = 4;

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
  } = {}
): { messages: TranscriptMessage[]; stats: CompactStats } {
  const {
    keepRecentRounds = KEEP_RECENT_ROUNDS,
    thresholdChars = COMPACT_THRESHOLD_CHARS,
    step = COMPACT_STEP,
  } = options;

  if (sizeOf(messages) < thresholdChars) return { messages, stats: EMPTY };

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



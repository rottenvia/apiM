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
// How many of the MOST RECENT tool results stay verbatim. Everything older
// is eligible for collapse. This was 80, which is what made long reverse-
// engineering runs cost a fortune: a single decompiled .c is 100k+ chars and
// 80 of them resent every round is millions of tokens. Eight recent results
// is plenty for what the model is actively working on; older large outputs
// are collapsed to a preview below.
export const KEEP_VERBATIM_RESULTS = 8;

/**
 * Only results above this size are worth collapsing.
 *
 * A short "wrote 12 lines" confirmation is already smaller than the
 * placeholder that would replace it.
 */
// Anything larger than this in an older tool result gets collapsed. Kept low
// so a single big read/decompile/inspect_binary stops being re-billed on
// every later round.
export const MIN_COLLAPSE_CHARS = 1_500;

/**
 * Tool-call ARGUMENTS are the carrier nothing ever reduced.
 *
 * A write_file argument IS the file being written — one 300k-char Lua module
 * rides inside `tool_calls[].function.arguments` on every subsequent round,
 * invisible to result collapsing (which only touches `role: "tool"`) and to
 * compaction (which folds whole rounds, but only above its own valve). The
 * model already acted on its own arguments; the paired result records the
 * outcome. Stub past this cap, same as results.
 *
 * Wire-safe: the API validates the call/reply pairing, never the argument
 * string's content — unlike `reasoning_content`, which must stay verbatim
 * on tool-calling turns.
 */
export const MAX_VERBATIM_ARGS_CHARS = 2_000;

/**
 * Leave the transcript alone until it is actually large.
 *
 * Pruning a short conversation saves nothing and only risks dropping context
 * the model still wants.
 *
 * 24_000 chars is about 6.7k tokens — two thirds of one percent of DeepSeek
 * v4's million-token window. It was sized for a 128k model and never revised,
 * so in practice pruning was always on: any conversation that read more than
 * a couple of files immediately started losing them. Reading a medium source
 * file could trip it on its own.
 *
 * 900_000 chars is ~250k tokens, a quarter of the window. Below that the
 * whole transcript is sent verbatim, which is what makes "read all of these
 * and compare them" work at all.
 */
// Start pruning as soon as the transcript is non-trivial. The old 900k char
// threshold meant pruning only switched on after ~250k tokens had already
// accumulated - by then every round was re-sending giant decompiles. With
// the aggressive collapse below, pruning early is safe: small/recent results
// are preserved, only old LARGE outputs become previews.
export const PRUNE_THRESHOLD_CHARS = 24_000;

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
/**
 * A collapsed tool result still carries enough to be useful without being
 * re-billed in full: its size, the first non-trivial line(s), and any file
 * paths or "VERDICT:" lines it mentioned. A 100k-char decompile becomes a
 * 600-char pointer, but the model can still see which file it was and what
 * it concluded - which is what stops it re-reading the same file.
 */
function placeholder(name: string, content: string): string {
  const lines = content.split("\n");
  const meaningful = lines.filter((l) => l.trim().length > 0);
  const head = meaningful.slice(0, 3).map((l) => l.trim().slice(0, 160)).join(" | ");
  const paths = Array.from(
    new Set(
      (content.match(/[\w./\\-]+\.(?:c|cpp|h|hpp|cs|ts|js|py|json|md|txt|sln|vcxproj|dll|exe)\b/gi) ?? [])
        .slice(0, 6)
    )
  ).join(", ");
  const verdict = meaningful.find((l) => /verdict|conclusion|found|proves?|^- \[/.test(l))?.trim().slice(0, 200);

  const bits = [
    `${lines.length} lines / ${content.length} chars`,
    head ? `starts: ${head}` : "",
    paths ? `files: ${paths}` : "",
    verdict ? `note: ${verdict}` : "",
  ].filter(Boolean);
  return `[earlier ${name} result collapsed to save context — ${bits.join("; ")}. Re-run the tool or read the listed file if you need the full text.]`;
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
  } = {}
): { messages: TranscriptMessage[]; stats: PruneStats } {
  const {
    keepVerbatim = KEEP_VERBATIM_RESULTS,
    minChars = MIN_COLLAPSE_CHARS,
    thresholdChars = PRUNE_THRESHOLD_CHARS,
  } = options;

  const empty: PruneStats = { collapsed: 0, charsSaved: 0, tokensSaved: 0 };

  if (transcriptChars(messages) < thresholdChars) {
    return { messages, stats: empty };
  }

  // Index every tool result, newest last.
    const resultIndices: number[] = [];
    messages.forEach((m, i) => {
      if (m.role === "tool") resultIndices.push(i);
    });

    // Result collapsing needs old results to exist; argument stubbing does not.
    // One fat write_file in a young run is exactly the case that used to ride
    // every later round as a 300k-char body, so the args pass must run even
    // when every result is still inside the verbatim window.
    const collapsible =
      resultIndices.length <= keepVerbatim
        ? new Set<number>()
        : new Set(resultIndices.slice(0, resultIndices.length - keepVerbatim));

  let collapsed = 0;
  let charsSaved = 0;

  const out = messages.map((m, i) => {
      if (m.role === "tool") {
        if (!collapsible.has(i)) return m;
        if (m.content.length < minChars) return m;

        const name = toolNameFor(messages, m.tool_call_id);
        const replacement = placeholder(name, m.content);

        // Never grow a message by "shrinking" it.
        if (replacement.length >= m.content.length) return m;

        collapsed += 1;
        charsSaved += m.content.length - replacement.length;

        // Same role and tool_call_id, so the call/reply pairing is preserved.
        return { ...m, content: replacement };
      }

      if (m.role === "assistant" && m.tool_calls?.length) {
        // Fat arguments stub regardless of recency: the model never needs its
        // own JSON back, and one 300k write_file blob re-billed on every later
        // round is what turned small follow-up questions into 900k-char bodies.
        let touched = false;
        const calls = m.tool_calls.map((call) => {
          const args = call.function.arguments;
          if (args.length <= MAX_VERBATIM_ARGS_CHARS) return call;
          /*
           * A valid JSON object — never truncated JSON plus prose.
           *
           * The old stub glued "\n…[arguments trimmed…]" onto cut-off JSON,
           * which does not parse, and the OpenRouter gateway validates every
           * tool call's arguments strictly: one stubbed write_file deep in
           * history 400s the whole body ("control character found while
           * parsing a string"). DeepSeek tolerates the garbage, which is why
           * it stayed invisible until Nemotron. The head keeps the call
           * identifiable (path/command lead the args); the surrogate guard
           * keeps the cut from splitting an astral character in two.
           */
          let head = args.slice(0, 400);
          const last = head.charCodeAt(head.length - 1);
          if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
          const trimmed = JSON.stringify({
            _trimmed: true,
            _note:
              "arguments trimmed from history — this call already ran; its paired result records what it did",
            _head: head,
          });
          touched = true;
          charsSaved += args.length - trimmed.length;
          return {
            ...call,
            function: { ...call.function, arguments: trimmed },
          };
        });
        return touched ? { ...m, tool_calls: calls } : m;
      }

      return m;
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

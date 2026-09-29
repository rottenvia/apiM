/**
 * Rolling summary of older conversation turns.
 *
 * Cross-turn history used to replay verbatim: the last 20 messages in full,
 * on every request of every run, with no size cap. A finished task is not
 * context — it is archaeology — and replaying it costs twice: the bytes on
 * every request, and the model's attention spread over dead work (including
 * failed attempts it then pattern-matches onto).
 *
 * The split this draws:
 *
 *   - the newest turns ride verbatim, exactly as before;
 *   - everything older is covered by a stored summary a cheap helper model
 *     keeps current, recording state (goal, decisions, what exists now) —
 *     the "understand what it is making" half LO asked for;
 *   - turns the helper has not covered yet ALSO ride verbatim, so nothing
 *     is ever silently missing: the window stretches over the backlog and
 *     only caps at the old 20-message behaviour when the helper is down.
 *
 * Refreshing is amortised: a helper call happens only once the uncovered
 * backlog passes a trigger, and a giant paste is summarised exactly once —
 * on the first request after it leaves the verbatim window.
 */

import type { StoredAttachment } from "@/lib/multimodal";

/** Newest messages that always ride verbatim. */
export const HISTORY_VERBATIM_TURNS = 8;

/**
 * Stretched cap when the helper is down.
 *
 * Uncovered overflow rides verbatim too, so a dead helper degrades to the
 * old last-20 replay instead of dropping turns. 20 is the pre-summary
 * behaviour, kept as the ceiling on purpose.
 */
export const HISTORY_VERBATIM_MAX = 20;

/** Uncovered backlog chars that trigger a refresh. */
export const SUMMARY_TRIGGER_CHARS = 4000;

/**
 * Uncovered backlog turns that trigger a refresh even when small.
 *
 * Without this, a run of "thanks"/"ok" turns would stretch the window to
 * the cap and then fall off it unsummarised — silent loss. Six short turns
 * are worth one cheap call to keep the cursor moving.
 */
export const SUMMARY_TRIGGER_TURNS = 6;

/** Largest digest ever handed to the helper in one call. */
export const SUMMARY_DIGEST_MAX_CHARS = 60000;

/** One turn's share of the digest — a giant paste is head-truncated. */
const SUMMARY_TURN_MAX_CHARS = 20000;

/** Stored summaries never grow past this, however long the chat. */
export const SUMMARY_TEXT_MAX_CHARS = 4000;

/**
 * First line of the injected summary block, and the request-size bucket key.
 * request-size.ts attributes any system message starting with this to the
 * "summary" bucket, so the receipt line proves the compaction worked.
 */
export const HISTORY_SUMMARY_MARKER = "[Conversation summary — older turns]";

/** One replayable turn with its stable id, so a cursor can point past it. */
export interface ScopedHistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: StoredAttachment[] | null;
  note?: boolean;
}

/** Stored per conversation; `upToId` is the last turn this covers. */
export interface StoredHistorySummary {
  text: string;
  upToId: string;
  /**
   * Turns permanently outside both summary and window.
   *
   * Only migration monsters hit this: overflow beyond the digest cap on the
   * first summarised request. They were beyond the old 20-window too, so
   * this is status-quo-or-better — but the count persists so the transcript
   * stays honest about it instead of silently pretending full coverage.
   */
  droppedTurns: number;
  updatedAt: string;
  /**
   * Set by /compact: the user asked for everything up to the cursor to
   * leave context, the newest turns included. Automatic refreshes only ever
   * cover turns already outside the verbatim window.
   */
  manual?: boolean;
  /** Turns the summary stands in for, for the "compacted" divider. */
  coveredTurns?: number;
}

export interface HistoryShape {
  /** What rides verbatim: newest turns plus uncovered backlog, capped. */
  verbatim: ScopedHistoryMessage[];
  /** Uncovered overflow, oldest first — the refresh backlog. */
  pending: ScopedHistoryMessage[];
  stored: StoredHistorySummary | null;
}

/**
 * Split the full replayable history into verbatim window, backlog, and the
 * stored summary covering everything before the backlog.
 *
 * A stale cursor (message deleted, summary from another branch) re-covers
 * the whole overflow rather than trusting a boundary that no longer exists.
 */
export function shapeHistory(
  messages: ScopedHistoryMessage[],
  stored: StoredHistorySummary | null
): HistoryShape {
  /*
   * Turns after the cursor are the only candidates. An automatic summary's
   * cursor always sits in the overflow, so this is the old split; a /compact
   * cursor can be the newest turn, and then nothing before it rides
   * verbatim — that is what the user asked for.
   */
  const covered = stored
    ? messages.findIndex((m) => m.id === stored.upToId)
    : -1;
  const open = covered >= 0 ? messages.slice(covered + 1) : messages;
  const tail = open.slice(-HISTORY_VERBATIM_TURNS);
  const pending = open.slice(0, open.length - tail.length);
  const verbatim = [...pending, ...tail].slice(-HISTORY_VERBATIM_MAX);
  return { verbatim, pending, stored };
}

/** True once the uncovered backlog is worth one cheap helper call. */
export function shouldRefreshHistorySummary(
  pending: ScopedHistoryMessage[]
): boolean {
  if (pending.length === 0) return false;
  if (pending.length >= SUMMARY_TRIGGER_TURNS) return true;
  let chars = 0;
  for (const m of pending) chars += m.content?.length ?? 0;
  return chars >= SUMMARY_TRIGGER_CHARS;
}

function attachmentMarker(a: StoredAttachment): string {
  const desc =
    typeof a.description === "string" && a.description.trim()
      ? `: "${a.description.trim().slice(0, 200)}"`
      : "";
  return `[${a.kind} ${a.name}${desc}]`;
}

function renderDigestTurn(m: ScopedHistoryMessage): string {
  const who = m.role === "user" ? "USER" : "ASSISTANT";
  // No [mid-task note] tag: by the time a turn reaches the digest its run
  // is over, and a live-framed correction would nag the summary forever.
  // The summarizer's "state, not story" rule washes solved steering out.
  let text = m.content ?? "";
  if (text.length > SUMMARY_TURN_MAX_CHARS) {
    text =
      text.slice(0, SUMMARY_TURN_MAX_CHARS) +
      `\n…[turn truncated, ${text.length - SUMMARY_TURN_MAX_CHARS} more chars]…`;
  }
  const media = (m.attachments ?? []).map(attachmentMarker).join(" ");
  return `${who}: ${text}${media ? `\nShared: ${media}` : ""}`;
}

export interface SummaryDigest {
  text: string;
  /** Pending turns covered by the digest. */
  included: number;
  /** Pending turns that did not fit — counted, not silently lost. */
  dropped: number;
}

/**
 * Render the backlog oldest-first for the helper, newest first to fit.
 *
 * Newest-first fill keeps the digest adjacent to the verbatim window: the
 * turns a summary abuts are the ones it must dovetail with. Always covers
 * at least the newest turn, truncated to the cap if it is itself enormous.
 */
export function buildSummaryDigest(
  pending: ScopedHistoryMessage[]
): SummaryDigest {
  if (pending.length === 0) return { text: "", included: 0, dropped: 0 };
  const rendered = pending.map(renderDigestTurn);
  const kept: string[] = [];
  let chars = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const line = rendered[i];
    if (chars + line.length > SUMMARY_DIGEST_MAX_CHARS && kept.length > 0) {
      break;
    }
    kept.unshift(
      chars + line.length > SUMMARY_DIGEST_MAX_CHARS
        ? line.slice(0, SUMMARY_DIGEST_MAX_CHARS - chars)
        : line
    );
    chars += kept[0].length;
    if (chars >= SUMMARY_DIGEST_MAX_CHARS) break;
  }
  return {
    text: kept.join("\n\n"),
    included: kept.length,
    dropped: pending.length - kept.length,
  };
}

const SUMMARY_SYSTEM = `You maintain the running summary of a long chat with an AI coding assistant, so older turns can leave context without losing what matters.

You get PREVIOUS SUMMARY (may be empty) and NEW TURNS, oldest first.

Update the summary. Record only what is durable:
- the current goal and its state (what is done, what is open)
- decisions made and why
- files or systems created or changed, with paths
- proven facts about this project (commands, paths, quirks that bit)
- preferences the user stated
- open threads and unfinished items

Do NOT record: play-by-play, failed attempts (unless they proved a durable fact above), pleasantries, verbatim code (describe it and name the path).

State, not story: write what is TRUE NOW, not what happened. Keep under 300 words. Plain text, short lines, no headers. If the new turns add nothing durable, return the previous summary unchanged.`;

export interface HistorySummaryCredentials {
  apiKey: string;
  baseUrl: string;
  model: string;
  thinkingStyle: "deepseek" | "openai" | "qwen";
}

export interface HistorySummaryResult {
  text: string;
  droppedTurns: number;
  /** Tokens spent, so the cost of remembering is never hidden. */
  usage: { prompt_tokens: number; completion_tokens: number } | null;
}

/**
 * Roll the backlog into the stored summary with a cheap helper model.
 *
 * Mirrors runRefine's contract: thinking disabled (extraction, not
 * reasoning), small output cap, and failures return null instead of
 * throwing — a missed refresh just stretches the verbatim window until the
 * next request retries it.
 */
export async function runHistorySummary(
  previous: string | null,
  pending: ScopedHistoryMessage[],
  creds: HistorySummaryCredentials,
  signal?: AbortSignal,
  options: {
    /** Replaces the default system prompt (the /compact variant). */
    system?: string;
    maxTokens?: number;
    maxChars?: number;
    /** Extra request fields: thinking switches, endpoint pins. */
    extraBody?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {}
): Promise<HistorySummaryResult | null> {
  if (pending.length === 0) return null;
  const digest = buildSummaryDigest(pending);

  try {
    const res = await fetch(`${creds.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.apiKey}`,
        ...options.headers,
      },
      signal,
      body: JSON.stringify({
        model: creds.model,
        ...(creds.thinkingStyle === "deepseek"
          ? { thinking: { type: "disabled" } }
          : {}),
        ...options.extraBody,
        max_tokens: options.maxTokens ?? 700,
        messages: [
          { role: "system", content: options.system ?? SUMMARY_SYSTEM },
          {
            role: "user",
            content:
              (previous ? `PREVIOUS SUMMARY:\n${previous}\n\n` : "") +
              `NEW TURNS:\n${digest.text}`,
          },
        ],
      }),
    });

    if (!res.ok) return null;

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const raw = body.choices?.[0]?.message?.content ?? "";
    if (!raw.trim()) return null;

    return {
      text: raw.trim().slice(0, options.maxChars ?? SUMMARY_TEXT_MAX_CHARS),
      droppedTurns: digest.dropped,
      usage:
        typeof body.usage?.prompt_tokens === "number" &&
        typeof body.usage?.completion_tokens === "number"
          ? {
              prompt_tokens: body.usage.prompt_tokens,
              completion_tokens: body.usage.completion_tokens,
            }
          : null,
    };
  } catch {
    return null;
  }
}

/** The system block injected ahead of the verbatim window. */
export function renderHistorySummary(summary: StoredHistorySummary): string {
  const dropped =
    summary.droppedTurns > 0
      ? `\n(${summary.droppedTurns} oldest turn${summary.droppedTurns === 1 ? "" : "s"} predate${summary.droppedTurns === 1 ? "s" : ""} this summary and ${summary.droppedTurns === 1 ? "is" : "are"} not in context.)`
      : "";
  return `${HISTORY_SUMMARY_MARKER}\n${summary.text}${dropped}`;
}

/** Stored /compact summaries may be longer: they replace the whole chat. */
export const COMPACT_TEXT_MAX_CHARS = 12_000;

/** Turns-worth of digest per /compact helper call; longer chats roll. */
const COMPACT_CHUNK_CHARS = SUMMARY_DIGEST_MAX_CHARS;

/** Beyond this many rolls the oldest turns are counted, not summarised. */
const COMPACT_MAX_CHUNKS = 8;

/** The /compact prompt: the summary becomes the whole conversation. */
export function compactSystemPrompt(instructions?: string): string {
  const focus = instructions?.trim()
    ? `\n\nThe user asked this compaction to focus on: ${instructions.trim().slice(0, 500)}`
    : "";
  return `You are compacting a chat between a user and an AI coding assistant. Your summary REPLACES the conversation: after this, the assistant sees only your summary plus new messages, so anything you leave out is forgotten.

You get PREVIOUS SUMMARY (may be empty) and NEW TURNS, oldest first.

Write the updated summary with these parts, as short plain-text lines:
- Goal: what the user is ultimately trying to get done, in their terms.
- Current state: what is done and working, what is half-done, what is broken.
- Files and systems: every file, command, URL or service that matters, with exact paths and names.
- Decisions and constraints: choices made and why; requirements and preferences the user stated.
- Facts learned: errors and their fixes, quirks, values that were verified.
- Next steps: what was about to happen, and any question left open.

Keep exact identifiers (paths, function names, versions, error strings) verbatim. No play-by-play, no pleasantries, no code beyond short identifiers. Up to 800 words.${focus}`;
}

/**
 * Split every uncovered turn into digest-sized chunks, oldest first.
 *
 * /compact must cover the WHOLE conversation, and one digest holds 60k
 * chars — the automatic refresh would drop the rest. Chunks roll through
 * the summary in order, so the oldest material is folded first and the
 * newest turns are the last thing the summary absorbs.
 */
export function compactChunks(
  turns: ScopedHistoryMessage[]
): { chunks: ScopedHistoryMessage[][]; skipped: number } {
  const chunks: ScopedHistoryMessage[][] = [];
  let current: ScopedHistoryMessage[] = [];
  let chars = 0;
  for (const turn of turns) {
    const size = Math.min(turn.content?.length ?? 0, SUMMARY_TURN_MAX_CHARS) + 40;
    if (current.length > 0 && chars + size > COMPACT_CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(turn);
    chars += size;
  }
  if (current.length) chunks.push(current);
  if (chunks.length <= COMPACT_MAX_CHUNKS) return { chunks, skipped: 0 };
  const dropped = chunks.slice(0, chunks.length - COMPACT_MAX_CHUNKS);
  return {
    chunks: chunks.slice(-COMPACT_MAX_CHUNKS),
    skipped: dropped.reduce((n, c) => n + c.length, 0),
  };
}

/** Chars a history window occupies on the wire, for before/after figures. */
export function historyChars(
  turns: ScopedHistoryMessage[],
  summary: StoredHistorySummary | null
): number {
  let chars = summary ? renderHistorySummary(summary).length : 0;
  for (const t of turns) chars += (t.content?.length ?? 0) + 16;
  return chars;
}

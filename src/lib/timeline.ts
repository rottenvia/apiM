import type { ToolEvent } from "@/components/ToolActivity";

/**
 * One thing that happened in a reply, in order.
 *
 * `think` is a round's reasoning, stored as a character range into the
 * message's `reasoningContent` rather than as text: reasoning is the bulk of
 * a long run (megabytes over an hour) and is fetched lazily for stored chats,
 * so copying it into the eagerly-loaded timeline would double it and defeat
 * the lazy load.
 */
export type TimelineEntry =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string }
  | { kind: "think"; start: number; end: number };

export interface TimelineRow {
  text: string;
  tools: ToolEvent[];
  /**
   * Set on a reasoning row: the range of `reasoningContent` this round
   * thought. A reasoning row carries no text and no tools of its own.
   */
  think?: { start: number; end: number };
}

/**
 * Record `reasoningContent[start, end)` as the reasoning happening now.
 *
 * Extends the trailing think entry when the new range continues it (the same
 * burst, split across stream frames), otherwise opens a new one — a new
 * round, or reasoning resuming after prose or a tool. Mutates and returns
 * `timeline`, so the server can use it in place and the client on a copy.
 */
export function appendThinkRange(
  timeline: TimelineEntry[],
  start: number,
  end: number
): TimelineEntry[] {
  if (end <= start) return timeline;
  const last = timeline[timeline.length - 1];
  if (last && last.kind === "think" && last.end === start) {
    timeline[timeline.length - 1] = { kind: "think", start: last.start, end };
  } else {
    timeline.push({ kind: "think", start, end });
  }
  return timeline;
}

/** Does this timeline place reasoning in-line (newer replies do)? */
export function timelineHasThinking(
  timeline: TimelineEntry[] | null | undefined
): boolean {
  return Boolean(timeline?.some((e) => e.kind === "think"));
}

/**
 * True when the text contains a markdown table.
 *
 * GFM table rows start with `|` in column one; a separator line alone
 * (`|---|---|`) does it too, which is the whole of a table with no body yet.
 * Used to decide whether a row may share its line with a tool column — a
 * table squeezed into the left column beside the vertical divider reads as
 * the line running through the table, so table rows take the full width and
 * their tools stack below instead.
 */
export function textHasTable(text: string): boolean {
  return /^\s*\|/m.test(text);
}

/**
 * Groups a reply into rows of "what was said" and "what was done".
 *
 * Kept out of the component so it can be tested directly — the ordering is
 * the entire feature, and a subtle grouping bug would only show as a UI that
 * looks vaguely wrong.
 */
export function buildTimelineRows(
  timeline: TimelineEntry[],
  toolEvents: ToolEvent[]
): TimelineRow[] {
  const byId = new Map(toolEvents.map((e) => [e.id, e]));
  const rows: TimelineRow[] = [];

  for (const entry of timeline) {
    if (entry.kind === "think") {
      // Reasoning is its own row, in the place it happened: after the tools
      // of the previous round and before the narration and tools it led to.
      const last = rows[rows.length - 1];
      if (last?.think && last.think.end === entry.start) {
        last.think = { start: last.think.start, end: entry.end };
      } else {
        rows.push({ text: "", tools: [], think: { start: entry.start, end: entry.end } });
      }
    } else if (entry.kind === "text") {
      const last = rows[rows.length - 1];
      // Continue the current row while it has no actions yet: text arrives in
      // fragments as it streams, and a new row per fragment would shred a
      // paragraph into one line each.
      if (last && !last.think && last.tools.length === 0) last.text += entry.text;
      else rows.push({ text: entry.text, tools: [] });
    } else {
      const event = byId.get(entry.id);
      // An id with no matching event means the result never arrived — skip it
      // rather than rendering a blank action.
      if (!event) continue;
      if (rows.length === 0 || rows[rows.length - 1].think) {
        rows.push({ text: "", tools: [] });
      }
      rows[rows.length - 1].tools.push(event);
    }
  }

  return rows;
}

import type { ToolEvent } from "@/components/ToolActivity";

export type TimelineEntry =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string };

export interface TimelineRow {
  text: string;
  tools: ToolEvent[];
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
    if (entry.kind === "text") {
      const last = rows[rows.length - 1];
      // Continue the current row while it has no actions yet: text arrives in
      // fragments as it streams, and a new row per fragment would shred a
      // paragraph into one line each.
      if (last && last.tools.length === 0) last.text += entry.text;
      else rows.push({ text: entry.text, tools: [] });
    } else {
      const event = byId.get(entry.id);
      // An id with no matching event means the result never arrived — skip it
      // rather than rendering a blank action.
      if (!event) continue;
      if (rows.length === 0) rows.push({ text: "", tools: [] });
      rows[rows.length - 1].tools.push(event);
    }
  }

  return rows;
}

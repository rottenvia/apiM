import type { ToolEvent } from "@/components/ToolActivity";

export type TimelineEntry =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string };

export interface TimelineRow {
  text: string;
  tools: ToolEvent[];
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

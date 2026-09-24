"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ToolActivity } from "@/components/ToolActivity";
import type { ToolEvent } from "@/components/ToolActivity";
import { buildTimelineRows, textHasTable } from "@/lib/timeline";
import type { TimelineEntry } from "@/lib/timeline";

export type { TimelineEntry } from "@/lib/timeline";

/**
 * Narration on the left, actions on the right, in the order they happened.
 *
 * The model talks between tool calls, so "I'll create the file" and the write
 * that followed belong together. Concatenating all the prose into one block
 * loses that pairing — which is the only part worth reading when a reply
 * touched six files.
 */
/**
 * Shallow tool-list equality for row memoisation.
 *
 * buildTimelineRows pushes the toolEvents elements themselves (not copies)
 * into rows, so a completed row's tools keep their identity across stream
 * frames while the parent rebuilds the row objects every time.
 */
function sameTools(a: ToolEvent[], b: ToolEvent[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const TimelineRow = memo(function TimelineRow({
  text,
  tools,
  first,
  plain,
  onOpenFile,
  markdownComponents,
}: {
  text: string;
  tools: ToolEvent[];
  /** First row: no separator rule above it. */
  first: boolean;
  /**
   * Render narration as plain text, no markdown parse. While the reply is
   * streaming every frame grows the trailing row; parsing the whole row's
   * markdown per frame is what made a fast model feel slow (a 20KB reply
   * costs ~36ms per full re-parse, every 16ms frame). Formatting snaps in
   * once, when the stream ends.
   */
  plain?: boolean;
  onOpenFile?: (path: string) => void;
  markdownComponents?: React.ComponentProps<typeof ReactMarkdown>["components"];
}) {
        const hasText = text.trim().length > 0;
        const hasTools = tools.length > 0;
        if (!hasText && !hasTools) return null;

        // A table is isolated, not split beside the tool column. Squeezed
        // into the left column it ends up a fraction of its natural width
        // with the vertical divider running alongside its cells, which reads
        // as the rule cutting straight through the table. Full width gives
        // the table the whole line; the row's tools stack below it.
        const split = hasText && hasTools && !textHasTable(text);

        return (
          <div
            className={`grid gap-y-2 ${
              // Only split when there is something on both sides. A row that
              // is only prose uses the full width, so ordinary paragraphs
              // don't end up in a narrow column beside nothing.
              split
                ? "gap-x-0 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,20rem)]"
                : "grid-cols-1"
              /*
               * A rule between rows, not just above the first.
               *
               * Only one separator was ever drawn — above the whole timeline
               * — so every row after it ran straight into the next with
               * nothing but padding between them. The vertical divider inside
               * a row then read as the only structure on screen, which is why
               * the layout looked like disconnected columns rather than a
               * sequence of steps.
               */
            } ${!first ? "mt-4 border-t border-border/60 pt-4" : ""}`}
          >
            {hasText && (
              <div
                className={`prose-chat min-w-0 break-words text-[15px] leading-relaxed text-text-primary ${
                  // Wider gutter than the divider's own spacing, so a long
                  // line ends clear of the rule instead of touching it, and
                  // break-words so an unbroken token wraps rather than
                  // spilling across it.
                  split ? "md:pr-6" : ""
                }`}
              >
                {plain ? (
                  <div className="whitespace-pre-wrap">{text}</div>
                ) : (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={markdownComponents}
                  >
                    {text}
                  </ReactMarkdown>
                )}
              </div>
            )}

            {/* The divider is its own grid column rather than a border on the
                prose, so it spans the full height of the taller side and the
                two columns read as genuinely separate. Hidden below md,
                where the layout stacks and a vertical rule would sit across
                the content. */}
            {split && (
              <span
                className="hidden w-px self-stretch bg-border md:block"
                aria-hidden="true"
              />
            )}

            {hasTools && (
              <div className={`min-w-0 ${split ? "md:pl-6" : ""}`}>
                <ToolActivity events={tools} onOpenFile={onOpenFile} />
              </div>
            )}
          </div>
        );
}, (prev, next) =>
  prev.text === next.text &&
  prev.first === next.first &&
  prev.plain === next.plain &&
  prev.onOpenFile === next.onOpenFile &&
  prev.markdownComponents === next.markdownComponents &&
  sameTools(prev.tools, next.tools)
);

export function MessageTimeline({
  timeline,
  toolEvents,
  onOpenFile,
  markdownComponents,
  plain,
}: {
  timeline: TimelineEntry[];
  toolEvents: ToolEvent[];
  onOpenFile?: (path: string) => void;
  markdownComponents?: React.ComponentProps<typeof ReactMarkdown>["components"];
  /** Narration renders as plain text while the reply streams (see TimelineRow). */
  plain?: boolean;
}) {
  const rows = buildTimelineRows(timeline, toolEvents);

  if (rows.length === 0) return null;

  return (
    /*
     * No ornamental rule above the first action.
     *
     * In the reported tool-only reply the screen was: effort/tokens, one
     * full-width line, then `fetch_url`. With the reasoning panel absent, that
     * line looked exactly like a collapsed/broken thinking box. Rows after the
     * first still separate themselves below; the first needs no page break.
     */
    <div className="flex flex-col">
      {rows.map((row, i) => (
        <TimelineRow
          key={i}
          text={row.text}
          tools={row.tools}
          first={i === 0}
          plain={plain}
          onOpenFile={onOpenFile}
          markdownComponents={markdownComponents}
        />
      ))}
    </div>
  );
}

"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ToolActivity } from "@/components/ToolActivity";
import type { ToolEvent } from "@/components/ToolActivity";
import { buildTimelineRows } from "@/lib/timeline";
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
export function MessageTimeline({
  timeline,
  toolEvents,
  onOpenFile,
  markdownComponents,
}: {
  timeline: TimelineEntry[];
  toolEvents: ToolEvent[];
  onOpenFile?: (path: string) => void;
  markdownComponents?: React.ComponentProps<typeof ReactMarkdown>["components"];
}) {
  const rows = buildTimelineRows(timeline, toolEvents);

  if (rows.length === 0) return null;

  return (
    // A short rule above the whole block, separating the agent's work from
    // whatever was said before it. Deliberately not full width: an edge-to-
    // edge line reads as a page break, a short one reads as "a new thing
    // starts here".
    <div className="flex flex-col">
      <span
        className="mb-3.5 h-px w-full flex-none bg-border/60"
        aria-hidden="true"
      />

      {rows.map((row, i) => {
        const hasText = row.text.trim().length > 0;
        const hasTools = row.tools.length > 0;
        if (!hasText && !hasTools) return null;

        const split = hasText && hasTools;

        return (
          <div
            key={i}
            className={`grid gap-y-2 ${
              // Only split when there is something on both sides. A row that
              // is only prose uses the full width, so ordinary paragraphs
              // don't end up in a narrow column beside nothing.
              split
                ? "gap-x-0 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,20rem)]"
                : "grid-cols-1"
            } ${i > 0 ? "mt-4 pt-4" : ""}`}
          >
            {hasText && (
              <div
                className={`prose-chat min-w-0 text-[15px] leading-relaxed text-text-primary ${
                  split ? "md:pr-5" : ""
                }`}
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={markdownComponents}
                >
                  {row.text}
                </ReactMarkdown>
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
              <div className={`min-w-0 ${split ? "md:pl-5" : ""}`}>
                <ToolActivity events={row.tools} onOpenFile={onOpenFile} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

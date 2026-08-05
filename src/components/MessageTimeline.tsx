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
    <div className="flex flex-col">
      {rows.map((row, i) => {
        const hasText = row.text.trim().length > 0;
        const hasTools = row.tools.length > 0;
        if (!hasText && !hasTools) return null;

        return (
          <div
            key={i}
            className={`grid gap-x-5 gap-y-2 ${
              // Only split when there is something on both sides. A row that
              // is only prose uses the full width, so ordinary paragraphs
              // don't end up in a narrow column beside nothing.
              hasText && hasTools
                ? "md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]"
                : "grid-cols-1"
            } ${i > 0 ? "mt-3.5 border-t border-border/50 pt-3.5" : ""}`}
          >
            {hasText && (
              <div className="prose-chat min-w-0 text-[15px] leading-relaxed text-text-primary">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={markdownComponents}
                >
                  {row.text}
                </ReactMarkdown>
              </div>
            )}

            {hasTools && (
              <div className="min-w-0">
                <ToolActivity events={row.tools} onOpenFile={onOpenFile} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

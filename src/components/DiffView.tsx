"use client";

import { useMemo } from "react";
import { diffLines, diffHunks, diffStats } from "@/lib/diff";

/**
 * Side-by-side-in-one-column diff.
 *
 * Unified rather than two panes: at the widths this renders in — a slide-over
 * panel, or inside a chat message — two columns would be about thirty
 * characters each, which is unreadable for code.
 */
export function DiffView({
  previous,
  current,
  /** Collapse unchanged regions. Off for very short files where it adds noise. */
  collapse = true,
}: {
  previous: string;
  current: string;
  collapse?: boolean;
}) {
  const { hunks, stats, unchanged } = useMemo(() => {
    const lines = diffLines(previous, current);
    const s = diffStats(lines);
    return {
      hunks: collapse
        ? diffHunks(lines, 3)
        : [{ lines, skippedBefore: 0 }],
      stats: s,
      unchanged: s.added === 0 && s.removed === 0,
    };
  }, [previous, current, collapse]);

  if (unchanged) {
    return (
      <p className="px-3 py-4 text-center text-[12px] text-text-muted">
        No changes.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-none items-center gap-3 border-b border-border px-3 py-1.5 text-[11.5px]">
        <span className="text-green-400">+{stats.added}</span>
        <span className="text-red-400">−{stats.removed}</span>
        <span className="text-text-muted">
          {stats.added + stats.removed} line
          {stats.added + stats.removed === 1 ? "" : "s"} changed
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-[1.5]">
        {hunks.map((hunk, hi) => (
          <div key={hi}>
            {hunk.skippedBefore > 0 && (
              <div className="border-y border-border/60 bg-bg-hover/30 px-3 py-1 text-[11px] text-text-muted">
                … {hunk.skippedBefore} unchanged line
                {hunk.skippedBefore === 1 ? "" : "s"}
              </div>
            )}

            {hunk.lines.map((line, li) => {
              const bg =
                line.kind === "added"
                  ? "bg-green-500/[0.09]"
                  : line.kind === "removed"
                    ? "bg-red-500/[0.09]"
                    : "";
              const fg =
                line.kind === "added"
                  ? "text-green-300"
                  : line.kind === "removed"
                    ? "text-red-300"
                    : "text-text-secondary";
              const sign =
                line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ";

              return (
                <div key={li} className={`flex ${bg}`}>
                  {/* Line numbers are not selectable, so copying a diff
                      doesn't drag the gutter along with the code. */}
                  <span
                    className="w-10 flex-none select-none px-1.5 text-right text-[10.5px] text-text-muted/70"
                    aria-hidden="true"
                  >
                    {line.oldLine ?? ""}
                  </span>
                  <span
                    className="w-10 flex-none select-none px-1.5 text-right text-[10.5px] text-text-muted/70"
                    aria-hidden="true"
                  >
                    {line.newLine ?? ""}
                  </span>
                  <span
                    className={`w-4 flex-none select-none text-center ${fg}`}
                    aria-hidden="true"
                  >
                    {sign}
                  </span>
                  <span className={`min-w-0 flex-1 whitespace-pre-wrap break-all pr-3 ${fg}`}>
                    {line.text || "\u00A0"}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

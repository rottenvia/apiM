"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mcpDisplayName, MCP_TOOL_PREFIX } from "@/lib/mcp";
import { describeTool } from "@/lib/tool-display";
import type { ToolKind } from "@/lib/tool-display";

/** One tool the model ran, as shown in the transcript. */
export interface ToolEvent {
  id: string;
  name: string;
  args: string;
  /** Undefined while the call is still running. */
  ok?: boolean;
  summary?: string;
  changedPath?: string;
}

/**
 * What to show when a step is expanded.
 *
 * For a write that is the file body; for a command it is the command line
 * itself, which was previously not inspectable at all — the one thing most
 * worth seeing was the only thing hidden.
 */
function argContent(args: string): string | null {
  try {
    const parsed = JSON.parse(args) as {
      content?: string;
      replacement?: string;
      old_text?: string;
      new_text?: string;
      command?: string;
      args?: unknown;
      query?: string;
    };

    if (typeof parsed.command === "string") {
      const list = Array.isArray(parsed.args) ? parsed.args : [];
      const quoted = list.map((a) =>
        /\s/.test(String(a)) ? JSON.stringify(String(a)) : String(a)
      );
      return [parsed.command, ...quoted].join(" ");
    }

    return (
      parsed.content ??
      parsed.new_text ??
      parsed.replacement ??
      // MCP console calls (execute_script and friends) carry their payload
      // under these keys — without them a remote call is never expandable.
      (parsed as { code?: string }).code ??
      (parsed as { script?: string }).script ??
      parsed.query ??
      null
    );
  } catch {
    return null;
  }
}

/** One small glyph per tool family, so a read never looks like a write. */
const GLYPHS: Record<ToolKind, string[]> = {
  read: ["M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z", "M14 3v5h5", "M9 13h6M9 17h4"],
  write: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"],
  delete: ["M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13h10l1-13"],
  search: ["M11 18a7 7 0 100-14 7 7 0 000 14z", "M20 20l-4-4"],
  run: ["M4 5h16v14H4z", "M8 10l3 2-3 2M13 15h3"],
  web: ["M12 21a9 9 0 100-18 9 9 0 000 18z", "M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"],
  plan: ["M9 6h11M9 12h11M9 18h11", "M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"],
  git: ["M6 3v12", "M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6z", "M18 9a9 9 0 01-9 9"],
  note: ["M5 4h14v16l-7-4-7 4z"],
  ask: ["M21 12a8 8 0 01-11.6 7.1L4 20l1-4.4A8 8 0 1121 12z"],
  image: ["M4 5h16v14H4z", "M4 16l5-5 4 4 3-3 4 4", "M15 9h.01"],
  done: ["M5 12l5 5 9-10"],
  other: ["M13 2L4 14h7l-1 8 9-12h-7z"],
};

function Icon({ kind, ok }: { kind: ToolKind; ok?: boolean }) {
  const paths = ok === false ? ["M12 21a9 9 0 100-18 9 9 0 000 18z", "M12 8v4M12 16h.01"] : GLYPHS[kind];
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * The list of file operations that ran during one reply.
 *
 * Collapsed to a single line each, because the raw JSON arguments are noise —
 * the useful information is which file changed. Clicking one shows what was
 * actually written.
 */
const ToolRow = memo(function ToolRow({
  event,
  onOpenFile,
  isOpen,
  onToggle,
}: {
  event: ToolEvent;
  /** Opens the workspace panel at this file. */
  onOpenFile?: (path: string) => void;
  isOpen: boolean;
  onToggle: (id: string) => void;
}) {
        const running = event.ok === undefined;
        const failed = event.ok === false;
        // Parsed once per args value, not once per stream frame. A write's
        // args hold the whole file body; re-parsing that for every tool on
        // every frame is what made long agent runs feel heavy.
        const args = event.args;
        const display = useMemo(
          () =>
            describeTool(
              event.name,
              args,
              event.name.startsWith(MCP_TOOL_PREFIX)
                ? mcpDisplayName(event.name)
                : undefined
            ),
          [event.name, args]
        );
        const filePath = event.changedPath ?? display.target;
        const body = useMemo(() => argContent(args), [args]);
        // Expanding to show only what the row already says is noise.
        const expandable =
          Boolean(body) && !running && body?.trim() !== display.target;
        // Only a changed file is worth opening in the workspace.
        const changed =
          Boolean(event.changedPath) ||
          display.kind === "write";
        // The result note, unless it only restates the row ("Created
        // src/a.ts" beside "Created src/a.ts").
        const summary =
          !running &&
          !failed &&
          event.summary &&
          !(filePath && event.summary.includes(filePath)) &&
          event.summary !== display.done
            ? event.summary
            : null;

        return (
          <div key={event.id} className="tool-row flex flex-col" data-kind={display.kind}>
            <div className="group flex min-w-0 items-center gap-1">
              <button
                type="button"
                onClick={() => expandable && onToggle(event.id)}
                disabled={!expandable}
                aria-expanded={expandable ? isOpen : undefined}
                className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[13px] leading-5 transition-colors duration-150 ${
                  failed ? "text-red-300" : "text-text-secondary"
                } ${expandable ? "cursor-pointer hover:bg-bg-hover/60 hover:text-text-primary" : "cursor-default"}`}
              >
                <span
                  className={`flex h-5 w-5 flex-none items-center justify-center rounded-lg ${
                    failed
                      ? "bg-red-500/10"
                      : running
                        ? "tool-running bg-accent/15 text-accent-light"
                        : "bg-bg-hover/70 text-text-muted"
                  }`}
                >
                  <Icon kind={display.kind} ok={event.ok} />
                </span>

                {/*
                  `min-w-0` on BOTH the flex parent and the truncating child:
                  a flex item's min-width is `auto`, so without it the verb
                  and the path each demand their natural width, the sum
                  overflows, and with the path set to `dir="rtl"` the overflow
                  renders back across the verb.
                */}
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
                  <span className={`flex-none font-medium ${running ? "thinking-shimmer" : ""}`}>
                    {running ? display.running : display.done}
                  </span>
                  {filePath && (
                    /*
                     * Truncated from the left for paths: the tail is the part
                     * that identifies the file, so the head gives way.
                     */
                    <span
                      dir={display.mono ? "rtl" : undefined}
                      title={filePath}
                      className={`min-w-0 flex-1 shrink truncate text-left opacity-75 ${
                        display.mono ? "font-mono text-[12px]" : "text-[13px]"
                      }`}
                    >
                      <bdi>{filePath}</bdi>
                    </span>
                  )}
                </span>

                {/* A failure reason can be a whole shell error: capped and
                    allowed to shrink so it never overlaps the verb. */}
                {failed && event.summary && (
                  <span className="min-w-0 max-w-[50%] shrink truncate text-[12px] opacity-80">
                    — {event.summary}
                  </span>
                )}
                {summary && (
                  <span className="hidden min-w-0 max-w-[40%] shrink truncate text-[12px] text-text-muted sm:block">
                    {summary}
                  </span>
                )}

                {expandable && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    className={`flex-none opacity-40 transition-transform duration-150 group-hover:opacity-70 ${
                      isOpen ? "rotate-180" : ""
                    }`}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                  </svg>
                )}
              </button>

              {/* Jump to the file in the workspace panel. A sibling, not
                  nested: a button inside a button never fires reliably. */}
              {!running && !failed && filePath && changed && onOpenFile && (
                <button
                  type="button"
                  onClick={() => onOpenFile(filePath)}
                  title="Open in workspace"
                  className="flex-none rounded-lg px-2 py-1 text-[12px] text-text-muted opacity-0 transition-opacity duration-150 hover:text-accent-light focus-visible:opacity-100 group-hover:opacity-100"
                >
                  Open
                </button>
              )}
            </div>

            {isOpen && body && (
              <pre className="tool-body mb-1 ml-8 mt-1 max-h-72 overflow-auto rounded-lg border border-border bg-bg-primary p-3 font-mono text-[12px] leading-relaxed text-text-secondary">
                {body}
              </pre>
            )}
          </div>
        );
}, (prev, next) =>
  // Event objects keep their identity once the call settles (only the array
  // is replaced), so a finished row never re-renders for later frames. The
  // running call's args stream in as new objects, which is what keeps its
  // own row — and only its row — live.
  prev.event === next.event &&
  prev.onOpenFile === next.onOpenFile &&
  prev.isOpen === next.isOpen &&
  prev.onToggle === next.onToggle
);

/**
 * The list of file operations that ran during one reply.
 *
 * Collapsed to a single line each, because the raw JSON arguments are noise —
 * the useful information is which file changed. Clicking one shows what was
 * actually written.
 */
export function ToolActivity({
  events,
  onOpenFile,
}: {
  events: ToolEvent[];
  /** Opens the workspace panel at this file. */
  onOpenFile?: (path: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  // Collapse whatever is open as soon as another tool starts. An expanded
  // panel from a finished step is stale detail competing with the live one,
  // and left alone they accumulate until the reply is unreadable.
  const runningCount = events.filter((e) => e.ok === undefined).length;
  const lastRunning = useRef(runningCount);
  useEffect(() => {
    if (runningCount > lastRunning.current) setOpenId(null);
    lastRunning.current = runningCount;
  }, [runningCount]);

  // Stable identity, or the row memo below never holds and every frame
  // re-renders every row.
  const onToggle = useCallback(
    (id: string) => setOpenId((cur) => (cur === id ? null : id)),
    []
  );

  if (!events.length) return null;

  return (
    <div className="mb-1 flex flex-col gap-0.5">
      {events.map((event) => (
        <ToolRow
          key={event.id}
          event={event}
          onOpenFile={onOpenFile}
          isOpen={openId === event.id}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

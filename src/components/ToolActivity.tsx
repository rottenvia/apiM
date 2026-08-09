"use client";

import { useEffect, useRef, useState } from "react";

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

const VERBS: Record<string, { running: string; done: string }> = {
  write_file: { running: "Writing", done: "Created" },
  edit_file: { running: "Editing", done: "Edited" },
  read_file: { running: "Reading", done: "Read" },
  list_files: { running: "Listing files", done: "Listed files" },
  delete_file: { running: "Deleting", done: "Deleted" },
};

/** Pulls the file path out of the streamed arguments, which may be partial. */
function argPath(args: string): string | null {
  try {
    const parsed = JSON.parse(args) as { path?: string };
    if (typeof parsed.path === "string") return parsed.path;
  } catch {
    // Arguments arrive in fragments, so mid-stream this is expected. Fall back
    // to a loose match so the filename can still be shown as it types in.
    const m = args.match(/"path"\s*:\s*"([^"]*)/);
    if (m) return m[1];
  }
  return null;
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

    return parsed.content ?? parsed.new_text ?? parsed.replacement ?? parsed.query ?? null;
  } catch {
    return null;
  }
}

function Icon({ name, ok }: { name: string; ok?: boolean }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  if (ok === false) {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
    );
  }
  if (name === "delete_file") {
    return (
      <svg {...common}>
        <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13h10l1-13" />
      </svg>
    );
  }
  if (name === "read_file" || name === "list_files") {
    return (
      <svg {...common}>
        <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
        <path d="M14 3v5h5" />
      </svg>
    );
  }
  // write / edit
  return (
    <svg {...common}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />
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

  if (!events.length) return null;

  return (
    <div className="mb-2.5 flex flex-col gap-1">
      {events.map((event) => {
        const verbs = VERBS[event.name] ?? {
          running: event.name,
          done: event.name,
        };
        const running = event.ok === undefined;
        const failed = event.ok === false;
        const filePath = event.changedPath ?? argPath(event.args);
        const body = argContent(event.args);
        const expandable = Boolean(body) && !running;
        // Reads don't change anything, so offering "Open" there is noise.
        const changed =
          event.name !== "read_file" && event.name !== "list_files";
        const isOpen = openId === event.id;

        return (
          <div key={event.id} className="flex flex-col">
            <button
              type="button"
              onClick={() =>
                expandable && setOpenId(isOpen ? null : event.id)
              }
              disabled={!expandable}
              aria-expanded={expandable ? isOpen : undefined}
              className={`group flex w-fit max-w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                failed
                  ? "border-red-500/25 bg-red-500/[0.07] text-red-300"
                  : "border-border bg-bg-hover/40 text-text-secondary"
              } ${expandable ? "cursor-pointer hover:border-border-light hover:text-text-primary" : "cursor-default"}`}
            >
              <span
                className={`flex-none ${
                  running ? "animate-pulse text-accent-light" : ""
                }`}
              >
                <Icon name={event.name} ok={event.ok} />
              </span>

              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="flex-none font-medium">
                  {running ? verbs.running : verbs.done}
                </span>
                {filePath && (
                  /*
                   * Truncated from the left, not the right.
                   *
                   * These rows sit in a 20rem column, so a real path never
                   * fits. Cutting the end removed the filename and left the
                   * directory — every row in an unpacked archive then read
                   * "nohomolyzer/extension/src/cont…", identical to its
                   * neighbours and useless. The tail is the part that
                   * identifies the file, so the head is what gives way.
                   */
                  <span
                    dir="rtl"
                    title={filePath}
                    className="min-w-0 flex-1 truncate text-left font-mono text-[12px] opacity-80"
                  >
                    {/* Isolated so the RTL direction only controls where the
                        ellipsis lands, and does not reorder the path itself. */}
                    <bdi>{filePath}</bdi>
                  </span>
                )}
              </span>

              {failed && event.summary && (
                <span className="min-w-0 truncate text-[12px] opacity-80">
                  — {event.summary}
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
                  className={`ml-0.5 flex-none opacity-50 transition-transform ${
                    isOpen ? "rotate-180" : ""
                  }`}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6 9l6 6 6-6"
                  />
                </svg>
              )}
            </button>

            {/* Jump to the file in the workspace panel. Deliberately a
                sibling, not nested: a button inside a button is invalid
                HTML and the inner click never fires reliably. */}
            {!running && !failed && filePath && changed && onOpenFile && (
              <button
                type="button"
                onClick={() => onOpenFile(filePath)}
                className="mt-1 w-fit rounded-lg px-2.5 py-0.5 text-[12px] text-text-muted transition-colors hover:text-accent-light"
              >
                Open in workspace
              </button>
            )}

            {isOpen && body && (
              <pre className="mt-1 max-h-72 overflow-auto rounded-lg border border-border bg-bg-primary p-3 font-mono text-[12px] leading-relaxed text-text-secondary">
                {body}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

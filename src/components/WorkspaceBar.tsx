"use client";

import { useState } from "react";

export interface WorkspaceFileInfo {
  path: string;
  size: number;
  modifiedAt: string;
}

/** Small file-type glyph, so a list of names is scannable at a glance. */
function fileGlyph(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["py"].includes(ext)) return "py";
  if (["js", "mjs", "cjs"].includes(ext)) return "js";
  if (["ts", "tsx"].includes(ext)) return "ts";
  if (["html", "htm"].includes(ext)) return "ht";
  if (["css", "scss"].includes(ext)) return "css";
  if (["json"].includes(ext)) return "{}";
  if (["md", "txt"].includes(ext)) return "md";
  if (["sh", "bash"].includes(ext)) return "sh";
  return "•";
}

/**
 * Always-visible strip showing that a workspace exists for this chat.
 *
 * The workspace was previously only discoverable by opening a popover, so
 * there was no way to tell from the chat that the assistant could write files
 * at all. This keeps that fact on screen: what it is when off, and what is in
 * it when on.
 */
export function WorkspaceBar({
  enabled,
  files,
  recentlyChanged,
  onEnable,
  onOpen,
  onOpenFile,
}: {
  enabled: boolean;
  files: WorkspaceFileInfo[];
  /** Paths touched by the last reply, briefly highlighted. */
  recentlyChanged?: string[];
  onEnable: () => void;
  onOpen: () => void;
  onOpenFile: (path: string) => void;
}) {
  const [wantExpanded, setWantExpanded] = useState(false);
  // Derived rather than synced through an effect: an empty workspace has
  // nothing to expand, and forcing it closed here avoids a second render.
  const expanded = wantExpanded && files.length > 0;

  const changed = new Set(recentlyChanged ?? []);
  const preview = files.slice(0, 4);
  const overflow = files.length - preview.length;

  if (!enabled) {
    return (
      <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-dashed border-border px-3 py-2">
        <span className="flex-none text-text-muted">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
            />
          </svg>
        </span>
        <p className="min-w-0 flex-1 text-[12px] leading-4 text-text-muted">
          <span className="text-text-secondary">Workspace is off.</span> Turn it
          on and the assistant writes real files instead of printing code.
        </p>
        <button
          onClick={onEnable}
          className="flex-none rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-text-secondary transition-colors hover:border-border-light hover:bg-bg-hover hover:text-text-primary"
        >
          Turn on
        </button>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-xl border border-accent/25 bg-accent/[0.05]">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <span className="flex-none text-accent-light">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
            />
          </svg>
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium leading-4 text-text-primary">
            Workspace on
          </p>
          <p className="text-[11px] leading-4 text-text-muted">
            {files.length === 0
              ? "Empty — ask for a file and it appears here."
              : `${files.length} file${files.length === 1 ? "" : "s"} in this chat`}
          </p>
        </div>

        {files.length > 0 && (
          <button
            onClick={() => setWantExpanded((v) => !v)}
            aria-expanded={expanded}
            className="flex flex-none items-center gap-1 rounded-lg px-2 py-1 text-[11.5px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            {expanded ? "Hide" : "Show"}
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className={`transition-transform ${expanded ? "rotate-180" : ""}`}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
            </svg>
          </button>
        )}

        <button
          onClick={onOpen}
          className="flex-none rounded-lg border border-border px-2.5 py-1 text-[12px] font-medium text-text-secondary transition-colors hover:border-border-light hover:bg-bg-hover hover:text-text-primary"
        >
          Open
        </button>
      </div>

      {/* Collapsed: a few filenames as chips. Expanded: all of them. */}
      {files.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-accent/15 px-3 py-2">
          {(expanded ? files : preview).map((file) => (
            <button
              key={file.path}
              onClick={() => onOpenFile(file.path)}
              title={file.path}
              className={`flex max-w-[14rem] items-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px] transition-colors ${
                changed.has(file.path)
                  ? "border-accent/40 bg-accent/10 text-accent-light"
                  : "border-border bg-bg-primary/40 text-text-secondary hover:border-border-light hover:text-text-primary"
              }`}
            >
              <span className="flex-none font-mono text-[9.5px] uppercase opacity-60">
                {fileGlyph(file.path)}
              </span>
              <span className="truncate font-mono">{file.path}</span>
            </button>
          ))}

          {!expanded && overflow > 0 && (
            <button
              onClick={() => setWantExpanded(true)}
              className="rounded-lg px-2 py-1 text-[11.5px] text-text-muted transition-colors hover:text-text-primary"
            >
              +{overflow} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

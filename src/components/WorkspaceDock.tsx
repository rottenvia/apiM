"use client";

import { useEffect, useRef, useState } from "react";
import type { WorkspaceFileInfo } from "@/components/WorkspaceBar";

/** Two-letter type badge, so a list of names is scannable at a glance. */
function fileGlyph(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "py") return "py";
  if (["js", "mjs", "cjs"].includes(ext)) return "js";
  if (["ts", "tsx"].includes(ext)) return "ts";
  if (["html", "htm"].includes(ext)) return "ht";
  if (["css", "scss"].includes(ext)) return "css";
  if (ext === "json") return "{}";
  if (["md", "txt"].includes(ext)) return "md";
  if (["sh", "bash"].includes(ext)) return "sh";
  return "•";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Always-visible workspace summary in the header.
 *
 * The bar above the messages scrolls away with the conversation, so once a
 * chat is long there is no way to see what files exist without opening the
 * panel. This stays put.
 */
export function WorkspaceDock({
  enabled,
  files,
  recentlyChanged,
  onEnable,
  onOpen,
  onOpenFile,
}: {
  enabled: boolean;
  files: WorkspaceFileInfo[];
  recentlyChanged?: string[];
  onEnable: () => void;
  onOpen: () => void;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const changed = new Set(recentlyChanged ?? []);
  const changedCount = files.filter((f) => changed.has(f.path)).length;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => (enabled ? setOpen((v) => !v) : onEnable())}
        className="chip"
        data-active={enabled}
        aria-expanded={enabled ? open : undefined}
        title={
          enabled
            ? "Files the assistant can read and write"
            : "Turn on the workspace so the assistant can write files"
        }
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
          />
        </svg>
        <span>{enabled ? files.length || "Files" : "Files off"}</span>

        {/* A quiet dot rather than a number: it means "something changed just
            now", and a count would imply it needs counting. */}
        {enabled && changedCount > 0 && !open && (
          <span
            className="h-1.5 w-1.5 flex-none rounded-full bg-accent-light"
            aria-label={`${changedCount} recently changed`}
          />
        )}
      </button>

      {enabled && open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[min(20rem,calc(100vw-1.5rem))]">
          <div className="popover-card">
            <div className="flex items-start justify-between gap-3 border-b border-border px-3.5 py-2.5">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold leading-5 text-text-primary">
                  Workspace
                </p>
                <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                  {files.length === 0
                    ? "Empty — ask for a file and it appears here"
                    : `${files.length} file${files.length === 1 ? "" : "s"} in this chat`}
                </p>
              </div>
              <button
                onClick={() => {
                  onOpen();
                  setOpen(false);
                }}
                className="flex-none rounded-lg border border-border px-2 py-1 text-[11.5px] text-text-secondary transition-colors hover:border-border-light hover:text-text-primary"
              >
                Open
              </button>
            </div>

            {files.length === 0 ? (
              <p className="px-3.5 py-4 text-center text-[12px] leading-relaxed text-text-muted">
                Nothing here yet.
              </p>
            ) : (
              // Capped height so a workspace with fifty files scrolls rather
              // than growing a popover taller than the window.
              <div className="max-h-[min(24rem,60vh)] overflow-y-auto p-1.5">
                {files.map((file) => (
                  <button
                    key={file.path}
                    onClick={() => {
                      onOpenFile(file.path);
                      setOpen(false);
                    }}
                    title={file.path}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-bg-hover"
                  >
                    <span className="w-6 flex-none text-center font-mono text-[9.5px] uppercase text-text-muted">
                      {fileGlyph(file.path)}
                    </span>
                    <span
                      className={`min-w-0 flex-1 truncate font-mono text-[12px] ${
                        changed.has(file.path)
                          ? "text-accent-light"
                          : "text-text-secondary"
                      }`}
                    >
                      {file.path}
                    </span>
                    <span className="flex-none text-[10.5px] text-text-muted">
                      {formatSize(file.size)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

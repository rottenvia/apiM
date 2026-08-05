"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceFileInfo } from "@/components/WorkspaceBar";
import type { SnapshotInfo } from "@/lib/snapshots";

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
  if (["sh", "bash", "cfg", "conf", "ini"].includes(ext)) return "sh";
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext)) return "im";
  return "•";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Matches the workspace limits, so the meter means something real. */
const CAPACITY_BYTES = 128 * 1024 * 1024;
const CAPACITY_FILES = 10_000;

/**
 * The workspace, pinned beside the conversation.
 *
 * The header dock answers "what files exist" in a glance, but a panel that
 * stays open is what makes the workspace feel like part of the app rather
 * than something hidden behind a button.
 */
export function WorkspaceSidePanel({
  workspaceId,
  files,
  recentlyChanged,
  onOpenFile,
  onClose,
  onRestored,
}: {
  workspaceId: string | null;
  files: WorkspaceFileInfo[];
  recentlyChanged?: string[];
  onOpenFile: (path: string) => void;
  onClose: () => void;
  /** Called after a restore, so the file list reflects the change. */
  onRestored?: () => void;
}) {
  const [history, setHistory] = useState<SnapshotInfo[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);

  const changed = new Set(recentlyChanged ?? []);

  // Paths that have already been rendered once. The entry animation keys off
  // this rather than off `changed`, so it plays when a file first appears and
  // not again on every edit — replaying it turned a working panel into a
  // flicker.
  const [seen, setSeen] = useState<Set<string>>(new Set());
  useEffect(() => {
    const paths = files.map((f) => f.path);
    // Deferred past paint so the row that just animated counts as seen only
    // from the next render, and skipped entirely when nothing is new.
    const timer = setTimeout(() => {
      setSeen((prev) => {
        const missing = paths.filter((p) => !prev.has(p));
        if (missing.length === 0) return prev;
        const next = new Set(prev);
        for (const p of missing) next.add(p);
        return next;
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [files]);

  const loadHistory = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/snapshots`);
      if (!res.ok) return;
      const data = (await res.json()) as { snapshots?: SnapshotInfo[] };
      setHistory(data.snapshots ?? []);
    } catch {
      /* cosmetic — keep whatever was last known */
    }
  }, [workspaceId]);

  // Refreshed whenever the files change, so the list is current the moment
  // it is opened rather than a snapshot of when the panel mounted.
  useEffect(() => {
    if (showHistory) queueMicrotask(() => void loadHistory());
  }, [showHistory, loadHistory, files.length]);

  const restore = useCallback(
    async (snapshot: SnapshotInfo) => {
      if (!workspaceId || busy) return;
      const when = new Date(snapshot.createdAt).toLocaleString();
      if (
        !window.confirm(
          `Put the workspace back to how it was at ${when}?\n\n` +
            `Files changed since will be reverted and files created since ` +
            `will be removed. The current state is saved first, so this can ` +
            `be undone.`
        )
      ) {
        return;
      }

      setBusy(true);
      try {
        await fetch(`/api/workspace/${workspaceId}/snapshots`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ snapshot: snapshot.id }),
        });
        await loadHistory();
        onRestored?.();
      } catch {
        /* the refresh reflects whatever actually happened */
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, busy, loadHistory, onRestored]
  );
  const totalBytes = useMemo(
    () => files.reduce((sum, f) => sum + f.size, 0),
    [files]
  );

  const usedPercent = Math.min(100, (totalBytes / CAPACITY_BYTES) * 100);

  const download = () => {
    if (!workspaceId) return;
    // A hidden anchor keeps the server's filename from Content-Disposition
    // rather than navigating away from the conversation.
    const a = document.createElement("a");
    a.href = `/api/workspace/${workspaceId}/download`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <aside className="hidden w-[17.5rem] flex-none flex-col border-l border-border bg-bg-secondary/40 lg:flex">
      <div className="flex items-center justify-between gap-2 px-3 pt-3.5">
        <span className="text-[12.5px] font-medium text-text-secondary">
          Workspace
        </span>

        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setShowHistory((v) => !v)}
            className="rounded-md p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            data-active={showHistory}
            title="Earlier versions of this workspace"
            aria-label="Workspace history"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.7}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 12a9 9 0 109-9 9 9 0 00-7 3.3M3 4v4h4M12 7v5l3 2"
              />
            </svg>
          </button>

          <button
            onClick={download}
            disabled={files.length === 0}
            className="rounded-md p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            title={
              files.length === 0
                ? "Nothing to download yet"
                : "Download everything as a .zip"
            }
            aria-label="Download workspace as zip"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.7}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"
              />
            </svg>
          </button>

          <button
            onClick={onClose}
            className="rounded-md p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            title="Hide the workspace panel"
            aria-label="Hide workspace panel"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Usage. Quiet by design — it is reassurance, not a headline. */}
      <div className="px-3 pb-2.5 pt-2">
        <div className="flex items-center justify-between text-[10.5px] text-text-muted">
          <span>
            {formatBytes(totalBytes)} / {formatBytes(CAPACITY_BYTES)}
          </span>
          <span>
            {files.length.toLocaleString()} / {CAPACITY_FILES.toLocaleString()} files
          </span>
        </div>
        <div className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-accent/70 transition-[width] duration-300"
            // Always show a sliver once anything exists, or a small workspace
            // looks identical to an empty one.
            style={{ width: `${totalBytes > 0 ? Math.max(1.5, usedPercent) : 0}%` }}
          />
        </div>
      </div>

      {showHistory ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {history.length === 0 ? (
            <p className="py-6 text-center text-[11.5px] leading-relaxed text-text-muted">
              No earlier versions yet.
              <br />
              One is saved before each message.
            </p>
          ) : (
            history.map((snapshot) => (
              <div
                key={snapshot.id}
                className="list-row group"
              >
                <p
                  className="truncate text-[11.5px] text-text-secondary"
                  title={snapshot.label}
                >
                  {snapshot.label}
                </p>
                <div className="mt-0.5 flex items-center gap-2">
                  <span className="flex-1 text-[10px] text-text-muted">
                    {new Date(snapshot.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {" · "}
                    {snapshot.fileCount} file
                    {snapshot.fileCount === 1 ? "" : "s"}
                  </span>
                  <button
                    onClick={() => void restore(snapshot)}
                    disabled={busy}
                    className="rounded-md border border-border px-1.5 py-0.5 text-[10.5px] text-text-secondary opacity-0 transition-all hover:border-accent/40 hover:text-text-primary focus:opacity-100 group-hover:opacity-100 disabled:opacity-40"
                  >
                    Restore
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {files.length === 0 ? (
          <p className="py-6 text-center text-[11.5px] leading-relaxed text-text-muted">
            No files yet.
            <br />
            Ask for one and it appears here.
          </p>
        ) : (
          files.map((file) => (
            <button
              key={file.path}
              onClick={() => onOpenFile(file.path)}
              title={file.path}
              className={`list-row group flex w-full items-center gap-2 text-left ${
                seen.has(file.path) ? "" : "animate-file-in"
              }`}
            >
              <span className="w-5 flex-none text-center font-mono text-[9px] uppercase text-text-muted">
                {fileGlyph(file.path)}
              </span>
              <span
                className={`min-w-0 flex-1 truncate font-mono text-[11.5px] ${
                  changed.has(file.path)
                    ? "text-accent-light"
                    : "text-text-secondary group-hover:text-text-primary"
                }`}
              >
                {file.path}
              </span>
              <span className="flex-none text-[10px] text-text-muted opacity-0 transition-opacity group-hover:opacity-100">
                {formatBytes(file.size)}
              </span>
            </button>
          ))
        )}
      </div>
      )}
    </aside>
  );
}

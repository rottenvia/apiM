"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ImportFilesDialog } from "@/components/ImportFilesDialog";
import {
  allDirPaths,
  buildFileTree,
  collapseChains,
  type TreeNode,
} from "@/lib/file-tree";
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



/**
 * The workspace, pinned beside the conversation.
 *
 * The header dock answers "what files exist" in a glance, but a panel that
 * stays open is what makes the workspace feel like part of the app rather
 * than something hidden behind a button.
 */
/**
 * One row per file or folder, indented by depth.
 *
 * The panel used to print the full path on every row, so an unpacked archive
 * showed a column of identical truncated strings — the part identifying each
 * file was the part cut off. Only the last segment is shown here; where it
 * sits says the rest.
 */
function FileTree({
  nodes,
  openDirs,
  onToggleDir,
  changed,
  seen,
  onOpenFile,
  depth = 0,
}: {
  nodes: TreeNode[];
  openDirs: Set<string>;
  onToggleDir: (path: string) => void;
  changed: Set<string>;
  seen: Set<string>;
  onOpenFile: (path: string) => void;
  depth?: number;
}) {
  return (
    <>
      {nodes.map((node) => {
        // Indent with padding rather than nested containers, so every row
        // keeps the same full-width hover area however deep it sits.
        const indent = { paddingLeft: `${depth * 12}px` };

        if (node.kind === "dir") {
          const open = openDirs.has(node.path);
          return (
            <div key={node.path}>
              <button
                onClick={() => onToggleDir(node.path)}
                title={node.path}
                aria-expanded={open}
                className="list-row group flex w-full items-center gap-1.5 text-left"
                style={indent}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.4}
                  aria-hidden="true"
                  className={`flex-none text-text-muted transition-transform duration-150 ${
                    open ? "rotate-90" : ""
                  }`}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                <span className="flex-none text-text-muted">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                  </svg>
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary group-hover:text-text-primary">
                  {node.name}
                </span>
                <span className="flex-none text-[11px] tabular-nums text-text-muted">
                  {node.fileCount}
                </span>
              </button>

              {open && (
                <FileTree
                  nodes={node.children}
                  openDirs={openDirs}
                  onToggleDir={onToggleDir}
                  changed={changed}
                  seen={seen}
                  onOpenFile={onOpenFile}
                  depth={depth + 1}
                />
              )}
            </div>
          );
        }

        return (
          <button
            key={node.path}
            onClick={() => onOpenFile(node.path)}
            title={node.path}
            className={`list-row group flex w-full items-center gap-2 text-left ${
              seen.has(node.path) ? "" : "animate-file-in"
            }`}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
          >
            <span className="flex h-[18px] w-[22px] flex-none items-center justify-center rounded border border-border bg-bg-tertiary font-mono text-[9px] uppercase tracking-tight text-text-muted transition-colors group-hover:border-border-light">
              {fileGlyph(node.path)}
            </span>
            <span
              className={`min-w-0 flex-1 truncate font-mono text-[12px] ${
                changed.has(node.path)
                  ? "text-accent-light"
                  : "text-text-secondary group-hover:text-text-primary"
              }`}
            >
              {node.name}
            </span>
            <span className="flex-none text-[11px] text-text-muted opacity-0 transition-opacity group-hover:opacity-100">
              {formatBytes(node.size)}
            </span>
          </button>
        );
      })}
    </>
  );
}

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
  const [importing, setImporting] = useState(false);

  const tree = useMemo(
    () => collapseChains(buildFileTree(files)),
    [files]
  );

  /*
   * Folders start open, except anything unpacked from an archive.
   *
   * Work the agent creates is worth showing: it is usually a handful of files
   * and the point is to watch them appear. An uploaded zip is the opposite —
   * a whole project, often hundreds of files, which unrolled in full buries
   * everything else and turns the panel into a wall of rows.
   *
   * So `uploads/` and everything beneath it arrives shut. You see one folder
   * with a count, and open it when you actually want to look inside.
   */
  const defaultClosed = useMemo(() => {
    const shut = new Set<string>();
    for (const dirPath of allDirPaths(tree)) {
      // Chains are collapsed for display, so the row for an unpacked archive
      // can be "uploads/EXT-Faceit" rather than a bare "uploads" — matching
      // the segment prefix catches both.
      if (dirPath === "uploads" || dirPath.startsWith("uploads/")) {
        shut.add(dirPath);
      }
    }
    return shut;
  }, [tree]);

  /**
   * Folders the user has opened or closed by hand.
   *
   * Held separately from the default so a deliberate choice always wins: a
   * folder opened by hand must not snap shut again when the tree is rebuilt
   * after a file changes.
   */
  const [userOpened, setUserOpened] = useState<Set<string>>(new Set());
  const [userClosed, setUserClosed] = useState<Set<string>>(new Set());

  const openDirs = useMemo(() => {
    const all = new Set(allDirPaths(tree));
    for (const shut of defaultClosed) if (!userOpened.has(shut)) all.delete(shut);
    for (const shut of userClosed) all.delete(shut);
    return all;
  }, [tree, defaultClosed, userOpened, userClosed]);

  const toggleDir = useCallback(
    (path: string) => {
      const isOpen = openDirs.has(path);
      // Recorded in both sets rather than one, so the choice survives the
      // tree being rebuilt and overrides whatever the default would be.
      setUserOpened((prev) => {
        const next = new Set(prev);
        if (isOpen) next.delete(path);
        else next.add(path);
        return next;
      });
      setUserClosed((prev) => {
        const next = new Set(prev);
        if (isOpen) next.add(path);
        else next.delete(path);
        return next;
      });
    },
    [openDirs]
  );
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


  const [downloading, setDownloading] = useState(false);

  /*
   * Fetch the bytes, then save them from memory.
   *
   * Pointing an anchor at the URL is the usual trick and it fails here: a
   * bare href to a server route is an ordinary navigation, so a download
   * manager extension — IDM in this case — intercepts it, tries to fetch the
   * URL itself as a separate unauthenticated request, and fails. The user
   * never gets a zip, they get IDM opening and erroring.
   *
   * Fetching in the page keeps the request inside the app, with its cookies,
   * and the blob URL that follows is same-origin and instantaneous, so there
   * is nothing for a download manager to take over.
   */
  const download = async () => {
    if (!workspaceId || downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/download`);
      if (!res.ok) throw new Error(String(res.status));

      const blob = await res.blob();
      // Keep the server's filename, falling back to something sensible.
      const disposition = res.headers.get("content-disposition") ?? "";
      const match = /filename="?([^"]+)"?/.exec(disposition);

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = match?.[1] ?? "workspace.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoked on the next tick: doing it immediately can cancel the save
      // in some browsers before it has read the blob.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      /* the button returns to normal; nothing was written */
    } finally {
      setDownloading(false);
    }
  };

  return (
    <aside className="hidden w-[17.5rem] flex-none flex-col border-l border-border bg-bg-secondary lg:flex">
      {/* A defined header strip rather than text floating above a list, so
          the panel reads as its own surface and matches the 56px headers on
          the sidebar and the chat area. */}
      <div className="flex h-[56px] flex-none items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex-none text-text-muted">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            </svg>
          </span>
          <span className="truncate text-[13px] font-medium text-text-primary">
            Workspace
          </span>
        </div>

        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setShowHistory((v) => !v)}
            className="sidebar-icon-btn h-7 w-7"
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
            onClick={() => setImporting(true)}
            className="sidebar-icon-btn h-7 w-7"
            title="Copy files from another chat"
            aria-label="Copy files from another chat"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 4h9a2 2 0 012 2v9M6 8h9a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8a2 2 0 012-2z" />
            </svg>
          </button>

          <button
            onClick={download}
            disabled={files.length === 0}
            className="sidebar-icon-btn h-7 w-7 disabled:cursor-not-allowed disabled:opacity-40"
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
            className="sidebar-icon-btn h-7 w-7"
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

      {/* What is here, not what is left.
          
          This was a progress bar against 128MB and 10,000 files, which are a
          hosted service's numbers. Everything lives on the user's own disk,
          so there is no quota to fill and a bar creeping toward a limit that
          does not exist is worse than no bar at all. */}
      <div className="flex items-baseline gap-1.5 px-3 pb-2 pt-3 text-[11px] text-text-muted">
        <span className="tabular-nums text-text-secondary">
          {files.length.toLocaleString()}
        </span>
        <span>{files.length === 1 ? "file" : "files"}</span>
        {totalBytes > 0 && (
          <>
            <span className="opacity-40">·</span>
            <span className="tabular-nums">{formatBytes(totalBytes)}</span>
          </>
        )}
      </div>

      {showHistory ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {history.length === 0 ? (
            <p className="py-6 text-center text-[12px] leading-relaxed text-text-muted">
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
                  className="truncate text-[12px] text-text-secondary"
                  title={snapshot.label}
                >
                  {snapshot.label}
                </p>
                <div className="mt-0.5 flex items-center gap-2">
                  <span className="flex-1 text-[11px] text-text-muted">
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
                    className="rounded-lg border border-border px-1.5 py-0.5 text-[11px] text-text-secondary opacity-0 transition-all hover:border-accent/40 hover:text-text-primary focus:opacity-100 group-hover:opacity-100 disabled:opacity-40"
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
          <p className="py-6 text-center text-[12px] leading-relaxed text-text-muted">
            No files yet.
            <br />
            Ask for one and it appears here.
          </p>
        ) : (
          <FileTree
            nodes={tree}
            openDirs={openDirs}
            onToggleDir={toggleDir}
            changed={changed}
            seen={seen}
            onOpenFile={onOpenFile}
          />
        )}
      </div>
      )}

      {/* Download, said in words.
          
          It already existed as a 14px unlabelled icon in the header strip,
          among four other 14px unlabelled icons, and was reported as missing
          — which is the same thing as not existing. Getting your files out is
          not a secondary action: it is the point of having a workspace, and
          it should be legible without hovering to find a tooltip. */}
      {files.length > 0 && (
        <div className="flex-none border-t border-border p-2">
          <button
            onClick={download}
            title="Download everything as a .zip"
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-[12px] font-medium text-text-secondary transition-colors hover:border-border-light hover:bg-bg-hover hover:text-text-primary"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
            </svg>
            Download all files
            <span className="text-text-muted">
              ({files.length})
            </span>
          </button>
        </div>
      )}
      {importing && workspaceId && (
        <ImportFilesDialog
          workspaceId={workspaceId}
          onClose={() => setImporting(false)}
          onImported={() => onRestored?.()}
        />
      )}
    </aside>
  );
}

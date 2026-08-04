"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface WorkspaceFile {
  path: string;
  size: number;
  modifiedAt: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Slide-over panel listing the files in a workspace.
 *
 * Rendered through a portal: message bubbles animate with a transform, which
 * makes them a containing block for position:fixed, and a panel mounted inside
 * one would be trapped in the bubble.
 */
export function WorkspacePanel({
  workspaceId,
  highlightPath,
  onClose,
}: {
  workspaceId: string;
  /** File to open immediately, when arriving from a "Created x.py" line. */
  highlightPath?: string | null;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [directory, setDirectory] = useState("");
  const [selected, setSelected] = useState<string | null>(highlightPath ?? null);
  const [content, setContent] = useState("");
  const [draft, setDraft] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [visible, setVisible] = useState(false);

  const closeRef = useRef<HTMLButtonElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dirty = draft !== content;

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    []
  );

  const handleClose = useCallback(() => {
    if (dirty && !window.confirm("You have unsaved changes. Close anyway?")) {
      return;
    }
    setVisible(false);
    setTimeout(onClose, 200);
  }, [dirty, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [handleClose]);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}`);
      if (!res.ok) throw new Error(`Couldn't load the file list (${res.status})`);
      const data = (await res.json()) as {
        files: WorkspaceFile[];
        directory: string;
      };
      setFiles(data.files);
      setDirectory(data.directory);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the files");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    // Deferred so the loading flag doesn't cascade through the mount commit.
    queueMicrotask(() => void loadList());
  }, [loadList]);

  const openFile = useCallback(
    async (filePath: string) => {
      if (dirty && !window.confirm("Discard unsaved changes?")) return;
      setSelected(filePath);
      setError(null);
      try {
        const res = await fetch(
          `/api/workspace/${workspaceId}?path=${encodeURIComponent(filePath)}`
        );
        const data = (await res.json()) as {
          content?: string;
          truncated?: boolean;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error ?? "Couldn't open that file");
        setContent(data.content ?? "");
        setDraft(data.content ?? "");
        setTruncated(Boolean(data.truncated));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't open that file");
        setContent("");
        setDraft("");
      }
    },
    [workspaceId, dirty]
  );

  // Open the highlighted file once the list has arrived.
  const openedHighlight = useRef(false);
  useEffect(() => {
    if (openedHighlight.current || !highlightPath || loading) return;
    openedHighlight.current = true;
    void openFile(highlightPath);
  }, [highlightPath, loading, openFile]);

  const save = useCallback(async () => {
    if (!selected || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selected, content: draft }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't save");
      setContent(draft);
      void loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }, [workspaceId, selected, draft, saving, loadList]);

  const remove = useCallback(
    async (filePath: string) => {
      if (!window.confirm(`Delete ${filePath}? This cannot be undone.`)) return;
      try {
        const res = await fetch(
          `/api/workspace/${workspaceId}?path=${encodeURIComponent(filePath)}`,
          { method: "DELETE" }
        );
        const data = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? "Couldn't delete");
        if (selected === filePath) {
          setSelected(null);
          setContent("");
          setDraft("");
        }
        void loadList();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't delete");
      }
    },
    [workspaceId, selected, loadList]
  );

  const handleCopy = useCallback(async () => {
    const ok = await copyText(draft);
    if (!ok) return;
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1600);
  }, [draft]);

  return createPortal(
    <div className="fixed inset-0 z-[70] flex justify-end">
      <div
        onClick={handleClose}
        className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      />

      <div
        role="dialog"
        aria-label="Workspace files"
        className={`relative flex h-full w-[min(46rem,100vw)] flex-col border-l border-border bg-bg-secondary transition-transform duration-200 ${
          visible ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold leading-5 text-text-primary">
              Workspace files
            </p>
            <p
              className="mt-0.5 truncate font-mono text-[11px] leading-4 text-text-muted"
              title={directory}
            >
              {directory || "…"}
            </p>
          </div>
          <button
            ref={closeRef}
            onClick={handleClose}
            className="popover-close"
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="border-b border-red-500/20 bg-red-500/[0.07] px-4 py-2 text-[12px] text-red-300">
            {error}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {/* File list */}
          <div className="flex w-[15rem] flex-none flex-col border-r border-border">
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {loading ? (
                <p className="px-2 py-3 text-[12px] text-text-muted">Loading…</p>
              ) : files.length === 0 ? (
                <p className="px-2 py-3 text-[12px] leading-relaxed text-text-muted">
                  No files yet. Ask the assistant to create one.
                </p>
              ) : (
                files.map((file) => (
                  <div
                    key={file.path}
                    className={`group flex items-center gap-1 rounded-lg px-1 transition-colors ${
                      selected === file.path
                        ? "bg-bg-hover"
                        : "hover:bg-bg-hover/60"
                    }`}
                  >
                    <button
                      onClick={() => void openFile(file.path)}
                      className="min-w-0 flex-1 py-2 pl-1.5 text-left"
                      title={file.path}
                    >
                      <div
                        className={`truncate font-mono text-[12px] ${
                          selected === file.path
                            ? "text-accent-light"
                            : "text-text-secondary"
                        }`}
                      >
                        {file.path}
                      </div>
                      <div className="mt-0.5 text-[10.5px] text-text-muted">
                        {formatSize(file.size)}
                      </div>
                    </button>
                    <button
                      onClick={() => void remove(file.path)}
                      aria-label={`Delete ${file.path}`}
                      title="Delete"
                      className="flex-none rounded p-1 text-text-muted opacity-0 transition-opacity hover:text-red-400 focus:opacity-100 group-hover:opacity-100"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.8}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13h10l1-13"
                        />
                      </svg>
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Editor */}
          <div className="flex min-w-0 flex-1 flex-col">
            {selected ? (
              <>
                <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                  <span
                    className="min-w-0 truncate font-mono text-[12px] text-text-secondary"
                    title={selected}
                  >
                    {selected}
                    {dirty && <span className="ml-1.5 text-accent-light">•</span>}
                  </span>
                  <div className="flex flex-none items-center gap-1.5">
                    <button
                      onClick={() => void handleCopy()}
                      className="chip"
                      title="Copy file contents"
                    >
                      <span>{copied ? "Copied" : "Copy"}</span>
                    </button>
                    <button
                      onClick={() => void save()}
                      className="chip"
                      data-active={dirty}
                      disabled={!dirty || saving}
                      title={dirty ? "Save changes" : "No changes to save"}
                    >
                      <span>{saving ? "Saving…" : "Save"}</span>
                    </button>
                  </div>
                </div>

                {truncated && (
                  <div className="border-b border-border bg-bg-hover/40 px-3 py-1.5 text-[11px] text-text-muted">
                    This file is too large to show in full — only the beginning
                    is loaded. Saving would truncate it, so saving is disabled.
                  </div>
                )}

                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  readOnly={truncated}
                  spellCheck={false}
                  className="min-h-0 flex-1 resize-none bg-bg-primary p-3 font-mono text-[12.5px] leading-relaxed text-text-secondary outline-none"
                />
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center px-6 text-center text-[12.5px] leading-relaxed text-text-muted">
                Select a file to view and edit it.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

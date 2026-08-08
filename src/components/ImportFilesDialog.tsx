"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Copy another chat's files into this workspace.
 *
 * Starting a new chat is usually deliberate — a clean slate for a new line of
 * thought — but the files from the last one often still matter. The only
 * alternatives were carrying the whole conversation forward or recreating
 * everything by hand.
 */

interface Chat {
  id: string;
  title: string;
  updatedAt?: string;
}

export function ImportFilesDialog({
  workspaceId,
  onClose,
  onImported,
}: {
  workspaceId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    queueMicrotask(async () => {
      try {
        const res = await fetch("/api/conversations");
        if (!res.ok) return;
        const data = (await res.json()) as { conversations?: Chat[] } | Chat[];
        const list = Array.isArray(data) ? data : (data.conversations ?? []);
        // Copying a workspace into itself is a no-op, so it is not offered.
        setChats(list.filter((c) => c.id !== workspaceId));
      } catch {
        /* the list is the feature; a failure shows as "no chats" */
      }
    });
  }, [workspaceId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => c.title.toLowerCase().includes(q));
  }, [chats, query]);

  const run = async () => {
    if (!picked || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspace/${workspaceId}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: picked }),
      });
      const data = (await res.json()) as {
        copied?: number;
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? "Couldn't copy those files.");
        return;
      }
      onImported();
      onClose();
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative flex h-[min(86vh,32rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border-light bg-bg-secondary shadow-2xl shadow-black/50 animate-fade-in">
        <div className="flex flex-none items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-5 text-text-primary">
              Copy files from another chat
            </h2>
            <p className="mt-0.5 truncate text-[11px] leading-4 text-text-muted">
              Files only. The conversation stays where it is.
            </p>
          </div>
          <button
            onClick={onClose}
            className="icon-btn flex-none"
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width="16" height="16">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-none border-b border-border px-5 py-2.5">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            className="w-full bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-muted"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          {visible.length === 0 ? (
            <p className="py-10 text-center text-[12px] text-text-muted">
              {chats.length === 0
                ? "No other chats yet."
                : "Nothing matches that."}
            </p>
          ) : (
            visible.map((chat) => {
              const selected = picked === chat.id;
              return (
                <button
                  key={chat.id}
                  onClick={() => setPicked(selected ? null : chat.id)}
                  data-active={selected}
                  className="option-item w-full"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">
                    {/* A checkbox rather than a plain row: the choice is
                        committed by the button below, so the row has to show
                        a held state rather than acting immediately. */}
                    <span
                      className={`flex h-4 w-4 flex-none items-center justify-center rounded border transition-colors ${
                        selected
                          ? "border-accent bg-accent text-white"
                          : "border-border"
                      }`}
                    >
                      {selected && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} width="10" height="10">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </span>
                    <span
                      className={`truncate text-[13px] ${
                        selected ? "text-text-primary" : "text-text-secondary"
                      }`}
                    >
                      {chat.title}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="flex flex-none items-center justify-between gap-3 border-t border-border px-5 py-3.5">
          <p className="min-w-0 truncate text-[11px] text-text-muted">
            {error ? (
              <span className="text-danger">{error}</span>
            ) : (
              "Files already here are kept, never overwritten."
            )}
          </p>
          <button
            onClick={run}
            disabled={!picked || busy}
            className="btn-primary flex-none disabled:opacity-40"
          >
            {busy ? "Copying…" : "Copy files"}
          </button>
        </div>
      </div>
    </div>
  );
}

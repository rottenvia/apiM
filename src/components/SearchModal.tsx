"use client";

import { useEffect, useRef, useState } from "react";

export interface SearchHit {
  conversationId: string;
  title: string;
  archived: boolean;
  updatedAt: string;
  matchCount: number;
  titleMatch: boolean;
  snippets: { role: "user" | "assistant"; text: string }[];
}

/** Wrap every case-insensitive occurrence of `needle` in a highlight span. */
function highlight(text: string, needle: string) {
  if (!needle) return text;
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (;;) {
    const at = lower.indexOf(target, cursor);
    if (at === -1) break;
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push(
      <mark
        key={`${at}-${parts.length}`}
        className="rounded-[3px] bg-[#c96442]/25 px-0.5 text-[#ede9e2]"
      >
        {text.slice(at, at + target.length)}
      </mark>
    );
    cursor = at + target.length;
  }
  parts.push(text.slice(cursor));
  return parts;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function SearchModal({
  onSelect,
  onClose,
  sidebarOpen,
}: {
  onSelect: (id: string) => void;
  onClose: () => void;
  /** Offsets the panel so it centres over the chat area, not the window. */
  sidebarOpen: boolean;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [visible, setVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    inputRef.current?.focus();
    return () => cancelAnimationFrame(id);
  }, []);

  const close = () => {
    setVisible(false);
    setTimeout(onClose, 160);
  };

  const choose = (id: string) => {
    onSelect(id);
    close();
  };

  // Debounced search — avoids a request per keystroke.
  useEffect(() => {
    const term = query.trim();
    const controller = new AbortController();

    if (term.length < 2) {
      // Deferred so the state update doesn't land synchronously in the
      // effect body and cascade a re-render.
      queueMicrotask(() => {
        setHits([]);
        setLoading(false);
      });
      return;
    }

    queueMicrotask(() => setLoading(true));
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as SearchHit[];
        setHits(Array.isArray(data) ? data : []);
        setActive(0);
      } catch {
        /* aborted or offline */
      } finally {
        setLoading(false);
      }
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && hits[active]) {
      e.preventDefault();
      choose(hits[active].conversationId);
    }
  };

  return (
    <div
      className="fixed inset-y-0 right-0 z-[70] flex items-start justify-center px-4 pt-[12vh] transition-[left] duration-300 ease-in-out sm:px-6"
      style={{ left: sidebarOpen ? "18rem" : 0 }}
    >
      <div
        onClick={close}
        className={`fixed inset-0 bg-black/60 backdrop-blur-[3px] transition-opacity duration-200 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      />

      <div
        onKeyDown={onKeyDown}
        className={`relative flex w-full max-w-3xl xl:max-w-4xl flex-col overflow-hidden rounded-2xl border border-[#403c34] bg-[#201e1b] shadow-[0_28px_70px_rgba(0,0,0,0.55)] transition-all duration-200 ${
          visible ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0"
        }`}
        role="dialog"
        aria-modal="true"
      >
        {/* Input */}
        <div className="flex flex-none items-center gap-2.5 border-b border-[#2c2924] px-3.5 py-3">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true" className="flex-none text-[#6d685d]">
            <circle cx="11" cy="11" r="8" />
            <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your chats…"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-[#ede9e2] placeholder-[#6d685d] outline-none"
          />
          {loading && (
            <span className="flex-none text-[10px] text-[#6d685d]">…</span>
          )}
          <kbd className="flex-none rounded border border-[#2c2924] px-1.5 py-0.5 font-mono text-[10px] text-[#6d685d]">
            Esc
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[52vh] overflow-y-auto p-1.5 [overscroll-behavior:contain]">
          {query.trim().length < 2 ? (
            <p className="px-3 py-8 text-center text-[13px] text-[#6d685d]">
              Type at least 2 characters to search titles and messages
            </p>
          ) : hits.length === 0 && !loading ? (
            <p className="px-3 py-8 text-center text-[13px] text-[#6d685d]">
              No matches for “{query.trim()}”
            </p>
          ) : (
            hits.map((hit, i) => (
              <button
                key={hit.conversationId}
                onClick={() => choose(hit.conversationId)}
                onMouseEnter={() => setActive(i)}
                data-active={i === active}
                className="w-full rounded-xl px-3 py-2.5 text-left transition-colors data-[active=true]:bg-[#2a2723]"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-[#ede9e2]">
                    {highlight(hit.title, query.trim())}
                  </span>
                  <span className="flex-none text-[10px] text-[#6d685d]">
                    {hit.archived && "archived · "}
                    {timeAgo(hit.updatedAt)}
                  </span>
                </div>

                {hit.snippets.map((s, j) => (
                  <p
                    key={j}
                    className="mt-1 line-clamp-2 text-[12px] leading-snug text-[#a29d92]"
                  >
                    <span className="mr-1 text-[10px] uppercase tracking-wide text-[#6d685d]">
                      {s.role === "user" ? "you" : "ai"}
                    </span>
                    {highlight(s.text, query.trim())}
                  </p>
                ))}

                {hit.matchCount > hit.snippets.length && (
                  <p className="mt-1 text-[10px] text-[#6d685d]">
                    +{hit.matchCount - hit.snippets.length} more matches
                  </p>
                )}
              </button>
            ))
          )}
        </div>

        {hits.length > 0 && (
          <div className="flex flex-none items-center gap-3 border-t border-[#2c2924] px-3.5 py-2 text-[10px] text-[#6d685d]">
            <span>↑↓ navigate</span>
            <span>↵ open</span>
            <span className="ml-auto">
              {hits.length} {hits.length === 1 ? "chat" : "chats"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

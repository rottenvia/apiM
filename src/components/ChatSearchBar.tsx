"use client";

import { useEffect, useRef } from "react";

export function ChatSearchBar({
  query,
  onQueryChange,
  wholeWord,
  onWholeWordChange,
  total,
  current,
  onNext,
  onPrev,
  onClose,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  wholeWord: boolean;
  onWholeWordChange: (value: boolean) => void;
  total: number;
  current: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) onPrev();
      else onNext();
    }
  };

  const hasQuery = query.trim().length > 0;

  return (
    <div className="flex flex-none justify-center px-4 pt-2">
      <div
        onKeyDown={handleKeyDown}
        className="flex w-full max-w-lg items-center gap-1.5 rounded-xl border border-border-light bg-bg-elevated px-2 py-1.5 shadow-[0_8px_28px_rgba(0,0,0,0.35)] animate-fade-in"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
          className="ml-1 flex-none text-text-muted"
        >
          <circle cx="11" cy="11" r="8" />
          <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
        </svg>

        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Find in this chat…"
          className="min-w-0 flex-1 bg-transparent text-sm text-text-primary placeholder-text-muted outline-none"
        />

        {/* Match counter */}
        <span
          className={`flex-none px-1 font-mono text-[11px] tabular-nums ${
            hasQuery && total === 0 ? "text-danger" : "text-text-muted"
          }`}
        >
          {hasQuery ? (total > 0 ? `${current + 1}/${total}` : "0/0") : ""}
        </span>

        {/* Whole-word toggle — "calc" vs "calculator" */}
        <button
          onClick={() => onWholeWordChange(!wholeWord)}
          data-active={wholeWord}
          title={
            wholeWord
              ? "Whole words only — “calc” won’t match “calculator”"
              : "Partial matches — “calc” will match “calculator”"
          }
          aria-pressed={wholeWord}
          className="flex h-6 flex-none items-center rounded-md px-1.5 font-mono text-[11px] font-semibold text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary data-[active=true]:bg-accent/15 data-[active=true]:text-accent-light"
        >
          ab|
        </button>

        <div className="mx-0.5 h-4 w-px flex-none bg-border" />

        <button
          onClick={onPrev}
          disabled={total === 0}
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
          className="flex h-6 w-6 flex-none items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M18 15l-6-6-6 6" />
          </svg>
        </button>

        <button
          onClick={onNext}
          disabled={total === 0}
          title="Next match (Enter)"
          aria-label="Next match"
          className="flex h-6 w-6 flex-none items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
          </svg>
        </button>

        <button
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close find"
          className="flex h-6 w-6 flex-none items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

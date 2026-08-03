"use client";

import { useEffect, useRef, useState } from "react";

export type SearchMode = "off" | "auto" | "always";

const MODES: {
  id: SearchMode;
  label: string;
  description: string;
  note?: string;
}[] = [
  {
    id: "auto",
    label: "Auto",
    description:
      "The model checks whether your question needs live information, and only searches when it does.",
    note: "Recommended — saves tokens on ordinary questions.",
  },
  {
    id: "always",
    label: "Always",
    description: "Run a web search on every message, regardless of topic.",
    note: "Slower and more expensive.",
  },
  {
    id: "off",
    label: "Off",
    description: "Never search. Answers come from the model's own knowledge.",
  },
];

export function SearchModeSelector({
  value,
  onChange,
}: {
  value: SearchMode;
  onChange: (mode: SearchMode) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = MODES.find((m) => m.id === value) ?? MODES[0];

  useEffect(() => {
    if (!isOpen) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen]);

  return (
    // No `relative` — the popover anchors to the composer wrapper so it opens
    // centered above the chat bar, matching the other selectors.
    <div ref={ref}>
      <button
        onClick={() => setIsOpen((o) => !o)}
        className="chip"
        data-active={value !== "off"}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        title="Web search behaviour"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a15.3 15.3 0 014 9 15.3 15.3 0 01-4 9 15.3 15.3 0 01-4-9 15.3 15.3 0 014-9z" />
        </svg>
        <span>Search{value === "off" ? " off" : `: ${current.label}`}</span>
        <svg
          style={{ width: 11, height: 11 }}
          className={`opacity-60 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-1/2 z-50 mb-3 w-[min(21rem,calc(100vw-1.5rem))] -translate-x-1/2">
          <div className="popover-card">
            <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold leading-5 text-text-primary">
                  Web search
                </p>
                <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                  When the assistant is allowed to look things up
                </p>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="popover-close"
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div role="listbox" aria-label="Web search mode" className="p-1.5">
              {MODES.map((mode) => {
                const selected = value === mode.id;
                return (
                  <button
                    key={mode.id}
                    role="option"
                    aria-selected={selected}
                    data-active={selected}
                    className="option-item"
                    onClick={() => {
                      onChange(mode.id);
                      setIsOpen(false);
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={`text-[13px] font-medium leading-5 ${
                            selected ? "text-accent-light" : "text-text-primary"
                          }`}
                        >
                          {mode.label}
                        </span>
                        {selected && (
                          <svg
                            className="h-4 w-4 flex-none text-accent"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2.2}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs leading-5 text-text-secondary">
                        {mode.description}
                      </p>
                      {mode.note && (
                        <p className="mt-1 text-[11px] leading-4 text-text-muted">
                          {mode.note}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { useState, useRef, useEffect } from "react";

interface ThinkingEffortSelectorProps {
  value: string;
  onChange: (value: string) => void;
}

const EFFORTS = [
  {
    id: "auto",
    label: "Auto",
    description: "Adjusts reasoning depth per message.",
    warning: "Can spend more tokens on complex prompts.",
  },
  {
    id: "none",
    label: "None",
    description: "No reasoning. Fastest and cheapest responses.",
    warning: null,
  },
  {
    id: "low",
    label: "Low",
    description: "Light reasoning for everyday questions.",
    warning: null,
  },
  {
    id: "high",
    label: "High",
    description: "Deep reasoning for complex problems and debugging.",
    warning: null,
  },
  {
    id: "max",
    label: "Max",
    description: "Maximum depth — 50K+ thinking tokens per reply.",
    warning: "Slowest and most expensive. Use sparingly.",
  },
];

export function ThinkingEffortSelector({
  value,
  onChange,
}: ThinkingEffortSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const current = EFFORTS.find((e) => e.id === value) || EFFORTS[0];

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen]);

  return (
    // NOTE: no `relative` here — the popover anchors to the composer wrapper
    // (its nearest positioned ancestor) so it is always centered above the
    // chat bar instead of covering it or hanging crookedly off this button.
    <div ref={dropdownRef}>
      <button
        onClick={() => setIsOpen((o) => !o)}
        className="chip"
        data-active={value !== "auto"}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        title="Thinking effort — how deeply the model reasons"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 3l1.85 5.15L19 10l-5.15 1.85L12 17l-1.85-5.15L5 10l5.15-1.85L12 3z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M18.5 15.5l.75 2 2 .75-2 .75-.75 2-.75-2-2-.75 2-.75.75-2z"
          />
        </svg>
        <span>{current.label}</span>
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
            {/* Header with dedicated close button */}
            <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold leading-5 text-text-primary">
                  Thinking effort
                </p>
                <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                  How deeply the model reasons before replying
                </p>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="popover-close"
                aria-label="Close"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {/* Scrollable list — never grows over the chat bar */}
            <div
              role="listbox"
              aria-label="Thinking effort"
              className="max-h-[min(22rem,calc(100dvh-260px))] overflow-y-auto p-1.5"
            >
              {EFFORTS.map((effort) => {
                const selected = value === effort.id;
                return (
                  <button
                    key={effort.id}
                    role="option"
                    aria-selected={selected}
                    data-active={selected}
                    className="option-item"
                    onClick={() => {
                      onChange(effort.id);
                      setIsOpen(false);
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={`text-[13px] font-medium leading-5 ${
                            selected
                              ? "text-accent-light"
                              : "text-text-primary"
                          }`}
                        >
                          {effort.label}
                        </span>
                        {selected && (
                          <svg
                            className="h-4 w-4 flex-none text-accent"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2.2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs leading-5 text-text-secondary">
                        {effort.description}
                      </p>
                      {effort.warning && (
                        <p className="mt-1 text-[11px] leading-4 text-warning">
                          {effort.warning}
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

"use client";

import { useState, useRef, useEffect } from "react";

interface ModelSelectorProps {
  value: string;
  onChange: (value: string) => void;
}

const MODELS = [
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    shortLabel: "V4 Pro",
    description: "49B parameters. Frontier-level quality for the hardest tasks.",
    specs: "1M context · 384K max output",
  },
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    shortLabel: "V4 Flash",
    description: "13B parameters. Fast and economical for quick tasks.",
    specs: "1M context · 384K max output",
  },
];

export function ModelSelector({ value, onChange }: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const current = MODELS.find((m) => m.id === value) || MODELS[0];

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
    // so it stays centered above the chat bar, identical to the thinking menu.
    <div ref={dropdownRef}>
      <button
        onClick={() => setIsOpen((o) => !o)}
        className="chip"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        title="Choose model"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
        >
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <rect x="9" y="9" width="6" height="6" />
          <path
            strokeLinecap="round"
            d="M15 2v2M15 20v2M9 2v2M9 20v2M2 15h2M2 9h2M20 15h2M20 9h2"
          />
        </svg>
        <span>{current.shortLabel}</span>
        <svg
          style={{ width: 11, height: 11 }}
          className={`opacity-60 transition-transform duration-150 ${isOpen ? "rotate-180" : ""}`}
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
                  Model
                </p>
                <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                  Which DeepSeek model answers your messages
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

            {/* Scrollable list */}
            <div
              role="listbox"
              aria-label="Model"
              className="max-h-[min(22rem,calc(100dvh-260px))] overflow-y-auto p-1.5"
            >
              {MODELS.map((model) => {
                const selected = value === model.id;
                return (
                  <button
                    key={model.id}
                    role="option"
                    aria-selected={selected}
                    data-active={selected}
                    className="option-item"
                    onClick={() => {
                      onChange(model.id);
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
                          {model.label}
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
                        {model.description}
                      </p>
                      <p className="mt-1 text-[11px] leading-4 text-text-muted">
                        {model.specs}
                      </p>
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

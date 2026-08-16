"use client";

import { useState, useRef, useEffect } from "react";

interface ThinkingEffortSelectorProps {
  value: string;
  onChange: (value: string) => void;
  /** Which model this applies to — the options differ per model. */
  model?: string;
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

/**
 * What the model actually does with the level you pick.
 *
 * From DeepSeek's own mapping table (api-docs.deepseek.com/guides/
 * thinking_mode). V4 Pro has no light reasoning mode — it silently maps
 * `low` up to `high` — so offering Low on Pro would charge for High while
 * pretending otherwise (the sort of thing you only discover from a bill).
 * Per request, Low is simply not offered on Pro; the real choices are
 * Auto, None, High and Max. Flash honours every level, so its menu keeps
 * Low.
 *
 *   requested   flash     pro
 *   low         low       high   (not offered)
 *   high        high      high
 *   max         max       max
 */
function effortsFor(model: string) {
  const isPro = model !== "deepseek-v4-flash";
  // On Pro, drop the levels the model ignores. Auto is kept so the default
  // still exists; None stays because it genuinely disables thinking.
  return EFFORTS.filter(
    (e) => !isPro || (e.id !== "low")
  );
}

/**
 * Coerce a stored effort value to one the selected model actually honours.
 *
 * If the user had Low picked and then switched to Pro — where Low does not
 * exist and is treated as High — map it up to High rather than leaving the
 * selector showing a missing option or silently sending a level the UI hid.
 */
export function effectiveEffort(effort: string, model: string): string {
  const isPro = model !== "deepseek-v4-flash";
  if (isPro && effort === "low") return "high";
  return effort;
}

export function ThinkingEffortSelector({
  value,
  onChange,
  model = "deepseek-v4-pro",
}: ThinkingEffortSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const efforts = effortsFor(model);
  const current = efforts.find((e) => e.id === value) || efforts[0];

  // If the selected model no longer honours the current value (e.g. Low was
  // picked on Flash, then the user switched to Pro, which has no Low),
  // upgrade it to the nearest real level rather than showing a missing
  // selection and sending a level the UI hid.
  useEffect(() => {
    if (value === "low" && model !== "deepseek-v4-flash") {
      onChange("high");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

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
                  Thinking effort
                </p>
                <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                  {model === "deepseek-v4-flash"
                    ? "How deeply the model reasons before replying"
                    : "V4 Pro has two real depths: High and Max"}
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
              {efforts.map((effort) => {
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

"use client";

import { useEffect, useRef, useState } from "react";

export type SearchMode = "off" | "auto" | "always";

/**
 * Web search, as a single toggle.
 *
 * This replaced a three-way dropdown labelled "Search: Auto". The label was
 * the longest in the composer and the choice behind it was one nobody needed
 * to revisit: "auto" is right for almost every message, and the model already
 * decides per question whether a search is warranted.
 *
 * So the chip is now just on or off, and "on" means auto. The third mode —
 * search on literally every message — is still reachable, but it lives behind
 * a long-press or right-click rather than costing a dropdown in the main row,
 * because choosing it is rare and expensive.
 */
export function WebSearchToggle({
  value,
  onChange,
}: {
  value: SearchMode;
  onChange: (mode: SearchMode) => void;
}) {
  const [showAlways, setShowAlways] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const enabled = value !== "off";

  useEffect(() => {
    if (!showAlways) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setShowAlways(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowAlways(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [showAlways]);

  // Clear a pending long-press if the component goes away mid-hold.
  useEffect(() => {
    return () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    };
  }, []);

  const startHold = () => {
    holdTimer.current = setTimeout(() => setShowAlways(true), 500);
  };
  const cancelHold = () => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  return (
    <div ref={ref}>
      <button
        onClick={() => {
          // A long-press opens the menu; do not also toggle.
          if (showAlways) return;
          onChange(enabled ? "off" : "auto");
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setShowAlways(true);
        }}
        onPointerDown={startHold}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        className="chip"
        data-active={enabled}
        aria-pressed={enabled}
        title={
          value === "always"
            ? "Web search on every message — right-click to change"
            : enabled
              ? "Web search on — right-click for more"
              : "Web search off"
        }
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a15.3 15.3 0 014 9 15.3 15.3 0 01-4 9 15.3 15.3 0 01-4-9 15.3 15.3 0 014-9z" />
        </svg>
        <span>Web</span>
        {/* The rare mode earns a marker, not a whole label. */}
        {value === "always" && (
          <span
            className="h-1 w-1 flex-none rounded-full bg-current"
            aria-hidden="true"
          />
        )}
      </button>

      {showAlways && (
        <div className="absolute bottom-full left-1/2 z-50 mb-3 w-[min(19rem,calc(100vw-1.5rem))] -translate-x-1/2">
          <div className="popover-card p-1.5">
            {(
              [
                {
                  id: "auto" as const,
                  label: "On",
                  blurb: "Gives the agent the web_search tool; it looks things up when it decides it needs to.",
                },
                {
                  id: "always" as const,
                  label: "Every message",
                  blurb: "Same tool, but nudged to default to looking things up.",
                },
                {
                  id: "off" as const,
                  label: "Off",
                  blurb: "The web_search tool is hidden; answers from the model's own knowledge only.",
                },
              ]
            ).map((mode) => {
              const selected = value === mode.id;
              return (
                <button
                  key={mode.id}
                  onClick={() => {
                    onChange(mode.id);
                    setShowAlways(false);
                  }}
                  className="option-item"
                  data-active={selected}
                >
                  <div className="min-w-0 flex-1">
                    <span
                      className={`text-[13px] font-medium leading-5 ${
                        selected ? "text-accent-light" : "text-text-primary"
                      }`}
                    >
                      {mode.label}
                    </span>
                    <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                      {mode.blurb}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

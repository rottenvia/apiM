"use client";

import { useState, useRef, useEffect } from "react";
import {
  getDeepSeekPeriod,
  formatCountdown,
} from "@/lib/deepseek-hours";
import {
  MODELS,
  customSpecs,
  customToModelInfo,
  resolveModelInfo,
} from "@/lib/models";
import type { CustomModelDef } from "@/lib/models";

interface ModelSelectorProps {
  value: string;
  customs: CustomModelDef[];
  onChange: (value: string) => void;
  onOpenSettings: () => void;
}

export function ModelSelector({
  value,
  customs,
  onChange,
  onOpenSettings,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const current = resolveModelInfo(value, customs);
  const showPeakHours = current.peakHours;

  // DeepSeek peak/off-peak indicator. Off-peak (16:30-00:30 Beijing time,
  // UTC+8) gives roughly half-price cache tokens; it updates every minute.
  //
  // Deliberately null on the first render: the label embeds the current
  // time, which differs between the server render and hydration (and the
  // locale format can differ too) — computing it in useState initialised
  // the mismatch React reports as a hydration error. The placeholder dot
  // below keeps the layout stable until the client fills in the real value.
  const [period, setPeriod] = useState<ReturnType<
    typeof getDeepSeekPeriod
  > | null>(null);
  useEffect(() => {
    // No synchronous setState (see ThinkingClock): the callbacks are the
    // only writers, so the mount never trips the set-state-in-effect rule.
    const tick = () => setPeriod(getDeepSeekPeriod());
    const immediate = setTimeout(tick, 0);
    const t = setInterval(tick, 60_000);
    return () => {
      clearTimeout(immediate);
      clearInterval(t);
    };
  }, []);

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
        {showPeakHours &&
          (period ? (
          <span
            aria-hidden
            title={
              period.period === "offpeak"
                ? `DeepSeek off-peak (discount) — ends ${period.nextChangeAtLocal} your time (${period.nextChangeAtBeijing}), in ${formatCountdown(period.nextChangeInMinutes)}`
                : `DeepSeek peak pricing — off-peak starts ${period.nextChangeAtLocal} your time (${period.nextChangeAtBeijing}), in ${formatCountdown(period.nextChangeInMinutes)}`
            }
            className={`ml-0.5 h-1.5 w-1.5 rounded-full ${
              period.period === "offpeak" ? "bg-emerald-400" : "bg-amber-400"
            }`}
          />
          ) : (
          <span
            aria-hidden
            title="DeepSeek peak/off-peak indicator"
            className="ml-0.5 h-1.5 w-1.5 rounded-full bg-border"
          />
          ))}
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
                  DeepSeek, OpenRouter, yours, or a local Qwen
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

            {/* Peak/off-peak is DeepSeek-only. The Nemotron lane is free on OpenRouter. */}
            {/* Gated on period: the menu only opens on click (post-hydration), so this is always set by then. */}
            {showPeakHours && period && (
            <div className="border-b border-border px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                    period.period === "offpeak"
                      ? "bg-emerald-500/15 text-emerald-300"
                      : "bg-amber-500/15 text-amber-300"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      period.period === "offpeak"
                        ? "bg-emerald-400"
                        : "bg-amber-400"
                    }`}
                  />
                  {period.period === "offpeak" ? "Off-peak" : "Peak"}
                </span>
                <span className="text-[11px] leading-4 text-text-muted">
                  {period.period === "offpeak"
                    ? "Discount pricing active"
                    : "Standard pricing"}{" "}
                  · switches to{" "}
                  {period.period === "offpeak" ? "peak" : "off-peak"} at{" "}
                  {period.nextChangeAtLocal} your time (
                  {period.nextChangeAtBeijing}, in{" "}
                  {formatCountdown(period.nextChangeInMinutes)})
                </span>
              </div>
            </div>
            )}

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
              {customs.length > 0 && (
                <>
                  <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    Your models
                  </p>
                  {customs.map((def) => {
                    const info = customToModelInfo(def);
                    const selected = value === def.id;
                    return (
                      <button
                        key={def.id}
                        role="option"
                        aria-selected={selected}
                        data-active={selected}
                        className="option-item"
                        onClick={() => {
                          onChange(def.id);
                          setIsOpen(false);
                        }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className={`truncate text-[13px] font-medium leading-5 ${
                                selected
                                  ? "text-accent-light"
                                  : "text-text-primary"
                              }`}
                            >
                              {def.label}
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
                          <p className="mt-0.5 truncate font-mono text-[11px] leading-4 text-text-secondary">
                            {def.apiModel}
                          </p>
                          <p className="mt-1 text-[11px] leading-4 text-text-muted">
                            OpenRouter · {customSpecs(def)}
                            {info.vision === "native" ? " · vision" : ""}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </>
              )}
              <button
                className="option-item"
                onClick={() => {
                  setIsOpen(false);
                  onOpenSettings();
                }}
              >
                <div className="min-w-0 flex-1">
                  <span className="text-[13px] font-medium leading-5 text-accent-light">
                    ＋ Add any OpenRouter model…
                  </span>
                  <p className="mt-0.5 text-xs leading-5 text-text-secondary">
                    Paste an id in Settings → Model and it lands here.
                  </p>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

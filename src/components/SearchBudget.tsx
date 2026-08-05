"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * This month's search spend, and the setting that controls it.
 *
 * Search is billed per request and one question can fire several, so "1,000
 * free credits" is nowhere near a thousand questions. Without this the first
 * sign of trouble is a quota error in the middle of an answer.
 */

interface ProviderSummary {
  id: string;
  label: string;
  requests: number;
  cached: number;
  usd: number;
  freeMonthlyUsd: number;
  remainingUsd: number;
  remainingRequests: number;
  exhausted: boolean;
}

interface UsageSummary {
  month: string;
  questions: number;
  totalRequests: number;
  totalCached: number;
  totalUsd: number;
  requestsPerQuestion: number;
  cacheHitRate: number;
  daysUntilReset: number;
  providers: ProviderSummary[];
}

interface Props {
  searchProfile: string;
  onSearchProfileChange: (profile: string) => void;
}

const PROFILES = [
  {
    id: "quality",
    name: "Thorough",
    blurb:
      "Reads full pages on every search from the start. The most expensive, and how the app behaved before.",
  },
  {
    id: "balanced",
    name: "Balanced",
    blurb:
      "Skims first, then reads full pages only for whatever is still missing. Same answers on most questions, roughly half the cost.",
    recommended: true,
  },
  {
    id: "cheap",
    name: "Frugal",
    blurb:
      "Skims only, and asks fewer questions per search. Cheapest, and weaker when an answer is buried deep in a page.",
  },
];

function money(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function SearchBudget({ searchProfile, onSearchProfileChange }: Props) {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [cache, setCache] = useState<{ entries: number; bytes: number } | null>(
    null
  );
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/search/usage");
      if (!res.ok) return;
      const data = await res.json();
      setUsage(data.usage);
      setCache(data.cache);
    } catch {
      /* the meter is informational — a failure here must not block settings */
    }
  }, []);

  // Deferred to a microtask so the fetch result never lands synchronously
  // inside the effect, which would cascade a second render.
  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const reset = async (target: "cache" | "usage") => {
    setBusy(true);
    try {
      const res = await fetch(`/api/search/usage?target=${target}`, {
        method: "DELETE",
      });
      if (res.ok) {
        const data = await res.json();
        setUsage(data.usage);
        setCache(data.cache);
      }
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  };

  // Providers with no free allowance are pay-as-you-go only; showing them at
  // "0 left" would read as a problem rather than as "not set up".
  const funded = usage?.providers.filter((p) => p.freeMonthlyUsd > 0) ?? [];

  return (
    <div>
      <label className="block text-sm font-semibold text-text-primary mb-2">
        Web search cost
      </label>
      <p className="mb-2.5 text-[12px] leading-relaxed text-text-secondary">
        Each search is charged separately, and one question can trigger several.
        This is how hard the assistant looks before it answers.
      </p>

      <div className="flex flex-col gap-1.5">
        {PROFILES.map((p) => {
          const active = searchProfile === p.id;
          return (
            <button
              key={p.id}
              onClick={() => onSearchProfileChange(p.id)}
              className="option-item"
              data-active={active}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`text-[13px] font-medium leading-5 ${
                      active ? "text-accent-light" : "text-text-primary"
                    }`}
                  >
                    {p.name}
                  </span>
                  {p.recommended && active && (
                    <span className="text-[11px] text-accent-light">
                      Recommended
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] leading-4 text-text-muted">
                  {p.blurb}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {/* ------------------------------------------------ this month's spend */}
      {usage && (
        <div className="mt-3 rounded-xl border border-border bg-bg-tertiary/60 px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[12px] font-medium text-text-primary">
              This month
            </span>
            <span className="text-[11px] text-text-muted">
              resets in {usage.daysUntilReset}{" "}
              {usage.daysUntilReset === 1 ? "day" : "days"}
            </span>
          </div>

          {funded.length > 0 && (
            <div className="mt-2 flex flex-col gap-1.5">
              {funded.map((p) => {
                const used = Math.min(
                  100,
                  p.freeMonthlyUsd > 0 ? (p.usd / p.freeMonthlyUsd) * 100 : 0
                );
                return (
                  <div key={p.id}>
                    <div className="flex items-baseline justify-between gap-2 text-[11px]">
                      <span className="text-text-secondary">{p.label}</span>
                      <span
                        className={
                          p.exhausted ? "text-[#cf6a5a]" : "text-text-muted"
                        }
                      >
                        {p.exhausted
                          ? "free credit used up"
                          : `about ${p.remainingRequests.toLocaleString()} searches left`}
                      </span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-bg-secondary">
                      <div
                        className={`h-full rounded-full transition-[width] ${
                          p.exhausted ? "bg-[#cf6a5a]" : "bg-accent"
                        }`}
                        style={{ width: `${used}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-2.5 grid grid-cols-3 gap-2 border-t border-border pt-2">
            <Stat label="questions" value={usage.questions.toLocaleString()} />
            <Stat
              label="searches"
              value={usage.totalRequests.toLocaleString()}
            />
            <Stat label="spent" value={money(usage.totalUsd)} />
          </div>

          {usage.questions > 0 && (
            <p className="mt-2 text-[11px] leading-4 text-text-muted">
              {usage.requestsPerQuestion.toFixed(1)} searches per question
              {usage.totalCached > 0 && (
                <>
                  {" · "}
                  {usage.totalCached.toLocaleString()} reused from cache, free
                </>
              )}
            </p>
          )}

          <p className="mt-1.5 text-[10.5px] leading-4 text-text-muted">
            Counted here rather than read from the provider, so treat it as an
            estimate. It is accurate as long as this app is the only thing using
            the key.
          </p>

          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              onClick={() => reset("cache")}
              disabled={busy || !cache?.entries}
              className="rounded-lg border border-border px-2 py-1 text-[11px] text-text-secondary transition-colors hover:border-border-light hover:text-text-primary disabled:opacity-40"
            >
              Clear cache
              {cache?.entries ? ` (${cache.entries})` : ""}
            </button>
            <button
              onClick={() => reset("usage")}
              disabled={busy}
              className="rounded-lg border border-border px-2 py-1 text-[11px] text-text-secondary transition-colors hover:border-border-light hover:text-text-primary disabled:opacity-40"
            >
              Reset counter
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[13px] font-medium tabular-nums text-text-primary">
        {value}
      </div>
      <div className="truncate text-[10.5px] text-text-muted">{label}</div>
    </div>
  );
}

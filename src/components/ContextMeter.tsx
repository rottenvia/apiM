"use client";

import { useEffect, useRef, useState } from "react";

export interface ContextSummaryInfo {
  manual: boolean;
  coveredTurns: number | null;
  updatedAt: string;
  text: string;
}

interface ContextMeterProps {
  /** Tokens the newest round occupied; null before the first reply. */
  used: number | null;
  /** True when `used` is derived from chars rather than reported by the API. */
  estimated: boolean;
  windowTokens: number;
  modelLabel: string;
  /** Where the newest request's bytes lived (chars), largest first. */
  breakdown: { label: string; chars: number }[] | null;
  totals: { tokens: number; cost: number; ms: number; priced: number; messages: number };
  summary: ContextSummaryInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null when there is nothing to compact (new chat, or already compacted). */
  onCompact: ((instructions?: string) => void) | null;
  compacting: boolean;
  /** Why Compact is unavailable, shown in its place. */
  compactBlocked?: string | null;
  /** Last compaction's outcome or error. */
  notice?: { tone: "ok" | "error"; text: string } | null;
  formatCost: (usd: number) => string;
  formatDuration: (ms: number) => string;
}

/** 67.4k, 1M, 812 — the compact form Claude Code's meter uses. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/*
 * Segment colours for the bar, by breakdown bucket. Theme tokens only, so
 * every theme recolours the meter with it.
 */
const SEGMENT_COLOR: Record<string, string> = {
  instructions: "var(--color-accent)",
  "tool schemas": "var(--color-search)",
  plugins: "color-mix(in oklab, var(--color-search) 55%, var(--color-accent))",
  history: "var(--color-warning)",
  summary: "var(--color-success)",
  "your message": "var(--color-text-secondary)",
  "tool results": "color-mix(in oklab, var(--color-warning) 55%, var(--color-danger))",
  "tool calls": "color-mix(in oklab, var(--color-accent) 50%, var(--color-warning))",
  reasoning: "color-mix(in oklab, var(--color-text-muted) 70%, var(--color-accent))",
  media: "var(--color-danger)",
};
const segmentColor = (label: string) =>
  SEGMENT_COLOR[label] ?? "var(--color-text-muted)";

function levelColor(pct: number): string {
  if (pct >= 85) return "var(--color-danger)";
  if (pct >= 60) return "var(--color-warning)";
  return "var(--color-accent)";
}

/**
 * The context-window meter: a ring in the composer, and a panel with what
 * fills the window, what the chat has cost, and a Compact button.
 *
 * Modelled on Claude Code's own: "67.4k / 1M (7%)" with a segmented bar.
 */
export function ContextMeter({
  used,
  estimated,
  windowTokens,
  modelLabel,
  breakdown,
  totals,
  summary,
  open,
  onOpenChange,
  onCompact,
  compacting,
  compactBlocked,
  notice,
  formatCost,
  formatDuration,
}: ContextMeterProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState("");
  const [showSummary, setShowSummary] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  const tokens = used ?? 0;
  const pct = windowTokens > 0 ? Math.min(100, (tokens / windowTokens) * 100) : 0;
  const pctLabel = pct > 0 && pct < 1 ? "<1" : String(Math.round(pct));
  const color = levelColor(pct);
  const R = 7;
  const C = 2 * Math.PI * R;

  // Breakdown is in chars; scale it onto the token count so the bar adds up.
  const totalChars = (breakdown ?? []).reduce((n, p) => n + p.chars, 0);
  const segments =
    totalChars > 0 && tokens > 0
      ? (breakdown ?? []).map((p) => ({
          label: p.label,
          tokens: (p.chars / totalChars) * tokens,
        }))
      : [];

  return (
    <div ref={ref} className="flex-none">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className="chip px-2"
        aria-expanded={open}
        aria-label={`Context window ${pctLabel}% full`}
        title={
          used === null
            ? "Context window — fills as the chat grows"
            : `Context: ${estimated ? "~" : ""}${formatTokens(tokens)} / ${formatTokens(windowTokens)} tokens (${pctLabel}%)`
        }
      >
        <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true" className="-rotate-90">
          <circle cx="9" cy="9" r={R} fill="none" stroke="var(--color-border-light)" strokeWidth="2.2" />
          <circle
            cx="9"
            cy="9"
            r={R}
            fill="none"
            stroke={color}
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeDasharray={`${(Math.max(pct, used ? 2 : 0) / 100) * C} ${C}`}
            style={{ transition: "stroke-dasharray 400ms ease, stroke 400ms ease" }}
          />
        </svg>
        <span className="hidden tabular-nums sm:inline">{used === null ? "0%" : `${pctLabel}%`}</span>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-3 w-[min(22rem,calc(100vw-1.5rem))]">
          <div className="popover-card p-3 text-[12px] leading-5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium text-text-primary">Context window</span>
              <span className="tabular-nums text-text-secondary">
                {used === null
                  ? `— / ${formatTokens(windowTokens)}`
                  : `${estimated ? "~" : ""}${formatTokens(tokens)} / ${formatTokens(windowTokens)} (${pctLabel}%)`}
              </span>
            </div>

            <div
              className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-bg-hover"
              role="img"
              aria-label={`${pctLabel}% of the context window used`}
            >
              {segments.length > 0 ? (
                segments.map((s) => (
                  <span
                    key={s.label}
                    style={{
                      width: `${(s.tokens / windowTokens) * 100}%`,
                      background: segmentColor(s.label),
                    }}
                  />
                ))
              ) : (
                <span style={{ width: `${pct}%`, background: color }} />
              )}
            </div>

            {segments.length > 0 && (
              <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-text-muted">
                {segments.slice(0, 8).map((s) => (
                  <li key={s.label} className="flex min-w-0 items-center gap-1.5">
                    <span
                      className="h-2 w-2 flex-none rounded-full"
                      style={{ background: segmentColor(s.label) }}
                    />
                    <span className="truncate">{s.label}</span>
                    <span className="ml-auto tabular-nums">{formatTokens(s.tokens)}</span>
                  </li>
                ))}
              </ul>
            )}

            <p className="mt-2 text-[11px] leading-4 text-text-muted">
              {used === null
                ? `Fills as the chat grows. ${modelLabel} holds ${formatTokens(windowTokens)} tokens.`
                : `What the newest request to ${modelLabel} carried${estimated ? " (estimated from its size)" : ""}. The next message adds to it.`}
            </p>

            {summary && (
              <div className="mt-3 border-t border-border pt-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-text-secondary">
                    {summary.manual ? "Compacted" : "Older turns summarised"}
                    {summary.coveredTurns ? ` · ${summary.coveredTurns} messages` : ""}
                    <span className="text-text-muted"> · {ago(summary.updatedAt)}</span>
                  </span>
                  <button
                    type="button"
                    className="text-[11px] text-accent-light hover:underline"
                    onClick={() => setShowSummary((v) => !v)}
                  >
                    {showSummary ? "Hide" : "View summary"}
                  </button>
                </div>
                {showSummary && (
                  <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-bg-hover/60 p-2 font-sans text-[11px] leading-4 text-text-secondary">
                    {summary.text}
                  </pre>
                )}
              </div>
            )}

            {totals.tokens > 0 && (
              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-0.5 border-t border-border pt-2.5 text-[11px] text-text-muted">
                <span className="font-medium text-text-secondary">This chat</span>
                <span className="tabular-nums">{totals.tokens.toLocaleString()} tokens</span>
                {totals.priced > 0 && <span className="tabular-nums">{formatCost(totals.cost)}</span>}
                {totals.ms > 0 && <span className="tabular-nums">{formatDuration(totals.ms)}</span>}
                <span className="tabular-nums">{totals.messages} messages</span>
              </div>
            )}

            <div className="mt-3 border-t border-border pt-2.5">
              {onCompact ? (
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!compacting) onCompact(focus.trim() || undefined);
                  }}
                >
                  <input
                    value={focus}
                    onChange={(e) => setFocus(e.target.value)}
                    placeholder="Keep in focus (optional)"
                    className="min-w-0 flex-1 rounded-lg border border-border bg-transparent px-2 py-1 text-[12px] text-text-primary placeholder-text-muted outline-none focus:border-border-light"
                    disabled={compacting}
                  />
                  <button
                    type="submit"
                    disabled={compacting}
                    className="flex-none rounded-lg bg-accent px-2.5 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                  >
                    {compacting ? "Compacting…" : "Compact"}
                  </button>
                </form>
              ) : (
                <p className="text-[11px] text-text-muted">
                  {compactBlocked ?? "Nothing to compact yet."}
                </p>
              )}
              {notice && (
                <p
                  role="status"
                  className={`mt-1.5 text-[11px] leading-4 ${notice.tone === "error" ? "text-danger" : "text-success"}`}
                >
                  {notice.text}
                </p>
              )}
              <p className="mt-1.5 text-[11px] leading-4 text-text-muted">
                Compact replaces the conversation with a summary for the model — your transcript stays on screen. Also: <code>/compact</code> in the message box.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

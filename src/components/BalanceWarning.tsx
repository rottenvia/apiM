"use client";

/**
 * How much is left, shown only when that is worth knowing.
 *
 * A balance readout on screen at all times is one more number competing with
 * the reply, and for most of a session it says the same uninteresting thing.
 * So this is silent while there is comfortably enough, and speaks up on the
 * way down — earlier and more insistently the lower it gets.
 *
 * The thresholds are chosen against how this app actually spends. A single
 * agent task at max thinking can run to a few tens of cents, so "low" has to
 * mean "less than one more task", not "nearly zero" — by the time it is
 * nearly zero the warning is too late to act on, which is exactly how an
 * account ends up overdrawn.
 */

/** Below this, a task might not finish. Roughly one max-thinking run. */
export const LOW_BALANCE_USD = 0.5;
/** Below this, most agent tasks will fail partway. */
export const CRITICAL_BALANCE_USD = 0.15;

export type BalanceLevel = "ok" | "low" | "critical" | "empty";

export function levelFor(total: number, available: boolean): BalanceLevel {
  // Negative is possible: DeepSeek admits a request against the balance and
  // deducts after it finishes, so a long run can end below zero.
  if (!available || total <= 0) return "empty";
  if (total < CRITICAL_BALANCE_USD) return "critical";
  if (total < LOW_BALANCE_USD) return "low";
  return "ok";
}

const COPY: Record<
  Exclude<BalanceLevel, "ok">,
  { title: string; detail: string; tone: string }
> = {
  low: {
    title: "Running low",
    detail:
      "Enough for a short reply, probably not a full agent task. Top up before starting anything long.",
    tone: "#cfa25a",
  },
  critical: {
    title: "Almost empty",
    detail:
      "A long task will stop partway. Whatever it has done is kept, and Continue picks it up once you top up.",
    tone: "#cfa25a",
  },
  empty: {
    title: "Out of balance",
    detail:
      "DeepSeek bills after each request, so a long run can finish overdrawn. Requests will fail until this is positive again.",
    tone: "#cf6a5f",
  },
};

function formatUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export function BalanceWarning({
  total,
  available,
  onDismiss,
  onRefresh,
  checking,
}: {
  total: number;
  available: boolean;
  onDismiss: () => void;
  onRefresh: () => void;
  checking: boolean;
}) {
  const level = levelFor(total, available);
  if (level === "ok") return null;

  const copy = COPY[level];

  return (
    <div className="balance-warning px-4 pb-1.5 sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        <div
          className="flex items-start gap-2.5 rounded-xl border px-3 py-2"
          style={{
            borderColor: `color-mix(in oklab, ${copy.tone} 30%, transparent)`,
            background: `color-mix(in oklab, ${copy.tone} 8%, transparent)`,
          }}
        >
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke={copy.tone} strokeWidth={1.9} aria-hidden="true"
            className="mt-0.5 flex-none"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span
                className="text-[13px] font-semibold"
                style={{ color: copy.tone }}
              >
                {copy.title}
              </span>
              <span className="text-[13px] font-medium text-text-primary">
                {formatUsd(total)}
              </span>
              <span className="text-[11px] text-text-muted">on DeepSeek</span>
            </div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-text-secondary">
              {copy.detail}
            </p>

            <div className="mt-1.5 flex items-center gap-2">
              <a
                href="https://platform.deepseek.com/top_up"
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg px-2 py-1 text-[11px] font-medium transition-colors"
                style={{
                  color: copy.tone,
                  background: `color-mix(in oklab, ${copy.tone} 14%, transparent)`,
                }}
              >
                Top up
              </a>
              <button
                onClick={onRefresh}
                disabled={checking}
                className="rounded-lg px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:bg-bg-hover disabled:opacity-50"
              >
                {checking ? "Checking…" : "Check again"}
              </button>
            </div>
          </div>

          <button
            onClick={onDismiss}
            title="Hide until it changes"
            aria-label="Hide until it changes"
            className="flex-none rounded-lg p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-secondary"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden="true">
              <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

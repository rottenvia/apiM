/**
 * Token pricing, used to show what a reply actually cost and to enforce the
 * per-reply spending cap.
 *
 * Rates are per 1M tokens, from DeepSeek's published V4 pricing that took
 * effect 16:00 UTC on 2026-08-16. They introduced peak/off-peak tiers, where
 * off-peak is exactly half peak, so a single number per tier no longer
 * describes the bill. The figures that matter for an agent running many
 * rounds are the CACHE rates: a reused prefix is about 30x cheaper than a
 * miss (down from ~120x before this change), which is what changed the
 * economics of compaction.
 *
 * Peak hours (UTC): 01:00-04:00 and 06:00-10:00 daily. Everything else is
 * off-peak. The split is computed from the clock; tests can pin a time.
 */

/** One set of per-1M-token rates. */
export interface ModelRates {
  /** Cache-miss input, per 1M tokens. */
  input: number;
  /** Cache-hit input, per 1M tokens. */
  cachedInput: number;
  /** Output, per 1M tokens. */
  output: number;
}

const OFF_PEAK: Record<string, ModelRates> = {
  "deepseek-v4-pro": { input: 0.66, cachedInput: 0.022, output: 1.98 },
  "deepseek-v4-flash": { input: 0.22, cachedInput: 0.007, output: 0.66 },
};

/** Peak is exactly 2x off-peak for every token type. */
const PEAK: Record<string, ModelRates> = Object.fromEntries(
  Object.entries(OFF_PEAK).map(([model, r]) => [
    model,
    { input: r.input * 2, cachedInput: r.cachedInput * 2, output: r.output * 2 },
  ])
);

/**
 * Is the given instant (or now) in a peak pricing window?
 *
 * Peak windows are fixed UTC ranges regardless of the server's own timezone:
 * 01:00-04:00 and 06:00-10:00.
 */
export function isPeakPricing(at: Date = new Date()): boolean {
  const h = at.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/** Rates for a model at a given instant, defaulting to now. */
export function ratesFor(
  model: string,
  at: Date = new Date()
): ModelRates | undefined {
  return (isPeakPricing(at) ? PEAK : OFF_PEAK)[model];
}

/**
 * @deprecated Use `ratesFor(model)` to get peak/off-peak aware rates. Retained
 * for callers that need a single representative figure (e.g. tests); it
 * returns the off-peak rate, which is the lower bound.
 */
export const MODEL_RATES: Record<string, ModelRates> = OFF_PEAK;

export interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** DeepSeek reports how much of the prompt hit its cache. */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

/**
 * Estimate the cost of one exchange in USD.
 *
 * Returns null for an unknown model rather than guessing, so the UI can stay
 * silent instead of showing a number that might be wrong.
 */
export function estimateCost(
  usage: UsageLike | null | undefined,
  model: string,
  at: Date = new Date()
): number | null {
  if (!usage) return null;
  const rates = ratesFor(model, at);
  if (!rates) return null;

  const completion = usage.completion_tokens ?? 0;
  const prompt = usage.prompt_tokens ?? 0;

  // Prefer the reported cache split; fall back to treating everything as a miss.
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit);

  return (
    (miss / 1e6) * rates.input +
    (hit / 1e6) * rates.cachedInput +
    (completion / 1e6) * rates.output
  );
}

/** Format a cost for display, keeping very small amounts legible. */
export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Format an elapsed duration compactly. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

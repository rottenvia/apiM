/**
 * Token pricing, used to show what a reply actually cost.
 *
 * Rates are per 1M tokens, from DeepSeek's published pricing (verified
 * 2026-08-03). They are only used for display, so a stale rate misleads
 * rather than overcharges — worth re-checking if DeepSeek changes pricing.
 */

export interface ModelRates {
  /** Cache-miss input, per 1M tokens. */
  input: number;
  /** Cache-hit input, per 1M tokens. */
  cachedInput: number;
  /** Output, per 1M tokens. */
  output: number;
}

export const MODEL_RATES: Record<string, ModelRates> = {
  "deepseek-v4-pro": { input: 0.435, cachedInput: 0.003625, output: 0.87 },
  "deepseek-v4-flash": { input: 0.14, cachedInput: 0.0028, output: 0.28 },
};

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
  model: string
): number | null {
  if (!usage) return null;
  const rates = MODEL_RATES[model];
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

/**
 * Token pricing, used to show what a reply actually cost.
 *
 * Rates are per 1M tokens, from DeepSeek's published pricing (verified
 * 2026-08-03). DeepSeek prices in Beijing time: off-peak (16:30-00:30
 * Beijing, UTC+8) is roughly half price on input/output (cache-hit is
 * already so cheap it is left unchanged). Used for display, so a stale
 * rate misleads rather than overcharges.
 */

import { getDeepSeekPeriod, type DeepSeekPeriod } from "./deepseek-hours";
export { getDeepSeekPeriod };

export interface ModelRates {
  input: number;
  cachedInput: number;
  output: number;
}

export const MODEL_RATES: Record<string, ModelRates> = {
  "deepseek-v4-pro": { input: 0.435, cachedInput: 0.003625, output: 0.87 },
  "deepseek-v4-flash": { input: 0.14, cachedInput: 0.0028, output: 0.28 },
  // OpenCode Zen lists Ox Alpha Free at $0 / $0 during the stealth preview.
  "ox-alpha": { input: 0, cachedInput: 0, output: 0 },
  // Electricity only — the weights run on the user's GPU.
  "qwen-3.8-27b": { input: 0, cachedInput: 0, output: 0 },
};

/** Off-peak multiplier for input/output (Beijing 16:30-00:30). Cache-hit unchanged. */
const OFFPEAK_FACTOR = 0.5;

export function ratesFor(
  model: string,
  period: DeepSeekPeriod = getDeepSeekPeriod().period
): ModelRates | null {
  const base = MODEL_RATES[model];
  if (!base) return null;
  if (period === "offpeak") {
    return {
      input: +(base.input * OFFPEAK_FACTOR).toFixed(6),
      cachedInput: base.cachedInput,
      output: +(base.output * OFFPEAK_FACTOR).toFixed(6),
    };
  }
  return base;
}

export interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  /**
   * Reasoning tokens, when reported separately (completion_tokens_details.
   * reasoning_tokens). They are a subset of completion_tokens and are billed
   * as output; kept so the UI can prove thinking was counted.
   */
  completion_tokens_details?: { reasoning_tokens?: number };
}

/**
 * Cost of one exchange in USD at the current peak/off-peak rate.
 *
 * Every billed token is counted:
 *   prompt miss -> input rate
 *   prompt hit  -> cache-hit rate
 *   completion  -> output rate (INCLUDES reasoning: completion_tokens sums
 *                  visible text + thinking, and providers bill thinking as
 *                  output)
 */
export function estimateCost(
  usage: UsageLike | null | undefined,
  model: string,
  period?: DeepSeekPeriod
): number | null {
  if (!usage) return null;
  const rates = ratesFor(model, period);
  if (!rates) return null;

  const completion = usage.completion_tokens ?? 0;
  const prompt = usage.prompt_tokens ?? 0;
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss =
    usage.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit);

  return (
    (miss / 1e6) * rates.input +
    (hit / 1e6) * rates.cachedInput +
    (completion / 1e6) * rates.output
  );
}

export function reasoningTokens(usage: UsageLike | null | undefined): number {
  return usage?.completion_tokens_details?.reasoning_tokens ?? 0;
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

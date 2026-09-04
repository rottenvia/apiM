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
  // Z.ai list price for GLM 5.3 Flash on OpenRouter (verified 2026-08-26):
  // $0.15 in / $0.50 out / $0.03 cache-read per 1M. A 50% launch discount
  // (0.075 / 0.015 / 0.25) runs through 2026-09-09 — budget against the
  // list price so the spending cap never undercounts.
  "glm-5.3-flash": { input: 0.15, cachedInput: 0.03, output: 0.5 },
  // OpenCode Zen's free preview lane for DeepSeek V4 Flash.
  "deepseek-v4-flash-free": { input: 0, cachedInput: 0, output: 0 },
  // Electricity only — the weights run on the user's GPU.
  "qwen-3.8-27b": { input: 0, cachedInput: 0, output: 0 },
};

/** Off-peak multiplier for input/output (Beijing 16:30-00:30). Cache-hit unchanged. */
const OFFPEAK_FACTOR = 0.5;

/**
 * GLM 5.3 Flash launched at half list price through 2026-09-09 16:00 UTC.
 *
 * The spending limit deliberately uses MODEL_RATES directly (list price), so
 * it never undercounts. The cost shown after a reply should reflect the rate
 * actually billed, though, or the number is "safe" but wrong by 2x during a
 * week-long launch window.
 */
const GLM_DISCOUNT_END_MS = Date.UTC(2026, 8, 9, 16, 0, 0);

function applyTemporaryDiscount(
  model: string,
  rates: ModelRates,
  now: number
): ModelRates {
  if (model !== "glm-5.3-flash" || now >= GLM_DISCOUNT_END_MS) return rates;
  return {
    input: +(rates.input * 0.5).toFixed(6),
    cachedInput: +(rates.cachedInput * 0.5).toFixed(6),
    output: +(rates.output * 0.5).toFixed(6),
  };
}

export function ratesFor(
  model: string,
  period: DeepSeekPeriod = getDeepSeekPeriod().period,
  now: number = Date.now()
): ModelRates | null {
  const base = MODEL_RATES[model];
  if (!base) return null;
  if (period === "offpeak") {
    return applyTemporaryDiscount(model, {
      input: +(base.input * OFFPEAK_FACTOR).toFixed(6),
      cachedInput: base.cachedInput,
      output: +(base.output * OFFPEAK_FACTOR).toFixed(6),
    }, now);
  }
  return applyTemporaryDiscount(model, base, now);
}

export interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  /**
   * OpenRouter's cache fields.
   *
   * DeepSeek reports cached prompt tokens as `prompt_cache_hit_tokens`;
   * OpenRouter (GLM 5.3 Flash, Ox-on-OpenRouter, etc.) follows the OpenAI
   * shape and reports them as `prompt_tokens_details.cached_tokens`. If we
   * read only DeepSeek's field, every OpenRouter cache hit is priced as a
   * full-price miss — a cached read costs ~1/5 of a miss for GLM, so easy
   * follow-up requests appeared to cost cents when their real incremental
   * cost was a fraction of that.
   */
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  };
  /**
   * Reasoning tokens, when reported separately (completion_tokens_details.
   * reasoning_tokens). They are a subset of completion_tokens and are billed
   * as output; kept so the UI can prove thinking was counted.
   */
  completion_tokens_details?: { reasoning_tokens?: number };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Normalize DeepSeek and OpenRouter usage shapes to the same cache split.
 *
 * Cache writes are charged at input rates, not cache-read rates: they are a
 * one-time full-price prefix read. Keeping them out of the cache-hit bucket
 * also prevents a miss from being silently discounted.
 */
export function cacheSplit(usage: UsageLike): {
  prompt: number;
  completion: number;
  hit: number;
  miss: number;
} {
  const completion = num(usage.completion_tokens);
  const prompt = num(usage.prompt_tokens);
  const created = num(
    usage.prompt_tokens_details?.cache_creation_tokens
  );
  const hit = Math.max(
    0,
    num(usage.prompt_cache_hit_tokens) +
      num(usage.prompt_tokens_details?.cached_tokens) +
      num(usage.prompt_tokens_details?.cache_read_tokens)
  );
  const explicitMiss = num(usage.prompt_cache_miss_tokens);
  // Cache writes are charged like ordinary input, not cache reads.
  const miss =
    explicitMiss > 0
      ? explicitMiss
      : Math.max(0, prompt - hit);

  return {
    prompt,
    completion,
    hit,
    miss: Math.max(miss, created),
  };
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

  const { completion, hit, miss } = cacheSplit(usage);

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

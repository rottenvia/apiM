/**
 * What has been spent on web search this month.
 *
 * Providers meter in billing units that do not match how the app is used: a
 * single question can fire seven billed requests across two rounds, so "1,000
 * free credits" is nowhere near a thousand questions. Without a meter the
 * first sign of trouble is a quota error mid-answer.
 *
 * Counted locally rather than read from the provider, because most do not
 * report a remaining balance per response. That is accurate while this app is
 * the only consumer of the key, which is the intended setup, but it is an
 * estimate and the UI says so.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** Overridable so parallel test suites do not share one usage ledger. */
const USAGE_FILE = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT, "search-usage.json")
  : path.resolve(process.cwd(), "data", "search-usage.json");

/** Known providers, with what their free allowance is worth per month. */
export interface ProviderInfo {
  id: string;
  label: string;
  /**
   * Cost of one billed request, in USD, at the pay-as-you-go rate.
   *
   * Display only. A stale rate misleads rather than overcharges, so it is
   * worth re-checking when a provider changes pricing.
   */
  costPerRequest: number;
  /** Value of the recurring monthly free allowance, in USD. */
  freeMonthlyUsd: number;
  /** True when the provider bills advanced depth at twice the basic rate. */
  depthDoubles: boolean;
}

/** Verified 2026-08-05 against each provider's public pricing page. */
export const PROVIDERS: Record<string, ProviderInfo> = {
  exa: {
    id: "exa",
    label: "Exa",
    costPerRequest: 0.007,
    freeMonthlyUsd: 10,
    depthDoubles: false,
  },
  tavily: {
    id: "tavily",
    label: "Tavily",
    costPerRequest: 0.008,
    freeMonthlyUsd: 8,
    depthDoubles: true,
  },
  linkup: {
    id: "linkup",
    label: "Linkup",
    costPerRequest: 0.005,
    freeMonthlyUsd: 5,
    depthDoubles: false,
  },
  serper: {
    id: "serper",
    label: "Serper",
    costPerRequest: 0.001,
    freeMonthlyUsd: 0,
    depthDoubles: false,
  },
};

export interface ProviderUsage {
  /** Billed requests actually sent. */
  requests: number;
  /** Requests answered from cache, so billed nothing. */
  cached: number;
  /** Estimated spend in USD. */
  usd: number;
}

export interface UsageRecord {
  /** Calendar month this record covers, as YYYY-MM. */
  month: string;
  /** Questions that triggered at least one search. */
  questions: number;
  providers: Record<string, ProviderUsage>;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function emptyRecord(): UsageRecord {
  return { month: currentMonth(), questions: 0, providers: {} };
}

/**
 * Read this month's usage.
 *
 * A record from a previous month is discarded rather than migrated, because
 * free allowances reset monthly and carrying the number forward would show a
 * quota as exhausted when it had just refilled.
 */
export async function readUsage(): Promise<UsageRecord> {
  try {
    const raw = await fs.readFile(USAGE_FILE, "utf8");
    const parsed = JSON.parse(raw) as UsageRecord;
    if (parsed.month !== currentMonth()) return emptyRecord();
    if (!parsed.providers || typeof parsed.providers !== "object") {
      return emptyRecord();
    }
    return parsed;
  } catch {
    return emptyRecord();
  }
}

/**
 * Serialise writes.
 *
 * Searches inside one round run through Promise.all, so several results land
 * at once; a naive read-modify-write loses all but the last.
 */
let writeChain: Promise<void> = Promise.resolve();

async function update(mutate: (r: UsageRecord) => void): Promise<void> {
  const next = writeChain.then(async () => {
    try {
      const record = await readUsage();
      mutate(record);
      await fs.mkdir(path.dirname(USAGE_FILE), { recursive: true });
      const tmp = `${USAGE_FILE}.${process.pid}.${Math.random()
        .toString(36)
        .slice(2)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
      await fs.rename(tmp, USAGE_FILE);
    } catch {
      /* metering must never break a search */
    }
  });
  // Keep the chain alive even if one link rejects.
  writeChain = next.catch(() => {});
  return next;
}

/** Record one billed request. */
export async function recordRequest(
  providerId: string,
  depth: string
): Promise<void> {
  const info = PROVIDERS[providerId];
  const multiplier = info?.depthDoubles && depth === "advanced" ? 2 : 1;
  const cost = (info?.costPerRequest ?? 0) * multiplier;

  await update((r) => {
    const p = (r.providers[providerId] ??= { requests: 0, cached: 0, usd: 0 });
    p.requests += multiplier;
    p.usd += cost;
  });
}

/** Record a request served from cache, which cost nothing. */
export async function recordCacheHit(providerId: string): Promise<void> {
  await update((r) => {
    const p = (r.providers[providerId] ??= { requests: 0, cached: 0, usd: 0 });
    p.cached += 1;
  });
}

/** Record that one question triggered a search. */
export async function recordQuestion(): Promise<void> {
  await update((r) => {
    r.questions += 1;
  });
}

export interface ProviderSummary extends ProviderUsage {
  id: string;
  label: string;
  freeMonthlyUsd: number;
  /** Remaining free allowance in USD, floored at zero. */
  remainingUsd: number;
  /** Roughly how many more requests the free allowance covers. */
  remainingRequests: number;
  /** True once the free allowance is spent. */
  exhausted: boolean;
}

export interface UsageSummary {
  month: string;
  questions: number;
  totalRequests: number;
  totalCached: number;
  totalUsd: number;
  /** Billed requests per question — the efficiency dial. */
  requestsPerQuestion: number;
  /** Share of requests answered from cache, 0-1. */
  cacheHitRate: number;
  /** Days until free allowances reset. */
  daysUntilReset: number;
  providers: ProviderSummary[];
}

function daysUntilReset(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(0, Math.ceil((next - now.getTime()) / 86_400_000));
}

/** Build the display-ready view of this month's spend. */
export async function usageSummary(): Promise<UsageSummary> {
  // Counters are written fire-and-forget, so without this the meter can show
  // a figure one or two requests behind the search that just ran.
  await flushUsage();
  const record = await readUsage();

  const providers: ProviderSummary[] = Object.values(PROVIDERS).map((info) => {
    const used = record.providers[info.id] ?? {
      requests: 0,
      cached: 0,
      usd: 0,
    };
    const remainingUsd = Math.max(0, info.freeMonthlyUsd - used.usd);
    return {
      ...used,
      id: info.id,
      label: info.label,
      freeMonthlyUsd: info.freeMonthlyUsd,
      remainingUsd,
      remainingRequests:
        info.costPerRequest > 0
          ? Math.floor(remainingUsd / info.costPerRequest)
          : 0,
      exhausted: info.freeMonthlyUsd > 0 && remainingUsd <= 0,
    };
  });

  const totalRequests = providers.reduce((n, p) => n + p.requests, 0);
  const totalCached = providers.reduce((n, p) => n + p.cached, 0);
  const totalUsd = providers.reduce((n, p) => n + p.usd, 0);

  return {
    month: record.month,
    questions: record.questions,
    totalRequests,
    totalCached,
    totalUsd,
    requestsPerQuestion:
      record.questions > 0 ? totalRequests / record.questions : 0,
    cacheHitRate:
      totalRequests + totalCached > 0
        ? totalCached / (totalRequests + totalCached)
        : 0,
    daysUntilReset: daysUntilReset(),
    providers,
  };
}

/**
 * Wait for every pending write to land.
 *
 * Counters are updated fire-and-forget so metering never delays a search, but
 * anything that reads the total straight afterwards — the API route, a test —
 * would otherwise see a figure that is one or two requests behind.
 */
export async function flushUsage(): Promise<void> {
  await writeChain;
}

/** Wipe the counters. Exposed so the UI can reset after a plan change. */
export async function resetUsage(): Promise<void> {
  await flushUsage();
  await fs.rm(USAGE_FILE, { force: true });
}

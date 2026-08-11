/**
 * On-disk cache for web search results.
 *
 * Every search costs money. During a working session the same query is fired
 * repeatedly — re-asking a question, a follow-up round landing on a phrasing
 * already tried, or simply reloading after a crash. Each of those was a fresh
 * billed request for content that had not changed.
 *
 * A cache hit returns the exact results the provider returned, so answer
 * quality is identical; only the bill and the latency change. The one real
 * risk is staleness, handled by a TTL and by refusing to cache anything the
 * caller marked as time-sensitive.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SearchResultItem } from "@/lib/search-types";

/** Overridable so parallel test suites do not share one cache. */
const CACHE_DIR = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT, "search-cache")
  : path.resolve(process.cwd(), "data", "search-cache");

/**
 * How long a cached result stays usable.
 *
 * Long enough to cover a working session and the retries within it, short
 * enough that "what is the latest version of X" does not answer from last
 * week. Time-ranged queries bypass the cache entirely regardless.
 */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Stop the cache directory growing without bound. */
export const MAX_CACHE_ENTRIES = 500;

interface CacheEntry {
  /** Stored for debugging; the filename is the hash, not this. */
  query: string;
  provider: string;
  depth: string;
  maxResults: number;
  createdAt: number;
  results: SearchResultItem[];
}

/**
 * Identity of a search, for cache purposes.
 *
 * Provider and depth are part of the key because the same words sent to a
 * different provider, or at a different depth, are a different request that
 * returns different content — reusing across them would silently downgrade
 * results.
 */
export interface CacheKeyParts {
  query: string;
  provider: string;
  depth: string;
  maxResults: number;
}

function keyFor(parts: CacheKeyParts): string {
  const normalised = [
    parts.query.trim().toLowerCase().replace(/\s+/g, " "),
    parts.provider,
    parts.depth,
    String(parts.maxResults),
  ].join("\u0000");
  return createHash("sha256").update(normalised).digest("hex").slice(0, 32);
}

/**
 * Look for a usable cached result.
 *
 * Returns null on anything unexpected rather than throwing: a broken cache
 * must degrade into "no cache", never into a failed search.
 */
export async function readCache(
  parts: CacheKeyParts
): Promise<SearchResultItem[] | null> {
  try {
    const file = path.join(CACHE_DIR, `${keyFor(parts)}.json`);
    const raw = await fs.readFile(file, "utf8");
    const entry = JSON.parse(raw) as CacheEntry;

    if (!Array.isArray(entry.results)) return null;
    if (Date.now() - entry.createdAt > CACHE_TTL_MS) return null;

    return entry.results;
  } catch {
    return null;
  }
}

/**
 * Store a result. Failures are swallowed — a cache that cannot write is a
 * slower app, not a broken one.
 */
export async function writeCache(
  parts: CacheKeyParts,
  results: SearchResultItem[]
): Promise<void> {
  // An empty result set is usually a transient provider problem. Caching it
  // would lock in the failure for a whole day.
  if (results.length === 0) return;

  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const entry: CacheEntry = {
      query: parts.query,
      provider: parts.provider,
      depth: parts.depth,
      maxResults: parts.maxResults,
      createdAt: Date.now(),
      results,
    };
    const file = path.join(CACHE_DIR, `${keyFor(parts)}.json`);
    // Unique temp name per write: a shared ".tmp" raced between concurrent
    // searches and produced ENOENT when one rename beat another's write.
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entry), "utf8");
    await fs.rename(tmp, file);
    await prune();
  } catch {
    /* cache is best-effort */
  }
}

/** Drop the oldest entries once the directory grows past the cap. */
async function prune(): Promise<void> {
  try {
    const names = (await fs.readdir(CACHE_DIR)).filter((n) =>
      n.endsWith(".json")
    );
    if (names.length <= MAX_CACHE_ENTRIES) return;

    const stats = await Promise.all(
      names.map(async (name) => {
        const full = path.join(CACHE_DIR, name);
        try {
          const s = await fs.stat(full);
          return { full, mtime: s.mtimeMs };
        } catch {
          return null;
        }
      })
    );

    const live = stats.filter((s): s is { full: string; mtime: number } => !!s);
    live.sort((a, b) => a.mtime - b.mtime);

    const excess = live.slice(0, live.length - MAX_CACHE_ENTRIES);
    await Promise.all(excess.map((e) => fs.rm(e.full, { force: true })));
  } catch {
    /* best-effort */
  }
}

/** Remove every cached search. Exposed so the UI can offer a reset. */
export async function clearCache(): Promise<void> {
  await fs.rm(CACHE_DIR, { recursive: true, force: true });
}

/** Rough size of the cache, for display. */
export async function cacheStats(): Promise<{
  entries: number;
  bytes: number;
}> {
  try {
    const names = (await fs.readdir(CACHE_DIR)).filter((n) =>
      n.endsWith(".json")
    );
    let bytes = 0;
    for (const name of names) {
      try {
        bytes += (await fs.stat(path.join(CACHE_DIR, name))).size;
      } catch {
        /* skip */
      }
    }
    return { entries: names.length, bytes };
  } catch {
    return { entries: 0, bytes: 0 };
  }
}

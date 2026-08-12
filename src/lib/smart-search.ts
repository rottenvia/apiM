/**
 * Smart Search Engine — multi-step query planning, execution and dedup.
 * TypeScript port of smart_search.py.
 */

/**
 * Overridable so the whole search path can be pointed at a local stub in
 * tests, matching the chat route. Previously hardcoded, which meant these
 * calls silently escaped to the real API during testing.
 */
const DEEPSEEK_BASE_URL =
  process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";

/** Overridable so the search path can be exercised against a stub in tests. */
const TAVILY_BASE_URL =
  process.env.TAVILY_BASE_URL ?? "https://api.tavily.com";
const EXA_BASE_URL = process.env.EXA_BASE_URL ?? "https://api.exa.ai";

import type {
  ProfileSettings,
  SearchDepth,
  SearchResultItem,
} from "@/lib/search-types";
import { profileSettings } from "@/lib/search-types";
import { readCache, writeCache } from "@/lib/search-cache";
import {
  PROVIDERS,
  recordCacheHit,
  recordQuestion,
  recordRequest,
} from "@/lib/search-usage";

/**
 * Combine an external abort signal with a per-request timeout, so a request
 * ends on whichever happens first. Previously only the timeout was honoured,
 * which is why pressing Stop left searches running to completion.
 */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  // AbortSignal.any is available on Node 20+ and all current browsers.
  return AbortSignal.any([signal, timeout]);
}

export type { SearchResultItem } from "@/lib/search-types";

export interface SmartSearchContext {
  results: SearchResultItem[];
  queries: string[];
  summary: string;
  searchesPerformed: number;
  sourcesUsed: number;
  /** How many escalation rounds ran. */
  rounds: number;
  /** Why the loop stopped, surfaced in the UI. */
  stopReason: string;
  /** Requests answered from cache, which cost nothing. */
  cacheHits: number;
  /** Estimated spend for this question, in USD. */
  estimatedUsd: number;
}

/**
 * Per-source character cap.
 *
 * Tavily's `content` field is a ~500 character snippet, so a detail sitting
 * just past the cut was invisible to the model — it would then answer
 * confidently from incomplete information. Requesting the parsed full page
 * and capping generously removes that failure entirely; the cap only exists
 * so one enormous reference page cannot swamp the context.
 */
export const MAX_SOURCE_CHARS = 30_000;

/**
 * Upper bound on escalation rounds.
 *
 * This is a safety guard, not a budget: if the sufficiency check ever gets
 * stuck reporting "not enough", an uncapped loop would search forever and the
 * request would hang. Real questions settle in one or two rounds.
 */
export const MAX_SEARCH_ROUNDS = 5;

/** Sources whose answers are authoritative for technical questions. */
const TRUSTED_DOMAINS = [
  "docs.python.org", "developer.mozilla.org", "nodejs.org", "react.dev",
  "docs.djangoproject.com", "go.dev", "doc.rust-lang.org", "docs.oracle.com",
  "learn.microsoft.com", "docs.aws.amazon.com", "cloud.google.com",
  "github.com", "stackoverflow.com", "pypi.org", "npmjs.com", "crates.io",
  "developer.apple.com", "developer.android.com", "kubernetes.io",
  "postgresql.org", "redis.io", "docs.docker.com",
];

/** Content farms and scrapers that mostly republish other people's answers. */
const BLOCKED_DOMAINS = [
  "pinterest.com", "quora.com", "answers.com", "coursehero.com",
  "w3schools.blog", "geeksforgeeks.org", "tutorialspoint.com",
];

/**
 * Determine thinking effort based on message complexity.
 */
export function autoThinkingEffort(message: string): string {
  const lower = message.toLowerCase();
  const wordCount = message.trim().split(/\s+/).filter(Boolean).length;

  const simplePatterns = [
    /^(hi|hello|hey|sup|yo)\b/,
    /^(thanks|thank you|thx)/,
    /^(ok|okay|got it|sure)/,
    /how (do|can) i (run|start|launch|open|install)/,
    /what (is|are) (your|the) (name|version)/,
  ];

  if (wordCount <= 5) {
    if (simplePatterns.some((p) => p.test(lower))) return "none";
    return "low";
  }

  const complexPatterns = [
    /debug|error|bug|crash|fail/,
    /implement|architect|design|build|create.*system/,
    /explain.*how.*works/,
    /compare|analyze|evaluate|review/,
    /optimize|refactor|improve|performance/,
    /security|vulnerability|exploit/,
    /algorithm|data structure/,
    /proof|prove|theorem/,
    /multi.*step|complex|complicated/,
  ];

  const complexScore = complexPatterns.filter((p) => p.test(lower)).length;

  /*
   * Length is not difficulty.
   *
   * This used to read `complexScore >= 3 || wordCount > 100`, so any message
   * over a hundred words got maximum reasoning effort regardless of what it
   * said. Pasting a stack trace, a config file, or a long log and asking
   * "what is this?" is a long message and an easy question — and it was
   * charged as the hardest kind of work there is, on the most expensive
   * setting, on every round of the reply.
   *
   * Effort is now decided by what the message asks for. Length only breaks a
   * tie: a long message that already looks hard is more likely to be hard,
   * but a long message on its own never is.
   */
  const longMessage = wordCount > 120;

  if (complexScore >= 3) return "max";
  // Genuinely hard *and* substantial — the tie-break, not a rule of its own.
  if (complexScore >= 2 && longMessage) return "max";
  if (complexScore >= 1) return "high";
  // Nothing about it looks difficult. A wall of pasted text is still a wall
  // of pasted text, so this stays cheap.
  return "low";
}

/**
 * Fast keyword pre-filter for auto-search mode.
 *
 * Only used to skip the classifier call entirely for messages that obviously
 * need no web access ("hi", "rewrite this function"). Anything ambiguous falls
 * through to the model, which decides properly.
 */
export function obviouslyNoSearch(message: string): boolean {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();

  // Very short greetings and acknowledgements.
  if (trimmed.length <= 12 && /^(hi|hello|hey|yo|sup|thanks|thank you|thx|ok|okay|got it|sure|nice|cool|great)\b/.test(lower)) {
    return true;
  }

  // Contains a code block — almost always "work on this", not "look this up".
  if (/```/.test(trimmed)) return true;

  return false;
}

/**
 * Ask the model whether a web search is actually needed.
 *
 * Runs on Flash with thinking disabled and a tiny token budget, so the check
 * costs a fraction of a cent and adds well under a second. This replaces a
 * regex heuristic that both missed real cases and fired on false positives
 * (any message containing "2026", for instance).
 */
export async function decideSearch(
  message: string,
  context: string,
  deepseekKey: string,
  signal?: AbortSignal,
  /**
   * The user's standing orders, if any are enabled.
   *
   * Reported: "when agent checking whether it need web or not it doesnt
   * follow plugin instructions". Correct — this judge is a separate model
   * call with its own system prompt, and the plugin block was never part of
   * it. So a plugin saying "never search, answer from what you know" or
   * "always look things up before answering" was invisible to the one
   * decision it most obviously applies to.
   *
   * Worse, this judge can return "clarify", which makes the main model ask a
   * question — and a plugin like Caveman Mode, whose whole point is not to
   * pad, had no say in whether that happened.
   *
   * Passed as extra system text rather than woven into the JSON contract, so
   * the response shape is unchanged and a plugin cannot break the parser.
   */
  standingOrders?: string
): Promise<{ needed: boolean; reason: string; clarify?: string }> {
  if (obviouslyNoSearch(message)) {
    return { needed: false, reason: "no external information required" };
  }

  try {
    const response = await fetch(
      `${DEEPSEEK_BASE_URL}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deepseekKey}`,
        },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          messages: [
            {
              role: "system",
              content: `Decide how to handle the user's message. Choose exactly one action.

"answer" — the model can answer from its own knowledge: general programming,
explanations, maths, writing, refactoring, opinions, or anything about code the
user already provided.

"search" — the answer depends on information the model cannot know: current
events, today's prices, recent release notes, a library's latest version, a
niche error message, or the user explicitly asks to search.

"clarify" — the question is too underspecified for a search to help, and the
useful answer depends on details only the user has. Typically personal or
situational questions ("how do I grow taller", "is this a good salary",
"which laptop should I buy") where searching returns generic articles that do
not address their actual situation. When choosing this, supply ONE specific
question that would unlock a genuinely useful answer.

Prefer "answer" or "search" when either would serve. Only pick "clarify" when
the missing detail materially changes the answer.

Respond with JSON only:
{"action": "answer"|"search"|"clarify", "reason": "under 8 words", "question": "only when action is clarify"}${
                standingOrders?.trim()
                  ? `\n\nThe user has standing orders for this conversation. They apply to this decision too — if they tell you to look things up, prefer "search"; if they tell you to be brief or not to ask questions, avoid "clarify". Still answer with the JSON above and nothing else.\n${standingOrders.trim()}`
                  : ""
              }`,
            },
            {
              role: "user",
              content: `Conversation so far:\n${context || "(none)"}\n\nNew message:\n${message}`,
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0,
          max_tokens: 60,
          thinking: { type: "disabled" },
        }),
        signal: withTimeout(signal, 12_000),
      }
    );

    if (response.ok) {
      const data = await response.json();
      const parsed = JSON.parse(
        data?.choices?.[0]?.message?.content ?? "{}"
      ) as { action?: string; reason?: string; question?: string };

      if (parsed.action === "clarify" && parsed.question) {
        return {
          needed: false,
          reason: parsed.reason ?? "needs more detail",
          clarify: parsed.question,
        };
      }

      return {
        needed: parsed.action === "search",
        reason: parsed.reason ?? "",
      };
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      console.error("Search decision failed:", error);
    }
  }

  // On any failure, skip the search rather than spending tokens on one that
  // may not be needed — the model still answers from its own knowledge.
  return { needed: false, reason: "classifier unavailable" };
}

interface QueryPlan {
  queries: string[];
  intent: string;
  type: string;
  /**
   * Recency window passed straight to Tavily. Filtering at query time is
   * strictly better than re-ranking afterwards: Tavily only returns
   * `published_date` for news topics, so post-hoc date sorting is impossible
   * for general searches.
   */
  timeRange?: "day" | "week" | "month" | "year";
  /** Restrict to these domains when the question is clearly about one. */
  includeDomains?: string[];
}

/**
 * Use DeepSeek to generate precise search queries for the message.
 */
async function generateSearchQueries(
  message: string,
  context: string,
  deepseekKey: string,
  signal?: AbortSignal
): Promise<QueryPlan> {
  try {
    const response = await fetch(
      `${DEEPSEEK_BASE_URL}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deepseekKey}`,
        },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          messages: [
            {
              role: "system",
              content: `You are a search query optimizer. Generate 2-4 precise web search queries.

Rules:
- Each query targets a SPECIFIC aspect
- Include version numbers and specific terms
- Include FULL error messages if present
- Never generate vague single-word queries

Also decide:
- timeRange: set "day"/"week"/"month"/"year" ONLY when freshness matters
  (latest version, recent release, current price, news). Omit otherwise —
  most technical questions are better served by the best answer, not the
  newest one.
- includeDomains: restrict to official sources when the question is clearly
  about one project (e.g. ["docs.python.org"] for a Python stdlib question).
  Omit when a general search is more appropriate.

Respond in JSON ONLY:
{"queries": ["query1", "query2"], "intent": "brief description", "type": "documentation|github|forum|article", "timeRange": "year", "includeDomains": []}`,
            },
            {
              role: "user",
              content: `Message: "${message}"\nContext: ${context}\n\nGenerate search queries.`,
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0.3,
          max_tokens: 500,
          // Query planning is a mechanical extraction task — reasoning adds
          // seconds of latency before the real answer even starts. This is a
          // top-level API parameter (not `extra_body`, which only the Python
          // SDK understands and the REST API silently ignores).
          thinking: { type: "disabled" },
        }),
        signal: withTimeout(signal, 30_000),
      }
    );

    if (response.ok) {
      const data = await response.json();
      const content =
        data?.choices?.[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(content) as Partial<QueryPlan>;
      if (Array.isArray(parsed.queries) && parsed.queries.length > 0) {
        const validRanges = ["day", "week", "month", "year"];
        return {
          queries: parsed.queries.map(String),
          intent: parsed.intent ?? message,
          type: parsed.type ?? "general",
          timeRange: validRanges.includes(parsed.timeRange as string)
            ? (parsed.timeRange as QueryPlan["timeRange"])
            : undefined,
          includeDomains: Array.isArray(parsed.includeDomains)
            ? parsed.includeDomains.map(String).slice(0, 10)
            : undefined,
        };
      }
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      console.error("Query generation error:", error);
    }
  }

  return { queries: [message], intent: message, type: "general" };
}

/**
 * Execute a single Tavily search.
 */
/**
 * Exa, used as the fallback when Tavily refuses.
 *
 * Added because Tavily started answering 432 — "This request exceeds your
 * plan's set usage limit" — which is a hard stop until the month rolls over
 * or the plan changes. One provider means one bad month is a dead feature.
 *
 * Two details that are easy to get wrong, both from Exa's own docs:
 *
 *   - Auth is `x-api-key`. The docs also list `Authorization: Bearer`, but
 *     the header that is verified to work is x-api-key, so that is what is
 *     sent.
 *   - Content fields MUST nest under `contents`. A top-level `text: true`
 *     returns 400, and it is documented as the single most common
 *     integration mistake.
 *
 * Exa has no `search_depth`, so depth is expressed as how many results to
 * ask for. Its scores are cosine similarities on a different scale from
 * Tavily's, which matters because the caller filters on score — see the note
 * where that filter lives.
 */
async function exaSearch(
  query: string,
  exaKey: string,
  options: {
    maxResults?: number;
    includeDomains?: string[];
    signal?: AbortSignal;
    depth?: SearchDepth;
    useCache?: boolean;
    onCacheHit?: () => void;
  } = {}
): Promise<Omit<SearchResultItem, "domain">[]> {
  const {
    maxResults = 10,
    includeDomains,
    signal,
    depth = "advanced",
    useCache = true,
    onCacheHit,
  } = options;

  const cacheKey = { query, provider: "exa", depth, maxResults };
  if (useCache) {
    const hit = await readCache(cacheKey);
    if (hit) {
      onCacheHit?.();
      void recordCacheHit("exa");
      return hit;
    }
  }

  try {
    const body: Record<string, unknown> = {
      query,
      type: "auto",
      numResults: maxResults,
      // Nested, not top-level. Top-level text/highlights returns 400.
      contents: { text: { maxCharacters: MAX_SOURCE_CHARS }, highlights: true },
      excludeDomains: BLOCKED_DOMAINS,
    };
    if (includeDomains?.length) body.includeDomains = includeDomains;

    const response = await fetch(`${EXA_BASE_URL}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": exaKey,
      },
      body: JSON.stringify(body),
      signal: withTimeout(signal, 45_000),
    });

    void recordRequest("exa", depth);

    if (response.ok) {
      const data = await response.json();
      const mapped = (data?.results ?? []).map((r: Record<string, unknown>) => {
        const text = String(r.text ?? "");
        // Highlights are the model-chosen key passages. When the full text is
        // missing they are all there is, and they are better than nothing.
        const highlights = Array.isArray(r.highlights)
          ? (r.highlights as unknown[]).map(String).join("\n\n")
          : "";
        const best = text.length > highlights.length ? text : highlights;
        return {
          title: String(r.title ?? ""),
          url: String(r.url ?? ""),
          content: best.slice(0, MAX_SOURCE_CHARS),
          score: Number(r.score ?? 0),
          publishedDate: r.publishedDate ? String(r.publishedDate) : undefined,
        };
      });

      if (useCache) await writeCache(cacheKey, mapped);
      return mapped;
    }

    let detail = "";
    try {
      const err = (await response.json()) as { error?: unknown; message?: unknown };
      detail = String(err?.error ?? err?.message ?? "");
    } catch {
      /* a non-JSON error body tells us nothing extra */
    }
    throw new SearchProviderError(response.status, detail);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return [];
    if (error instanceof SearchProviderError) throw error;
    console.error("Exa search error:", error);
    throw new SearchProviderError(
      0,
      error instanceof Error ? error.message : "the search service could not be reached"
    );
  }
}

/**
 * The search provider refused or failed, as opposed to finding nothing.
 *
 * Carries the HTTP status so the caller can say something specific: a 401 is
 * a wrong key, a 429 is a spent quota, and neither is fixed by rephrasing.
 */
export class SearchProviderError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string
  ) {
    super(detail || `search provider returned ${status}`);
    this.name = "SearchProviderError";
  }
}

async function tavilySearch(
  query: string,
  tavilyKey: string,
  options: {
    maxResults?: number;
    timeRange?: string;
    includeDomains?: string[];
    signal?: AbortSignal;
    depth?: SearchDepth;
    /** Reuse a stored result for this query when one is fresh enough. */
    useCache?: boolean;
    /** Counts cache hits back to the caller. */
    onCacheHit?: () => void;
  } = {}
): Promise<Omit<SearchResultItem, "domain">[]> {
  const {
    maxResults = 10,
    timeRange,
    includeDomains,
    signal,
    depth = "advanced",
    useCache = true,
    onCacheHit,
  } = options;

  // Time-ranged queries are asking for what changed recently, so a day-old
  // answer is exactly the wrong thing to hand back.
  const cacheable = useCache && !timeRange;
  const cacheKey = {
    query,
    provider: "tavily",
    depth,
    maxResults,
  };

  if (cacheable) {
    const hit = await readCache(cacheKey);
    if (hit) {
      onCacheHit?.();
      void recordCacheHit("tavily");
      return hit;
    }
  }

  try {
    const body: Record<string, unknown> = {
      query,
      search_depth: depth,
      max_results: maxResults,
      include_answer: true,
      chunks_per_source: 3,
      // Ask for the parsed, cleaned page rather than only a ~500 char
      // snippet, so a detail just past the snippet boundary is still visible.
      // Tavily does the fetching and strips nav/ads, which avoids building a
      // scraper that would trip over paywalls and bot checks.
      include_raw_content: "markdown",
      exclude_domains: BLOCKED_DOMAINS,
    };

    if (timeRange) body.time_range = timeRange;
    if (includeDomains?.length) body.include_domains = includeDomains;

    const response = await fetch(`${TAVILY_BASE_URL}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tavilyKey}`,
      },
      body: JSON.stringify(body),
      // Full-page retrieval is slower than snippets alone.
      signal: withTimeout(signal, 45_000),
    });

    // Billed on send, not on success: a request that returns an error status
    // has still been counted by the provider in most cases, and undercounting
    // is the failure mode that leads to a surprise quota error.
    void recordRequest("tavily", depth);

    if (response.ok) {
      const data = await response.json();
      const mapped = (data?.results ?? []).map((r: Record<string, unknown>) => {
        const snippet = String(r.content ?? "");
        const full = String(r.raw_content ?? "");
        // Prefer the full page, but fall back to the snippet when extraction
        // failed or returned less than the snippet already had.
        const best = full.length > snippet.length ? full : snippet;
        return {
          title: String(r.title ?? ""),
          url: String(r.url ?? ""),
          content: best.slice(0, MAX_SOURCE_CHARS),
          score: Number(r.score ?? 0),
          publishedDate: r.published_date
            ? String(r.published_date)
            : undefined,
        };
      });

      if (cacheable) await writeCache(cacheKey, mapped);
      return mapped;
    }

    /*
     * A failed REQUEST is not an empty RESULT.
     *
     * This used to fall straight through to `return []`, so a rejected key, a
     * spent quota and a genuine "nothing matched" were all reported to the
     * model as "No results — try different wording". It then rephrased and
     * retried, five times, each one billed and each one failing the same way.
     *
     * Reported after a real run: five searches, five empty answers, including
     * for the query "cat". A search that cannot possibly return nothing
     * returning nothing is the tell, and nothing in the output said so.
     *
     * The status is what distinguishes them, so it is thrown rather than
     * swallowed. The caller decides what to tell the model.
     */
    let detail = "";
    try {
      const body = (await response.json()) as { detail?: unknown };
      const d = body?.detail;
      detail =
        typeof d === "string"
          ? d
          : typeof (d as { error?: string })?.error === "string"
            ? (d as { error: string }).error
            : "";
    } catch {
      /* a non-JSON error body tells us nothing extra */
    }
    throw new SearchProviderError(response.status, detail);
  } catch (error) {
    // AbortError just means the user pressed Stop.
    if (error instanceof Error && error.name === "AbortError") return [];
    // A provider failure must reach the caller, not look like zero hits.
    if (error instanceof SearchProviderError) throw error;
    console.error("Tavily search error:", error);
    throw new SearchProviderError(0,
      error instanceof Error ? error.message : "the search service could not be reached");
  }
}

/**
 * One search, across every configured provider.
 *
 * Peers, not a primary and a spare. Asked for directly, and it is the better
 * design: Tavily returns cleaned full-page markdown, Exa is a neural index
 * that finds things keyword matching misses, and they disagree about which
 * pages matter. Running both and merging beats picking one and hoping.
 *
 * Three properties worth stating, because each was a decision:
 *
 *   - Both are queried IN PARALLEL, so two providers cost the same wall-clock
 *     time as one. This is the reason peer-instead-of-fallback is affordable
 *     at all.
 *   - One provider failing does not fail the search. With a fallback chain a
 *     Tavily 432 meant waiting for Tavily to fail before Exa even started;
 *     now Exa's results are already in hand.
 *   - It only throws when EVERY provider failed. That distinction is what
 *     stopped a rejected key looking like an empty index — see
 *     SearchProviderError.
 *
 * Deduplication happens in the caller, which already drops repeat URLs, so a
 * page both providers return is charged once and shown once.
 */
async function searchOnce(
  query: string,
  options: {
    tavilyKey?: string;
    exaKey?: string;
    maxResults?: number;
    timeRange?: string;
    includeDomains?: string[];
    signal?: AbortSignal;
    depth?: SearchDepth;
    useCache?: boolean;
    onCacheHit?: () => void;
    /** Told which providers actually answered, for the UI and the ledger. */
    onProvider?: (id: string) => void;
  } = {}
): Promise<Omit<SearchResultItem, "domain">[]> {
  const { tavilyKey, exaKey, timeRange, onProvider, ...rest } = options;

  if (!tavilyKey && !exaKey) {
    throw new SearchProviderError(0, "no search provider is configured");
  }

  const attempts: Promise<{
    id: string;
    results?: Omit<SearchResultItem, "domain">[];
    error?: unknown;
  }>[] = [];

  if (tavilyKey) {
    attempts.push(
      tavilySearch(query, tavilyKey, { ...rest, timeRange })
        .then((results) => ({ id: "tavily", results }))
        .catch((error) => ({ id: "tavily", error }))
    );
  }
  if (exaKey) {
    // Exa has no time_range parameter, so a recency-limited query loses that
    // filter on this side. Tavily still applies it when both are on.
    attempts.push(
      exaSearch(query, exaKey, rest)
        .then((results) => ({ id: "exa", results }))
        .catch((error) => ({ id: "exa", error }))
    );
  }

  const settled = await Promise.all(attempts);

  const merged: Omit<SearchResultItem, "domain">[] = [];
  const seen = new Set<string>();
  const failures: { id: string; error: unknown }[] = [];

  for (const outcome of settled) {
    if (outcome.error !== undefined) {
      failures.push({ id: outcome.id, error: outcome.error });
      console.warn(
        `${outcome.id} search failed:`,
        outcome.error instanceof Error ? outcome.error.message : outcome.error
      );
      continue;
    }
    onProvider?.(outcome.id);
    for (const r of outcome.results ?? []) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      merged.push(r);
    }
  }

  /*
   * Only a total failure is a failure.
   *
   * If Tavily is out of quota and Exa answered, that is a successful search —
   * the user does not need to hear about a provider that was covered for. If
   * BOTH failed, the first real error is rethrown so the message stays
   * specific ("the Tavily key was rejected") rather than becoming a generic
   * "search unavailable".
   */
  if (merged.length === 0 && failures.length === attempts.length) {
    const providerError = failures.find(
      (f) => f.error instanceof SearchProviderError
    );
    throw providerError
      ? (providerError.error as SearchProviderError)
      : new SearchProviderError(0, "every search provider failed");
  }

  return merged;
}

/**
 * Ask a cheap model whether the gathered sources actually answer the question.
 *
 * Deliberately concrete — "does this contain the specific fact needed" rather
 * than "are you satisfied" — because a vague prompt produces a vague verdict.
 * Only titles and the opening of each source are sent, so the check stays
 * small regardless of how much page content was retrieved.
 */
async function assessSufficiency(
  message: string,
  results: SearchResultItem[],
  deepseekKey: string,
  signal?: AbortSignal
): Promise<{ sufficient: boolean; missing: string }> {
  if (results.length === 0) return { sufficient: false, missing: message };

  const digest = results
    .slice(0, 8)
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title} (${r.domain})\n${r.content.slice(0, 600)}`
    )
    .join("\n\n");

  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deepseekKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [
          {
            role: "system",
            content: `Decide whether the search results contain the specific information needed to answer the question completely.

Answer sufficient=false only when something concrete is missing — a version number, an error cause, a specific value. Do not demand exhaustive coverage; enough to answer well is enough.

When false, state briefly what is still missing so a better query can be written.

Respond in JSON ONLY:
{"sufficient": true|false, "missing": "what is still needed, under 15 words"}`,
          },
          {
            role: "user",
            content: `Question: ${message}\n\nResults:\n${digest}`,
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 120,
        thinking: { type: "disabled" },
      }),
      signal: withTimeout(signal, 20_000),
    });

    if (response.ok) {
      const data = await response.json();
      const parsed = JSON.parse(
        data?.choices?.[0]?.message?.content ?? "{}"
      ) as { sufficient?: boolean; missing?: string };
      return {
        sufficient: parsed.sufficient !== false,
        missing: parsed.missing ?? "",
      };
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) {
      console.error("Sufficiency check failed:", error);
    }
  }

  // If the judge is unavailable, stop rather than loop blindly.
  return { sufficient: true, missing: "" };
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Execute smart multi-step search: plan queries, search each,
 * deduplicate, rank, and summarize.
 */
export async function smartSearch(
  message: string,
  context: string,
  deepseekKey: string,
  tavilyKey: string,
  signal?: AbortSignal,
  profileName?: string,
  /**
   * Optional second provider, used when Tavily refuses.
   *
   * Appended rather than inserted so every existing caller keeps working
   * unchanged — this function is called from three places.
   */
  exaKey?: string
): Promise<SmartSearchContext> {
  const profile: ProfileSettings = profileSettings(profileName);
  const plan = await generateSearchQueries(message, context, deepseekKey, signal);

  const seenUrls = new Set<string>();
  const seenQueries = new Set<string>();
  const collected: SearchResultItem[] = [];
  const allQueries: string[] = [];
  let searchesPerformed = 0;
  let cacheHits = 0;
  let billedBasic = 0;
  let billedAdvanced = 0;
  let rounds = 0;
  let stopReason = "";

  void recordQuestion();

  // Rank trusted sources above general ones. Tavily's score reflects textual
  // relevance only, so an SEO blog can outrank official documentation.
  const rank = (r: SearchResultItem) => {
    const trusted = TRUSTED_DOMAINS.some(
      (d) => r.domain === d || r.domain.endsWith(`.${d}`)
    );
    return r.score + (trusted ? 0.25 : 0);
  };

  const runQueries = async (
    queries: string[],
    depth: SearchDepth,
    timeRange?: string,
    includeDomains?: string[]
  ) => {
    const fresh = queries
      .map((q) => q.trim())
      .filter((q) => q && !seenQueries.has(q.toLowerCase()));
    if (fresh.length === 0) return;

    fresh.forEach((q) => seenQueries.add(q.toLowerCase()));
    allQueries.push(...fresh);

    const settled = await Promise.all(
      fresh.map((query) => {
        let hit = false;
        return searchOnce(query, {
          tavilyKey,
          exaKey,
          timeRange,
          includeDomains,
          signal,
          depth,
          maxResults: profile.resultsPerQuery,
          useCache: profile.useCache,
          onCacheHit: () => {
            hit = true;
          },
        }).then((results) => {
          if (hit) cacheHits += 1;
          else if (depth === "advanced") billedAdvanced += 1;
          else billedBasic += 1;
          return results;
        });
      })
    );

    for (const results of settled) {
      searchesPerformed += 1;
      for (const r of results) {
        if (!r.url || seenUrls.has(r.url)) continue;
        if (r.score < 0.3 || r.content.length < 50) continue;
        seenUrls.add(r.url);
        collected.push({ ...r, domain: domainOf(r.url) });
      }
    }
  };

  // Round 1 — the planned queries, cast wide and shallow. The sufficiency
  // check below decides whether anything here is worth a deeper read, so
  // paying deep-parse prices up front only helps the questions that would
  // have settled either way.
  rounds += 1;
  await runQueries(
    plan.queries.slice(0, profile.firstRoundQueries),
    profile.firstRoundDepth,
    plan.timeRange,
    plan.includeDomains
  );

  // Escalate only while something concrete is still missing. Most questions
  // stop here; the cap exists so a stuck judge cannot loop forever.
  while (rounds < MAX_SEARCH_ROUNDS) {
    // Abandon the loop the moment the client goes away.
    if (signal?.aborted) {
      stopReason = "stopped";
      break;
    }

    const verdict = await assessSufficiency(
      message,
      collected,
      deepseekKey,
      signal
    );
    if (verdict.sufficient) {
      stopReason =
        rounds === 1 ? "found what was needed" : "found what was needed after follow-up";
      break;
    }

    const followUp = await generateSearchQueries(
      `${message}\n\nStill missing: ${verdict.missing}`,
      context,
      deepseekKey,
      signal
    );

    // The judge found a concrete gap, so this round is the one that earns a
    // deeper read: the answer is somewhere past a snippet boundary.
    const before = collected.length;
    rounds += 1;
    await runQueries(
      followUp.queries.slice(0, profile.followUpQueries),
      profile.followUpDepth,
      followUp.timeRange ?? plan.timeRange,
      followUp.includeDomains
    );

    // No new sources means further rounds would repeat themselves.
    if (collected.length === before) {
      stopReason = "no further sources found";
      break;
    }

    if (rounds >= MAX_SEARCH_ROUNDS) {
      stopReason = "reached the search limit";
    }
  }

  if (!stopReason) stopReason = "reached the search limit";

  collected.sort((a, b) => rank(b) - rank(a));
  const topResults = collected.slice(0, 8);

  const summary = topResults
    .map((r, i) => {
      const date = r.publishedDate ? ` (${r.publishedDate})` : "";
      return `[${i + 1}] ${r.title}${date}\nURL: ${r.url}\n${r.content}\n\n---\n`;
    })
    .join("\n");

  const rate = PROVIDERS.tavily.costPerRequest;
  const estimatedUsd = billedBasic * rate + billedAdvanced * rate * 2;

  return {
    results: topResults,
    queries: allQueries,
    summary,
    searchesPerformed,
    sourcesUsed: topResults.length,
    rounds,
    stopReason,
    cacheHits,
    estimatedUsd,
  };
}

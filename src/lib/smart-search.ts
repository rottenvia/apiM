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

export interface SearchResultItem {
  title: string;
  url: string;
  content: string;
  score: number;
  domain: string;
}

export interface SmartSearchContext {
  results: SearchResultItem[];
  queries: string[];
  summary: string;
  searchesPerformed: number;
  sourcesUsed: number;
}

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

  if (complexScore >= 3 || wordCount > 100) return "max";
  if (complexScore >= 2 || wordCount > 50) return "high";
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
  deepseekKey: string
): Promise<{ needed: boolean; reason: string }> {
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
              content: `Decide whether answering the user's message requires a live web search.

Answer NO when the model can answer from its own knowledge: general programming,
explanations, maths, writing, refactoring, opinions, or anything about code the
user already provided.

Answer YES only when the answer depends on information the model cannot know:
current events, today's prices or weather, release notes for something recent,
a specific library's latest version, a niche error message, or the user
explicitly asks to search or cite sources.

Respond with JSON only: {"search": true|false, "reason": "under 8 words"}`,
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
        signal: AbortSignal.timeout(12_000),
      }
    );

    if (response.ok) {
      const data = await response.json();
      const parsed = JSON.parse(
        data?.choices?.[0]?.message?.content ?? "{}"
      ) as { search?: boolean; reason?: string };
      return {
        needed: parsed.search === true,
        reason: parsed.reason ?? "",
      };
    }
  } catch (error) {
    console.error("Search decision failed:", error);
  }

  // On any failure, skip the search rather than spending tokens on one that
  // may not be needed — the model still answers from its own knowledge.
  return { needed: false, reason: "classifier unavailable" };
}

interface QueryPlan {
  queries: string[];
  intent: string;
  type: string;
}

/**
 * Use DeepSeek to generate precise search queries for the message.
 */
async function generateSearchQueries(
  message: string,
  context: string,
  deepseekKey: string
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
- Include version numbers, specific terms
- Include FULL error messages if present
- Never generate vague single-word queries

Respond in JSON ONLY:
{"queries": ["query1", "query2"], "intent": "brief description", "type": "documentation|github|forum|article"}`,
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
        signal: AbortSignal.timeout(30_000),
      }
    );

    if (response.ok) {
      const data = await response.json();
      const content =
        data?.choices?.[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(content) as Partial<QueryPlan>;
      if (Array.isArray(parsed.queries) && parsed.queries.length > 0) {
        return {
          queries: parsed.queries.map(String),
          intent: parsed.intent ?? message,
          type: parsed.type ?? "general",
        };
      }
    }
  } catch (error) {
    console.error("Query generation error:", error);
  }

  return { queries: [message], intent: message, type: "general" };
}

/**
 * Execute a single Tavily search.
 */
async function tavilySearch(
  query: string,
  tavilyKey: string,
  maxResults = 5
): Promise<Omit<SearchResultItem, "domain">[]> {
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tavilyKey}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "advanced",
        max_results: maxResults,
        include_answer: true,
        chunks_per_source: 3,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.ok) {
      const data = await response.json();
      return (data?.results ?? []).map(
        (r: Record<string, unknown>) => ({
          title: String(r.title ?? ""),
          url: String(r.url ?? ""),
          content: String(r.content ?? ""),
          score: Number(r.score ?? 0),
        })
      );
    }
  } catch (error) {
    console.error("Tavily search error:", error);
  }

  return [];
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
  tavilyKey: string
): Promise<SmartSearchContext> {
  const plan = await generateSearchQueries(message, context, deepseekKey);
  const queries = plan.queries.slice(0, 4);

  const allResults: Omit<SearchResultItem, "domain">[] = [];
  let searchesPerformed = 0;

  // Run every query concurrently. Sequentially this cost one full round trip
  // per query (up to 4) before the model could even start answering.
  const settled = await Promise.all(
    queries.map((query) => tavilySearch(query, tavilyKey))
  );
  for (const results of settled) {
    searchesPerformed += 1;
    allResults.push(...results);
  }

  // Deduplicate by URL, keep quality hits only
  const seenUrls = new Set<string>();
  const uniqueResults: SearchResultItem[] = [];
  for (const r of allResults) {
    if (!r.url || seenUrls.has(r.url)) continue;
    if (r.score < 0.3 || r.content.length < 50) continue;
    seenUrls.add(r.url);
    uniqueResults.push({ ...r, domain: domainOf(r.url) });
  }

  uniqueResults.sort((a, b) => b.score - a.score);
  const topResults = uniqueResults.slice(0, 8);

  const summary = topResults
    .map(
      (r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content}\n\n---\n`
    )
    .join("\n");

  return {
    results: topResults,
    queries,
    summary,
    searchesPerformed,
    sourcesUsed: topResults.length,
  };
}

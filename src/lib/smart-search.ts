/**
 * Smart Search Engine — multi-step query planning, execution and dedup.
 * TypeScript port of smart_search.py.
 */

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
 * Heuristic guess at whether a message would benefit from web search.
 *
 * NOT used by the chat route: the Search toggle is authoritative there, so
 * turning search off never searches and turning it on always does. Kept for
 * a possible future "auto search" mode.
 */
export function shouldAutoSearch(message: string): boolean {
  const lower = message.toLowerCase();

  const searchTriggers = [
    /search\s+(for|about|the)/,
    /find\s+(me|the|a|information|info)/,
    /look\s+up/,
    /what\s+is\s+the\s+(latest|current|newest|recent)/,
    /how\s+to\s+fix/,
    /error.*\d+/,
    /github\.com|stackoverflow/,
    /latest\s+version/,
    /documentation\s+for/,
    /any\s+(updates|news|changes)/,
    /\b(2024|2025|2026)\b/,
    /release\s+(date|notes)/,
  ];

  return searchTriggers.some((p) => p.test(lower));
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
      "https://api.deepseek.com/chat/completions",
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

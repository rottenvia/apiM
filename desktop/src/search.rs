//! Web search for the agent: Tavily and Exa asked together, merged, ranked and
//! handed to the model as text. A cheap model plans the queries and judges
//! whether the results answer the question; the profile decides what each
//! round may spend. Port of src/lib/smart-search.ts, src/lib/search-types.ts
//! and the `web_search` case of src/lib/tools.ts, plus the address guard from
//! src/lib/web.ts.

use crate::search_usage::{self as usage, CacheKey};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;

/// Per-source character cap. Providers are asked for the parsed full page, so
/// a detail just past a snippet boundary is still visible; the cap only stops
/// one enormous reference page swamping the context.
pub const MAX_SOURCE_CHARS: usize = 30_000;
/// A guard, not a budget: a judge stuck on "not enough" must not search
/// forever. Real questions settle in one or two rounds.
pub const MAX_SEARCH_ROUNDS: usize = 5;
/// What the tool shows the model: how many results, and how much of each.
pub const SEARCH_RESULTS: usize = 8;
pub const SEARCH_SNIPPET: usize = 700;
pub const DEFAULT_SEARCH_PROFILE: &str = "balanced";

/// Sources whose answers are authoritative for technical questions.
const TRUSTED_DOMAINS: &[&str] = &[
    "docs.python.org", "developer.mozilla.org", "nodejs.org", "react.dev",
    "docs.djangoproject.com", "go.dev", "doc.rust-lang.org", "docs.oracle.com",
    "learn.microsoft.com", "docs.aws.amazon.com", "cloud.google.com",
    "github.com", "stackoverflow.com", "pypi.org", "npmjs.com", "crates.io",
    "developer.apple.com", "developer.android.com", "kubernetes.io",
    "postgresql.org", "redis.io", "docs.docker.com",
];

/// Content farms and scrapers that mostly republish other people's answers.
const BLOCKED_DOMAINS: &[&str] = &[
    "pinterest.com", "quora.com", "answers.com", "coursehero.com",
    "w3schools.blog", "geeksforgeeks.org", "tutorialspoint.com",
];

const PLAN_SYSTEM: &str = r#"You are a search query optimizer. Generate 2-4 precise web search queries.

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
{"queries": ["query1", "query2"], "intent": "brief description", "type": "documentation|github|forum|article", "timeRange": "year", "includeDomains": []}"#;

const JUDGE_SYSTEM: &str = r#"Decide whether the search results contain the specific information needed to answer the question completely.

Answer sufficient=false only when something concrete is missing — a version number, an error cause, a specific value. Do not demand exhaustive coverage; enough to answer well is enough.

When false, state briefly what is still missing so a better query can be written.

Respond in JSON ONLY:
{"sufficient": true|false, "missing": "what is still needed, under 15 words"}"#;

/// One hit. `score` is the provider's own relevance: not comparable across
/// providers, and missing is not zero (Exa's auto search omits it). Field
/// order and names are what the web app writes into the cache.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    /// "tavily" or "exa".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_date: Option<String>,
    /// Host without "www.", filled in once a result is kept.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub domain: String,
}

/// How aggressively one question may spend on search.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProfileSettings {
    /// "basic" or "advanced", for the opening round.
    pub first_round_depth: &'static str,
    /// Depth once the sufficiency check has asked for more.
    pub follow_up_depth: &'static str,
    pub first_round_queries: usize,
    pub follow_up_queries: usize,
    /// Providers bill per request and include up to ten results in the base
    /// price, so asking for fewer pays the same for half the sources.
    pub results_per_query: u32,
    pub use_cache: bool,
}

/// `quality` | `balanced` | `cheap`; anything else is the default, balanced.
pub fn profile_settings(name: &str) -> ProfileSettings {
    let profile = |first_round_depth, follow_up_depth, first_round_queries, follow_up_queries| ProfileSettings { first_round_depth, follow_up_depth, first_round_queries, follow_up_queries, results_per_query: 10, use_cache: true };
    match name {
        // Every request at advanced depth, four queries to open: the original behaviour, kept as a known-good escape hatch.
        "quality" => profile("advanced", "advanced", 4, 3),
        "cheap" => profile("basic", "basic", 2, 2),
        // The opening round goes wide and shallow; only the gap the judge names is worth deep-parse prices.
        _ => profile("basic", "advanced", 3, 3),
    }
}

/// Search keys with their on/off switches from Settings. A switched-off
/// provider is as good as keyless.
#[derive(Clone, Debug, Default)]
pub struct Keys {
    pub tavily: String,
    pub exa: String,
    pub tavily_enabled: bool,
    pub exa_enabled: bool,
}

impl Keys {
    fn tavily(&self) -> &str {
        if self.tavily_enabled { self.tavily.trim() } else { "" }
    }
    fn exa(&self) -> &str {
        if self.exa_enabled { self.exa.trim() } else { "" }
    }
}

/// The Chat Completions endpoint that plans queries and judges results: a
/// known-cheap helper, never the main model.
#[derive(Clone, Debug)]
pub struct Planner {
    pub api_key: String,
    pub base_url: String,
    pub api_model: String,
    /// DeepSeek needs thinking switched off explicitly; other endpoints read an omitted field as off.
    pub deepseek: bool,
}

/// The provider refused or failed, as opposed to finding nothing. The status
/// lets the caller say something specific: a 401 is a wrong key, a 429 a spent
/// quota, and neither is fixed by rephrasing. 0 means it could not be reached.
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderError {
    pub status: u16,
    pub detail: String,
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        if self.detail.is_empty() { write!(f, "search provider returned {}", self.status) } else { f.write_str(&self.detail) }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SearchOutcome {
    /// The best eight, ranked.
    pub results: Vec<SearchResult>,
    pub queries: Vec<String>,
    /// The results as one block of text with full page content.
    pub summary: String,
    pub searches_performed: usize,
    pub sources_used: usize,
    /// How many escalation rounds ran.
    pub rounds: usize,
    /// Why the loop stopped, for the UI.
    pub stop_reason: String,
    /// Queries answered from cache, which cost nothing.
    pub cache_hits: usize,
    /// Estimated spend for this question, in USD.
    pub estimated_usd: f64,
    /// Which providers actually answered, and which failed and why: without
    /// these a silent empty result looks the same as a provider never called.
    pub providers_used: Vec<String>,
    pub provider_errors: Vec<String>,
}

/// Puts a search's sources, queries and cost on the reply it ran for, as the web's chat route does: each source and query
/// once, and the search's cost added to the reply's search total.
pub fn record_on(msg: &mut crate::store::Message, found: &SearchOutcome) {
    for r in &found.results {
        if !msg.search_results.iter().any(|have| have.url == r.url) {
            msg.search_results.push(crate::store::SearchResult { title: r.title.clone(), url: r.url.clone(), domain: r.domain.clone() });
        }
    }
    for q in &found.queries {
        if !msg.search_queries.contains(q) {
            msg.search_queries.push(q.clone());
        }
    }
    msg.search_usd += found.estimated_usd;
}

/// What the `web_search` tool hands back.
#[derive(Clone, Debug, PartialEq)]
pub struct Reply {
    pub ok: bool,
    /// For the model.
    pub content: String,
    /// One line for the step row.
    pub summary: String,
    /// Set when results came back: feeds the citation chips and the cost total.
    pub search: Option<SearchOutcome>,
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| default.to_string())
}

/// The first `max` characters.
// ponytail: counts characters where the web counts UTF-16 units, so a cut lands a little later on text with emoji.
fn head(text: &str, max: usize) -> &str {
    text.char_indices().nth(max).map_or(text, |(cut, _)| &text[..cut])
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or("")
}

fn domain_of(url: &str) -> String {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(|host| host.strip_prefix("www.").unwrap_or(host).to_string())).unwrap_or_default()
}

/// The lowest score worth keeping, per provider. These are not interchangeable:
/// Tavily reports a relevance where a decent hit is 0.5 or better, Exa a cosine
/// similarity where the same hit is 0.15 to 0.35. One threshold for both threw
/// every correct Exa answer away. An unknown provider gets 0: dropping results
/// there is no calibration for is worse than showing a weak one.
fn score_floor(provider: Option<&str>) -> f64 {
    match provider {
        Some("tavily") => 0.3,
        Some("exa") => 0.12,
        _ => 0.0,
    }
}

/// One small JSON-mode call to the planner. None on any failure: each caller has a safe default.
async fn ask(client: &reqwest::Client, planner: &Planner, system: &str, user: String, temperature: f64, max_tokens: u32, timeout_secs: u64) -> Option<Value> {
    let mut body = json!({
        "model": planner.api_model,
        "messages": [{ "role": "system", "content": system }, { "role": "user", "content": user }],
        "response_format": { "type": "json_object" },
        "temperature": temperature,
        "max_tokens": max_tokens,
    });
    // Planning is mechanical extraction; reasoning only adds seconds before the real answer starts.
    if planner.deepseek {
        body["thinking"] = json!({ "type": "disabled" });
    }
    let mut request = client.post(format!("{}/chat/completions", planner.base_url)).bearer_auth(&planner.api_key).json(&body).timeout(Duration::from_secs(timeout_secs));
    if planner.base_url.to_ascii_lowercase().contains("openrouter.ai") {
        request = request.header("HTTP-Referer", "https://github.com/eggyeg/apiM").header("X-Title", "apiM");
    }
    let response = request.send().await.ok().filter(|r| r.status().is_success())?;
    let data: Value = response.json().await.ok()?;
    serde_json::from_str(data["choices"][0]["message"]["content"].as_str().unwrap_or("{}")).ok()
}

struct QueryPlan {
    queries: Vec<String>,
    /// day | week | month | year, passed straight to Tavily. Filtering at query
    /// time beats re-ranking: providers only date news results.
    time_range: Option<String>,
    /// Restrict to these domains when the question is clearly about one project.
    include_domains: Vec<String>,
}

fn parse_plan(parsed: &Value) -> Option<QueryPlan> {
    let string = |v: &Value| v.as_str().map_or_else(|| v.to_string(), str::to_string);
    let queries: Vec<String> = parsed["queries"].as_array()?.iter().map(string).collect();
    if queries.is_empty() {
        return None;
    }
    Some(QueryPlan {
        queries,
        time_range: parsed["timeRange"].as_str().filter(|range| ["day", "week", "month", "year"].contains(range)).map(str::to_string),
        include_domains: parsed["includeDomains"].as_array().map(|domains| domains.iter().take(10).map(string).collect()).unwrap_or_default(),
    })
}

/// Asks the planner for precise queries. Without a planner, or when it fails, the message itself is the query.
async fn plan_queries(client: &reqwest::Client, planner: Option<&Planner>, message: &str, context: &str) -> QueryPlan {
    let user = format!("Message: \"{message}\"\nContext: {context}\n\nGenerate search queries.");
    let planned = match planner {
        Some(planner) => ask(client, planner, PLAN_SYSTEM, user, 0.3, 500, 30).await,
        None => None,
    };
    planned.as_ref().and_then(parse_plan).unwrap_or_else(|| QueryPlan { queries: vec![message.to_string()], time_range: None, include_domains: Vec::new() })
}

/// Asks the planner whether the gathered sources actually answer the question,
/// and what is still missing when they do not. Only titles and the opening of
/// each source are sent, so the check stays small. If the judge is
/// unavailable the answer is "enough": stop rather than loop blindly.
async fn enough(client: &reqwest::Client, planner: Option<&Planner>, message: &str, results: &[SearchResult]) -> (bool, String) {
    let Some(planner) = planner else { return (true, String::new()) };
    if results.is_empty() {
        return (false, message.to_string());
    }
    let digest = results.iter().take(8).enumerate().map(|(i, r)| format!("[{}] {} ({})\n{}", i + 1, r.title, r.domain, head(&r.content, 600))).collect::<Vec<_>>().join("\n\n");
    match ask(client, planner, JUDGE_SYSTEM, format!("Question: {message}\n\nResults:\n{digest}"), 0.0, 120, 20).await {
        Some(verdict) => (verdict["sufficient"] != false, text(&verdict, "missing").to_string()),
        None => (true, String::new()),
    }
}

/// How one query is asked.
#[derive(Clone, Copy)]
struct Asked<'a> {
    depth: &'a str,
    max_results: u32,
    time_range: Option<&'a str>,
    include_domains: &'a [String],
    use_cache: bool,
}

/// One provider's results for one query, and whether they came from the cache.
type Answer = Result<(Vec<SearchResult>, bool), ProviderError>;

fn rows(data: &Value) -> impl Iterator<Item = &Value> {
    data["results"].as_array().into_iter().flatten()
}

fn date(row: &Value, key: &str) -> Option<String> {
    row[key].as_str().filter(|d| !d.is_empty()).map(str::to_string)
}

fn tavily_results(data: &Value) -> Vec<SearchResult> {
    rows(data)
        .map(|r| {
            // The full page when extraction worked; the snippet when it failed or came back shorter.
            let (snippet, full) = (text(r, "content"), text(r, "raw_content"));
            SearchResult {
                title: text(r, "title").to_string(),
                url: text(r, "url").to_string(),
                content: head(if full.len() > snippet.len() { full } else { snippet }, MAX_SOURCE_CHARS).to_string(),
                score: Some(r["score"].as_f64().unwrap_or(0.0)),
                provider: Some("tavily".to_string()),
                published_date: date(r, "published_date"),
                domain: String::new(),
            }
        })
        .collect()
}

fn exa_results(data: &Value) -> Vec<SearchResult> {
    rows(data)
        .map(|r| {
            // Highlights are the passages Exa picked. When the full text is missing they are all there is.
            let highlights = r["highlights"].as_array().map(|h| h.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n\n")).unwrap_or_default();
            let full = text(r, "text");
            SearchResult {
                title: text(r, "title").to_string(),
                url: text(r, "url").to_string(),
                content: head(if full.len() > highlights.len() { full } else { &highlights }, MAX_SOURCE_CHARS).to_string(),
                // Optional in Exa's API. Turning its absence into a zero put every such page under the floor.
                score: r["score"].as_f64(),
                provider: Some("exa".to_string()),
                published_date: date(r, "publishedDate"),
                domain: String::new(),
            }
        })
        .collect()
}

fn tavily_refusal(body: &Value) -> String {
    body["detail"].as_str().or_else(|| body["detail"]["error"].as_str()).unwrap_or("").to_string()
}

fn exa_refusal(body: &Value) -> String {
    body["error"].as_str().or_else(|| body["message"].as_str()).unwrap_or("").to_string()
}

/// Sends one provider request, with the cache in front and the meter behind.
async fn call(request: reqwest::RequestBuilder, key: CacheKey<'_>, cacheable: bool, results: fn(&Value) -> Vec<SearchResult>, refusal: fn(&Value) -> String) -> Answer {
    if cacheable && let Some(hit) = usage::read_cache(&key) {
        usage::record_cache_hit(key.provider);
        return Ok((hit, true));
    }
    let unreachable = |e: reqwest::Error| ProviderError { status: 0, detail: e.to_string() };
    // Full-page retrieval is slower than snippets alone.
    let response = request.timeout(Duration::from_secs(45)).send().await.map_err(unreachable)?;
    // Billed on send, not on success: a request that comes back as an error has
    // usually still been counted, and undercounting is what leads to a surprise quota error.
    usage::record_request(key.provider, key.depth);
    let status = response.status();
    if !status.is_success() {
        // A failed REQUEST is not an empty RESULT. Returning nothing here made a
        // rejected key look like "no results", and the model rephrased and retried, each try billed.
        let detail = response.json::<Value>().await.map(|body| refusal(&body)).unwrap_or_default();
        return Err(ProviderError { status: status.as_u16(), detail });
    }
    let found = results(&response.json::<Value>().await.map_err(unreachable)?);
    if cacheable {
        usage::write_cache(&key, &found);
    }
    Ok((found, false))
}

async fn tavily_search(client: &reqwest::Client, query: &str, key: &str, asked: Asked<'_>) -> Answer {
    let mut body = json!({
        "query": query,
        "search_depth": asked.depth,
        "max_results": asked.max_results,
        "include_answer": true,
        "chunks_per_source": 3,
        // The parsed, cleaned page rather than a ~500 character snippet. Tavily
        // does the fetching, which avoids a scraper that trips over paywalls and bot checks.
        "include_raw_content": "markdown",
        "exclude_domains": BLOCKED_DOMAINS,
    });
    if let Some(range) = asked.time_range {
        body["time_range"] = json!(range);
    }
    if !asked.include_domains.is_empty() {
        body["include_domains"] = json!(asked.include_domains);
    }
    let request = client.post(format!("{}/search", env_or("TAVILY_BASE_URL", "https://api.tavily.com"))).bearer_auth(key).json(&body);
    // A time-ranged query asks what changed recently, so a day-old answer is exactly the wrong thing to hand back.
    let cacheable = asked.use_cache && asked.time_range.is_none();
    call(request, CacheKey { query, provider: "tavily", depth: asked.depth, max_results: asked.max_results }, cacheable, tavily_results, tavily_refusal).await
}

/// Exa has no search depth and no time range. Two things from its docs that are
/// easy to get wrong: auth is `x-api-key`, and content fields must nest under
/// `contents` (a top-level `text: true` is a 400).
async fn exa_search(client: &reqwest::Client, query: &str, key: &str, asked: Asked<'_>) -> Answer {
    let mut body = json!({
        "query": query,
        "type": "auto",
        "numResults": asked.max_results,
        "contents": { "text": { "maxCharacters": MAX_SOURCE_CHARS }, "highlights": true },
        "excludeDomains": BLOCKED_DOMAINS,
    });
    if !asked.include_domains.is_empty() {
        body["includeDomains"] = json!(asked.include_domains);
    }
    let request = client.post(format!("{}/search", env_or("EXA_BASE_URL", "https://api.exa.ai"))).header("x-api-key", key).json(&body);
    call(request, CacheKey { query, provider: "exa", depth: asked.depth, max_results: asked.max_results }, asked.use_cache, exa_results, exa_refusal).await
}

/// What one query brought back from every configured provider.
#[derive(Default)]
struct Once {
    results: Vec<SearchResult>,
    cache_hit: bool,
    answered: Vec<&'static str>,
    errors: Vec<String>,
}

/// Merges the providers' answers for one query, Tavily's first, each URL once.
/// One provider failing does not fail the search: if Tavily is out of quota
/// and Exa answered, that is a successful search. Only every provider failing
/// is a failure, and then the first error is returned so the message stays specific.
fn merge_answers(answers: [(&'static str, Option<Answer>); 2]) -> Result<Once, ProviderError> {
    let mut once = Once::default();
    let mut seen = HashSet::new();
    let mut first_error = None;
    let mut asked = 0;
    for (id, answer) in answers {
        let Some(answer) = answer else { continue };
        asked += 1;
        match answer {
            Ok((results, cache_hit)) => {
                once.cache_hit |= cache_hit;
                once.answered.push(id);
                once.results.extend(results.into_iter().filter(|r| !r.url.is_empty() && seen.insert(r.url.clone())));
            }
            Err(error) => {
                once.errors.push(format!("{id}: {error}"));
                first_error.get_or_insert(error);
            }
        }
    }
    match first_error {
        Some(error) if once.results.is_empty() && once.errors.len() == asked => Err(error),
        _ => Ok(once),
    }
}

/// One query across every configured provider, in parallel: peers, not a
/// primary and a spare. Tavily returns cleaned full pages, Exa is a neural
/// index that finds what keyword matching misses, and two providers cost the
/// same wall-clock time as one.
async fn search_once(client: &reqwest::Client, query: &str, keys: &Keys, asked: Asked<'_>) -> Result<Once, ProviderError> {
    let (tavily, exa) = (keys.tavily(), keys.exa());
    if tavily.is_empty() && exa.is_empty() {
        return Err(ProviderError { status: 0, detail: "no search provider is configured".to_string() });
    }
    let (from_tavily, from_exa) = tokio::join!(
        async { if tavily.is_empty() { None } else { Some(tavily_search(client, query, tavily, asked).await) } },
        // Exa has no time range, so a recency-limited query loses that filter on this side.
        async { if exa.is_empty() { None } else { Some(exa_search(client, query, exa, asked).await) } },
    );
    merge_answers([("tavily", from_tavily), ("exa", from_exa)])
}

/// Everything one question has gathered so far.
#[derive(Default)]
struct Run {
    seen_urls: HashSet<String>,
    seen_queries: HashSet<String>,
    collected: Vec<SearchResult>,
    queries: Vec<String>,
    searches: usize,
    cache_hits: usize,
    billed_basic: usize,
    billed_advanced: usize,
    providers: Vec<String>,
    errors: Vec<String>,
}

impl Run {
    /// The queries not asked yet in this run, trimmed, and now marked as asked.
    fn fresh(&mut self, queries: &[String]) -> Vec<String> {
        let fresh: Vec<String> = queries.iter().map(|q| q.trim().to_string()).filter(|q| !q.is_empty() && !self.seen_queries.contains(&q.to_lowercase())).collect();
        self.seen_queries.extend(fresh.iter().map(|q| q.to_lowercase()));
        self.queries.extend(fresh.iter().cloned());
        fresh
    }

    /// Folds one query's answer in: new URLs only, and only what clears the quality gate.
    fn take(&mut self, once: Once, depth: &str) {
        self.searches += 1;
        if once.cache_hit {
            self.cache_hits += 1;
        } else if depth == "advanced" {
            self.billed_advanced += 1;
        } else {
            self.billed_basic += 1;
        }
        for id in once.answered {
            if !self.providers.iter().any(|p| p == id) {
                self.providers.push(id.to_string());
            }
        }
        for error in once.errors {
            if !self.errors.contains(&error) {
                self.errors.push(error);
            }
        }
        for mut r in once.results {
            // A missing score means the provider did not grade it, not zero relevance. Only a score that was supplied can reject.
            let weak = r.score.is_some_and(|s| s < score_floor(r.provider.as_deref()));
            if r.url.is_empty() || self.seen_urls.contains(&r.url) || weak || r.content.chars().count() < 50 {
                continue;
            }
            self.seen_urls.insert(r.url.clone());
            r.domain = domain_of(&r.url);
            self.collected.push(r);
        }
    }

    /// Runs one round of queries. A query every provider failed on fails the whole search.
    async fn round(&mut self, client: &reqwest::Client, keys: &Keys, queries: &[String], asked: Asked<'_>) -> Result<(), ProviderError> {
        let fresh = self.fresh(queries);
        let answers = futures_util::future::join_all(fresh.iter().map(|query| search_once(client, query, keys, asked))).await;
        for once in answers {
            self.take(once?, asked.depth);
        }
        Ok(())
    }

    fn finish(mut self, rounds: usize, stop_reason: &str) -> SearchOutcome {
        // Trusted sources rank above general ones: a provider's score is textual
        // relevance only, so an SEO blog can outrank the official documentation.
        // A missing score is neutral, not worst: it ranks at its provider's floor.
        let rank = |r: &SearchResult| {
            let trusted = TRUSTED_DOMAINS.iter().any(|d| r.domain == *d || r.domain.ends_with(&format!(".{d}")));
            r.score.unwrap_or_else(|| score_floor(r.provider.as_deref())) + if trusted { 0.25 } else { 0.0 }
        };
        self.collected.sort_by(|a, b| rank(b).total_cmp(&rank(a)));
        self.collected.truncate(8);
        let summary = self.collected.iter().enumerate().map(|(i, r)| format!("[{}] {}{}\nURL: {}\n{}\n\n---\n", i + 1, r.title, r.published_date.as_ref().map_or(String::new(), |d| format!(" ({d})")), r.url, r.content)).collect::<Vec<_>>().join("\n");
        let rate = usage::provider("tavily").map_or(0.0, |p| p.cost_per_request);
        SearchOutcome {
            sources_used: self.collected.len(),
            results: self.collected,
            queries: self.queries,
            summary,
            searches_performed: self.searches,
            rounds,
            stop_reason: stop_reason.to_string(),
            cache_hits: self.cache_hits,
            estimated_usd: self.billed_basic as f64 * rate + self.billed_advanced as f64 * rate * 2.0,
            providers_used: self.providers,
            provider_errors: self.errors,
        }
    }
}

/// Plans queries, searches each, deduplicates and ranks, escalating while the
/// judge says something concrete is still missing. `planner` None searches for
/// the message as written, one round. Dropping the future cancels the search.
pub async fn smart_search(client: &reqwest::Client, message: &str, context: &str, profile: &str, keys: &Keys, planner: Option<&Planner>) -> Result<SearchOutcome, ProviderError> {
    let profile = profile_settings(profile);
    let plan = plan_queries(client, planner, message, context).await;
    usage::record_question();

    // Round 1: the planned queries. The check below decides whether anything
    // is worth a deeper read, so paying deep-parse prices up front only helps
    // the questions that would have settled either way.
    let mut run = Run::default();
    let mut rounds = 1;
    let first = Asked { depth: profile.first_round_depth, max_results: profile.results_per_query, time_range: plan.time_range.as_deref(), include_domains: &plan.include_domains, use_cache: profile.use_cache };
    run.round(client, keys, &plan.queries[..plan.queries.len().min(profile.first_round_queries)], first).await?;

    // Escalate only while something concrete is still missing. Most questions stop here.
    let mut stop_reason = "reached the search limit";
    while rounds < MAX_SEARCH_ROUNDS {
        let (sufficient, missing) = enough(client, planner, message, &run.collected).await;
        if sufficient {
            stop_reason = if rounds == 1 { "found what was needed" } else { "found what was needed after follow-up" };
            break;
        }
        let follow_up = plan_queries(client, planner, &format!("{message}\n\nStill missing: {missing}"), context).await;
        // The judge found a concrete gap, so this is the round that earns a deeper read.
        let before = run.collected.len();
        rounds += 1;
        let deeper = Asked { depth: profile.follow_up_depth, time_range: follow_up.time_range.as_deref().or(plan.time_range.as_deref()), include_domains: &follow_up.include_domains, ..first };
        run.round(client, keys, &follow_up.queries[..follow_up.queries.len().min(profile.follow_up_queries)], deeper).await?;
        // No new sources means further rounds would repeat themselves.
        if run.collected.len() == before {
            stop_reason = "no further sources found";
            break;
        }
    }
    Ok(run.finish(rounds, stop_reason))
}

fn reply(ok: bool, content: String, summary: String) -> Reply {
    Reply { ok, content, summary, search: None }
}

/// Says WHY, so the model stops instead of rephrasing: no rewording fixes a rejected key.
fn failed_reply(error: &ProviderError) -> Reply {
    let why = match error.status {
        401 | 403 => "the Tavily key was rejected. Check it in Settings.".to_string(),
        429 | 432 => "the Tavily quota or rate limit is spent.".to_string(),
        0 => "the search service could not be reached.".to_string(),
        status => format!("the search service returned HTTP {status}."),
    };
    let detail = if error.detail.is_empty() { String::new() } else { format!(" ({})", error.detail) };
    let status = if error.status == 0 { "unreachable".to_string() } else { error.status.to_string() };
    reply(
        false,
        format!("Search FAILED — {why}{detail}\n\nThis is not \"no results\": the query never ran. Do not retry it or rephrase — nothing about the wording is the problem. Tell the user plainly, and use fetch_url if you already know a URL that would answer this."),
        format!("Search failed ({status})"),
    )
}

/// Always says which providers ran, especially when nothing came back.
fn found_reply(query: &str, found: SearchOutcome) -> Reply {
    let ran = if found.providers_used.is_empty() { "none".to_string() } else { found.providers_used.join(", ") };
    let errors = if found.provider_errors.is_empty() { String::new() } else { format!("\nProvider errors: {}", found.provider_errors.join("; ")) };
    if found.results.is_empty() {
        let advice = if found.provider_errors.is_empty() {
            "Every configured provider ran and genuinely found nothing. Try different wording, or say you could not find it."
        } else {
            "At least one provider errored — that is not the same as finding nothing. Tell the user what failed rather than rephrasing."
        };
        return reply(true, format!("No results for \"{query}\".\nProviders that answered: {ran}.{errors}\n\n{advice}"), format!("No results — {} (via {ran})", head(query, 40)));
    }
    let body = found.results.iter().take(SEARCH_RESULTS).enumerate().map(|(i, hit)| format!("[{}] {}\n{}\n{}", i + 1, hit.title, hit.url, head(&hit.content, SEARCH_SNIPPET))).collect::<Vec<_>>().join("\n\n");
    Reply {
        ok: true,
        content: format!("{} result(s) for \"{query}\":\n\n{body}\n\nCite the URLs you use. Call fetch_url on one for the full page.\n[via {ran}{errors}]", found.results.len()),
        summary: format!("Searched via {ran}: {}", head(query, 35)),
        search: Some(found),
    }
}

/// The whole `web_search` tool call: what the model reads back, whatever happened.
pub async fn web_search(client: &reqwest::Client, query: &str, profile: &str, keys: &Keys, planner: Option<&Planner>) -> Reply {
    let query = query.trim();
    if query.is_empty() {
        return reply(false, "Error: a query is required.".to_string(), "Empty query".to_string());
    }
    if keys.tavily().is_empty() && keys.exa().is_empty() {
        return reply(false, "Web search is not configured — no Tavily or Exa key is set in Settings. Say plainly that you could not look this up rather than guessing, or use fetch_url if you already know the URL.".to_string(), "Search unavailable".to_string());
    }
    match smart_search(client, query, "", profile, keys, planner).await {
        Ok(found) => found_reply(query, found),
        Err(error) => failed_reply(&error),
    }
}

// Where an address really points (src/lib/web.ts). The agent chooses these
// URLs, so this is the boundary between "read a web page" and "read whatever
// is reachable from this machine".

/// Loopback only: never private LAN ranges or cloud metadata.
pub fn is_loopback_host(hostname: &str) -> bool {
    let host = hostname.to_ascii_lowercase();
    host == "localhost" || host == "::1" || host == "[::1]" || host.ends_with(".localhost") || host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.octets()[0] == 127)
}

fn v4_private([a, b, c, _]: [u8; 4]) -> bool {
    a == 0 || a == 10 || a == 127 || (a == 100 && (64..=127).contains(&b)) || (a == 169 && b == 254) || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 0 && c == 0) || (a == 192 && b == 168) || (a == 198 && (b == 18 || b == 19)) || a >= 224
}

fn non_public(ip: IpAddr) -> bool {
    let g = match ip {
        IpAddr::V4(v4) => return v4_private(v4.octets()),
        IpAddr::V6(v6) => v6.segments(),
    };
    let embedded = |hi: u16, lo: u16| v4_private([(hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8]);
    // ::, ::1, ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible).
    if g[..5].iter().all(|x| *x == 0) && (g[5] == 0xffff || g[5] == 0) {
        return embedded(g[6], g[7]);
    }
    // NAT64 and 6to4 carry an IPv4 address too.
    if g[0] == 0x64 && g[1] == 0xff9b {
        return embedded(g[6], g[7]);
    }
    if g[0] == 0x2002 {
        return embedded(g[1], g[2]);
    }
    // Unique local, link-local, multicast.
    (g[0] & 0xfe00) == 0xfc00 || (g[0] & 0xffc0) == 0xfe80 || (g[0] & 0xff00) == 0xff00
}

/// True for any address that is not on the public internet, after unwrapping
/// the IPv6 forms that embed an IPv4 one. Unparseable is refused rather than guessed.
pub fn is_non_public_ip(ip: &str) -> bool {
    let ip = ip.trim_matches(['[', ']']);
    ip.split('%').next().unwrap_or(ip).parse().map_or(true, non_public)
}

fn loopback_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.octets()[0] == 127,
        IpAddr::V6(v6) => v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.octets()[0] == 127),
    }
}

/// Rejects anything that is not a public http(s) address, judged as written.
/// `allow_loopback` opens localhost only, for http_request's local-dev mode.
pub fn assert_public_url(raw: &str, allow_loopback: bool) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| format!("Not a valid URL: {raw}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("Only http and https are supported, not \"{}:\".", url.scheme()));
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if is_loopback_host(&host) {
        return if allow_loopback { Ok(url) } else { Err("That address is on this machine, not the public web. For a local development API, use http_request with allow_local=true.".to_string()) };
    }
    // Names that may resolve inside the local network are never opted in.
    if host == "0.0.0.0" || host.ends_with(".local") || host.ends_with(".internal") {
        return Err("That address is on this machine or its private network, which this tool will not fetch.".to_string());
    }
    // Every literal, after unwrapping mapped, NAT64 and 6to4 forms.
    let literal = host.trim_matches(['[', ']']);
    if literal.parse::<IpAddr>().is_ok() && is_non_public_ip(literal) {
        return Err("That is a private network address, which this tool will not fetch.".to_string());
    }
    Ok(url)
}

/// `assert_public_url`, then resolves the name and checks where it really
/// points: a public NAME can point at loopback (127.0.0.1.nip.io). For use
/// before every connection, and every redirect hop.
// ponytail: checks the addresses, then the HTTP client resolves again. Pin the checked address on the client (resolve_to_addrs) if DNS rebinding becomes a concern.
pub async fn assert_public_url_resolved(raw: &str, allow_loopback: bool) -> Result<reqwest::Url, String> {
    let url = assert_public_url(raw, allow_loopback)?;
    let host = url.host_str().unwrap_or("").trim_matches(['[', ']']).to_string();
    if allow_loopback && is_loopback_host(url.host_str().unwrap_or("")) {
        return Ok(url);
    }
    let addresses: Vec<IpAddr> = match host.parse() {
        Ok(ip) => vec![ip],
        Err(_) => {
            let name = host.clone();
            let resolved = tokio::task::spawn_blocking(move || (name.as_str(), 0).to_socket_addrs().map(|found| found.map(|a| a.ip()).collect::<Vec<_>>())).await;
            resolved.ok().and_then(Result::ok).filter(|found| !found.is_empty()).ok_or_else(|| format!("Could not resolve {host}."))?
        }
    };
    match addresses.into_iter().find(|ip| non_public(*ip) && !(allow_loopback && loopback_ip(*ip))) {
        Some(address) => Err(format!("{host} points at {address}, which is on this machine or a private network — this tool will not fetch it.")),
        None => Ok(url),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(url: &str, provider: &str, score: Option<f64>) -> SearchResult {
        SearchResult { title: format!("T {url}"), url: url.to_string(), content: "x".repeat(60), score, provider: Some(provider.to_string()), ..Default::default() }
    }

    #[test]
    fn profiles_differ_where_they_should() {
        let (quality, balanced, cheap) = (profile_settings("quality"), profile_settings("balanced"), profile_settings("cheap"));
        assert_eq!((quality.first_round_depth, quality.follow_up_depth, quality.first_round_queries, quality.follow_up_queries), ("advanced", "advanced", 4, 3));
        assert_eq!((balanced.first_round_depth, balanced.follow_up_depth, balanced.first_round_queries, balanced.follow_up_queries), ("basic", "advanced", 3, 3));
        assert_eq!((cheap.first_round_depth, cheap.follow_up_depth, cheap.first_round_queries, cheap.follow_up_queries), ("basic", "basic", 2, 2));
        assert_eq!((profile_settings(""), profile_settings("nonsense")), (balanced, profile_settings(DEFAULT_SEARCH_PROFILE)));
        assert!([quality, balanced, cheap].iter().all(|p| p.results_per_query == 10 && p.use_cache));
        // A switched-off provider is as good as keyless.
        let keys = Keys { tavily: " tvly-x ".into(), exa: "exa-x".into(), tavily_enabled: true, exa_enabled: false };
        assert_eq!((keys.tavily(), keys.exa()), ("tvly-x", ""));
    }

    #[test]
    fn provider_answers_map_to_results() {
        let tavily = tavily_results(&json!({ "results": [
            { "title": "Docs", "url": "https://docs.python.org/3/", "content": "snippet", "raw_content": "the whole parsed page", "score": 0.91, "published_date": "2026-09-01" },
            { "title": "Short", "url": "https://b.test/", "content": "snippet wins", "raw_content": null }
        ] }));
        assert_eq!((tavily[0].content.as_str(), tavily[0].score, tavily[0].published_date.as_deref(), tavily[0].provider.as_deref()), ("the whole parsed page", Some(0.91), Some("2026-09-01"), Some("tavily")));
        // Tavily always grades, so an absent score is a real zero there.
        assert_eq!((tavily[1].content.as_str(), tavily[1].score), ("snippet wins", Some(0.0)));

        let exa = exa_results(&json!({ "results": [
            { "title": "A", "url": "https://a.test/", "text": "full text of the page", "highlights": ["h1"], "score": 0.19, "publishedDate": "2026-01-02T00:00:00.000Z" },
            { "title": "B", "url": "https://b.test/", "highlights": ["first passage", "second passage"] }
        ] }));
        assert_eq!((exa[0].content.as_str(), exa[0].score), ("full text of the page", Some(0.19)));
        // No text: the highlights are all there is. No score: it stays missing, not zero.
        assert_eq!((exa[1].content.as_str(), exa[1].score, exa[1].published_date.as_deref()), ("first passage\n\nsecond passage", None, None));
        assert!(tavily_results(&json!({})).is_empty() && exa_results(&json!({ "results": null })).is_empty());

        assert_eq!(tavily_refusal(&json!({ "detail": { "error": "This request exceeds your plan's set usage limit" } })), "This request exceeds your plan's set usage limit");
        assert_eq!((tavily_refusal(&json!({ "detail": "Unauthorized" })), exa_refusal(&json!({ "message": "bad key" })), exa_refusal(&json!([]))), ("Unauthorized".to_string(), "bad key".to_string(), String::new()));
        assert_eq!(head(&"é".repeat(MAX_SOURCE_CHARS + 5), MAX_SOURCE_CHARS).chars().count(), MAX_SOURCE_CHARS);
    }

    #[test]
    fn providers_merge_and_only_total_failure_fails() {
        let quota = ProviderError { status: 432, detail: "This request exceeds your plan's set usage limit".into() };
        let both = merge_answers([
            ("tavily", Some(Ok((vec![hit("https://a.test/", "tavily", Some(0.8)), hit("https://b.test/", "tavily", Some(0.6))], false)))),
            ("exa", Some(Ok((vec![hit("https://b.test/", "exa", None), hit("https://c.test/", "exa", None), hit("", "exa", None)], true)))),
        ])
        .unwrap();
        // Tavily's copy of a shared page is the one kept, and one cached side marks the query as a cache hit.
        assert_eq!(both.results.iter().map(|r| (r.url.as_str(), r.provider.as_deref().unwrap())).collect::<Vec<_>>(), [("https://a.test/", "tavily"), ("https://b.test/", "tavily"), ("https://c.test/", "exa")]);
        assert!(both.cache_hit && both.answered == ["tavily", "exa"] && both.errors.is_empty());

        // Tavily out of quota, Exa answered: a successful search that says what failed.
        let covered = merge_answers([("tavily", Some(Err(quota.clone()))), ("exa", Some(Ok((vec![hit("https://c.test/", "exa", None)], false))))]).unwrap();
        assert_eq!((covered.results.len(), covered.answered.as_slice(), covered.errors.as_slice()), (1, &["exa"][..], &["tavily: This request exceeds your plan's set usage limit".to_string()][..]));
        // A provider that answered with nothing is not a failure either.
        assert!(merge_answers([("tavily", Some(Err(quota.clone()))), ("exa", Some(Ok((Vec::new(), false))))]).is_ok());
        // Every provider failed: the first error comes back, whether one was asked or two.
        let rejected = ProviderError { status: 401, detail: String::new() };
        assert_eq!(merge_answers([("tavily", Some(Err(quota.clone()))), ("exa", Some(Err(rejected.clone())))]).err(), Some(quota));
        assert_eq!(merge_answers([("tavily", None), ("exa", Some(Err(rejected.clone())))]).err(), Some(rejected.clone()));
        assert_eq!(rejected.to_string(), "search provider returned 401");
    }

    #[test]
    fn gate_dedup_and_rank() {
        let mut run = Run::default();
        assert_eq!(run.fresh(&[" rust async ".into(), "Rust Async".into(), String::new()]), ["rust async", "Rust Async"]);
        assert!(run.fresh(&["RUST ASYNC".into()]).is_empty());

        let mut short = hit("https://short.test/", "tavily", Some(0.9));
        short.content = "too short".into();
        let first = Once {
            results: vec![
                hit("https://blog.test/post", "tavily", Some(0.8)),
                // Under Tavily's floor, but the same number is a good Exa hit.
                hit("https://weak.test/", "tavily", Some(0.19)),
                hit("https://exa-hit.test/", "exa", Some(0.19)),
                hit("https://www.docs.python.org/3/library/asyncio.html", "tavily", Some(0.6)),
                hit("https://ungraded.test/", "exa", None),
                short,
            ],
            cache_hit: false,
            answered: vec!["tavily", "exa"],
            errors: vec!["exa: slow".into()],
        };
        run.take(first, "advanced");
        // A later query returns a page already held, and one that was rejected before but is good now.
        let second = Once { results: vec![hit("https://blog.test/post", "exa", Some(0.3)), hit("https://weak.test/", "exa", Some(0.2))], cache_hit: true, answered: vec!["exa"], errors: vec!["exa: slow".into()] };
        run.take(second, "basic");
        run.take(Once::default(), "basic");

        let out = run.finish(2, "found what was needed after follow-up");
        // The official docs (0.6 + 0.25 trusted) outrank the blog (0.8); the ungraded page sits at Exa's floor, last.
        assert_eq!(out.results.iter().map(|r| r.domain.as_str()).collect::<Vec<_>>(), ["docs.python.org", "blog.test", "weak.test", "exa-hit.test", "ungraded.test"]);
        assert_eq!((out.searches_performed, out.cache_hits, out.sources_used, out.rounds), (3, 1, 5, 2));
        assert_eq!((out.providers_used.as_slice(), out.provider_errors.as_slice()), (&["tavily".to_string(), "exa".to_string()][..], &["exa: slow".to_string()][..]));
        // One advanced query at double Tavily's rate, one basic, one served from cache.
        assert_eq!(out.estimated_usd, 1.0 * 0.008 + 1.0 * 0.008 * 2.0);
        assert!(out.summary.starts_with("[1] T https://www.docs.python.org/3/library/asyncio.html\nURL: https://www.docs.python.org/3/library/asyncio.html\nxxx") && out.summary.ends_with("\n\n---\n"));

        // Only the best eight are kept.
        let mut many = Run::default();
        many.take(Once { results: (0..12).map(|i| hit(&format!("https://s{i}.test/"), "tavily", Some(0.4 + i as f64 / 100.0))).collect(), ..Default::default() }, "basic");
        let top = many.finish(1, "found what was needed");
        assert_eq!((top.results.len(), top.results[0].url.as_str()), (8, "https://s11.test/"));
    }

    #[test]
    fn plans_parse() {
        let plan = parse_plan(&json!({ "queries": ["tokio 1.53 select macro", 7], "timeRange": "week", "includeDomains": ["docs.rs"] })).unwrap();
        assert_eq!((plan.queries, plan.time_range.as_deref(), plan.include_domains), (vec!["tokio 1.53 select macro".to_string(), "7".to_string()], Some("week"), vec!["docs.rs".to_string()]));
        assert!(parse_plan(&json!({ "queries": ["q"], "timeRange": "decade" })).unwrap().time_range.is_none());
        assert!(parse_plan(&json!({ "queries": [] })).is_none() && parse_plan(&json!({})).is_none());
    }

    #[test]
    fn the_model_reads_the_web_apps_words() {
        let mut found = SearchOutcome { results: vec![hit("https://a.test/", "tavily", Some(0.9)), hit("https://b.test/", "exa", None)], providers_used: vec!["tavily".into(), "exa".into()], ..Default::default() };
        found.results[0].content = "y".repeat(SEARCH_SNIPPET + 50);
        let ok = found_reply("rust edition 2024 let chains stable version number", found.clone());
        assert_eq!(
            ok.content,
            format!("2 result(s) for \"rust edition 2024 let chains stable version number\":\n\n[1] T https://a.test/\nhttps://a.test/\n{}\n\n[2] T https://b.test/\nhttps://b.test/\n{}\n\nCite the URLs you use. Call fetch_url on one for the full page.\n[via tavily, exa]", "y".repeat(SEARCH_SNIPPET), "x".repeat(60))
        );
        assert_eq!((ok.ok, ok.summary.as_str(), ok.search.is_some()), (true, "Searched via tavily, exa: rust edition 2024 let chains stable", true));

        found.results.clear();
        found.providers_used = vec!["exa".into()];
        found.provider_errors = vec!["tavily: This request exceeds your plan's set usage limit".into()];
        let empty = found_reply("cat", found.clone());
        assert_eq!(empty.content, "No results for \"cat\".\nProviders that answered: exa.\nProvider errors: tavily: This request exceeds your plan's set usage limit\n\nAt least one provider errored — that is not the same as finding nothing. Tell the user what failed rather than rephrasing.");
        assert_eq!((empty.ok, empty.summary.as_str(), empty.search), (true, "No results — cat (via exa)", None));
        found.provider_errors.clear();
        found.providers_used.clear();
        assert_eq!(found_reply("cat", found).content, "No results for \"cat\".\nProviders that answered: none.\n\nEvery configured provider ran and genuinely found nothing. Try different wording, or say you could not find it.");

        let failed = failed_reply(&ProviderError { status: 432, detail: "usage limit".into() });
        assert_eq!(failed.content, "Search FAILED — the Tavily quota or rate limit is spent. (usage limit)\n\nThis is not \"no results\": the query never ran. Do not retry it or rephrase — nothing about the wording is the problem. Tell the user plainly, and use fetch_url if you already know a URL that would answer this.");
        assert_eq!((failed.ok, failed.summary.as_str()), (false, "Search failed (432)"));
        assert!(failed_reply(&ProviderError { status: 401, detail: String::new() }).content.starts_with("Search FAILED — the Tavily key was rejected. Check it in Settings.\n\nThis"));
        assert!(failed_reply(&ProviderError { status: 500, detail: String::new() }).content.starts_with("Search FAILED — the search service returned HTTP 500.\n\n"));
        let down = failed_reply(&ProviderError { status: 0, detail: "no search provider is configured".into() });
        assert!(down.content.starts_with("Search FAILED — the search service could not be reached. (no search provider is configured)\n\n") && down.summary == "Search failed (unreachable)");
    }

    #[tokio::test]
    async fn no_key_and_no_query_never_reach_the_network() {
        let client = reqwest::Client::new();
        let off = Keys { tavily: "tvly-x".into(), exa: String::new(), tavily_enabled: false, exa_enabled: true };
        let unset = web_search(&client, "anything", "balanced", &off, None).await;
        assert_eq!((unset.ok, unset.summary.as_str()), (false, "Search unavailable"));
        assert!(unset.content.starts_with("Web search is not configured — no Tavily or Exa key is set in Settings."));
        let on = Keys { tavily_enabled: true, ..off.clone() };
        assert_eq!(web_search(&client, "   ", "balanced", &on, None).await.content, "Error: a query is required.");
        let asked = Asked { depth: "basic", max_results: 10, time_range: None, include_domains: &[], use_cache: false };
        assert_eq!(search_once(&client, "q", &off, asked).await.err(), Some(ProviderError { status: 0, detail: "no search provider is configured".into() }));
    }

    #[tokio::test]
    async fn private_addresses_are_refused() {
        for public in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "[2001:4860:4860::8888]", "64:ff9b::808:808"] {
            assert!(!is_non_public_ip(public), "{public}");
        }
        // Loopback, private ranges, CGNAT, metadata, and the IPv6 forms that smuggle an IPv4 address.
        for private in ["127.0.0.1", "10.1.2.3", "100.64.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "0.0.0.0", "::", "::1", "::ffff:127.0.0.1", "[::ffff:a9fe:a9fe]", "::127.0.0.1", "64:ff9b::7f00:1", "2002:c0a8:101::1", "fc00::1", "fd12::1", "fe80::1%eth0", "ff02::1", "not-an-ip", "999.1.1.1"] {
            assert!(is_non_public_ip(private), "{private}");
        }
        assert!(assert_public_url("https://example.com/a?b=1", false).is_ok());
        assert_eq!(assert_public_url("ftp://example.com/", false).unwrap_err(), "Only http and https are supported, not \"ftp:\".");
        assert_eq!(assert_public_url("no scheme", false).unwrap_err(), "Not a valid URL: no scheme");
        assert!(assert_public_url("http://localhost:3000/", false).unwrap_err().starts_with("That address is on this machine, not the public web."));
        for local in ["http://localhost:3000/", "http://127.0.0.1:8080/x", "http://[::1]:3000/", "http://app.localhost/"] {
            assert!(assert_public_url(local, true).is_ok(), "{local}");
        }
        for private in ["http://192.168.1.1/", "http://[::ffff:127.0.0.1]:3000/", "http://[::ffff:a9fe:a9fe]/latest", "http://[fd00::1]/", "http://169.254.169.254/", "http://100.64.0.1/"] {
            assert_eq!(assert_public_url(private, true).unwrap_err(), "That is a private network address, which this tool will not fetch.", "{private}");
        }
        // Odd spellings of loopback are normalised before they are judged.
        assert!(assert_public_url("http://0x7f.1/", false).is_err() && assert_public_url("http://2130706433/", false).is_err());
        assert!(assert_public_url("http://nas.local/", true).unwrap_err().starts_with("That address is on this machine or its private network"));
        // Literal addresses resolve to themselves, so none of this touches DNS.
        assert_eq!(assert_public_url_resolved("http://[::ffff:10.0.0.1]/", false).await.unwrap_err(), "That is a private network address, which this tool will not fetch.");
        assert!(assert_public_url_resolved("https://8.8.8.8/", false).await.is_ok() && assert_public_url_resolved("http://127.0.0.1:5173/", true).await.is_ok());
    }
}

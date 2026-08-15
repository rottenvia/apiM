/**
 * Checks the search cost controls — profiles, the cache and the meter.
 *
 * Run:  npm run test:budget
 *
 * Search is billed per request, and one question can fire several. These
 * check that the cheaper settings really do cut requests, that a cached
 * result is byte-identical to the one it replaces (so quality cannot quietly
 * drop), and that the meter counts what was actually sent.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rm } from "node:fs/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
/*
 * Where this suite keeps its files.
 *
 * Several suites clear `data/` to start from a known state, which is correct
 * alone and destructive in parallel — they delete each other's fixtures. The
 * runner gives each suite its own directory through APIM_DATA_ROOT, and the
 * app reads the same variable, so the code under test and the test agree.
 */
const DATA_ROOT = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.join(ROOT, "data");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const T = await load("src/lib/search-types.ts");
const C = await load("src/lib/search-cache.ts");
const U = await load("src/lib/search-usage.ts");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0,
  fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

await rm(path.join(DATA_ROOT, "search-cache"), { recursive: true, force: true });
await rm(path.join(DATA_ROOT, "search-usage.json"), { force: true });

console.log("\napiM search budget checks\n");

// ---------------------------------------------------------------- profiles

console.log("1. Profiles");

const quality = T.profileSettings("quality");
const balanced = T.profileSettings("balanced");
const cheap = T.profileSettings("cheap");

check(
  "quality keeps the original behaviour — advanced everywhere",
  quality.firstRoundDepth === "advanced" && quality.followUpDepth === "advanced"
);
check(
  "quality keeps the original 4 opening queries",
  quality.firstRoundQueries === 4
);
check(
  "balanced opens shallow but escalates when the judge asks",
  balanced.firstRoundDepth === "basic" && balanced.followUpDepth === "advanced"
);
check(
  "cheap never escalates",
  cheap.firstRoundDepth === "basic" && cheap.followUpDepth === "basic"
);
check(
  "every profile asks for the full 10 results the base price includes",
  [quality, balanced, cheap].every((p) => p.resultsPerQuery === 10),
  "5 paid the 10-result price for half the sources"
);
check(
  "cheaper profiles fire fewer opening queries",
  quality.firstRoundQueries > balanced.firstRoundQueries &&
    balanced.firstRoundQueries > cheap.firstRoundQueries
);
check(
  "an unknown profile name falls back rather than crashing",
  T.profileSettings("nonsense").firstRoundQueries === balanced.firstRoundQueries
);
check(
  "an omitted profile name falls back too",
  T.profileSettings(undefined).firstRoundQueries === balanced.firstRoundQueries
);

// Cost model: what each profile bills for a question that settles in one
// round, and one that needs a follow-up. Tavily doubles advanced.
const bill = (p, rounds) => {
  let credits = p.firstRoundQueries * (p.firstRoundDepth === "advanced" ? 2 : 1);
  for (let i = 1; i < rounds; i++) {
    credits += p.followUpQueries * (p.followUpDepth === "advanced" ? 2 : 1);
  }
  return credits;
};

check(
  "an easy question costs less on balanced than on quality",
  bill(balanced, 1) < bill(quality, 1),
  `${bill(balanced, 1)} vs ${bill(quality, 1)} credits`
);
check(
  "a hard question still costs less on balanced",
  bill(balanced, 2) < bill(quality, 2),
  `${bill(balanced, 2)} vs ${bill(quality, 2)} credits`
);
check(
  "balanced still pays for depth on the follow-up round",
  bill(balanced, 2) - bill(balanced, 1) === balanced.followUpQueries * 2,
  "the round that found a gap gets the deep read"
);

// ------------------------------------------------------------------- cache

console.log("\n2. Cache");

const key = { query: "how to sort a list", provider: "tavily", depth: "basic", maxResults: 10 };
const sample = [
  { title: "Sorting", url: "https://docs.python.org/x", content: "sorted()", score: 0.9, domain: "docs.python.org" },
];

check("a miss returns null rather than throwing", (await C.readCache(key)) === null);

await C.writeCache(key, sample);
const hit = await C.readCache(key);
check("a stored result comes back", Array.isArray(hit) && hit.length === 1);
check(
  "the cached result is byte-identical to what was stored",
  JSON.stringify(hit) === JSON.stringify(sample),
  "a cache that alters results would quietly change answers"
);

check(
  "a different query does not collide",
  (await C.readCache({ ...key, query: "something else" })) === null
);
check(
  "the same words at a different depth are a different request",
  (await C.readCache({ ...key, depth: "advanced" })) === null,
  "advanced returns fuller pages — reusing basic would downgrade it"
);
check(
  "the same words to a different provider are a different request",
  (await C.readCache({ ...key, provider: "exa" })) === null
);
check(
  "whitespace and case do not create a second entry",
  JSON.stringify(await C.readCache({ ...key, query: "  HOW TO   Sort a List " })) ===
    JSON.stringify(sample)
);

await C.writeCache({ ...key, query: "empty results" }, []);
check(
  "an empty result is not cached",
  (await C.readCache({ ...key, query: "empty results" })) === null,
  "usually a transient failure — caching it would lock it in for a day"
);

const stats = await C.cacheStats();
check("cache stats report the entries", stats.entries >= 1);

await C.clearCache();
check("clearing empties the cache", (await C.readCache(key)) === null);

// ------------------------------------------------------------------- meter

console.log("\n3. Usage meter");

await U.resetUsage();
let summary = await U.usageSummary();
check("a fresh month starts at zero", summary.totalRequests === 0 && summary.totalUsd === 0);
check("every known provider is listed", summary.providers.length === Object.keys(U.PROVIDERS).length);

await U.recordQuestion();
await U.recordRequest("tavily", "basic");
await U.recordRequest("tavily", "basic");
summary = await U.usageSummary();
check("basic requests count one each", summary.totalRequests === 2);

await U.recordRequest("tavily", "advanced");
summary = await U.usageSummary();
check(
  "an advanced request bills double on Tavily",
  summary.totalRequests === 4,
  "2 basic + 1 advanced = 4 credits"
);

await U.recordRequest("exa", "advanced");
summary = await U.usageSummary();
const exa = summary.providers.find((p) => p.id === "exa");
check(
  "depth does not double on providers that have no such split",
  exa.requests === 1,
  "Exa has one search tier"
);

await U.recordCacheHit("tavily");
summary = await U.usageSummary();
check("a cache hit is counted but not billed", summary.totalCached === 1);
const tav = summary.providers.find((p) => p.id === "tavily");
check("a cache hit does not raise the bill", tav.requests === 4);

check(
  "requests per question is reported",
  summary.requestsPerQuestion === 5,
  "5 billed across 1 question"
);
check(
  "the cache hit rate is reported",
  Math.abs(summary.cacheHitRate - 1 / 6) < 1e-9
);
check("remaining free allowance is reported", tav.remainingUsd < tav.freeMonthlyUsd);
check("remaining is expressed in requests too", tav.remainingRequests > 0);
check("a provider with free allowance left is not exhausted", tav.exhausted === false);
check(
  "days until reset is a sane number",
  summary.daysUntilReset >= 0 && summary.daysUntilReset <= 31
);

// Exhaustion — the signal the failover pool will key off.
const info = U.PROVIDERS.linkup;
const toExhaust = Math.ceil(info.freeMonthlyUsd / info.costPerRequest) + 1;
for (let i = 0; i < toExhaust; i++) await U.recordRequest("linkup", "basic");
summary = await U.usageSummary();
const link = summary.providers.find((p) => p.id === "linkup");
check("a spent allowance reports exhausted", link.exhausted === true);
check("remaining never goes negative", link.remainingUsd === 0);

// Concurrency — one round fires several searches through Promise.all.
await U.resetUsage();
await Promise.all(Array.from({ length: 20 }, () => U.recordRequest("tavily", "basic")));
summary = await U.usageSummary();
check(
  "concurrent searches all get counted",
  summary.totalRequests === 20,
  "a naive read-modify-write loses all but the last"
);

await U.resetUsage();
await C.clearCache();

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

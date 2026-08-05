/**
 * Runs the real search engine against fake providers and counts the bill.
 *
 * Run:  npm run test:search
 *
 * The unit checks confirm each piece works; this confirms the whole path
 * does — that a profile really does cut requests, that a repeat question
 * costs nothing, and that the sources reaching the model are the same either
 * way. Both servers are local, so nothing is spent and nothing leaves the
 * machine.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { rm } from "node:fs/promises";

const ROOT = path.resolve(import.meta.dirname, "..");

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

// ------------------------------------------------------------ fake Tavily

/** Every request the engine actually sent, so the bill can be counted. */
const calls = [];

const tavily = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    calls.push({ query: parsed.query, depth: parsed.search_depth, max: parsed.max_results });

    // Return max_results distinct sources, so asking for more really does
    // yield more — that is the whole point of the 5 -> 10 change.
    const n = parsed.max_results ?? 5;
    const results = Array.from({ length: n }, (_, i) => ({
      title: `Result ${i} for ${parsed.query}`,
      url: `https://example${i}.com/${encodeURIComponent(parsed.query)}`,
      content: `Body text about ${parsed.query}. `.repeat(20),
      raw_content: `Full page about ${parsed.query}. `.repeat(60),
      score: 0.9 - i * 0.01,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results }));
  });
});

// ---------------------------------------------------------- fake DeepSeek

/** Flipped by each test to control how many rounds the engine runs. */
let sufficientAfterFirstRound = true;
let planCalls = 0;

const deepseek = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    const system = String(parsed.messages?.[0]?.content ?? "");
    let content;

    if (system.includes("Decide whether the search results contain")) {
      content = JSON.stringify({
        sufficient: sufficientAfterFirstRound,
        missing: sufficientAfterFirstRound ? "" : "the exact version number",
      });
      // Only withhold once, so the loop terminates.
      sufficientAfterFirstRound = true;
    } else {
      // A follow-up plan must produce *new* wording, or the engine's dedup
      // correctly discards it and no second round happens at all.
      const user = String(parsed.messages?.[1]?.content ?? "");
      const followUp = user.includes("Still missing");
      planCalls += 1;
      content = JSON.stringify({
        queries: followUp
          ? ["gap query one", "gap query two", "gap query three"]
          : ["alpha query", "beta query", "gamma query", "delta query"],
        intent: "test",
        type: "general",
      });
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

const listen = (server, port) =>
  new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

await listen(tavily, 8831);
await listen(deepseek, 8832);

process.env.TAVILY_BASE_URL = "http://127.0.0.1:8831";
process.env.DEEPSEEK_BASE_URL = "http://127.0.0.1:8832";

await rm(path.join(ROOT, "data", "search-cache"), { recursive: true, force: true });
await rm(path.join(ROOT, "data", "search-usage.json"), { force: true });

// Imported after the env vars are set — the module reads them at load time.
const S = await import(pathToFileURL(path.join(ROOT, "src/lib/smart-search.ts")).href);
const U = await import(pathToFileURL(path.join(ROOT, "src/lib/search-usage.ts")).href);
const C = await import(pathToFileURL(path.join(ROOT, "src/lib/search-cache.ts")).href);

/** Tavily bills advanced at double. */
const creditsOf = (list) =>
  list.reduce((n, c) => n + (c.depth === "advanced" ? 2 : 1), 0);

console.log("\napiM search engine — end to end against fake providers\n");

// ------------------------------------------------------- one easy question

console.log("1. An easy question, settled in one round");

calls.length = 0;
await C.clearCache();
const quality = await S.smartSearch("what is x", "", "k", "k", undefined, "quality");
const qualityCalls = [...calls];
const qualityCredits = creditsOf(qualityCalls);

calls.length = 0;
await C.clearCache();
const balanced = await S.smartSearch("what is x", "", "k", "k", undefined, "balanced");
const balancedCalls = [...calls];
const balancedCredits = creditsOf(balancedCalls);

check(
  "thorough fires the original four searches at full depth",
  qualityCalls.length === 4 && qualityCalls.every((c) => c.depth === "advanced")
);
check(
  "balanced fires three, skimming",
  balancedCalls.length === 3 && balancedCalls.every((c) => c.depth === "basic")
);
check(
  "balanced costs less than thorough",
  balancedCredits < qualityCredits,
  `${balancedCredits} vs ${qualityCredits} credits — ${Math.round(
    (1 - balancedCredits / qualityCredits) * 100
  )}% cheaper`
);
check(
  "both ask for the full ten results the base price covers",
  [...qualityCalls, ...balancedCalls].every((c) => c.max === 10)
);
check(
  "the model still receives a full set of sources",
  balanced.sourcesUsed === quality.sourcesUsed && balanced.sourcesUsed > 0,
  `${balanced.sourcesUsed} sources either way`
);
check(
  "the reported spend matches what was actually sent",
  Math.abs(balanced.estimatedUsd - balancedCredits * 0.008) < 1e-9
);

// ----------------------------------------------------- a harder question

console.log("\n2. A harder question, needing a second round");

calls.length = 0;
await C.clearCache();
sufficientAfterFirstRound = false;
const hard = await S.smartSearch("what is y", "", "k", "k", undefined, "balanced");
const hardCalls = [...calls];

check("a second round ran", hard.rounds === 2);
const firstRound = hardCalls.slice(0, 3);
const secondRound = hardCalls.slice(3);
check(
  "the opening round skimmed",
  firstRound.length === 3 && firstRound.every((c) => c.depth === "basic")
);
check(
  "the round chasing the gap reads full pages",
  secondRound.length > 0 && secondRound.every((c) => c.depth === "advanced"),
  "depth is spent where the judge said something was missing"
);

// ------------------------------------------------------------------ cache

console.log("\n3. Asking the same thing again");

calls.length = 0;
const repeat = await S.smartSearch("what is x", "", "k", "k", undefined, "balanced");

check(
  "a repeated question sends no requests at all",
  calls.length === 0,
  "answered entirely from cache"
);
check("the repeat is reported as free", repeat.estimatedUsd === 0);
check("the cache hits are counted", repeat.cacheHits === 3);
check(
  "the reused sources are identical to the paid ones",
  JSON.stringify(repeat.results.map((x) => x.url)) ===
    JSON.stringify(balanced.results.map((x) => x.url)),
  "a cache that changed results would quietly change answers"
);

// The escape hatch has to actually work.
calls.length = 0;
await S.smartSearch("what is x", "", "k", "k", undefined, "quality");
check(
  "switching back to thorough re-searches rather than reusing skimmed pages",
  calls.length > 0 && calls.every((c) => c.depth === "advanced")
);

// ------------------------------------------------------------ the meter

console.log("\n4. The meter");

const summary = await U.usageSummary();
check("questions were counted", summary.questions === 5);
check("billed requests were counted", summary.totalRequests > 0);
check("cache hits were counted separately", summary.totalCached === 3);
check(
  "searches per question is reported",
  summary.requestsPerQuestion > 0,
  `${summary.requestsPerQuestion.toFixed(1)} per question`
);
check(
  "free allowance remaining is reported",
  summary.providers.find((p) => p.id === "tavily").remainingRequests > 0
);

// ------------------------------------------------------------- the saving

console.log("\n5. What this saves over a working session");

// A realistic burst: 30 questions, a third of them repeats.
const perQuestionOld = 8; // 4 queries, advanced, as it was
const perQuestionNew = balancedCredits;
const questions = 30;
const repeats = 10;
const oldBill = questions * perQuestionOld;
const newBill = (questions - repeats) * perQuestionNew;

check(
  "a 30-question session costs meaningfully less",
  newBill < oldBill / 2,
  `${newBill} vs ${oldBill} credits — $${((oldBill - newBill) * 0.008).toFixed(2)} saved`
);
check(
  "a 1,000-credit free tier now covers far more questions",
  Math.floor(1000 / perQuestionNew) > 2 * Math.floor(1000 / perQuestionOld),
  `${Math.floor(1000 / perQuestionNew)} vs ${Math.floor(1000 / perQuestionOld)} questions`
);

await rm(path.join(ROOT, "data", "search-cache"), { recursive: true, force: true });
await rm(path.join(ROOT, "data", "search-usage.json"), { force: true });
tavily.close();
deepseek.close();

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

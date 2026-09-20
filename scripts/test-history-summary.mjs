/**
 * Rolling summary of older conversation turns.
 *
 * Run:  npm run test:history-summary
 *
 * History used to replay verbatim (last 20, uncapped): finished work rode
 * every request at full size. Now the newest 8 ride verbatim, everything
 * older rides as a stored summary a cheap helper keeps current, and turns
 * the helper has not covered yet stretch the window (max 20) so nothing is
 * ever silently missing.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
// Before the store loads: it reads the data root once at import.
process.env.APIM_DATA_ROOT = path.join(ROOT, ".test-data", "history-summary");

const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const read = (p) => readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const HS = await load("src/lib/history-summary.ts");
const store = await load("src/lib/store.ts");
const RS = await load("src/lib/request-size.ts");
const route = read("src/app/api/chat/route.ts");

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

const msg = (id, content, role = "user", extra = {}) => ({
  id,
  role,
  content,
  ...extra,
});
const msgs = (n, chars = 10) =>
  Array.from({ length: n }, (_, i) =>
    msg(`m${i}`, `TURN-${i} ` + "x".repeat(chars), i % 2 ? "assistant" : "user")
  );
const stored = (upToId, droppedTurns = 0) => ({
  text: "prior summary",
  upToId,
  droppedTurns,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

// --- split ---
check("short history rides fully verbatim with no backlog", (() => {
  const s = HS.shapeHistory(msgs(5), null);
  return s.verbatim.length === 5 && s.pending.length === 0;
})());
check("uncovered overflow stretches the window instead of dropping", (() => {
  const s = HS.shapeHistory(msgs(12), null);
  return (
    s.verbatim.length === 12 &&
    s.pending.length === 4 &&
    s.pending[0].id === "m0" &&
    s.pending[3].id === "m3"
  );
})());
check("a fresh cursor compacts to the newest 8", (() => {
  const s = HS.shapeHistory(msgs(12), stored("m3"));
  return (
    s.verbatim.length === 8 &&
    s.verbatim[0].id === "m4" &&
    s.pending.length === 0
  );
})());
check("a mid-backlog cursor pends only what follows it", (() => {
  const s = HS.shapeHistory(msgs(12), stored("m1"));
  return (
    s.pending.length === 2 &&
    s.pending[0].id === "m2" &&
    s.verbatim.length === 10
  );
})());
check("a stale cursor re-covers the whole overflow", (() => {
  const s = HS.shapeHistory(msgs(12), stored("deleted-id"));
  return s.pending.length === 4 && s.pending[0].id === "m0";
})());
check("the stretched window caps at the old last-20", (() => {
  const s = HS.shapeHistory(msgs(30), null);
  return s.verbatim.length === 20 && s.pending.length === 22;
})());

// --- trigger ---
check("empty backlog never refreshes", !HS.shouldRefreshHistorySummary([]));
check(
  "three small turns wait",
  !HS.shouldRefreshHistorySummary(msgs(3, 20))
);
check(
  "six small turns trigger on count",
  HS.shouldRefreshHistorySummary(msgs(6, 20))
);
check(
  "one 5k-char turn triggers on size",
  HS.shouldRefreshHistorySummary([msg("big", "x".repeat(5000))])
);

// --- digest ---
check("small backlogs digest whole with nothing dropped", (() => {
  const dg = HS.buildSummaryDigest(msgs(4, 50));
  return (
    dg.included === 4 &&
    dg.dropped === 0 &&
    dg.text.includes("TURN-0") &&
    dg.text.includes("TURN-3")
  );
})());
check("oversized backlogs keep the newest and count the dropped", (() => {
  const dg = HS.buildSummaryDigest(msgs(10, 9000));
  return (
    dg.dropped > 0 &&
    dg.included + dg.dropped === 10 &&
    dg.text.includes("TURN-9") &&
    !dg.text.includes("TURN-0")
  );
})());
check("a lone giant turn is truncated, never skipped", (() => {
  const dg = HS.buildSummaryDigest([msg("big", "y".repeat(90000))]);
  return (
    dg.included === 1 &&
    dg.dropped === 0 &&
    dg.text.length <= HS.SUMMARY_DIGEST_MAX_CHARS &&
    dg.text.includes("truncated")
  );
})());
check("digest marks attachments and mid-task notes", (() => {
  const dg = HS.buildSummaryDigest([
    msg("a", "see this", "user", {
      note: true,
      attachments: [
        { name: "err.png", kind: "image", description: "red stack trace" },
      ],
    }),
  ]);
  return (
    dg.text.includes("[mid-task note]") &&
    dg.text.includes('[image err.png: "red stack trace"]')
  );
})());

// --- runner (mocked fetch) ---
const realFetch = globalThis.fetch;
const seen = [];
globalThis.fetch = async (url, init) => {
  seen.push({ url, body: JSON.parse(init.body) });
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "s".repeat(5000) } }],
      usage: { prompt_tokens: 11, completion_tokens: 22 },
    }),
    { status: 200 }
  );
};
try {
  const out = await HS.runHistorySummary("OLD", msgs(2, 30), {
    apiKey: "k",
    baseUrl: "https://x.test/v1",
    model: "deepseek-v4-flash",
    thinkingStyle: "deepseek",
  });
  check(
    "runner asks the cheap model with thinking disabled",
    seen.length === 1 &&
      seen[0].body.model === "deepseek-v4-flash" &&
      seen[0].body.thinking?.type === "disabled" &&
      seen[0].body.max_tokens === 700
  );
  check(
    "runner prompt carries previous summary plus new turns",
    seen[0].body.messages[1].content.includes("OLD") &&
      seen[0].body.messages[1].content.includes("TURN-0") &&
      seen[0].body.messages[1].content.includes("TURN-1")
  );
  check(
    "runner caps stored text and reports usage",
    out.text.length === HS.SUMMARY_TEXT_MAX_CHARS &&
      out.droppedTurns === 0 &&
      out.usage.prompt_tokens === 11 &&
      out.usage.completion_tokens === 22
  );

  seen.length = 0;
  await HS.runHistorySummary(null, msgs(1, 10), {
    apiKey: "k",
    baseUrl: "https://x.test/v1",
    model: "free-model",
    thinkingStyle: "openai",
  });
  check(
    "non-deepseek helpers skip the thinking object",
    seen.length === 1 && !("thinking" in seen[0].body)
  );

  globalThis.fetch = async () => new Response("nope", { status: 500 });
  check(
    "a failed helper call returns null, never throws",
    (await HS.runHistorySummary(null, msgs(1, 10), {
      apiKey: "k",
      baseUrl: "https://x.test/v1",
      model: "m",
      thinkingStyle: "openai",
    })) === null
  );
  globalThis.fetch = async () => {
    throw new Error("down");
  };
  check(
    "a throwing helper call returns null, never throws",
    (await HS.runHistorySummary(null, msgs(1, 10), {
      apiKey: "k",
      baseUrl: "https://x.test/v1",
      model: "m",
      thinkingStyle: "openai",
    })) === null
  );
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("must not be called");
  };
  check(
    "empty backlog short-circuits before any fetch",
    (await HS.runHistorySummary("OLD", [], {
      apiKey: "k",
      baseUrl: "https://x.test/v1",
      model: "m",
      thinkingStyle: "openai",
    })) === null && !called
  );
} finally {
  globalThis.fetch = realFetch;
}

// --- render ---
check("rendered block opens with the marker", (() => {
  const t = HS.renderHistorySummary(stored("m3"));
  return t.startsWith(HS.HISTORY_SUMMARY_MARKER) && t.includes("prior summary");
})());
check("rendered block stays honest about dropped turns", (() => {
  const t = HS.renderHistorySummary(stored("m3", 4));
  return t.includes("4 oldest turns") && t.includes("not in context");
})());

// --- persist (isolated data root) ---
const convId = `hssum-${Date.now()}`;
await store.appendMessages(convId, "summary test", [
  { id: "m0", role: "user", content: "hi", createdAt: new Date().toISOString() },
]);
const first = {
  text: "v1",
  upToId: "m0",
  droppedTurns: 0,
  updatedAt: new Date().toISOString(),
};
check(
  "first summary persists against an empty cursor",
  (await store.saveHistorySummary(convId, null, first)) === true
);
check(
  "stored summary reads back on the conversation",
  (await store.getConversation(convId))?.historySummary?.text === "v1"
);
check(
  "a stale cursor loses the write and keeps the winner",
  (await store.saveHistorySummary(convId, null, {
    ...first,
    text: "loser",
  })) === false &&
    (await store.getConversation(convId))?.historySummary?.text === "v1"
);
check(
  "missing conversations fail closed",
  (await store.saveHistorySummary("nope-missing", null, first)) === false
);

// --- request-size bucket ---
check("summary content gets its own size bucket", (() => {
  const parts = RS.breakdownRequestMessages(
    [{ role: "system", content: `${HS.HISTORY_SUMMARY_MARKER}\nabc` }],
    0
  );
  return parts.some((p) => p.label === "summary" && p.chars > 0);
})());

// --- route wiring ---
check(
  "route builds history through the summary splitter",
  route.includes("loadHistoryForRequest(convId")
);
check(
  "route gates the refresh on the trigger and a cheap helper",
  /shouldRefreshHistorySummary\(full\.pending\) &&\s*helper/.test(route)
);
check(
  "route persists the refreshed cursor",
  route.includes("saveHistorySummary(")
);
check(
  "summary injects ahead of the verbatim window",
  route.indexOf("content: historySummaryText") <
    route.indexOf("for (const msg of scopedHistory)")
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

/**
 * Checks retry-on-transient-failure and transcript pruning.
 *
 * Run:  npm run test:resilience
 *
 * These are the two changes most able to break things silently. A retry that
 * fires on a rejected key wastes the user's time; a prune that drops a tool
 * reply produces a 400 from DeepSeek that looks like a model bug. Both are
 * asserted directly.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { finishSuite } from "./lib/proc.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const R = await load("src/lib/retry.ts");
const P = await load("src/lib/prune.ts");

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

console.log("\napiM resilience checks\n");

// ------------------------------------------------------------ classifiers

console.log("1. What counts as worth retrying");

check("a 429 retries", R.isRetryableStatus(429));
check("a 500 retries", R.isRetryableStatus(500));
check("a 503 retries", R.isRetryableStatus(503));
check(
  "a 401 does not — a rejected key fails the same way every time",
  !R.isRetryableStatus(401)
);
check(
  "a 402 does not — an empty balance will not refill on retry",
  !R.isRetryableStatus(402)
);
check("a 400 does not — a malformed request stays malformed", !R.isRetryableStatus(400));

check(
  "a dropped connection is transient",
  R.isTransientNetworkError(Object.assign(new Error("socket hang up"), { name: "TypeError" }))
);
check(
  "a timeout is transient",
  R.isTransientNetworkError(Object.assign(new Error("t"), { name: "TimeoutError" }))
);
check(
  "pressing Stop is not a failure to retry",
  !R.isTransientNetworkError(Object.assign(new Error("x"), { name: "AbortError" }))
);

// ------------------------------------------------------------ live server

console.log("\n2. Retrying against a real server");

let hits = 0;
let failuresToServe = 0;
let serveStatus = 500;

const server = createServer((req, res) => {
  hits += 1;
  if (failuresToServe > 0) {
    failuresToServe -= 1;
    if (serveStatus === 429) res.setHeader("retry-after", "0");
    res.writeHead(serveStatus, { "Content-Type": "text/plain" });
    res.end("nope");
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});

await new Promise((resolve) => server.listen(8841, "127.0.0.1", resolve));
const URL_ = "http://127.0.0.1:8841";
const fast = { baseDelayMs: 5, maxDelayMs: 10 };

hits = 0;
failuresToServe = 0;
let out = await R.fetchWithRetry(() => fetch(URL_), fast);
check("a healthy request is sent once", hits === 1 && out.response?.ok);

hits = 0;
failuresToServe = 2;
serveStatus = 503;
out = await R.fetchWithRetry(() => fetch(URL_), fast);
check(
  "two transient failures then success recovers",
  out.response?.ok === true && hits === 3,
  `${hits} attempts`
);

hits = 0;
failuresToServe = 99;
serveStatus = 500;
out = await R.fetchWithRetry(() => fetch(URL_), fast);
check(
  "a permanently failing server gives up after the attempt limit",
  hits === 3 && out.response?.status === 500,
  "and hands back the real response, not a generic error"
);

hits = 0;
failuresToServe = 99;
serveStatus = 401;
out = await R.fetchWithRetry(() => fetch(URL_), fast);
check(
  "a rejected key is not retried",
  hits === 1 && out.response?.status === 401,
  "retrying would only delay an error the user needs to see"
);

hits = 0;
failuresToServe = 1;
serveStatus = 429;
const notices = [];
out = await R.fetchWithRetry(() => fetch(URL_), {
  ...fast,
  onRetry: (i) => notices.push(i),
});
check("a rate limit retries and recovers", out.response?.ok === true);
check("the retry is reported so the UI can show it", notices.length === 1);
check(
  "the reason is human-readable",
  notices[0]?.reason === "rate limited",
  notices[0]?.reason
);

// Stop must win immediately, not after the backoff.
hits = 0;
failuresToServe = 99;
serveStatus = 500;
const ac = new AbortController();
const started = Date.now();
const pending = R.fetchWithRetry(() => fetch(URL_), {
  baseDelayMs: 5_000,
  maxDelayMs: 5_000,
  signal: ac.signal,
});
setTimeout(() => ac.abort(), 30);
out = await pending;
check(
  "pressing Stop during a backoff returns at once",
  Date.now() - started < 1_000,
  `${Date.now() - started}ms, not the 5s backoff`
);
check("the abort is reported as an abort", out.error?.name === "AbortError");

server.close();

// ---------------------------------------------------------------- pruning

console.log("\n3. Pruning a long transcript");

/*
 * The pruner is round-aware, not count-based. The most recent N assistant
 * rounds that called tools keep ALL of their tool results verbatim (however
 * large), because the model is actively reasoning over them. Older results
 * are collapsed only when they are big enough to be worth it; small
 * confirmations and short reads stay.
 */
const bigOutput = (n) => `line one of output\n${"x".repeat(n)}`;

function buildTranscript(rounds, size = 1500) {
  const msgs = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Please refactor the project." },
  ];
  for (let i = 0; i < rounds; i++) {
    msgs.push({
      role: "assistant",
      content: null,
      reasoning_content: `Thinking about step ${i}`,
      tool_calls: [
        {
          id: `call_${i}`,
          type: "function",
          function: { name: "read_file", arguments: `{"path":"f${i}.py"}` },
        },
      ],
    });
    msgs.push({ role: "tool", tool_call_id: `call_${i}`, content: bigOutput(size) });
  }
  return msgs;
}

const short = buildTranscript(2);
let res = P.pruneTranscript(short);
check(
  "a short conversation is left completely alone",
  res.stats.collapsed === 0 && res.messages === short,
  "pruning it would save nothing and risk dropping context"
);

/*
 * Reading a whole project must survive intact.
 *
 * Forty reads of an ordinary source file are a few thousand characters each,
 * which is below MIN_COLLAPSE_CHARS, and the whole transcript is below the
 * size threshold — so nothing is collapsed. The model can describe all forty
 * files rather than the handful a cap would leave.
 */
const wholeProject = buildTranscript(40);
const untouched = P.pruneTranscript(wholeProject);
check(
  "reading forty ordinary files keeps every one of them",
  untouched.stats.collapsed === 0,
  `${untouched.stats.collapsed} collapsed — the agent can describe all 40`
);

/*
 * The active window is whole files, however big.
 *
 * This is the point of the round-aware design: read_file returns the whole
 * file, and the rounds the model is currently working with keep that content
 * verbatim. Even transcripts far over the threshold must not collapse the
 * last KEEP_VERBATIM_ROUNDS rounds.
 */
const keepRounds = P.KEEP_VERBATIM_ROUNDS;
const active = buildTranscript(keepRounds + 20, 30_000);
res = P.pruneTranscript(active);
const activeResults = res.messages.filter((m) => m.role === "tool");
const lastRoundIds = new Set(
  active
    .filter(
      (m, i) =>
        m.role === "assistant" &&
        i >= active.length - keepRounds * 2 - 1 &&
        m.tool_calls
    )
    .flatMap((m) => m.tool_calls.map((c) => c.id))
);
check(
  "the most recent rounds' results stay verbatim however large",
  activeResults
    .filter((m) => lastRoundIds.has(m.tool_call_id))
    .every((m) => m.content.length > 20_000),
  "cutting an active read forces a wasteful re-read"
);
check(
  "older large results collapse",
  res.stats.collapsed > 0,
  `${res.stats.collapsed} collapsed`
);

// The three invariants that would otherwise produce a 400.
check(
  "every tool call still has a matching reply",
  P.toolCallsAreBalanced(res.messages),
  "an orphaned call is a 400 from DeepSeek"
);
check(
  "the message count is unchanged — nothing was dropped",
  res.messages.length === active.length
);
check("the system prompt is untouched", res.messages[0].content === active[0].content);
check("the user's question is untouched", res.messages[1].content === active[1].content);
check(
  "reasoning_content survives verbatim on tool-calling turns",
  res.messages
    .filter((m) => m.role === "assistant")
    .every((m, i) => m.reasoning_content === `Thinking about step ${i}`),
  "omitting it is a 400 once tools are in play"
);
check(
  "tool_call_ids are preserved on collapsed replies",
  res.messages
    .filter((m) => m.role === "tool")
    .every((m, i) => m.tool_call_id === `call_${i}`)
);

const collapsedOne = res.messages.find(
  (m) => m.role === "tool" && m.content.startsWith("[earlier")
);
check(
  "a placeholder names the tool it replaced",
  collapsedOne.content.includes("read_file")
);
check(
  "a placeholder keeps the first line, usually the useful part",
  collapsedOne.content.includes("line one of output")
);
check(
  "a placeholder tells the model how to get the rest",
  collapsedOne.content.includes("Call the tool again")
);
check(
  "the input array is not modified",
  active.filter((m) => m.role === "tool").every((m) => m.content.length > 20_000),
  "the stored transcript must keep everything"
);

const before = P.transcriptChars(active);
const after = P.transcriptChars(res.messages);
check(
  "the saving is real",
  after < before,
  `${before.toLocaleString()} -> ${after.toLocaleString()} chars`
);
check(
  "the reported saving matches reality",
  Math.abs(res.stats.charsSaved - (before - after)) < 2
);

// Small results are not worth a placeholder even when old.
const tiny = buildTranscript(60).map((m) =>
  m.role === "tool" ? { ...m, content: "ok" } : m
);
tiny.push({ role: "user", content: "x".repeat(P.PRUNE_THRESHOLD_CHARS + 10) });
res = P.pruneTranscript(tiny);
check(
  "results smaller than MIN_COLLAPSE_CHARS are left alone",
  res.stats.collapsed === 0,
  "the placeholder would be longer than the content"
);

// Multiple calls in one round all keep their replies.
const parallel = [
  { role: "system", content: "s" },
  { role: "user", content: "u" },
];
// Enough rounds to clear the threshold and leave older results to collapse.
const parallelRounds = P.KEEP_VERBATIM_ROUNDS + 30;
for (let i = 0; i < parallelRounds; i++) {
  parallel.push({
    role: "assistant",
    content: null,
    reasoning_content: "r",
    tool_calls: [
      { id: `a_${i}`, type: "function", function: { name: "read_file", arguments: "{}" } },
      { id: `b_${i}`, type: "function", function: { name: "list_files", arguments: "{}" } },
    ],
  });
  parallel.push({ role: "tool", tool_call_id: `a_${i}`, content: bigOutput(20_000) });
  parallel.push({ role: "tool", tool_call_id: `b_${i}`, content: bigOutput(20_000) });
}
res = P.pruneTranscript(parallel);
check(
  "parallel tool calls in one round stay balanced after pruning",
  P.toolCallsAreBalanced(res.messages),
  `${parallelRounds * 2} calls across ${parallelRounds} rounds`
);
check("parallel calls still got pruned", res.stats.collapsed > 0);

// force:true collapses eligible old results without waiting for the size
// gate. Need more rounds than the recent-results window so there is something
// old enough to collapse.
const forced = buildTranscript(
  P.KEEP_VERBATIM_ROUNDS + P.KEEP_RECENT_RESULTS + 5,
  5_000
);
const fres = P.pruneTranscript(forced, { force: true });
check(
  "force prunes even below the threshold",
  fres.stats.collapsed > 0,
  `${fres.stats.collapsed} collapsed — used to recover from a context-length rejection`
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
await finishSuite(fail);

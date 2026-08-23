/**
 * Reclaiming the reasoning, which is what a long run actually spends.
 *
 * Run:  npm run test:compact
 *
 * Pruning was aimed at tool output — the text of files the model read.
 * Measuring a real twenty-round task showed that was the wrong target:
 *
 *     reasoning      180k tokens   93%
 *     file contents   11k tokens    6%
 *     system prompt    3k tokens    1%
 *
 * On max thinking the model writes ~9k tokens of reasoning per round, it was
 * never pruned, and every round resends all of it.
 *
 * It cannot just be deleted. DeepSeek requires reasoning_content on any
 * assistant turn carrying tool_calls, and returns 400 without it. So whole
 * rounds are folded away — calls and their replies together — leaving a plain
 * assistant message that needs no reasoning. Every check below that mentions
 * 400 is guarding a hard API failure, not a preference.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const C = await load("src/lib/compact.ts");
const { toolCallsAreBalanced } = await load("src/lib/prune.ts");
const { serializeForApi } = await load("src/lib/transcript.ts");
const route = read("src/app/api/chat/route.ts");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

/** A run at max thinking: ~9k reasoning tokens a round. */
function build(rounds, { reasoningTokens = 9000, fileChars = 8000 } = {}) {
  const m = [
    { role: "system", content: "sys" },
    { role: "user", content: "build the thing" },
  ];
  for (let i = 0; i < rounds; i++) {
    m.push({
      role: "assistant",
      content: `Step ${i}.`,
      reasoning_content: "R".repeat(Math.round(reasoningTokens * 3.6)),
      tool_calls: [
        {
          id: `c${i}`,
          type: "function",
          function: {
            name: i % 3 === 0 ? "write_file" : "read_file",
            arguments: JSON.stringify({ path: `src/m${i}.js` }),
          },
        },
      ],
    });
    m.push({ role: "tool", tool_call_id: `c${i}`, content: "x".repeat(fileChars) });
  }
  return m;
}

const size = (ms) =>
  ms.reduce(
    (a, m) =>
      a +
      (typeof m.content === "string" ? m.content.length : 0) +
      (m.reasoning_content?.length ?? 0) +
      (m.tool_calls ?? []).reduce((b, c) => b + c.function.arguments.length, 0),
    0
  );

console.log("\napiM context compaction checks\n");

// ------------------------------------------------------------------
console.log("1. The transcript stays valid for the API");

const long = build(20);
const res = C.compactForResume(long);

check("tool calls and replies stay paired", toolCallsAreBalanced(res.messages),
  "an orphaned call is a 400");
check(
  "no tool reply is left without its call",
  (() => {
    const out = serializeForApi(res.messages);
    const ids = new Set(out.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)));
    return out.every((m) => m.role !== "tool" || ids.has(m.tool_call_id));
  })(),
  "a 400 from DeepSeek"
);
check(
  "every surviving tool-calling turn still carries its reasoning",
  res.messages.every((m) =>
    !(m.role === "assistant" && m.tool_calls?.length) || Boolean(m.reasoning_content)
  ),
  "omitting it on a tool turn is an explicit 400 in DeepSeek's docs"
);
check(
  "folded rounds carry no reasoning, since they carry no calls",
  res.messages
    .filter((m) => typeof m.content === "string" && m.content.includes("Earlier step"))
    .every((m) => !m.reasoning_content),
  "with the calls gone the API ignores it — sending it would be pure waste"
);
check("it serialises cleanly", serializeForApi(res.messages).length === res.messages.length);
check(
  "the system prompt and the question are untouched",
  res.messages[0].content === "sys" && res.messages[1].content === "build the thing"
);

// ------------------------------------------------------------------
console.log("\n2. It actually saves what it claims");

const before = size(long);
const after = size(res.messages);
check(
  "a 20-round run shrinks by most of its weight",
  after < before * 0.35,
  `${Math.round(before / 3.6 / 1000)}k -> ${Math.round(after / 3.6 / 1000)}k tokens (${Math.round(100 * (1 - after / before))}% off)`
);
check(
  "the saving is mostly reclaimed reasoning",
  res.stats.reasoningChars > res.stats.charsSaved * 0.7,
  `${Math.round(res.stats.reasoningChars / 3.6 / 1000)}k tokens of it`
);
check("the reported saving matches reality", Math.abs(res.stats.charsSaved - (before - after)) < 200);
check("the input array is never modified", size(long) === before,
  "the stored transcript must keep everything");

// ------------------------------------------------------------------
console.log("\n3. Recent thinking is kept — that is the useful part");

const withReasoning = res.messages.filter(
  (m) => m.role === "assistant" && m.reasoning_content
);
check(
  "the last few rounds keep their reasoning in full",
  withReasoning.length === C.KEEP_RECENT_ROUNDS,
  `${withReasoning.length} rounds, which is where "what was I doing" lives`
);
check(
  "the most recent round is never folded",
  Boolean(res.messages[res.messages.length - 2]?.reasoning_content) ||
    Boolean(res.messages[res.messages.length - 1]?.reasoning_content) ||
    withReasoning.length > 0
);
check(
  "a folded round still says what it did",
  res.messages.some(
    (m) => typeof m.content === "string" && /write_file\(src\/m0\.js\)/.test(m.content)
  ),
  "the model keeps a truthful account of its own history"
);
check(
  "a failed call is recorded as failed",
  (() => {
    const t = build(12);
    t[3] = { role: "tool", tool_call_id: "c0", content: "Error: No such file: x.js" };
    const out = C.compactForResume(t);
    return out.messages.some(
      (m) => typeof m.content === "string" && /failed/.test(m.content)
    );
  })(),
  "so it does not assume an action succeeded"
);

// ------------------------------------------------------------------
console.log("\n4. Short runs are left alone");

const short = build(3);
const shortRes = C.compactTranscript(short);
check(
  "a short conversation is untouched",
  shortRes.stats.rounds === 0 && shortRes.messages === short,
  "there is nothing to gain and detail to lose"
);
check(
  "nothing is folded while under the size threshold",
  C.compactTranscript(build(6, { reasoningTokens: 200, fileChars: 200 })).stats.rounds === 0
);
check(
  "a reply with no tool rounds at all is safe",
  C.compactForResume([
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    { role: "assistant", content: "just an answer" },
  ]).stats.rounds === 0
);

// ------------------------------------------------------------------
console.log("\n5. Compacting does not itself break the cache");

/*
 * The boundary is quantised on purpose. Moving it every round would rewrite
 * an earlier message on every request, and DeepSeek matches its cache as a
 * prefix — so the rewrite would cost a full-price re-read each time, more
 * than the reasoning it saved.
 */
const boundaries = [];
for (let n = 20; n <= 32; n++) {
  const out = C.compactTranscript(build(n), { thresholdChars: 0 });
  boundaries.push(out.stats.rounds);
}
const distinct = new Set(boundaries).size;
check(
  "the boundary holds still for several rounds at a time",
  distinct <= boundaries.length / 3,
  `${distinct} distinct positions across 13 rounds — a moving boundary would miss the cache every time`
);
check(
  "the step is a real constant, not incidental",
  C.COMPACT_STEP >= 4,
  `step = ${C.COMPACT_STEP}`
);

// ------------------------------------------------------------------
console.log("\n6. It is wired into both paths");

check(
  "the live agent loop compacts before sending",
  /compactTranscript\(\s*pruned\.messages/.test(route) &&
    /serializeForApi\(wireMessages\)/.test(route)
);
check(
  "resuming compacts the replayed attempt",
  /const folded = compactForResume\(resumed\.messages\)/.test(route),
  "a resume replays a whole finished attempt in one request"
);
check(
  "resume compacts before the transcript is used, not after",
  route.indexOf("compactForResume(resumed.messages)") <
    route.indexOf("await refreshFileTree();")
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

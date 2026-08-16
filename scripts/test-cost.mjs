/**
 * The things that decide what a reply costs.
 *
 * Run:  npm run test:cost
 *
 * Two mechanisms are checked here, both of which were found by measuring
 * rather than reading (`npm run cost:lab`):
 *
 *   1. Tree deltas. DeepSeek's cache matches a prefix, so the workspace
 *      listing must be APPENDED to, never moved or rewritten. Getting this
 *      wrong is invisible — nothing breaks, it just costs a third more.
 *
 *   2. The spending limit. It has to stop between rounds, leave the run
 *      resumable, and never fire when no cap was set.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const tree = await load("src/lib/tree-delta.ts");
const budget = await load("src/lib/budget.ts");
const compact = await load("src/lib/compact.ts");
const pricing = await load("src/lib/pricing.ts");

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

console.log("\napiM cost-control checks\n");

// ---------------------------------------------------------------------------
console.log("1. The workspace listing is appended to, not rewritten");

const t = new tree.TreeTracker();
const first = t.update([
  { path: "a.ts", size: 100 },
  { path: "b.ts", size: 200 },
]);
check("the first listing is a full baseline", first.kind === "baseline");

const same = t.update([
  { path: "a.ts", size: 100 },
  { path: "b.ts", size: 200 },
]);
check(
  "an unchanged workspace produces nothing at all",
  same.kind === "none" && same.text === "",
  "re-sending an identical tree would break the cache for no gain"
);

const added = t.update([
  { path: "a.ts", size: 100 },
  { path: "b.ts", size: 200 },
  { path: "c.ts", size: 50 },
]);
check("a new file becomes a small delta", added.kind === "delta");
check("the delta names the new file", added.text.includes("c.ts"));
check("the delta marks it as added", /\+ c\.ts/.test(added.text));
check(
  "the delta is tiny next to a full listing",
  added.text.length < 120,
  `${added.text.length} chars`
);

const modified = t.update([
  { path: "a.ts", size: 999 },
  { path: "b.ts", size: 200 },
  { path: "c.ts", size: 50 },
]);
check("a changed size is reported as modified", /~ a\.ts/.test(modified.text));

const removed = t.update([
  { path: "a.ts", size: 999 },
  { path: "c.ts", size: 50 },
]);
check("a deleted file is reported as removed", /- b\.ts/.test(removed.text));
check(
  "a removal carries no size",
  !/- b\.ts\s+\(/.test(removed.text),
  "there is no size to report for a file that is gone"
);

// Deltas must be deterministic or two identical states serialise differently
// and miss the cache for no reason.
const a1 = tree.diffTrees(
  [{ path: "x", size: 1 }],
  [
    { path: "z", size: 1 },
    { path: "y", size: 1 },
    { path: "x", size: 1 },
  ]
);
const a2 = tree.diffTrees(
  [{ path: "x", size: 1 }],
  [
    { path: "y", size: 1 },
    { path: "z", size: 1 },
    { path: "x", size: 1 },
  ]
);
check(
  "the same change always serialises identically",
  JSON.stringify(a1) === JSON.stringify(a2),
  "input order must not leak into the request"
);

console.log("\n2. Deltas do not pile up forever");

const t2 = new tree.TreeTracker();
t2.update([{ path: "base.ts", size: 1 }]);
let sawBaseline = false;
for (let i = 0; i < 60; i++) {
  const files = [{ path: "base.ts", size: 1 }];
  for (let j = 0; j <= i; j++) files.push({ path: `f${j}.ts`, size: 10 });
  const step = t2.update(files);
  if (step.kind === "baseline") sawBaseline = true;
}
check(
  "a long run eventually re-baselines",
  sawBaseline,
  "a hundred diffs are bigger and harder to read than one listing"
);

const t3 = new tree.TreeTracker();
t3.update([]);
const bulk = [];
for (let i = 0; i < 500; i++) bulk.push({ path: `unzipped/file${i}.ts`, size: 100 });
const bulkStep = t3.update(bulk);
check(
  "unpacking hundreds of files re-baselines instead of listing them twice",
  bulkStep.kind === "baseline",
  "500 files at once — the delta would BE the tree"
);

console.log("\n3. Compaction stays a safety valve, not an economy measure");

/*
 * Compaction rewrites a prefix, which forces a full-price re-read of
 * everything after the edit point. The tokens it removes were cached at a
 * discount, so folding them only pays for itself if the run is long enough
 * for the future savings to exceed the one miss.
 *
 * Before 2026-08-16 the miss/hit ratio was ~120x and break-even was ~120
 * rounds — far past the 40-round cap — so compaction never paid for itself
 * and the threshold was a 1.8M-char context-window safety valve. DeepSeek's
 * new pricing dropped the ratio to ~30x, so break-even is now ~30 rounds;
 * compaction can repay itself on a very long task, but below ~250k tokens it
 * is still pure cost. The threshold therefore sits in the conservative band:
 * high enough that ordinary tasks never rewrite the prefix, low enough that
 * it fires before the model's context window is exhausted.
 */
// Dollars per token, V4 Pro off-peak after the 2026-08-16 pricing change.
const MISS = 0.66 / 1_000_000;
const HIT = 0.022 / 1_000_000;
const promptTokens = 100_000;
const removedFraction = 0.5;
const rewriteCost = promptTokens * (1 - removedFraction) * MISS;
const savingPerRound = promptTokens * removedFraction * HIT;
const breakEvenRounds = rewriteCost / savingPerRound;

check(
  "at the new ~30x ratio a long task can still break even",
  breakEvenRounds <= 40,
  `break-even is ${Math.round(breakEvenRounds)} rounds; the loop caps at 40`
);
check(
  "the threshold is above an ordinary multi-file task",
  compact.COMPACT_THRESHOLD_CHARS >= 600_000,
  `${compact.COMPACT_THRESHOLD_CHARS.toLocaleString()} chars`
);
check(
  "and it fires well before the 1M-token window is exhausted",
  compact.COMPACT_THRESHOLD_CHARS / 3.6 < 400_000,
  `~${Math.round(compact.COMPACT_THRESHOLD_CHARS / 3.6 / 1000)}k tokens, against a 1M window`
);

const shortRun = [
  { role: "system", content: "x" },
  { role: "user", content: "y" },
];
check(
  "a short conversation is still untouched",
  compact.compactTranscript(shortRun).stats.rounds === 0
);

console.log("\n4. The spending limit");

check("no cap means no cap", budget.createBudget(null).limitUsd === null);
check(
  "a zero cap is treated as no cap, not as stop-immediately",
  budget.createBudget(0).limitUsd === null,
  "nobody means 'spend nothing' by typing 0"
);
check(
  "a negative cap cannot lock the app",
  budget.createBudget(-5).limitUsd === null
);

const b = budget.createBudget(1);
check("nothing spent yet, so it continues", budget.checkBudget(b, 0).action === "continue");

// A round costing $0.10: 20k miss tokens + 100k output on Pro.
const roundUsage = {
  prompt_tokens: 20_000,
  completion_tokens: 100_000,
  prompt_cache_hit_tokens: 0,
  prompt_cache_miss_tokens: 20_000,
};
const cost = budget.chargeRound(b, roundUsage, "deepseek-v4-pro");
check(
  "a round is charged at the real cache-split rate",
  Math.abs(cost - (pricing.estimateCost(roundUsage, "deepseek-v4-pro") ?? 0)) < 1e-12,
  `$${cost.toFixed(4)}`
);
check("it does not stop while well under", budget.checkBudget(b, cost).action === "continue");

// Push to 80%.
const b2 = budget.createBudget(1);
b2.spentUsd = 0.81;
const warned = budget.checkBudget(b2, 0.01);
check("it warns at 80% before stopping", warned.action === "warn", "$0.81 of $1.00");
check(
  "it only warns once",
  budget.checkBudget(b2, 0.01).action === "continue",
  "repeating it every round would be noise"
);

const b3 = budget.createBudget(1);
b3.spentUsd = 1.2;
check("it stops once the cap is passed", budget.checkBudget(b3, 0).action === "stop");

// The predictive case: still under, but one more round would go over.
const b4 = budget.createBudget(1);
b4.spentUsd = 0.9;
const predicted = budget.checkBudget(b4, 0.3);
check(
  "it stops before a round that would overshoot",
  predicted.action === "stop",
  "$0.90 spent, next round ~$0.30, cap $1.00 — checking afterwards is too late"
);
check(
  "and says why in plain language",
  predicted.action === "stop" && /remaining budget/.test(predicted.reason),
  predicted.action === "stop" ? predicted.reason : ""
);

const msg = budget.budgetStopMessage(0.512, 0.5, true);
check("the stop message states both numbers", msg.includes("$0.5120") && msg.includes("$0.50"));
check("it says the work was kept", /saved/i.test(msg));
check("it points at Resume", /resume/i.test(msg));
check("it says how to lift the limit", /settings/i.test(msg));

const noResume = budget.budgetStopMessage(0.512, 0.5, false);
check(
  "it does not offer Resume when there is nothing to resume",
  !/resume/i.test(noResume)
);

console.log("\n5. It is actually wired into the request path");

const { readFile } = await import("node:fs/promises");
const route = (await readFile(path.join(ROOT, "src/app/api/chat/route.ts"), "utf8")).replace(/\r\n/g, "\n");

check("the route accepts a budget", /budgetUsd/.test(route));
check("every round is charged", /chargeRound\(/.test(route));
check("the limit is checked in the agent loop", /checkBudget\(/.test(route));
check(
  "a budget stop leaves the reply resumable",
  /hitOutputCeiling \|\| stoppedByBudget/.test(route),
  "otherwise hitting the cap throws away everything it paid for"
);
check(
  "the check happens before the tools run, not after",
  route.indexOf("checkBudget(") < route.indexOf("toolRounds += 1"),
  "stopping after them pays for results nothing will read"
);
check(
  "pending tool calls are still answered when stopping",
  /Not run — the spending limit/.test(route),
  "a tool_call with no reply is a 400 and an unresumable transcript"
);

const page = (await readFile(path.join(ROOT, "src/app/page.tsx"), "utf8")).replace(/\r\n/g, "\n");
check("the client sends the limit", /budgetUsd,/.test(page));
check("the client shows the warning", /budget_warning/.test(page));
check("the client explains the stop", /budget_stopped/.test(page));

const routeTree = /treeTracker\.update\(/.test(route);
check("the route uses tree deltas", routeTree);
check(
  "a delta is appended, never spliced in",
  /transcript\.push\(\{ role: "system", content: step\.text \}\)/.test(route)
);

/*
 * The file tree must be the LAST thing rewritten, not patched in place.
 *
 * DeepSeek caches by prefix, so a message that changes at position 3
 * invalidates 3..n. The tree changes on nearly every round — it is refreshed
 * after every action — so writing it back to a fixed early index re-billed
 * every tool result behind it, and the bill grew with the length of the run.
 *
 * Simulated over 40 rounds with a modest workspace and the real ordering:
 *
 *   tree patched at a fixed index   126,088 missed tokens   $0.0552
 *   tree removed and re-appended     34,945 missed tokens   $0.0159
 *
 * The plan block already had this right and said so in its own comment. The
 * tree, which changes far more often, did not.
 */
console.log("\n8. The file tree does not sit in front of the transcript");

const { readFileSync: rfs } = await import("node:fs");
const routeText = rfs(path.join(ROOT, "src/app/api/chat/route.ts"), "utf8").replace(
  /\r\n/g,
  "\n"
);

const setTreeBody = routeText.slice(
  routeText.indexOf("const setFileTree = (text: string) => {"),
  routeText.indexOf("if (workspaceEnabled) {\n          setFileTree(workspaceFiles);")
);

check(
  "setFileTree removes the old listing before writing a new one",
  /transcript\.splice\(i, 1\)/.test(setTreeBody),
  "leaving it in place is what invalidated everything behind it"
);
check(
  "and appends, rather than assigning to a stored index",
  /transcript\.push\(\{ role: "system", content: body \}\)/.test(setTreeBody) &&
    !/transcript\[fileTreeIndex\] = /.test(setTreeBody),
  "an in-place write at position 3 re-bills positions 3..n"
);
check(
  "only the tree is removed, not every system message",
  /startsWith\("Current workspace contents"\)/.test(setTreeBody),
  "the plan and the persona are system messages too"
);

/*
 * Ordering still holds: the plan is re-appended after the tree each round, so
 * it remains the last thing read before the model decides. Both blocks push
 * to the end, and the plan block runs later in the loop.
 */
const atTreeRefresh = routeText.indexOf("const refreshFileTree = async () => {");
const atPlanReappend = routeText.indexOf("Keep the plan in front of the model");
check(
  "the plan is re-appended after the tree is refreshed",
  atPlanReappend > atTreeRefresh && atTreeRefresh !== -1,
  "the plan has to be the last thing the model reads"
);

/*
 * A prefix-cache simulation, so the property is measured rather than asserted
 * from the shape of the code.
 */
const estTok = (t) => Math.ceil(t.length / 3.6);
const simulate = (inPlace, rounds) => {
  let t = [
    { c: "SYS".padEnd(9000, "s"), tag: "sys" },
    { c: "task", tag: "user" },
  ];
  let idx = -1;
  let prev = [];
  let missed = 0;
  const setTree = (n) => {
    const body = "Current workspace contents".padEnd(1800, "y") + n;
    if (inPlace) {
      if (idx === -1) {
        t.push({ c: body, tag: "tree" });
        idx = t.length - 1;
      } else t[idx] = { c: body, tag: "tree" };
    } else {
      t = t.filter((m) => m.tag !== "tree");
      t.push({ c: body, tag: "tree" });
    }
  };
  setTree(0);
  for (let n = 0; n < rounds; n++) {
    let common = 0;
    while (common < t.length && common < prev.length && t[common].c === prev[common].c)
      common++;
    for (let i = common; i < t.length; i++) missed += estTok(t[i].c);
    prev = t.map((m) => ({ ...m }));
    t.push({ c: "call".repeat(20), tag: "a" });
    t.push({ c: "result".repeat(60), tag: "t" });
    setTree(n + 1);
    t = t.filter((m) => m.tag !== "plan");
    t.push({ c: "Your plan for:".padEnd(700, "x"), tag: "plan" });
  }
  return missed;
};

const inPlaceMiss = simulate(true, 40);
const appendedMiss = simulate(false, 40);
check(
  "appending costs at least 3x fewer missed tokens over 40 rounds",
  appendedMiss * 3 <= inPlaceMiss,
  `${inPlaceMiss} in place vs ${appendedMiss} appended`
);
check(
  "appending reclaims a material number of cache-miss tokens",
  inPlaceMiss - appendedMiss > 20_000,
  `${(inPlaceMiss - appendedMiss).toLocaleString()} fewer missed tokens on one 40-round task`
);
check(
  "the saving is real money, not rounding",
  (inPlaceMiss - appendedMiss) * MISS > 0.02,
  `$${((inPlaceMiss - appendedMiss) * MISS).toFixed(4)} on one 40-round task`
);

console.log(
  `\n${pass + fail} checks · ${pass} passed${fail ? ` · ${r(`${fail} failed`)}` : ""}\n`
);
process.exit(fail ? 1 : 0);

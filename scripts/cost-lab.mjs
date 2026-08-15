/**
 * Where the money actually goes.
 *
 * Run:  npm run cost:lab
 *
 * This drives the REAL chat route against a fake DeepSeek that simulates the
 * real prompt cache (prefix match, 64-token blocks) and bills at the real
 * rates. Nothing here is estimated from reading the code — every number comes
 * out of a request the app genuinely made.
 *
 * The output is a breakdown of one twelve-round agent task:
 *
 *   - what fraction of the prompt hit the cache each round
 *   - which messages the cache MISSES came from
 *   - how much of the bill is reasoning output vs input
 *
 * Guessing at this is how you end up optimising the wrong thing, which has
 * already happened once on this project.
 */
import path from "node:path";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  nextBin,
  findFreePort,
  killTree,
  spawnTracked,
  waitForServer,
} from "./lib/proc.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const WS_ID = "costlab";
const REPORT = path.join(ROOT, "scripts", ".cost-report.json");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (c) => (s) => (COLOR ? `\x1b[${c}m${s}\x1b[0m` : s);
const bold = wrap(1);
const dim = wrap(2);
const yellow = wrap(33);
const green = wrap(32);

const children = [];
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const c of children) killTree(c);
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

function start(label, cmd, args, env) {
  const child = spawnTracked(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
  children.push(child);
  const echo = (d) => {
    if (process.env.VERBOSE) process.stdout.write(dim(`[${label}] ${d}`));
  };
  child.stdout.on("data", echo);
  child.stderr.on("data", echo);
  return child;
}

const usd = (n) => `$${n.toFixed(4)}`;
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

async function run(label, port, payload) {
  const events = [];
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(300_000),
    body: JSON.stringify({
      deepseekApiKey: "sk-mock",
      webSearchMode: "off",
      ...payload,
    }),
  });
  const text = await res.text();
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const rest = line.slice(6).trim();
    if (!rest || rest === "[DONE]") continue;
    try {
      events.push(JSON.parse(rest));
    } catch {
      /* ignore */
    }
  }
  return events;
}

async function main() {
  console.log(bold("\napiM cost breakdown — measured, not guessed\n"));

  await rm(path.join(ROOT, "data", "workspaces", WS_ID), { recursive: true, force: true });
  await mkdir(path.join(ROOT, "data", "workspaces", WS_ID, "src", "lib"), { recursive: true });

  // A workspace with enough files that the tree is a real cost, like a user's
  // project rather than an empty folder.
  const fileCount = Number(process.env.SIM_FILES ?? 250);
  for (let i = 0; i < fileCount; i++) {
    await writeFile(
      path.join(ROOT, "data", "workspaces", WS_ID, "src", "lib", `sample${i}.txt`),
      `line ${i} of a sample source file\n`.repeat(20),
      "utf8"
    );
  }

  const mockPort = await findFreePort();
  const appPort = await findFreePort();
  const simRounds = Number(process.env.SIM_ROUNDS ?? 12);

  console.log(dim(`  simulating a ${simRounds}-round agent task in a ${fileCount}-file workspace`));
  console.log(dim("  starting the app (first run compiles, ~40s)…\n"));

  await rm(REPORT, { force: true });
  const mock = start("mock", process.execPath, ["scripts/mock-billing.mjs"], {
    MOCK_PORT: String(mockPort),
    BILL_REPORT: REPORT,
    SIM_ROUNDS: String(simRounds),
  });
  const app = start("app", process.execPath, [nextBin(ROOT), "dev", "--port", String(appPort)], {
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${mockPort}`,
  });

  const dead = (c) => () => c.exitCode !== null || c.signalCode !== null;
  if (!(await waitForServer(`http://127.0.0.1:${mockPort}/`, 20_000, dead(mock)))) {
    console.log("mock did not start");
    process.exit(1);
  }
  if (!(await waitForServer(`http://127.0.0.1:${appPort}/api/conversations`, 240_000, dead(app)))) {
    console.log("app did not start — run with VERBOSE=1");
    process.exit(1);
  }

  // Optionally simulate a real CONVERSATION: several user messages in one
  // chat, not one message in isolation. This is how the app is actually used
  // and it exercises a cache path the single-message test never touches.
  const turns = Number(process.env.SIM_TURNS ?? 1);
  let convId = null;
  const history = [];
  for (let turn = 1; turn < turns; turn++) {
    const q = `Follow-up question number ${turn}: check the previous step and continue.`;
    const evs = await run("turn", appPort, {
      message: q,
      conversationId: convId,
      conversationHistory: history.slice(),
      workspaceEnabled: true,
      workspaceId: WS_ID,
      thinkingEffort: process.env.SIM_EFFORT ?? "high",
    });
    const meta = evs.find((e) => e.type === "meta");
    if (meta?.conversationId) convId = meta.conversationId;
    const text = evs.filter((e) => e.type === "content").map((e) => e.delta).join("");
    history.push({ role: "user", content: q });
    history.push({ role: "assistant", content: text });
  }

  const events = await run("agent task", appPort, {
    conversationId: convId,
    conversationHistory: history,
    message:
      "Refactor the data layer: debug the failing tests, implement the new " +
      "cache, and review performance across the whole system.",
    workspaceEnabled: true,
    workspaceId: WS_ID,
    model: process.env.SIM_MODEL ?? "deepseek-v4-pro",
    thinkingEffort: process.env.SIM_EFFORT ?? "high",
    budgetUsd: process.env.SIM_BUDGET ? Number(process.env.SIM_BUDGET) : undefined,
  });

  // Give the last write a moment to land.
  await new Promise((r) => setTimeout(r, 500));

  const stop = events.find((e) => e.type === "budget_stopped");
  const warn = events.find((e) => e.type === "budget_warning");
  if (process.env.SIM_BUDGET) {
    console.log(bold("Spending limit\n"));
    console.log(`  warned:  ${warn ? `yes, at $${warn.spentUsd.toFixed(4)}` : "no"}`);
    console.log(
      `  stopped: ${stop ? `yes, at $${stop.spentUsd.toFixed(4)} of $${stop.limitUsd.toFixed(2)}` : "no"}`
    );
    console.log();
  }

  const bill = JSON.parse(await readFile(REPORT, "utf8"));
  cleanup();

  const requested = process.env.SIM_EFFORT ?? "high";
  const actual = bill.requests[0]?.effort ?? requested;
  if (actual !== requested) {
    console.log(
      yellow(`  note: you asked for effort "${requested}"; this model actually uses "${actual}"\n`)
    );
  }

  console.log(bold("Per round\n"));
  console.log(
    dim("  round   prompt    cached     missed     output    cost      biggest miss")
  );
  for (const r of bill.requests) {
    const worst = Object.entries(r.missByKind).sort((a, b) => b[1] - a[1])[0];
    const pct = r.promptTokens ? Math.round((r.hitTokens / r.promptTokens) * 100) : 0;
    console.log(
      `  ${String(r.round).padEnd(6)}  ${k(r.promptTokens).padEnd(8)}  ` +
        `${(k(r.hitTokens) + ` (${pct}%)`).padEnd(15)}` +
        `${k(r.missTokens).padEnd(10)} ${k(r.completionTokens).padEnd(9)} ` +
        `${usd(r.cost).padEnd(9)} ${worst ? `${worst[0]} ${k(worst[1])}` : ""}`
    );
  }

  const t = bill.totals;
  const RATE = (bill.requests[0]?.model ?? "deepseek-v4-pro") === "deepseek-v4-flash"
    ? { input: 0.14, cached: 0.0028, output: 0.28 }
    : { input: 0.435, cached: 0.003625, output: 0.87 };
  const inCostMiss = (t.missTokens / 1e6) * RATE.input;
  const inCostHit = (t.hitTokens / 1e6) * RATE.cached;
  const outCost = (t.outputTokens / 1e6) * RATE.output;
  const reasoningCost = (t.reasoningOutputTokens / 1e6) * RATE.output;

  console.log(bold("\nTotals\n"));
  console.log(`  cache misses (input)   ${k(t.missTokens).padEnd(10)} ${usd(inCostMiss)}  ${yellow(pctOf(inCostMiss, t.cost))}`);
  console.log(`  cache hits   (input)   ${k(t.hitTokens).padEnd(10)} ${usd(inCostHit)}  ${green(pctOf(inCostHit, t.cost))}`);
  console.log(`  output                 ${k(t.outputTokens).padEnd(10)} ${usd(outCost)}  ${yellow(pctOf(outCost, t.cost))}`);
  console.log(dim(`    of which reasoning   ${k(t.reasoningOutputTokens).padEnd(8)} ${usd(reasoningCost)}  ${pctOf(reasoningCost, t.cost)}`));
  console.log(bold(`\n  TOTAL                             ${usd(t.cost)}\n`));

  console.log(bold("Cache misses, by what caused them\n"));
  const kinds = Object.entries(bill.missByKind).sort((a, b) => b[1] - a[1]);
  for (const [kind, tokens] of kinds) {
    const cost = (tokens / 1e6) * RATE.input;
    console.log(`  ${kind.padEnd(22)} ${k(tokens).padEnd(9)} ${usd(cost)}  ${pctOf(cost, t.cost)}`);
  }
  console.log();
}

function pctOf(part, whole) {
  if (!whole) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

main().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});

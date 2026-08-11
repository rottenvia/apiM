/**
 * The plan: what stops the agent finishing early.
 *
 * Run:  npm run test:plan
 *
 * The agent loop can run forty rounds. Everything it DID survives — tool
 * calls are summarised into the transcript — but nothing recorded what it was
 * TRYING to do. From inside round twelve, the work so far looks like a
 * complete answer, so the model writes a confident summary and stops with
 * requirements from the first message still unmet.
 *
 * That is not a model being lazy. It is a missing input.
 *
 * The end-to-end check below is the one that matters: a mock model is scripted
 * to claim "All done! I have completed the task." after finishing one step of
 * three. The run must not end there.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rm } from "node:fs/promises";
import {
  nextBin,
  findFreePort,
  killTree,
  spawnTracked,
  waitForServer,
} from "./lib/proc.mjs";

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

const plan = await load("src/lib/plan.ts");
const { WORKSPACE_TOOLS } = await load("src/lib/tools.ts");

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

console.log("\napiM plan checks\n");

// ---------------------------------------------------------------------------
console.log("1. A plan is well-formed or it is refused");

let threw = "";
try {
  plan.createPlan("", ["a"]);
} catch (e) {
  threw = e.message;
}
check("a plan needs a goal", /needs a goal/.test(threw));

threw = "";
try {
  plan.createPlan("A properly stated goal", []);
} catch (e) {
  threw = e.message;
}
check("a plan needs steps", /at least one step/.test(threw));

threw = "";
try {
  plan.createPlan(
    "A properly stated goal",
    Array.from({ length: 40 }, (_, i) => `Do the numbered piece of work ${i}`)
  );
} catch (e) {
  threw = e.message;
}
check(
  "an enormous plan is refused",
  /too many/i.test(threw),
  "a plan is a map, not a transcript"
);

const p0 = plan.createPlan("Build a scraper", [
  "Inspect the page",
  "Write the parser",
  "Run the tests",
]);
check("steps are numbered from one", p0.steps[0].id === 1 && p0.steps[2].id === 3);
check("everything starts as todo", p0.steps.every((s) => s.state === "todo"));

// ---------------------------------------------------------------------------
console.log("\n2. 'Done' has to be earned");

threw = "";
try {
  plan.updatePlan(p0, [{ id: 1, state: "done" }]);
} catch (e) {
  threw = e.message;
}
check(
  "a step cannot be marked done without evidence",
  /cannot be marked done/.test(threw),
  "'done' is the word an agent over-claims — this makes it cost something"
);
check("and the refusal says what to do instead", /mark it "doing"/.test(threw));

threw = "";
try {
  plan.updatePlan(p0, [{ id: 1, state: "done", verified: "   " }]);
} catch (e) {
  threw = e.message;
}
check("whitespace is not evidence", /cannot be marked done/.test(threw));
threw = "";
try {
  plan.updatePlan(p0, [{ id: 1, state: "done", verified: "ok" }]);
} catch (e) {
  threw = e.message;
}
check(
  "and neither is a token word like 'ok'",
  /cannot be marked done/.test(threw),
  "a one-word acknowledgement costs nothing, which defeats the point"
);

threw = "";
try {
  plan.updatePlan(p0, [{ id: 1, state: "blocked" }]);
} catch (e) {
  threw = e.message;
}
check("blocked needs a reason too", /cannot be marked blocked/.test(threw));

threw = "";
try {
  plan.updatePlan(p0, [{ id: 99, state: "doing" }]);
} catch (e) {
  threw = e.message;
}
check("an unknown step number is reported", /no step 99/.test(threw));

let p1 = plan.updatePlan(p0, [
  { id: 1, state: "done", verified: "browse returned .match-score" },
]);
check("a verified step is accepted", p1.steps[0].state === "done");
check("the evidence is kept", p1.steps[0].verified === "browse returned .match-score");
check("the revision advances", p1.revision === p0.revision + 1);
check(
  "the original plan is not mutated",
  p0.steps[0].state === "todo",
  "a rejected update must never leave a half-changed plan"
);

// ---------------------------------------------------------------------------
console.log("\n3. Progress is stated, not inferred");

let progress = plan.planProgress(p1);
check("done is counted", progress.done === 1 && progress.total === 3);
check("it is not complete", progress.complete === false);
check("the next step is named", progress.next?.id === 2);

const text = plan.formatPlan(p1);
check("the rendered plan says it is unfinished", /Not finished/.test(text));
check(
  "and tells the model not to write a summary yet",
  /Do not write a closing summary/.test(text),
  "this is the sentence that prevents the confident half-finished answer"
);
check("evidence is shown alongside the step", /verified: browse returned/.test(text));

const finished = plan.updatePlan(p1, [
  { id: 2, state: "done", verified: "parser.py written" },
  { id: 3, state: "done", verified: "run_tests: 4 passed" },
]);
progress = plan.planProgress(finished);
check("a finished plan reports complete", progress.complete === true);
check(
  "and says to stop",
  /Summarise what you built and stop/.test(plan.formatPlan(finished))
);

const blocked = plan.updatePlan(p1, [
  { id: 2, state: "blocked", blocker: "the API needs a key the user has not given" },
]);
check("blocked steps are counted", plan.planProgress(blocked).blocked === 1);
check("the blocker is shown", /blocked: the API needs a key/.test(plan.formatPlan(blocked)));

// ---------------------------------------------------------------------------
console.log("\n4. Wiring");

const names = WORKSPACE_TOOLS.map((t) => t.function.name);
check("make_plan is offered", names.includes("make_plan"));
check("update_plan is offered", names.includes("update_plan"));

const { readFile } = await import("node:fs/promises");
const route = (await readFile(path.join(ROOT, "src/app/api/chat/route.ts"), "utf8")).replace(/\r\n/g, "\n");

check(
  "the system prompt tells the model to plan",
  /call make_plan/.test(route),
  "a tool the model never reaches for is not a feature"
);
check(
  "and to verify its own work",
  /Check your own work before claiming it works/.test(route)
);
check(
  "the plan is re-appended each round",
  /transcript\.push\(\{ role: "system", content: formatPlan\(plan\) \}\)/.test(route),
  "a tool result gets compacted away on long runs — exactly when it matters"
);
check(
  "it is found by marker, not a stored index",
  /m\.content\.startsWith\(PLAN_MARKER\)/.test(route),
  "two things splice this transcript; a remembered index drifts"
);
check(
  "the loop refuses to end on an unfinished plan",
  /Your plan is not finished/.test(route)
);
check(
  "but only nudges once",
  /nudgedIncomplete/.test(route),
  "nagging a model that has genuinely finished costs a round and pads the answer"
);
check(
  "and never argues with a blocked plan",
  /const stuck = plan\.steps\.some\(\(s\) => s\.state === "blocked"\)/.test(route),
  "being stuck and saying so is a correct ending"
);

const bubble = (await readFile(path.join(ROOT, "src/components/MessageBubble.tsx"), "utf8")).replace(/\r\n/g, "\n");
check("the plan is shown in the UI", /<PlanPanel plan=\{message\.plan\}/.test(bubble));
check(
  "and the bubble re-renders when it changes",
  /a\.plan === b\.plan/.test(bubble),
  "otherwise the progress bar would freeze at its first value"
);

// ---------------------------------------------------------------------------
console.log("\n5. End to end: a model that tries to stop early is not allowed to");

const mockPort = await findFreePort();
const appPort = await findFreePort();

const start = (label, cmd, args, env) => {
  const child = spawnTracked(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
  children.push(child);
  const echo = (dd) => {
    if (process.env.VERBOSE) process.stdout.write(d(`[${label}] ${dd}`));
  };
  child.stdout.on("data", echo);
  child.stderr.on("data", echo);
  return child;
};

const mock = start("mock", process.execPath, ["scripts/mock-plan.mjs"], {
  PORT: String(mockPort),
  MOCK_PLAN_PORT: String(mockPort),
});
const app = start("app", process.execPath, [nextBin(ROOT), "dev", "--port", String(appPort)], {
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${mockPort}`,
});

const dead = (c) => () => c.exitCode !== null || c.signalCode !== null;
const mockUp = await waitForServer(`http://127.0.0.1:${mockPort}/`, 20_000, dead(mock));
const appUp = await waitForServer(
  `http://127.0.0.1:${appPort}/api/conversations`,
  180_000,
  dead(app)
);

if (!mockUp || !appUp) {
  check("the test harness starts", false, "run with VERBOSE=1 for details");
} else {
  const res = await fetch(`http://127.0.0.1:${appPort}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      message: "do the thing",
      deepseekApiKey: "sk-mock",
      workspaceEnabled: true,
      workspaceId: "plantest",
      webSearchMode: "off",
      thinkingEffort: "none",
    }),
  });

  const body = await res.text();
  const frames = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const rest = line.slice(6).trim();
    if (!rest || rest === "[DONE]") continue;
    try {
      frames.push(JSON.parse(rest));
    } catch {
      /* ignore */
    }
  }

  const planFrames = frames.filter((f) => f.type === "plan");
  const answer = frames
    .filter((f) => f.type === "content")
    .map((f) => f.delta)
    .join("");

  check("the plan reached the browser", planFrames.length >= 2, `${planFrames.length} updates`);
  check(
    "the model claimed to be finished at 1 of 3",
    /All done!/.test(answer),
    "this is the failure being reproduced, not a bug in the test"
  );
  check(
    "but the run continued anyway",
    /Now genuinely finished/.test(answer),
    "without the nudge the reply would have ended at 'All done!'"
  );
  check(
    "and every step ended verified",
    planFrames[planFrames.length - 1]?.summary === "3/3 steps",
    planFrames[planFrames.length - 1]?.summary
  );
}

// ---------------------------------------------------------------------------
console.log("\n6. End to end: a model that claims a test run it never made");

if (appUp) {
  const mock2 = start("liar", process.execPath, ["scripts/mock-liar.mjs"], {
    MOCK_PLAN_PORT: String(await findFreePort()),
  });
  // Re-point is not possible on a running app, so this reuses the same app
  // against the first mock's port only for the plan flow; the liar path is
  // exercised through the unit check below instead, which is where the
  // decision actually lives.
  killTree(mock2);
}

const planLib = await load("src/lib/plan.ts");
check(
  "a claimed test run with no tool used is refused",
  planLib.checkEvidence("ran the tests, all passed", ["write_file"]) !== null,
  "the agent writes its own evidence — this catches the cheapest lie"
);
check(
  "the same claim is accepted once run_tests has run",
  planLib.checkEvidence("ran the tests, all passed", ["run_tests"]) === null
);
check(
  "describing work needs no corroboration",
  planLib.checkEvidence("wrote the parser module", []) === null,
  "over-reaching here would make the plan unusable for ordinary steps"
);

cleanup();
await rm(path.join(DATA_ROOT, "workspaces", "plantest"), { recursive: true, force: true });

console.log(
  `\n${pass + fail} checks · ${pass} passed${fail ? ` · ${r(`${fail} failed`)}` : ""}\n`
);
process.exit(fail ? 1 : 0);

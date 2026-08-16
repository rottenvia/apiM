/**
 * Every tool that CAN run without the internet, actually run.
 *
 * Run:  npm run test:dispatch
 *
 * Why this exists: you asked why the tools that need no server are not
 * tested, and the honest answer was that several of them were not being
 * executed at all. I measured it rather than guessing — searching every
 * offline suite for a real `runTool(...)` call — and got 20 of 33.
 *
 * The other 13 split into three groups:
 *
 *   Reachable, and simply never called
 *     list_files, delete_file, make_plan, update_plan, http_request,
 *     download_file, wait_for_output, run_tests
 *     Some were covered indirectly — delete_file's underlying deleteFile()
 *     is tested, list_files' listFiles() is tested in nine suites — but the
 *     TOOL was not, so the dispatch, the argument parsing and the sentence
 *     handed back to the model were unverified. That gap is where the
 *     "Edited 2 file(s)" bug lived: the library was right and the receipt
 *     was wrong.
 *
 *   Needs the network
 *     fetch_url, web_search, browse, inspect_page
 *     Not run here. This sandbox has no outbound network, and a test that
 *     silently passes because it could not reach anything is worse than no
 *     test. What CAN be checked without a network is the failure path, so
 *     that is what is checked.
 *
 *   Needs a person
 *     ask_user. It blocks until someone answers. Covered by mocks in the
 *     plan and autonomy suites instead.
 *
 * `run_command` is deliberately not dispatched through runTool: it lives in
 * the chat route because it needs the approval prompt. Its own function is
 * covered by test-runner and test-install.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { finishSuite } from "./lib/proc.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_ROOT = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.join(ROOT, "data");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const { runTool, WORKSPACE_TOOLS } = await load("src/lib/tools.ts");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

const WS = "dispatchtest";
const WS_DIR = path.join(DATA_ROOT, "workspaces", WS);
await rm(WS_DIR, { recursive: true, force: true });
await mkdir(WS_DIR, { recursive: true });

/** Tracks which tools this suite really dispatched, for the audit at the end. */
const dispatched = new Set();
async function call(name, args = {}, context = {}) {
  dispatched.add(name);
  return runTool(WS, name, args, context);
}

console.log("\napiM — every offline tool, actually dispatched\n");

// --------------------------------------------------------------- list_files

console.log("1. list_files");

let res = await call("list_files");
check(
  "an empty workspace says so instead of returning nothing",
  res.ok && /empty/i.test(res.content),
  res.summary
);

await runTool(WS, "write_file", { path: "a.txt", content: "alpha" });
await runTool(WS, "write_file", { path: "sub/b.txt", content: "beta" });

res = await call("list_files");
check(
  "it lists what is there, with sizes",
  res.ok && res.content.includes("a.txt") && /\d+ bytes/.test(res.content),
  res.summary
);
check(
  "the count is singular or plural correctly",
  /Listed \d+ files?$/.test(res.summary),
  res.summary
);

res = await call("list_files", { path: "sub" });
check(
  "it can list a subdirectory",
  res.ok && res.content.includes("b.txt") && !res.content.includes("a.txt"),
  res.summary
);

// -------------------------------------------------------------- delete_file

console.log("\n2. delete_file");

await runTool(WS, "write_file", { path: "doomed.txt", content: "bye" });
res = await call("delete_file", { path: "doomed.txt" });
check("it reports what it deleted", res.ok && /doomed\.txt/.test(res.summary));
check(
  "and names the changed path, so the UI can refresh",
  res.changedPath === "doomed.txt",
  String(res.changedPath)
);

const after = await runTool(WS, "list_files", {});
check("the file is really gone", !after.content.includes("doomed.txt"));

res = await call("delete_file", { path: "never-existed.txt" });
check(
  "deleting something absent is an error the model can act on",
  !res.ok && /not|exist|find/i.test(res.content),
  res.content.slice(0, 60)
);

res = await call("undo_file", { path: "doomed.txt" });
check(
  "a deleted file can still be brought back",
  res.ok,
  "delete keeps history, which is the whole reason it is allowed"
);

// ---------------------------------------------------------------- edit_files

console.log("\n3. edit_files counts files, not edits");

await runTool(WS, "write_file", {
  path: "two-bugs.py",
  content: "def f(n):\n    return n\n\nfor i in range(1, 20):\n    print(f(i))\n",
});

res = await call("edit_files", {
  edits: [
    { path: "two-bugs.py", old_text: "return n", new_text: "return n * 2" },
    { path: "two-bugs.py", old_text: "range(1, 20)", new_text: "range(1, 21)" },
  ],
});
/*
 * Two edits, one file.
 *
 * Reported from a real run: the model fixed both bugs in counter.py with a
 * single edit_files call and was told "Edited 2 file(s)". The work was right
 * and the receipt was wrong — it overstates how much of the workspace was
 * touched, in the direction that matters.
 */
check(
  "two edits to one file report one file",
  res.ok && /Edited 1 file\b/.test(res.summary),
  res.summary
);
check(
  "and the edit count is still visible in the detail",
  /2 edits/.test(res.content),
  res.content.split("\n")[0]
);

await runTool(WS, "write_file", { path: "other.py", content: "x = 1\n" });
res = await call("edit_files", {
  edits: [
    { path: "two-bugs.py", old_text: "n * 2", new_text: "n * 3" },
    { path: "other.py", old_text: "x = 1", new_text: "x = 2" },
  ],
});
check(
  "two edits to two files report two files",
  res.ok && /Edited 2 files\b/.test(res.summary),
  res.summary
);

res = await call("edit_files", {
  edits: [
    { path: "other.py", old_text: "x = 2", new_text: "x = 3" },
    { path: "other.py", old_text: "NOT PRESENT ANYWHERE", new_text: "y" },
  ],
});
check(
  "a partial failure keeps the good edit and names the bad one",
  /Edited 1 file, 1 failed/.test(res.summary) &&
    /NOT applied/.test(res.content) &&
    /old_text not found/.test(res.content),
  res.summary
);
check(
  "and tells the model how to retry just that one",
  /retry just these/.test(res.content) && /read the file first/.test(res.content),
  "a failure the model cannot act on becomes a retry loop"
);

// ------------------------------------------------------------------- plans

console.log("\n4. make_plan and update_plan");

/*
 * These two are handled in the chat route, not in runTool — they mutate the
 * plan held for the run and stream a panel update, so they need the run's
 * state. Dispatching them here returns "Unknown tool", which my first version
 * of this suite reported as four failures.
 *
 * The route wiring is covered end to end by test-plan against a live server.
 * What belongs here is the logic underneath, called directly.
 */
const P = await load("src/lib/plan.ts");

const plan = P.createPlan("Fix the failing build and prove it passes", [
  "Read the build error from the CI log",
  "Change the offending import path",
  "Run the test suite and confirm it is green",
]);
check("a plan can be created", plan.steps.length === 3, `${plan.steps.length} steps`);
check(
  "the steps are readable back",
  P.formatPlan(plan).includes("import path"),
  "the model has to be able to see its own plan"
);

let threw = false;
try {
  P.createPlan("x", []);
} catch {
  threw = true;
}
check(
  "an empty plan is refused",
  threw,
  "a plan with no steps is a plan-shaped way of skipping planning"
);

const advanced = P.updatePlan(plan, [
  {
    id: 1,
    state: "done",
    verified: "The log said: cannot resolve ../lib/parse from src/index.ts",
  },
]);
check(
  "a step can be completed with evidence",
  advanced.steps[0].state === "done",
  advanced.steps[0].state
);

let refusedBare = false;
try {
  P.updatePlan(plan, [{ id: 2, state: "done" }]);
} catch {
  refusedBare = true;
}
check(
  "a step cannot be closed with no evidence at all",
  refusedBare,
  "'done' with nothing behind it is the claim that turns out to be wrong"
);
/*
 * Two different guards, and I conflated them at first.
 *
 * MIN_EVIDENCE is a length floor in updatePlan: "ok" is too short to be an
 * account of anything. checkEvidence is narrower and more interesting — it
 * only fires on text that CLAIMS a check ("ran the tests"), and only when no
 * tool capable of checking was used. Plenty of honest evidence is short of a
 * claim, so checkEvidence deliberately accepts it and the length floor is
 * what rejects the useless kind.
 */
let refusedThin = false;
try {
  P.updatePlan(plan, [{ id: 2, state: "done", verified: "ok" }]);
} catch {
  refusedThin = true;
}
check(
  "thin evidence is refused by the length floor",
  refusedThin,
  `'ok' is under MIN_EVIDENCE (${P.MIN_EVIDENCE})`
);
check(
  "claiming a test run without running one is caught",
  P.checkEvidence("ran the tests and they all passed", []) !== null,
  "no verifying tool was used this run, so that claim is unsupported"
);
check(
  "the same claim is accepted once a real test was run",
  P.checkEvidence("ran the tests and they all passed", ["run_tests"]) === null,
  "it must not punish the honest case"
);
check(
  "describing work is not treated as a claim",
  P.checkEvidence("rewrote the import path in src/index.ts", []) === null,
  "over-reaching here would make the plan unusable for ordinary steps"
);

// Both tools must still be offered to the model, whoever handles them.
for (const n of ["make_plan", "update_plan"]) {
  check(
    `${n} is offered to the model`,
    WORKSPACE_TOOLS.some((t) => t.function.name === n)
  );
}

// ------------------------------------------------------------- http_request

console.log("\n5. http_request and download_file refuse to reach this machine");

/*
 * I wrote this section pointing at a local server and every check failed —
 * with "That address is on this machine, not the public web."
 *
 * That is the tool being right and the test being wrong. Reaching loopback
 * and private ranges from a tool the model controls is server-side request
 * forgery: it is how an agent gets talked into reading a cloud metadata
 * endpoint or an admin port that is only trusted because it is local. The
 * guard is absolute and has no environment override, which is the correct
 * design and the reason a local fixture cannot be used here.
 *
 * So what gets verified is the guard itself, on every shape of local address,
 * plus the argument handling that does not need a network. The success path
 * needs the internet and is honestly listed as uncovered.
 */
const server = createServer((req, res2) => {
  res2.writeHead(200, { "Content-Type": "application/json" });
  res2.end('{"hello":"apiM"}');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

for (const [label, url] of [
  ["loopback by IP", `http://127.0.0.1:${port}/ping`],
  ["loopback by name", `http://localhost:${port}/ping`],
  ["the all-interfaces address", `http://0.0.0.0:${port}/ping`],
  ["a private LAN range", "http://192.168.1.1/admin"],
  ["the cloud metadata endpoint", "http://169.254.169.254/latest/meta-data/"],
]) {
  res = await call("http_request", { url });
  check(
    `http_request refuses ${label}`,
    !res.ok && /this machine|not the public web|private|local/i.test(res.content),
    res.summary
  );
}

res = await call("http_request", { url: "ftp://example.com/x" });
check(
  "a non-HTTP scheme is refused",
  !res.ok,
  "the tool is for HTTP; anything else is a mistake worth naming"
);

res = await call("http_request", { url: "not-a-url" });
check(
  "a malformed URL fails cleanly rather than throwing",
  !res.ok && typeof res.content === "string" && res.content.length > 5,
  res.summary
);

// ------------------------------------------------------------ download_file

console.log("\n6. download_file");

res = await call("download_file", {
  url: `http://127.0.0.1:${port}/file.json`,
  path: "fetched.json",
});
check(
  "download_file honours the same guard",
  !res.ok && /this machine|not the public web/i.test(res.content),
  res.summary
);

res = await call("download_file", {
  url: "https://example.com/x.json",
  path: "../escape.json",
});
/*
 * The path is checked before anything is fetched, so this is verifiable
 * without a network: it must be refused for the PATH, not for the URL.
 */
check(
  "it cannot write outside the workspace",
  !res.ok && !/this machine/i.test(res.content),
  res.summary
);

// ---------------------------------------------------------- wait_for_output

console.log("\n7. wait_for_output");

res = await call("wait_for_output", { id: "no-such-process", pattern: "ready" });
check(
  "waiting on a process that does not exist fails fast and clearly",
  !res.ok && /process/i.test(res.content),
  res.summary
);

/*
 * A process that actually stays up.
 *
 * My first attempt used `node -e` with a couple of timers, and start_process
 * refused it: "exited immediately (code 0)". That is the tool being right —
 * start_process is for things that keep running, and something that exits
 * straight away is almost always a mistake worth reporting rather than a
 * background job. A real file with an open handle is the honest fixture.
 */
await writeFile(
  path.join(WS_DIR, "slowsrv.js"),
  [
    "setTimeout(() => console.log('SERVER READY'), 300);",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"),
  "utf8"
);

const started = await runTool(WS, "start_process", {
  command: "node",
  args: ["slowsrv.js"],
});
check("a long-running process starts", started.ok, started.summary);

// The id is printed as "id proc-1-xxxxx". Matched precisely, because a loose
// pattern grabs the first word of the sentence instead.
const id = (started.content.match(/\bid (proc-[\w-]+)/) ?? [])[1];
if (started.ok && id) {
  res = await call("wait_for_output", {
    id,
    pattern: "SERVER READY",
    timeout_ms: 8000,
  });
  check(
    "wait_for_output returns once the pattern appears",
    res.ok && /SERVER READY/.test(res.content),
    res.summary
  );

  res = await call("wait_for_output", {
    id,
    pattern: "THIS NEVER APPEARS",
    timeout_ms: 1200,
  });
  check(
    "and gives up with a timeout rather than hanging forever",
    !res.ok && /timed out|not appear|timeout/i.test(`${res.summary} ${res.content}`),
    res.summary
  );

  await runTool(WS, "stop_process", { id }).catch(() => {});
} else {
  check("wait_for_output had a process to watch", false, started.summary);
}

// ----------------------------------------------------------------- run_tests

/*
 * Answering a process that asks a question.
 *
 * stdin was opened with "ignore", so the agent could WATCH a prompt appear
 * and had no way to reply. That covers npm init, a migration confirming a
 * destructive step, a REPL, anything with "continue? [y/N]" — and because a
 * closed stdin makes some tools read EOF and abort rather than prompt, the
 * failure did not even look like a missing feature.
 */
console.log("\n7b. write_process answers a prompt");

await writeFile(
  path.join(WS_DIR, "ask.js"),
  [
    'const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });',
    'process.stdout.write("Name? ");',
    'rl.on("line", (line) => {',
    "  if (!line.trim()) return;",
    '  console.log("Hello, " + line.trim() + "!");',
    "  setInterval(() => {}, 1000);",
    "});",
    "",
  ].join("\n"),
  "utf8"
);

const asker = await runTool(WS, "start_process", {
  command: "node",
  args: ["ask.js"],
});
const askId = (asker.content.match(/\bid (proc-[\w-]+)/) ?? [])[1];

if (asker.ok && askId) {
  res = await call("write_process", { id: askId, input: "Marsel" });
  check("input reaches the process", res.ok, res.summary);
  check(
    "and the program acted on it",
    /Hello, Marsel!/.test(res.content),
    "proof it was read, not just written"
  );
  check(
    "what was typed is echoed into the log",
    /> Marsel/.test(res.content),
    "a pipe shows no keystrokes, so the transcript would be a mystery"
  );

  res = await call("write_process", { id: "proc-does-not-exist", input: "y" });
  check("an unknown id is refused", !res.ok && /No process/.test(res.content));

  await runTool(WS, "stop_process", { id: askId });
  res = await call("write_process", { id: askId, input: "y" });
  check(
    "writing to a stopped process fails with a reason",
    !res.ok && /exited|stopped|not accepting/i.test(res.content),
    res.content.slice(0, 60)
  );
} else {
  check("a process was available to write to", false, asker.summary);
}

console.log("\n8. run_tests");

res = await call("run_tests", {});
check(
  "with no suite present it says so, and suggests the alternative",
  !res.ok && /no test suite/i.test(res.content) && /run_command/.test(res.content),
  res.summary
);

/*
 * A real, tiny suite: node's own test runner, no install required.
 *
 * detectRunner looks for a package.json test script, so one is written here.
 * This is the only way to exercise the parse-the-output path for real.
 */
await writeFile(
  path.join(WS_DIR, "package.json"),
  JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }, null, 2),
  "utf8"
);
await writeFile(
  path.join(WS_DIR, "sum.test.js"),
  [
    'const { test } = require("node:test");',
    'const assert = require("node:assert");',
    'test("adds", () => assert.strictEqual(1 + 1, 2));',
    "",
  ].join("\n"),
  "utf8"
);

res = await call("run_tests", {});
/*
 * The COUNT matters, not just the verdict.
 *
 * This first said only "no failures", and passed while reporting "All 0 tests
 * passed" — a summary confidently wrong about how much ran, which is worse
 * than admitting it did not understand.
 */
check(
  "a passing suite is reported as passing, with the real count",
  res.ok && /All 1 tests? passed/.test(res.summary),
  res.summary
);

await writeFile(
  path.join(WS_DIR, "sum.test.js"),
  [
    'const { test } = require("node:test");',
    'const assert = require("node:assert");',
    'test("adds", () => assert.strictEqual(1 + 1, 3));',
    "",
  ].join("\n"),
  "utf8"
);

res = await call("run_tests", {});
check(
  "a FAILING suite is still a successful tool call",
  res.ok,
  "the agent asked what the state was and got a true answer; " +
    "marking it failed invites a pointless retry"
);
check(
  "the failing count is right",
  /1 failed/.test(res.summary),
  res.summary
);
check(
  "and the failing test is named, not just counted",
  /adds/.test(res.content),
  "a count with no name means reading the raw output again"
);

/*
 * Both of node --test's output formats, pinned.
 *
 * The live run above only ever exercises whichever format THIS machine's Node
 * produces, so it cannot catch the other one — which is exactly how the first
 * version of this shipped broken.
 *
 * Node 22 and earlier print TAP when piped. Node 23 changed the non-TTY
 * default to spec to match what a terminal shows. So the TAP-only parser I
 * wrote passed here on Node 22 and did nothing on a real Node 24 run: "All 0
 * tests passed" for a green suite, no named failures for a red one.
 *
 * These are fixed samples, so they test the parser on every machine
 * regardless of which Node is installed.
 */
console.log("\n9. node --test speaks two formats, and both must parse");

const { parseTestOutput } = await load("src/lib/testing.ts");

const TAP_PASS = [
  "TAP version 13",
  "# Subtest: adds",
  "ok 1 - adds",
  "1..1",
  "# tests 1",
  "# pass 1",
  "# fail 0",
  "# skipped 0",
].join("\n");

const TAP_FAIL = [
  "TAP version 13",
  "not ok 1 - adds",
  "  ---",
  "  error: '2 !== 3'",
  "  ...",
  "# tests 1",
  "# pass 0",
  "# fail 1",
  "# skipped 0",
].join("\n");

// A real U+2714 / U+2716 / U+2139, as the spec reporter emits.
const SPEC_PASS = [
  "\u2714 adds (0.71ms)",
  "\u2139 tests 1",
  "\u2139 suites 0",
  "\u2139 pass 1",
  "\u2139 fail 0",
  "\u2139 skipped 0",
].join("\n");

const SPEC_FAIL = [
  "\u2716 adds (1.20ms)",
  "  Error [ERR_ASSERTION]: 2 !== 3",
  "\u2139 tests 1",
  "\u2139 pass 0",
  "\u2139 fail 1",
  "\u2139 skipped 0",
  "\u2716 failing tests:",
  "\u2716 adds (1.20ms)",
].join("\n");

for (const [label, sample, code, wantPass, wantFail] of [
  ["TAP, passing", TAP_PASS, 0, 1, 0],
  ["TAP, failing", TAP_FAIL, 1, 0, 1],
  ["spec, passing", SPEC_PASS, 0, 1, 0],
  ["spec, failing", SPEC_FAIL, 1, 0, 1],
]) {
  const parsed = parseTestOutput("npm test", sample, "", code);
  check(
    `${label} is understood`,
    !parsed.unparsed &&
      parsed.passed === wantPass &&
      parsed.failed === wantFail &&
      parsed.ok === (wantFail === 0),
    `${parsed.passed} passed, ${parsed.failed} failed${parsed.unparsed ? ", UNPARSED" : ""}`
  );
}

const specFail = parseTestOutput("npm test", SPEC_FAIL, "", 1);
check(
  "the failing test is named once, not once per mention",
  specFail.failures.length === 1 && specFail.failures[0].name === "adds",
  `${specFail.failures.length} entries: ${specFail.failures.map((f) => f.name).join(", ")}`
);
check(
  "a stack-trace line is not mistaken for a test name",
  !parseTestOutput(
    "npm test",
    `${SPEC_FAIL}\n    at Test.run (node:internal/test_runner/test:1047:25)`,
    "",
    1
  ).failures.some((f) => /at Test\.run/.test(f.name)),
  "the duration suffix is what keeps the pattern honest"
);

// ------------------------------------------------- network tools, honestly

console.log("\n10. The network tools, where they can be checked without a network");

for (const name of ["fetch_url", "web_search", "browse", "inspect_page"]) {
  const tool = WORKSPACE_TOOLS.find((t) => t.function.name === name);
  check(`${name} is registered with a schema`, !!tool, tool ? "" : "missing");
}

res = await call("fetch_url", { url: "not-a-url" });
check(
  "fetch_url rejects a malformed URL rather than throwing",
  !res.ok && typeof res.content === "string",
  res.summary
);

res = await call("http_request", { url: "ftp://example.com/x" });
check(
  "a non-HTTP scheme is refused",
  !res.ok,
  "the tool is for HTTP; anything else is a mistake worth naming"
);

// --------------------------------------------------------------- the audit

console.log("\n11. The audit this suite exists to satisfy");

const all = WORKSPACE_TOOLS.map((t) => t.function.name).sort();
/*
 * Tools that cannot be dispatched here, each for a stated reason. Anything
 * NOT on this list and not dispatched above is an untested tool, and this
 * check is what makes that impossible to add quietly.
 */
const CANNOT = new Map([
  ["run_command", "lives in the chat route because it needs approval; covered by test-runner"],
  ["github_push", "lives in the chat route because it needs OAuth plus approval; covered by test-github"],
  ["make_plan", "handled in the chat route; its logic is called directly above"],
  ["update_plan", "handled in the chat route; its logic is called directly above"],
  ["ask_user", "blocks for a human; covered by mocks in plan and autonomy"],
  ["fetch_url", "needs the internet; failure path checked above"],
  ["web_search", "needs the internet and a key"],
  ["browse", "needs a real browser; covered by test-browser against a driver"],
  ["inspect_page", "needs the internet"],
  ["view_image", "needs a vision API key"],
  ["read_document", "covered by test-documents, which owns the fixtures"],
  ["inspect_binary", "covered by test-binaries with synthetic PE/.NET fixtures and a local DLL graph"],
  ["restore_snapshot", "covered by test-snapshots end to end"],
  ["list_snapshots", "covered by test-snapshots"],
  ["read_process", "covered by test-processes"],
  ["stop_process", "covered by test-processes"],
  ["list_processes", "covered by test-processes"],
  ["start_process", "covered by test-processes"],
  ["apply_patch", "covered by test-tools3"],
  ["move_file", "covered by test-tools2"],
  ["undo_file", "covered by test-tools2"],
  ["read_files", "covered by test-hardening for ordering"],
  ["write_files", "covered by test-tools2"],
  ["replace_in_files", "covered by test-tools2"],
  ["search_files", "covered by test-tools2"],
  ["read_file", "covered by test-tools2"],
  ["write_file", "used as a fixture throughout this suite"],
  ["edit_file", "covered by test-tools2"],
]);

const unexplained = all.filter((n) => !dispatched.has(n) && !CANNOT.has(n));
check(
  "every tool is either dispatched here or has a stated reason it is not",
  unexplained.length === 0,
  unexplained.length ? unexplained.join(", ") : `${all.length} tools accounted for`
);

console.log(
  d(
    `\n  dispatched here: ${dispatched.size}` +
      `   explained elsewhere: ${all.length - dispatched.size}` +
      `   total: ${all.length}`
  )
);

await rm(WS_DIR, { recursive: true, force: true });
server.closeAllConnections?.();
await Promise.race([
  new Promise((resolve) => server.close(resolve)),
  new Promise((resolve) => setTimeout(resolve, 2000)),
]);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
await finishSuite(fail);

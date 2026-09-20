/**
 * No-progress detection: halting a run that moves without advancing.
 *
 * Run:  npm run test:stall
 *
 * The loop-breaker catches identical failures. The wider loop differs
 * every call and "works" every time — re-read the file, retry the edit
 * with a new anchor, fail, narrate again — while nothing advances. Each
 * round re-sends the whole context, so the meter on this loop is money.
 *
 * The rule is information-theoretic: a call is progress when it adds
 * something new (bytes changed, the world ran, unseen text arrived).
 * Failures, byte-identical re-reads, and plan bookkeeping are stall
 * calls: warn at four, halt at six. Writes, runs, and a user's answer
 * reset the meter and clear the seen-map.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const read = (p) => readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const S = await load("src/lib/stall.ts");
const R = await load("src/lib/revive.ts");
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

const READ = "read a file";
const EDIT = "applied an edit";

// --- the core distinction ---
check("a first read is progress", (() => {
  const t = new S.StallTracker();
  const o = t.observe("read_file", { path: "a.cpp" }, true, READ);
  return o.progress && o.stallCalls === 0 && !o.warn && !o.trip;
})());
check("an identical re-read with identical text stalls", (() => {
  const t = new S.StallTracker();
  t.observe("read_file", { path: "a.cpp" }, true, READ);
  const o = t.observe("read_file", { path: "a.cpp" }, true, READ);
  return !o.progress && o.stallCalls === 1;
})());
check("the same call with changed output is progress (live polling)", (() => {
  const t = new S.StallTracker();
  t.observe("read_process", { id: "p1" }, true, "line 1");
  const o = t.observe("read_process", { id: "p1" }, true, "line 1\nline 2");
  return o.progress && o.stallCalls === 0;
})());
check("different arguments are a different call", (() => {
  const t = new S.StallTracker();
  t.observe("read_file", { path: "a.cpp" }, true, READ);
  const o = t.observe("read_file", { path: "b.cpp" }, true, READ);
  return o.progress && o.stallCalls === 0;
})());
check("failures stall even when every one differs", (() => {
  const t = new S.StallTracker();
  t.observe("edit_file", { anchor: "a" }, false, "no anchor a");
  const o = t.observe("edit_file", { anchor: "b" }, false, "no anchor b");
  return !o.progress && o.stallCalls === 2;
})());
check("plan bookkeeping stalls — planning is not doing", (() => {
  const t = new S.StallTracker();
  const a = t.observe("make_plan", { goal: "x" }, true, "planned");
  const b = t.observe("update_plan", { updates: [] }, true, "updated");
  return !a.progress && !b.progress && b.stallCalls === 2;
})());
check("a user's answer is forward motion", (() => {
  const t = new S.StallTracker();
  t.observe("read_file", { path: "a.cpp" }, true, READ);
  t.observe("read_file", { path: "a.cpp" }, true, READ);
  const o = t.observe("ask_user", { question: "q" }, true, "use X");
  return o.progress && o.stallCalls === 0;
})());

// --- the world changing resets everything ---
check("a write resets the meter and refreshes old reads", (() => {
  const t = new S.StallTracker();
  t.observe("read_file", { path: "a.cpp" }, true, READ);
  const w = t.observe("edit_file", { path: "a.cpp" }, true, EDIT);
  const r = t.observe("read_file", { path: "a.cpp" }, true, READ);
  return w.progress && w.stallCalls === 0 && r.progress && r.stallCalls === 0;
})());
check("running the world counts as progress", (() => {
  const t = new S.StallTracker();
  const out = ["run_command", "run_tests", "build_project", "start_process"].map(
    (n) => t.observe(n, {}, true, "did it")
  );
  return out.every((o) => o.progress);
})());
check("a failed write stalls and does not refresh anything", (() => {
  const t = new S.StallTracker();
  t.observe("read_file", { path: "a.cpp" }, true, READ);
  t.observe("edit_file", { path: "a.cpp" }, false, "no anchor");
  const o = t.observe("read_file", { path: "a.cpp" }, true, READ);
  return o.stallCalls === 2 && !o.progress;
})());

// --- warn then halt ---
check("the fourth stall call warns, exactly once", (() => {
  const t = new S.StallTracker();
  const out = [];
  // First observation is progress (new call); stalls start at the second.
  for (let i = 0; i < 6; i++) {
    out.push(t.observe("read_file", { path: "a.cpp" }, true, READ));
  }
  return (
    out[3].stallCalls === 3 &&
    !out[3].warn &&
    out[4].warn &&
    !out[4].trip &&
    !out[5].warn
  );
})());
check("the sixth stall call trips and stays tripped", (() => {
  const t = new S.StallTracker();
  const out = [];
  for (let i = 0; i < 8; i++) {
    out.push(t.observe("read_file", { path: "a.cpp" }, true, READ));
  }
  return out[6].trip && out[6].stallCalls === 6 && out[7].trip;
})());
check("one new read mid-loop resets the meter but does not save it", (() => {
  const t = new S.StallTracker();
  const sandbox = "sandbox.cpp text";
  let last = null;
  last = t.observe("read_file", { path: "sandbox.cpp" }, true, sandbox);
  last = t.observe("edit_file", { anchor: "A" }, false, "no anchor A");
  last = t.observe("read_file", { path: "sandbox.cpp" }, true, sandbox);
  last = t.observe("read_file", { path: "base85.cpp" }, true, "base85 text");
  last = t.observe("edit_file", { anchor: "B" }, false, "no anchor B");
  last = t.observe("read_file", { path: "sandbox.cpp" }, true, sandbox);
  last = t.observe("edit_file", { anchor: "C" }, false, "no anchor C");
  // Progress among the stall (base85 first read) resets once; the rest runs down.
  return last.trip === false && last.stallCalls === 3;
})());
check("LO's paste trips once the new file is also exhausted", (() => {
  const t = new S.StallTracker();
  const sandbox = "sandbox.cpp text";
  const base = "base85 text";
  const seq = [
    ["read_file", { path: "sandbox.cpp" }, true, sandbox],
    ["edit_file", { anchor: "A" }, false, "no anchor A"],
    ["read_file", { path: "sandbox.cpp" }, true, sandbox],
    ["read_file", { path: "base85.cpp" }, true, base],
    ["edit_file", { anchor: "B" }, false, "no anchor B"],
    ["read_file", { path: "sandbox.cpp" }, true, sandbox],
    ["read_file", { path: "base85.cpp" }, true, base],
    ["edit_file", { anchor: "C" }, false, "no anchor C"],
    ["read_file", { path: "sandbox.cpp" }, true, sandbox],
    ["read_file", { path: "base85.cpp" }, true, base],
  ];
  let last = null;
  for (const [n, a, ok, c] of seq) last = t.observe(n, a, ok, c);
  return last.trip && last.stallCalls === 6;
})());

// --- text ---
check(
  "warning names the count and the consequence",
  S.stallWarningText(4).includes("4 tool calls") &&
    /2 more unchanged calls stop the run/.test(S.stallWarningText(4))
);
check(
  "trip marker stays short for the saved transcript",
  S.stallTripMarker().length < 300
);
check(
  "user note quotes the recent actions and offers Resume",
  (() => {
    const note = S.stallTripUserNote([
      "read_file",
      "read_file",
      "edit_file",
      "read_file",
      "edit_file",
      "read_file",
    ]);
    return (
      note.includes("6 tool calls") &&
      note.includes("read_file ×2") &&
      note.includes("Resume")
    );
  })()
);

// --- route wiring ---
check(
  "route observes every tool result through the stall tracker",
  /stallTracker\.observe\(\s*call\.function\.name,\s*parsed\.ok \? parsed\.value : call\.function\.arguments,\s*result\.ok,\s*pristineResult\s*\)/.test(
    route
  )
);
check(
  "stall hashes pristine output, not marker-appended text",
  route.indexOf("const pristineResult = result.content;") <
    route.indexOf("stallTracker.observe(")
);
check(
  "stall trip halts with the no_progress stop reason",
  route.includes('stoppedPrematurely = "no_progress"')
);
check(
  "one halt flag serves both subsystems at both loop exits",
  (route.match(/if \(runHalted\) break;/g) ?? []).length === 2 &&
    route.includes("runHalted = true;")
);
check(
  "breaker trip skips the stall check — one halt, one note",
  /if \(!runHalted\) \{\s*const stall = stallTracker\.observe\(/.test(route)
);
check(
  "revive names the no_progress stop",
  R.prematureStopNotice("no_progress").includes("stalled")
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

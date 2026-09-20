/**
 * Circuit breaker for tool-call loops.
 *
 * Run:  npm run test:breaker
 *
 * The failure mode: the model sends the same tool call with identical
 * arguments, it fails, and the model sends it again unchanged — until the
 * round cap, each failure re-read and pattern-matched onto. Observed on a
 * free long-context model stuck re-sending one edit_file call with reads
 * interleaved between the retries.
 *
 * The rule: strikes are PER CALL. One call failing twice warns, three times
 * halts — interleaved work neither clears nor advances the count, because
 * the real loop reads between retries. Only that call succeeding clears
 * its strikes. Success repeats are never counted (polling is legitimate).
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const read = (p) => readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const LB = await load("src/lib/loop-breaker.ts");
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

// --- fingerprinting ---
check(
  "fingerprint is stable under key reorder",
  LB.fingerprintToolCall("edit_file", { a: 1, b: 2 }) ===
    LB.fingerprintToolCall("edit_file", { b: 2, a: 1 })
);
check(
  "fingerprint is stable under nested key reorder",
  LB.fingerprintToolCall("t", { o: { x: 1, y: [1, { p: 1, q: 2 }] } }) ===
    LB.fingerprintToolCall("t", { o: { y: [1, { q: 2, p: 1 }], x: 1 } })
);
check(
  "fingerprint differs on any changed value",
  LB.fingerprintToolCall("edit_file", { anchor: "a" }) !==
    LB.fingerprintToolCall("edit_file", { anchor: "b" })
);
check(
  "fingerprint differs across tool names",
  LB.fingerprintToolCall("read_file", { path: "x" }) !==
    LB.fingerprintToolCall("write_file", { path: "x" })
);
check(
  "raw-string args fingerprint deterministically",
  LB.fingerprintToolCall("t", "{oops") === LB.fingerprintToolCall("t", "{oops") &&
    LB.fingerprintToolCall("t", "{oops") !== LB.fingerprintToolCall("t", "{oops2")
);

// --- counting ---
const ARGS = { path: "main.cpp", anchor: "while (" };
const run = (steps) => {
  const b = new LB.LoopBreaker();
  return steps.map(([ok, args = ARGS, name = "edit_file"]) =>
    b.observe(name, args, ok)
  );
};
check("first failure is a quiet strike one", (() => {
  const [o] = run([[false]]);
  return o.repeats === 1 && !o.warn && !o.trip;
})());
check("second identical failure warns without tripping", (() => {
  const [, o] = run([[false], [false]]);
  return o.repeats === 2 && o.warn && !o.trip;
})());
check("third identical failure trips", (() => {
  const [, , o] = run([[false], [false], [false]]);
  return o.repeats === 3 && !o.warn && o.trip;
})());
check("a success resets the count", (() => {
  const seq = run([[false], [false], [true], [false]]);
  return seq[3].repeats === 1 && !seq[3].warn && !seq[3].trip;
})());
check("different calls keep separate strike counts", (() => {
  const b = new LB.LoopBreaker();
  b.observe("edit_file", ARGS, false);
  b.observe("edit_file", ARGS, false);
  const o = b.observe("read_file", { path: "main.cpp" }, false);
  return o.repeats === 1 && !o.warn && !o.trip;
})());
check("interleaved work does not clear strikes — the real loop trips", (() => {
  const b = new LB.LoopBreaker();
  b.observe("edit_file", ARGS, false);
  b.observe("read_file", { path: "main.cpp" }, true);
  const w = b.observe("edit_file", ARGS, false);
  b.observe("read_file", { path: "main.cpp" }, true);
  const t = b.observe("edit_file", ARGS, false);
  return w.warn && !w.trip && t.trip && t.repeats === 3;
})());
check("that same call succeeding clears only its own strikes", (() => {
  const b = new LB.LoopBreaker();
  b.observe("edit_file", ARGS, false);
  b.observe("read_file", { path: "x" }, false);
  b.observe("edit_file", ARGS, true);
  const e = b.observe("edit_file", ARGS, false);
  const r = b.observe("read_file", { path: "x" }, false);
  return e.repeats === 1 && !e.warn && r.repeats === 2 && r.warn;
})());
check("many distinct failures never warn or trip", (() => {
  const b = new LB.LoopBreaker();
  const out = ["a", "b", "c", "d"].map((n) =>
    b.observe(n, { q: n }, false)
  );
  return out.every((o) => o.repeats === 1 && !o.warn && !o.trip);
})());
check("changed arguments reset the count", (() => {
  const b = new LB.LoopBreaker();
  b.observe("edit_file", ARGS, false);
  b.observe("edit_file", ARGS, false);
  const o = b.observe("edit_file", { ...ARGS, anchor: "while (c" }, false);
  return o.repeats === 1 && !o.warn && !o.trip;
})());
check("success repeats never warn or trip", (() => {
  const seq = run([[true], [true], [true], [true], [true]]);
  return seq.every((o) => !o.warn && !o.trip);
})());

// --- text ---
check(
  "warning names the tool and the third-strike consequence",
  LB.loopWarningText("edit_file").includes("`edit_file`") &&
    /third identical failure stops the run/.test(LB.loopWarningText("edit_file"))
);
check(
  "trip marker stays short for the saved transcript",
  LB.loopTripMarker("edit_file").length < 300
);
check(
  "user note names the call and carries the last error",
  (() => {
    const note = LB.loopTripUserNote("edit_file", "anchor not found");
    return (
      note.includes("`edit_file`") &&
      note.includes("three times") &&
      note.includes("anchor not found") &&
      /Resume/.test(note)
    );
  })()
);
check(
  "user note truncates a huge error",
  LB.loopTripUserNote("t", "x".repeat(1000)).length < 600
);

// --- route wiring ---
check(
  "route observes every tool result through the breaker",
  /loopBreaker\.observe\(\s*call\.function\.name,\s*parsed\.ok \? parsed\.value : call\.function\.arguments,\s*result\.ok\s*\)/.test(
    route
  )
);
check(
  "breaker check sits before the tool message enters the transcript",
  (() => {
    // Order on the result path: observe, then the tool push carrying
    // result.content, then the client tool_result send. (An earlier
    // `role: "tool"` push in the pre-pass loop must not satisfy this.)
    const observed = route.indexOf("loopBreaker.observe(");
    const pushed = route.indexOf('role: "tool"', observed);
    const sent = route.indexOf('type: "tool_result"', observed);
    return observed > 0 && pushed > observed && sent > pushed;
  })()
);
check(
  "trip halts with the loop_breaker stop reason",
  route.includes('stoppedPrematurely = "loop_breaker"')
);
check(
  "trip breaks out of both the calls loop and the rounds loop",
  (route.match(/if \(breakerTripped\) break;/g) ?? []).length === 2
);
check(
  "revive names the loop_breaker stop",
  R.prematureStopNotice("loop_breaker").includes("three times")
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

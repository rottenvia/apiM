// Hidden grader for js-debounce-throttle. cwd = copy of the agent's workspace.
// Drives time with a fake clock; only one short real-timer test for the
// default clock.
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

let cases = 0;
let passed = 0;
async function test(label, fn) {
  cases++;
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), 3000))]);
    passed++;
  } catch (e) {
    console.log(`FAIL ${label}: ${String(e?.message ?? e).split("\n").slice(0, 4).join(" ")}`);
  }
}
function finish() {
  console.log(`SCORE ${passed}/${cases}`);
  process.exit(passed === cases ? 0 : 1);
}

let debounce, throttle;
try {
  ({ debounce, throttle } = await import(pathToFileURL(path.resolve("timing.js")).href));
  if (typeof debounce !== "function" || typeof throttle !== "function") throw new Error("timing.js must export debounce and throttle");
} catch (e) {
  console.log(`FAIL import timing.js: ${e.message}`);
  cases = 1;
  finish();
}

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout: (cb, ms, ...args) => {
      const id = ++seq;
      const delay = Math.max(0, Number(ms) || 0);
      timers.set(id, { at: now + delay, cb, args, seq: id });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
  };
  function advanceTo(t) {
    for (let guard = 0; guard < 100000; guard++) {
      let next = null;
      for (const tm of timers.values()) {
        if (tm.at <= t && (!next || tm.at < next.at || (tm.at === next.at && tm.seq < next.seq))) next = tm;
      }
      if (!next) break;
      timers.delete(next.seq);
      now = Math.max(now, next.at);
      next.cb(...next.args);
    }
    now = Math.max(now, t);
  }
  return { clock, advanceTo, get now() { return now; } };
}

/**
 * Wrap fn with make(fn, clock), call it at the given times (the call's arg is
 * its time), run to `end`, and return the invocations as "arg@time".
 */
function scenario(make, callTimes, end) {
  const fc = fakeClock();
  const log = [];
  const wrapped = make((arg) => {
    log.push(`${arg}@${fc.now}`);
    return arg;
  }, fc.clock);
  for (const t of callTimes) {
    fc.advanceTo(t);
    wrapped(t);
  }
  fc.advanceTo(end);
  return log;
}
const range = (from, to, step) => {
  const out = [];
  for (let t = from; t <= to; t += step) out.push(t);
  return out;
};

// ------------------------------------------------------------ debounce
await test("debounce: trailing call with the latest args after the burst", () => {
  assert.deepEqual(scenario((f, clock) => debounce(f, 50, { clock }), [0, 10, 20], 500), ["20@70"]);
});

await test("debounce: separate bursts are invoked separately", () => {
  assert.deepEqual(scenario((f, clock) => debounce(f, 50, { clock }), [0, 49, 100, 160, 205], 1000), ["49@99", "100@150", "205@255"]);
});

await test("debounce: leading only — the burst keeps extending with each call", () => {
  const make = (f, clock) => debounce(f, 50, { leading: true, trailing: false, clock });
  assert.deepEqual(scenario(make, [0, 30, 60, 90, 130, 200], 1000), ["0@0", "200@200"]);
});

await test("debounce: leading + trailing", () => {
  const make = (f, clock) => debounce(f, 50, { leading: true, clock });
  assert.deepEqual(scenario(make, [0], 500), ["0@0"], "single call must not be invoked twice");
  assert.deepEqual(scenario(make, [0, 20, 40, 300], 1000), ["0@0", "40@90", "300@300"]);
});

await test("debounce: maxWait forces invocations during a long burst", () => {
  const make = (f, clock) => debounce(f, 50, { maxWait: 105, clock });
  assert.deepEqual(scenario(make, range(0, 240, 20), 1000), ["100@105", "200@210", "240@290"]);
});

await test("debounce: maxWait with leading", () => {
  const make = (f, clock) => debounce(f, 50, { leading: true, maxWait: 120, clock });
  assert.deepEqual(scenario(make, range(0, 300, 25), 1000), ["0@0", "100@120", "225@240", "300@350"]);
});

await test("debounce: maxWait longer than the burst has no effect", () => {
  const make = (f, clock) => debounce(f, 50, { maxWait: 500, clock });
  assert.deepEqual(scenario(make, [0, 30, 60, 400], 1000), ["60@110", "400@450"]);
});

await test("debounce: forwards this and all arguments", () => {
  const fc = fakeClock();
  let seen;
  const d = debounce(function (...args) { seen = { self: this, args }; }, 30, { clock: fc.clock });
  const obj = { d };
  obj.d(1, "two", 3);
  fc.advanceTo(100);
  assert.equal(seen?.self, obj);
  assert.deepEqual(seen.args, [1, "two", 3]);
});

await test("debounce: returns the most recent result", () => {
  const fc = fakeClock();
  const d = debounce((x) => x * 2, 50, { leading: true, clock: fc.clock });
  assert.equal(d(1), 2, "leading invocation's result is returned by the same call");
  fc.advanceTo(10);
  assert.equal(d(5), 2);
  fc.advanceTo(100); // trailing invocation with 5
  fc.advanceTo(200);
  assert.equal(d(7), 14, "new burst leading result");
  const t = debounce((x) => x + 1, 50, { clock: fc.clock });
  assert.equal(t(1), undefined, "nothing invoked yet");
  fc.advanceTo(300);
  assert.equal(t(10), 2);
});

await test("debounce: cancel drops the trailing call and resets", () => {
  const fc = fakeClock();
  const log = [];
  const d = debounce((x) => log.push(`${x}@${fc.now}`), 50, { leading: true, clock: fc.clock });
  d(0);
  fc.advanceTo(10);
  d(10);
  assert.equal(d.pending(), true);
  fc.advanceTo(20);
  d.cancel();
  assert.equal(d.pending(), false);
  fc.advanceTo(30);
  d(30); // new burst -> leading
  fc.advanceTo(500);
  assert.deepEqual(log, ["0@0", "30@30"]);
});

await test("debounce: flush invokes now and ends the burst", () => {
  const fc = fakeClock();
  const log = [];
  const d = debounce((x) => (log.push(`${x}@${fc.now}`), x * 10), 50, { clock: fc.clock });
  assert.equal(d.flush(), undefined, "flush with nothing pending");
  d(0);
  fc.advanceTo(10);
  d(10);
  fc.advanceTo(20);
  assert.equal(d.flush(), 100);
  assert.equal(d.pending(), false);
  fc.advanceTo(500);
  assert.deepEqual(log, ["10@20"]);
  assert.equal(d.flush(), 100, "flush with nothing pending returns the last result");
  assert.deepEqual(log, ["10@20"]);
});

await test("debounce: pending() tracks the trailing invocation", () => {
  const fc = fakeClock();
  const d = debounce(() => {}, 50, { clock: fc.clock });
  assert.equal(d.pending(), false);
  d();
  assert.equal(d.pending(), true);
  fc.advanceTo(49);
  assert.equal(d.pending(), true);
  fc.advanceTo(50);
  assert.equal(d.pending(), false);
  const l = debounce(() => {}, 50, { leading: true, clock: fc.clock });
  l();
  assert.equal(l.pending(), false, "a single leading call leaves nothing pending");
  l();
  assert.equal(l.pending(), true);
});

await test("debounce: no clock falls back to real timers", async () => {
  let n = 0;
  const d = debounce(() => n++, 20);
  d();
  d();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(n, 1);
});

// ------------------------------------------------------------ throttle
await test("throttle: leading + trailing windows", () => {
  const make = (f, clock) => throttle(f, 40, { clock });
  assert.deepEqual(scenario(make, [0, 10, 25, 35, 50, 70, 75, 130], 1000), ["0@0", "35@40", "75@80", "130@130"]);
});

await test("throttle: steady stream invokes once per window", () => {
  const make = (f, clock) => throttle(f, 50, { clock });
  assert.deepEqual(scenario(make, range(0, 196, 7), 1000), ["0@0", "49@50", "98@100", "147@150", "196@200"]);
});

await test("throttle: leading false", () => {
  const make = (f, clock) => throttle(f, 40, { leading: false, clock });
  assert.deepEqual(scenario(make, [5, 10, 30, 60, 100], 1000), ["30@45", "60@85", "100@125"]);
});

await test("throttle: trailing false drops calls inside a window", () => {
  const make = (f, clock) => throttle(f, 40, { trailing: false, clock });
  assert.deepEqual(scenario(make, [0, 10, 39, 41, 60, 85], 1000), ["0@0", "41@41", "85@85"]);
});

await test("throttle: forwards this/args and returns the latest result", () => {
  const fc = fakeClock();
  const obj = {
    k: 3,
    t: throttle(function (x, y) { return this.k * x + y; }, 50, { clock: fc.clock }),
  };
  assert.equal(obj.t(2, 1), 7);
  fc.advanceTo(10);
  assert.equal(obj.t(10, 0), 7);
  fc.advanceTo(60);
  assert.equal(obj.t(1, 1), 30, "trailing invocation at 50 returned 30");
});

await test("throttle: cancel drops the pending call and resets", () => {
  const fc = fakeClock();
  const log = [];
  const t = throttle((x) => log.push(`${x}@${fc.now}`), 50, { clock: fc.clock });
  t(0);
  fc.advanceTo(10);
  t(10);
  assert.equal(t.pending(), true);
  fc.advanceTo(20);
  t.cancel();
  assert.equal(t.pending(), false);
  fc.advanceTo(30);
  t(30);
  fc.advanceTo(500);
  assert.deepEqual(log, ["0@0", "30@30"]);
});

await test("throttle: flush performs the pending call now", () => {
  const fc = fakeClock();
  const log = [];
  const t = throttle((x) => (log.push(`${x}@${fc.now}`), x), 50, { clock: fc.clock });
  t(0);
  fc.advanceTo(10);
  t(10);
  fc.advanceTo(20);
  assert.equal(t.flush(), 10);
  assert.equal(t.pending(), false);
  fc.advanceTo(500);
  assert.deepEqual(log, ["0@0", "10@20"]);
});

await test("throttle: a call after the windows have closed is leading again", () => {
  const make = (f, clock) => throttle(f, 30, { clock });
  assert.deepEqual(scenario(make, [0, 5, 100, 101, 102, 300], 1000), ["0@0", "5@30", "100@100", "102@130", "300@300"]);
});

finish();

// Hidden grader for js-event-emitter. cwd = copy of the agent's workspace.
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

let cases = 0;
let passed = 0;
async function test(label, fn) {
  cases++;
  try {
    await fn();
    passed++;
  } catch (e) {
    console.log(`FAIL ${label}: ${String(e?.message ?? e).split("\n")[0]}`);
  }
}
function finish() {
  console.log(`SCORE ${passed}/${cases}`);
  process.exit(passed === cases ? 0 : 1);
}

let EventEmitter;
try {
  ({ EventEmitter } = await import(pathToFileURL(path.resolve("emitter.js")).href));
  if (typeof EventEmitter !== "function") throw new Error("emitter.js does not export EventEmitter");
} catch (e) {
  console.log(`FAIL import emitter.js: ${e.message}`);
  cases = 1;
  finish();
}

await test("on + emit passes args in registration order", () => {
  const e = new EventEmitter();
  const log = [];
  e.on("x", (a, b) => log.push(["1", a, b]));
  e.on("x", (a, b) => log.push(["2", a, b]));
  assert.equal(e.emit("x", 1, 2), true);
  assert.deepEqual(log, [["1", 1, 2], ["2", 1, 2]]);
});

await test("emit with no listeners returns false", () => {
  const e = new EventEmitter();
  assert.equal(e.emit("nothing", 1), false);
});

await test("listener is called with this = emitter", () => {
  const e = new EventEmitter();
  let self;
  e.on("x", function () { self = this; });
  e.emit("x");
  assert.equal(self, e);
});

await test("on/once/off/removeAllListeners chain", () => {
  const e = new EventEmitter();
  const f = () => {};
  assert.equal(e.on("a", f), e);
  assert.equal(e.once("a", f), e);
  assert.equal(e.off("a", f), e);
  assert.equal(e.removeAllListeners("a"), e);
});

await test("on with a non-function throws TypeError", () => {
  const e = new EventEmitter();
  assert.throws(() => e.on("x", "nope"), TypeError);
  assert.throws(() => e.once("x", null), TypeError);
});

await test("same function added twice is called twice; off removes one", () => {
  const e = new EventEmitter();
  let n = 0;
  const f = () => n++;
  e.on("x", f).on("x", f);
  assert.equal(e.listenerCount("x"), 2);
  e.emit("x");
  assert.equal(n, 2);
  e.off("x", f);
  assert.equal(e.listenerCount("x"), 1);
  e.emit("x");
  assert.equal(n, 3);
  e.off("x", f).off("x", f);
  assert.equal(e.listenerCount("x"), 0);
  assert.equal(e.emit("x"), false);
});

await test("off removes the most recently added registration", () => {
  const e = new EventEmitter();
  const log = [];
  const f = () => log.push("f");
  const g = () => log.push("g");
  e.on("x", f).on("x", g).on("x", f);
  e.off("x", f);
  e.emit("x");
  assert.deepEqual(log, ["f", "g"]);
  assert.deepEqual(e.listeners("x"), [f, g]);
});

await test("once runs exactly once", () => {
  const e = new EventEmitter();
  let n = 0;
  e.once("x", () => n++);
  assert.equal(e.emit("x"), true);
  assert.equal(e.emit("x"), false);
  assert.equal(n, 1);
  assert.equal(e.listenerCount("x"), 0);
});

await test("once listener re-emitting the same event is not called again", () => {
  const e = new EventEmitter();
  let n = 0;
  let countInside = -1;
  e.once("x", () => {
    n++;
    countInside = e.listenerCount("x");
    e.emit("x");
  });
  e.emit("x");
  assert.equal(n, 1);
  assert.equal(countInside, 0);
});

await test("off with the original function removes a once registration", () => {
  const e = new EventEmitter();
  let n = 0;
  const f = () => n++;
  e.once("x", f);
  assert.deepEqual(e.listeners("x"), [f]);
  e.off("x", f);
  e.emit("x");
  assert.equal(n, 0);
  assert.equal(e.listenerCount("x"), 0);
});

await test("listener added during emit is not called by that emit", () => {
  const e = new EventEmitter();
  const log = [];
  e.on("x", () => {
    log.push("a");
    e.on("x", () => log.push("late"));
  });
  e.emit("x");
  assert.deepEqual(log, ["a"]);
  e.emit("x");
  assert.deepEqual(log, ["a", "a", "late"]);
});

await test("listener removed during emit (before its turn) is not called", () => {
  const e = new EventEmitter();
  const log = [];
  const b = () => log.push("b");
  const c = () => log.push("c");
  e.on("x", () => { log.push("a"); e.off("x", b); });
  e.on("x", b);
  e.on("x", c);
  e.emit("x");
  assert.deepEqual(log, ["a", "c"]);
});

await test("removing one of two duplicate registrations during emit skips only that one", () => {
  const e = new EventEmitter();
  let n = 0;
  const f = () => n++;
  e.on("x", () => e.off("x", f)); // removes the most recent f
  e.on("x", f);
  e.on("x", f);
  e.emit("x");
  assert.equal(n, 1);
  assert.equal(e.listenerCount("x"), 2);
});

await test("removeAllListeners during emit stops the remaining listeners", () => {
  const e = new EventEmitter();
  const log = [];
  e.on("x", () => { log.push("a"); e.removeAllListeners("x"); });
  e.on("x", () => log.push("b"));
  e.emit("x");
  assert.deepEqual(log, ["a"]);
  assert.equal(e.listenerCount("x"), 0);
});

await test("removing an already-run listener during emit does not skip later ones", () => {
  const e = new EventEmitter();
  const log = [];
  const a = () => log.push("a");
  e.on("x", a);
  e.on("x", () => { log.push("b"); e.off("x", a); });
  e.on("x", () => log.push("c"));
  e.emit("x");
  assert.deepEqual(log, ["a", "b", "c"]);
});

await test("a throwing listener propagates and stops the emit", () => {
  const e = new EventEmitter();
  const log = [];
  const boom = new Error("boom");
  e.on("x", () => { throw boom; });
  e.on("x", () => log.push("after"));
  assert.throws(() => e.emit("x"), (err) => err === boom);
  assert.deepEqual(log, []);
});

await test("emit('error', err) with no listener throws err", () => {
  const e = new EventEmitter();
  const err = new RangeError("bad");
  assert.throws(() => e.emit("error", err), (x) => x === err);
});

await test("emit('error', non-Error) with no listener throws an Error mentioning it", () => {
  const e = new EventEmitter();
  assert.throws(() => e.emit("error", "disk full"), (x) => x instanceof Error && x.message.includes("disk full"));
});

await test("emit('error') with a listener calls it instead of throwing", () => {
  const e = new EventEmitter();
  let got;
  e.on("error", (err) => { got = err; });
  const err = new Error("x");
  assert.equal(e.emit("error", err), true);
  assert.equal(got, err);
});

await test("once 'error' listener handles one error, the next one throws", () => {
  const e = new EventEmitter();
  let n = 0;
  e.once("error", () => n++);
  e.emit("error", new Error("1"));
  assert.throws(() => e.emit("error", new Error("2")), /2/);
  assert.equal(n, 1);
});

await test("event names like constructor / __proto__ / toString and symbols work", () => {
  const e = new EventEmitter();
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(e.listenerCount(name), 0, `listenerCount(${name}) should be 0`);
    assert.deepEqual(e.listeners(name), []);
    assert.equal(e.emit(name), false, `emit(${name}) with no listeners`);
    let hit = 0;
    e.on(name, () => hit++);
    assert.equal(e.emit(name), true);
    assert.equal(hit, 1);
    assert.equal(e.listenerCount(name), 1);
  }
  const s = Symbol("s");
  let got;
  e.on(s, (v) => { got = v; });
  e.emit(s, 7);
  assert.equal(got, 7);
  assert.equal(e.listenerCount(Symbol("s")), 0);
});

await test("listeners() returns a copy", () => {
  const e = new EventEmitter();
  const f = () => {};
  e.on("x", f);
  const arr = e.listeners("x");
  arr.push(() => {});
  arr.length = 0;
  assert.equal(e.listenerCount("x"), 1);
  assert.deepEqual(e.listeners("x"), [f]);
});

await test("removeAllListeners() without args clears every event", () => {
  const e = new EventEmitter();
  e.on("a", () => {}).on("b", () => {}).once("c", () => {});
  e.removeAllListeners();
  assert.equal(e.listenerCount("a") + e.listenerCount("b") + e.listenerCount("c"), 0);
  assert.equal(e.emit("a"), false);
});

await test("emitters do not share listeners", () => {
  const a = new EventEmitter();
  const b = new EventEmitter();
  a.on("x", () => {});
  assert.equal(b.listenerCount("x"), 0);
});

finish();

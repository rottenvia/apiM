// Hidden grader for js-callbacks-to-async. cwd = copy of the agent's workspace.
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

// Stray errors from the agent's code must not kill the grader; they are
// reported by the last case instead.
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));
process.on("uncaughtException", (e) => unhandled.push(e));

let cases = 0;
let passed = 0;
async function test(label, fn) {
  cases++;
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("timed out (promise never settled?)")), 4000)))]);
    passed++;
  } catch (e) {
    console.log(`FAIL ${label}: ${String(e?.message ?? e).split("\n").slice(0, 4).join(" ")}`);
  } finally {
    clearTimeout(timer);
  }
}
function finish() {
  console.log(`SCORE ${passed}/${cases}`);
  process.exit(passed === cases ? 0 : 1);
}

let lib;
try {
  lib = await import(pathToFileURL(path.resolve("index.js")).href);
} catch (e) {
  console.log(`FAIL import index.js: ${e.message}`);
  cases = 1;
  finish();
}
const { readRecord, writeRecord, listIds, parseRecord, mapLimit, withRetry, loadAll, buildReport } = lib;

const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isThenable = (x) => x !== null && (typeof x === "object" || typeof x === "function") && typeof x.then === "function";

function isErr(e, name) {
  const cls = lib[name];
  return (typeof cls === "function" && e instanceof cls) || e?.name === name;
}
/** Calls fn(); it must return a promise (not throw synchronously) that rejects. Returns the error. */
async function rejects(fn, check, what) {
  let p;
  try {
    p = fn();
  } catch (e) {
    throw new Error(`${what}: threw synchronously (${e?.name}: ${e?.message}) instead of returning a rejected promise`);
  }
  assert.ok(isThenable(p), `${what}: did not return a promise`);
  let err = null;
  let value;
  try {
    value = await p;
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${what}: resolved (${JSON.stringify(value)}) instead of rejecting`);
  if (check) assert.ok(check(err), `${what}: rejected with the wrong error: ${err?.name}: ${err?.message}`);
  return err;
}

let fxCount = 0;
function fixture(records, extra = {}) {
  const dir = path.resolve(".bench_check", `fx-${++fxCount}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const r of records) fs.writeFileSync(path.join(dir, `${r.id}.json`), JSON.stringify(r));
  for (const [name, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
const REC = [
  { id: "b-2", date: "2024-01-05", category: "Food", amount: 10.25, note: "lunch" },
  { id: "a-1", date: "2024-01-02", category: " travel ", amount: 99.99 },
  { id: "c-3", date: "2024-01-09", category: "food", amount: 4.75 },
  { id: "d-4", date: "2024-02-01", category: "Books", amount: 30 },
  { id: "e-5", date: "2024-02-03", category: "travel", amount: 0.01 },
  { id: "f-6", date: "2024-02-04", category: "books", amount: 30 },
];
const norm = (r) => ({ id: r.id, date: r.date, category: r.category.trim().toLowerCase(), amountCents: Math.round(r.amount * 100), note: r.note ?? "" });

// ------------------------------------------------------------ API shape
await test("index.js exports the whole API", () => {
  for (const name of ["readRecord", "writeRecord", "listIds", "parseRecord", "mapLimit", "withRetry", "loadAll", "buildReport"]) {
    assert.equal(typeof lib[name], "function", `${name} is not exported`);
  }
  for (const name of ["NotFoundError", "ValidationError"]) assert.equal(typeof lib[name], "function", `${name} is not exported`);
});

await test("no exported function takes a callback any more", async () => {
  const maxLen = { readRecord: 2, writeRecord: 3, listIds: 1, parseRecord: 1, mapLimit: 3, withRetry: 2, loadAll: 2, buildReport: 2 };
  for (const [name, n] of Object.entries(maxLen)) {
    assert.ok(lib[name].length <= n, `${name}.length is ${lib[name].length}; it still declares a callback parameter?`);
  }
  // Static: no exported function declares a cb/callback/done parameter.
  const files = ["index.js", ...fs.readdirSync("lib").filter((f) => f.endsWith(".js")).map((f) => path.join("lib", f))];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*(\w+)\s*\(([^)]*)\)/g)) {
      assert.ok(!/\b(cb|callback|done|next)\b/.test(m[2]), `${f}: ${m[1]}(${m[2].trim()}) still takes a callback`);
    }
  }
  // Behavioural: an extra trailing function is never called, and a promise comes back.
  const dir = fixture(REC.slice(0, 2));
  const spy = () => {
    spy.called = true;
  };
  const calls = {
    readRecord: () => readRecord(dir, "a-1", spy),
    writeRecord: () => writeRecord(dir, "_tmp", { x: 1 }, spy),
    listIds: () => listIds(dir, spy),
    parseRecord: () => parseRecord(JSON.stringify(REC[0]), spy),
    mapLimit: () => mapLimit([1, 2], 2, async (x) => x, spy),
    withRetry: () => withRetry(async () => 1, { retries: 0, delayMs: 1 }, spy),
    loadAll: () => loadAll(dir, { concurrency: 2 }, spy),
    buildReport: () => buildReport(dir, {}, spy),
  };
  for (const [name, call] of Object.entries(calls)) {
    spy.called = false;
    const p = call();
    assert.ok(isThenable(p), `${name}(...) did not return a promise`);
    await Promise.race([p, sleep(1500)]);
    await sleep(20);
    assert.ok(!spy.called, `${name} called the trailing callback argument`);
  }
});

// ------------------------------------------------------------ parse / store
await test("parseRecord resolves to the normalized record", async () => {
  const p = parseRecord(JSON.stringify(REC[1]));
  assert.ok(isThenable(p), "parseRecord must return a promise");
  assert.deepEqual(await p, norm(REC[1]));
  assert.deepEqual(await parseRecord(JSON.stringify(REC[0])), norm(REC[0]));
});

await test("parseRecord rejects invalid input with ValidationError", async () => {
  await rejects(() => parseRecord("{not json"), (e) => isErr(e, "ValidationError"), "bad JSON");
  await rejects(() => parseRecord(JSON.stringify({ id: "x", date: "2024-01-01", amount: 1 })), (e) => isErr(e, "ValidationError"), "missing category");
  await rejects(() => parseRecord(JSON.stringify({ id: "x", date: "2024-01-01", category: "a", amount: -1 })), (e) => isErr(e, "ValidationError"), "negative amount");
});

await test("readRecord: found, missing, bad id, bad content", async () => {
  const dir = fixture(REC, { "bad.json": '{"id":"bad","date":"yesterday","category":"x","amount":1}' });
  assert.deepEqual(await readRecord(dir, "c-3"), norm(REC[2]));
  const e = await rejects(() => readRecord(dir, "nope"), (e) => isErr(e, "NotFoundError"), "missing record");
  assert.ok(e.code !== "ENOENT" || isErr(e, "NotFoundError"));
  await rejects(() => readRecord(dir, "../etc/passwd"), (e) => isErr(e, "ValidationError"), "bad id");
  await rejects(() => readRecord(dir, "bad"), (e) => isErr(e, "ValidationError"), "invalid record content");
});

await test("writeRecord writes JSON atomically and rejects bad ids / bad dirs", async () => {
  const dir = fixture([]);
  const p = writeRecord(dir, "out-1", { hello: "world", n: [1, 2] });
  assert.ok(isThenable(p), "writeRecord must return a promise");
  await p;
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "out-1.json"), "utf8")), { hello: "world", n: [1, 2] });
  assert.deepEqual(fs.readdirSync(dir), ["out-1.json"], "temporary files left behind");
  await rejects(() => writeRecord(dir, "../escape", {}), (e) => isErr(e, "ValidationError"), "bad id");
  await rejects(() => writeRecord(path.join(dir, "missing-subdir"), "x", {}), (e) => e?.code === "ENOENT", "missing directory");
});

await test("listIds lists record ids sorted, skipping _files and non-json", async () => {
  const dir = fixture(REC, { "_report.json": "{}", "notes.txt": "hi", "z.json.bak": "{}", "_draft.json": "{}" });
  assert.deepEqual(await listIds(dir), ["a-1", "b-2", "c-3", "d-4", "e-5", "f-6"]);
  await rejects(() => listIds(path.join(dir, "nope")), (e) => e?.code === "ENOENT", "missing directory");
});

// ------------------------------------------------------------ mapLimit
await test("mapLimit keeps `limit` iterators running (sliding window) and preserves order", async () => {
  const started = [];
  const ctl = {};
  let inFlight = 0;
  let maxInFlight = 0;
  const items = ["a", "b", "c", "d", "e", "f"];
  const p = mapLimit(items, 2, (item, index) => {
    started.push(`${item}${index}`);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((res, rej) => {
      ctl[item] = { res: (v) => (inFlight--, res(v)), rej: (e) => (inFlight--, rej(e)) };
    });
  });
  assert.ok(isThenable(p), "mapLimit must return a promise");
  await tick();
  assert.deepEqual(started, ["a0", "b1"]);
  ctl.b.res("B");
  await tick();
  assert.deepEqual(started, ["a0", "b1", "c2"], "the next item must start as soon as one finishes");
  ctl.a.res("A");
  await tick();
  assert.deepEqual(started, ["a0", "b1", "c2", "d3"]);
  ctl.d.res("D");
  await tick();
  ctl.c.res("C");
  await tick();
  assert.deepEqual(started, ["a0", "b1", "c2", "d3", "e4", "f5"]);
  ctl.f.res("F");
  ctl.e.res("E");
  assert.deepEqual(await p, ["A", "B", "C", "D", "E", "F"]);
  assert.equal(maxInFlight, 2);
});

await test("mapLimit stops starting items after the first error and rejects with it", async () => {
  const started = [];
  const ctl = {};
  const p = mapLimit([0, 1, 2, 3, 4, 5, 6, 7], 3, (item) => {
    started.push(item);
    return new Promise((res, rej) => (ctl[item] = { res, rej }));
  });
  let settled = null;
  p.then((v) => (settled = { v }), (e) => (settled = { e }));
  await tick();
  assert.deepEqual(started, [0, 1, 2]);
  ctl[1].res(1);
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3]);
  const first = new Error("first");
  ctl[3].rej(first);
  await tick();
  assert.ok(settled && settled.e === first, `expected rejection with the first error, got ${settled ? (settled.e ? settled.e.message : "resolved") : "still pending"}`);
  ctl[0].res(0);
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3], "no new items may start after a failure");
  ctl[2].rej(new Error("second"));
  await tick();
  assert.equal(settled.e, first);
  assert.deepEqual(started, [0, 1, 2, 3], "no new items may start after a failure");
});

await test("mapLimit: empty input, plain values, sync throws, limit 1", async () => {
  let called = false;
  assert.deepEqual(await mapLimit([], 3, () => (called = true)), []);
  assert.equal(called, false);
  assert.deepEqual(await mapLimit([1, 2, 3], 10, (x, i) => x * 10 + i), [10, 21, 32]);
  const boom = new Error("sync boom");
  await rejects(() => mapLimit([1, 2, 3], 2, (x) => {
    if (x === 2) throw boom;
    return x;
  }), (e) => e === boom, "iterator throwing synchronously");
  let inFlight = 0;
  let maxInFlight = 0;
  const out = await mapLimit([30, 5, 15, 1], 1, async (ms) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(ms);
    inFlight--;
    return ms;
  });
  assert.deepEqual(out, [30, 5, 15, 1]);
  assert.equal(maxInFlight, 1);
});

await test("mapLimit with real timers: results in input order, not completion order", async () => {
  const out = await mapLimit([40, 10, 30, 5, 20], 3, async (ms, i) => {
    await sleep(ms);
    return `${i}:${ms}`;
  });
  assert.deepEqual(out, ["0:40", "1:10", "2:30", "3:5", "4:20"]);
});

// ------------------------------------------------------------ withRetry
await test("withRetry resolves after transient failures", async () => {
  let attempts = 0;
  const p = withRetry(async () => {
    attempts++;
    if (attempts < 3) throw new Error(`fail ${attempts}`);
    return "done";
  }, { retries: 3, delayMs: 5 });
  assert.ok(isThenable(p), "withRetry must return a promise");
  assert.equal(await p, "done");
  assert.equal(attempts, 3);
});

await test("withRetry rejects with the last error after retries+1 attempts, then stops", async () => {
  let attempts = 0;
  const err = await rejects(() => withRetry(async () => {
    attempts++;
    throw new Error(`fail ${attempts}`);
  }, { retries: 2, delayMs: 5 }), null, "always failing task");
  assert.equal(err.message, "fail 3");
  assert.equal(attempts, 3);
  await sleep(60);
  assert.equal(attempts, 3, "no attempts may happen after the promise settled");
});

await test("withRetry waits delayMs between attempts and honours retries: 0", async () => {
  let attempts = 0;
  const t0 = Date.now();
  await withRetry(async () => {
    if (++attempts < 2) throw new Error("x");
    return 1;
  }, { retries: 1, delayMs: 80 });
  assert.ok(Date.now() - t0 >= 70, `second attempt came after ${Date.now() - t0}ms, expected >= 80ms`);
  let once = 0;
  await rejects(() => withRetry(async () => {
    once++;
    throw new Error("nope");
  }, { retries: 0, delayMs: 1 }), (e) => e.message === "nope", "retries: 0");
  await sleep(20);
  assert.equal(once, 1);
});

await test("withRetry defaults (2 retries) and synchronous throws in the task", async () => {
  let attempts = 0;
  await rejects(() => withRetry(() => {
    attempts++;
    throw new Error("sync");
  }), (e) => e.message === "sync", "always failing task with defaults");
  assert.equal(attempts, 3);
});

// ------------------------------------------------------------ loadAll / buildReport
await test("loadAll resolves to every record in id order", async () => {
  const dir = fixture(REC, { "_report.json": "{}", "readme.txt": "x" });
  const records = await loadAll(dir, { concurrency: 2 });
  assert.deepEqual(records, [...REC].sort((a, b) => (a.id < b.id ? -1 : 1)).map(norm));
  assert.deepEqual(await loadAll(fixture([])), []);
});

await test("loadAll rejects when a record is invalid or the dir is missing", async () => {
  const dir = fixture(REC, { "c-0.json": "{broken" });
  await rejects(() => loadAll(dir, { concurrency: 3 }), (e) => isErr(e, "ValidationError"), "invalid record");
  await rejects(() => loadAll(path.join(dir, "nope")), (e) => e?.code === "ENOENT", "missing dir");
});

const EXPECTED_REPORT = {
  count: 6,
  totalCents: 17500,
  categories: [
    { category: "travel", count: 2, totalCents: 10000 },
    { category: "books", count: 2, totalCents: 6000 },
    { category: "food", count: 2, totalCents: 1500 },
  ],
  ids: ["a-1", "b-2", "c-3", "d-4", "e-5", "f-6"],
};

await test("buildReport resolves to the report and saves _report.json", async () => {
  const dir = fixture(REC);
  const report = await buildReport(dir, { concurrency: 2 });
  assert.deepEqual(report, EXPECTED_REPORT);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "_report.json"), "utf8")), EXPECTED_REPORT);
  assert.deepEqual(await buildReport(dir), EXPECTED_REPORT, "second run must ignore _report.json");
});

await test("buildReport rejects on an invalid record and writes nothing", async () => {
  const dir = fixture(REC, { "zz.json": JSON.stringify({ id: "zz", date: "2024-13", category: "x", amount: 1 }) });
  await rejects(() => buildReport(dir), (e) => isErr(e, "ValidationError"), "invalid record");
  assert.ok(!fs.existsSync(path.join(dir, "_report.json")), "_report.json must not be written");
});

// ------------------------------------------------------------ example.js
await test("example.js uses the promise API and prints the right output", () => {
  const src = fs.readFileSync("example.js", "utf8");
  assert.ok(!/\(\s*err\w*\s*,\s*\w+\s*\)\s*=>|function\s*\w*\s*\(\s*err\w*\s*,|\(\s*\w+\s*,\s*\w+\s*,\s*cb\s*\)|\(\s*cb\s*\)\s*=>/.test(src), "example.js still contains error-first callbacks");
  assert.ok(/\bawait\b|\.then\s*\(/.test(src), "example.js does not use the promise API");
  fs.rmSync(path.join("samples", "_report.json"), { force: true });
  const r = spawnSync(process.execPath, ["example.js"], { encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH ?? "" } });
  assert.equal(r.status, 0, `example.js exited with ${r.status}: ${(r.stderr || "").trim().split("\n").slice(-2).join(" ")}`);
  const want = [
    "records: 5",
    "total: 1018.65",
    "  rent: 1 / 950.00",
    "  groceries: 2 / 53.45",
    "  transport: 2 / 15.20",
    "missing record: NotFoundError",
    "flaky: ok after 3 attempts",
    "mapLimit: 0:ALPHA 1:BETA 2:GAMMA 3:DELTA",
  ].join("\n");
  assert.equal(r.stdout.trimEnd(), want, `example output:\n${r.stdout}`);
});

await test("no unhandled rejections or uncaught exceptions", async () => {
  await sleep(50);
  assert.equal(unhandled.length, 0, `unhandled: ${unhandled.map((e) => e?.message ?? e).join("; ")}`);
});

finish();

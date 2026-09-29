// Hidden grader for js-natural-sort. cwd = copy of the agent's workspace.
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

let cases = 0;
let passed = 0;
function test(label, fn) {
  cases++;
  try {
    fn();
    passed++;
  } catch (e) {
    console.log(`FAIL ${label}: ${String(e?.message ?? e).split("\n").slice(0, 4).join(" ")}`);
  }
}
function finish() {
  console.log(`SCORE ${passed}/${cases}`);
  process.exit(passed === cases ? 0 : 1);
}

let naturalCompare, naturalSort;
try {
  ({ naturalCompare, naturalSort } = await import(pathToFileURL(path.resolve("natsort.js")).href));
  if (typeof naturalCompare !== "function" || typeof naturalSort !== "function") throw new Error("natsort.js must export naturalCompare and naturalSort");
} catch (e) {
  console.log(`FAIL import natsort.js: ${e.message}`);
  cases = 1;
  finish();
}

// ---- reference ordering (used only for the randomized consistency test)
const CHUNK = /\d+|\D+/g;
const isDigit = (s) => s.charCodeAt(0) >= 48 && s.charCodeAt(0) <= 57;
const stripZeros = (s) => s.replace(/^0+(?=\d)/, "");

function cmpNumeric(x, y) {
  const a = stripZeros(x);
  const b = stripZeros(y);
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function refCompare(a, b) {
  if (a === b) return 0;
  const ca = a.match(CHUNK) ?? [];
  const cb = b.match(CHUNK) ?? [];
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i];
    const y = cb[i];
    const dx = isDigit(x);
    const dy = isDigit(y);
    let r;
    if (dx && dy) r = cmpNumeric(x, y);
    else if (dx) r = -1;
    else if (dy) r = 1;
    else r = cmpUnits(x.toLowerCase(), y.toLowerCase());
    if (r !== 0) return r;
  }
  if (ca.length !== cb.length) return ca.length - cb.length;
  for (let i = 0; i < n; i++) {
    if (isDigit(ca[i])) {
      const za = ca[i].length - stripZeros(ca[i]).length;
      const zb = cb[i].length - stripZeros(cb[i]).length;
      if (za !== zb) return za - zb;
    }
  }
  return cmpUnits(a, b);
}

const sign = (x) => (x < 0 ? -1 : x > 0 ? 1 : 0);
function expectOrder(label, list) {
  test(label, () => {
    // Sort several shuffled copies; every one must come out in `list` order.
    for (let seed = 1; seed <= 5; seed++) {
      const shuffled = shuffle(list, seed);
      const got = [...shuffled].sort(naturalCompare);
      assert.deepEqual(got, list, `sorted ${JSON.stringify(shuffled)} -> ${JSON.stringify(got)}`);
    }
    for (let i = 0; i + 1 < list.length; i++) {
      const r = naturalCompare(list[i], list[i + 1]);
      assert.ok(typeof r === "number" && r < 0, `compare(${JSON.stringify(list[i])}, ${JSON.stringify(list[i + 1])}) = ${r}, want < 0`);
      const back = naturalCompare(list[i + 1], list[i]);
      assert.ok(back > 0, `compare(${JSON.stringify(list[i + 1])}, ${JSON.stringify(list[i])}) = ${back}, want > 0`);
    }
  });
}
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
function shuffle(arr, seed) {
  const r = rng(seed * 7919);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

expectOrder("numbers inside names", ["file1.txt", "file2.txt", "file3.txt", "file10.txt", "file20.txt", "file100.txt"]);
expectOrder("case-insensitive letters, upper-case first on ties", ["A", "a", "B", "b", "C"]);
expectOrder("numeric value beats case", ["file9", "File10", "file10"]);
expectOrder("leading zeros break ties", ["a1", "a01", "a001", "a2", "a02"]);
expectOrder("zero itself", ["a0", "a00", "a000", "a1"]);
expectOrder("leading zeros before case", ["a1", "A01", "a01"]);
expectOrder("leading zeros: first differing chunk decides", ["x1y02", "x01y2"]);
expectOrder("versions", ["1.2", "1.9", "1.9.1", "1.10", "1.10.0", "1.10.1", "2.0", "10.0"]);
expectOrder("prefixes and digit-before-text", ["", "a", "a1", "a1a", "a 1", "a-1", "a_1", "ab"]);
expectOrder("text compared by lower-cased code units", ["_private", "alpha", "Zeta"]);
expectOrder("extensions and mixed case", ["img1.png", "IMG2.png", "img2.PNG", "img10.png", "img12.png"]);
expectOrder("numbers longer than 2^53", ["x9007199254740992b", "x9007199254740993a", "x999999999999999999", "x12345678901234567890", "x12345678901234567891"]);
expectOrder("long numbers with leading zeros", ["n00000000000000000000001", "n2", "n000000000000000000000010"]);

test("identical strings compare 0, different strings never do", () => {
  assert.equal(naturalCompare("file01", "file01"), 0);
  assert.equal(naturalCompare("", ""), 0);
  for (const [a, b] of [["file1", "file01"], ["File", "file"], ["a", "A"], ["0", "00"], ["x ", "x"]]) {
    assert.notEqual(naturalCompare(a, b), 0, `compare(${JSON.stringify(a)}, ${JSON.stringify(b)}) must not be 0`);
  }
});

test("consistent with the rules on random strings", () => {
  const parts = ["a", "A", "b", "B", "0", "1", "9", "00", "007", "10", ".", "-", " ", "_", "z", "Z", "é"];
  const r = rng(42);
  const words = new Set();
  while (words.size < 400) {
    let w = "";
    const n = 1 + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) w += parts[Math.floor(r() * parts.length)];
    words.add(w);
  }
  const list = [...words];
  const want = [...list].sort(refCompare);
  const got = [...list].sort(naturalCompare);
  const i = want.findIndex((w, k) => w !== got[k]);
  assert.ok(i < 0, `first mismatch at position ${i}: got ${JSON.stringify(got.slice(Math.max(0, i - 1), i + 2))}, want ${JSON.stringify(want.slice(Math.max(0, i - 1), i + 2))}`);
  for (let k = 0; k < 2000; k++) {
    const a = list[Math.floor(r() * list.length)];
    const b = list[Math.floor(r() * list.length)];
    assert.equal(sign(naturalCompare(a, b)), sign(refCompare(a, b)), `compare(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
  }
});

test("naturalSort returns a new sorted array and leaves the input alone", () => {
  const input = ["z10", "z9", "Z1"];
  const copy = [...input];
  const out = naturalSort(input);
  assert.deepEqual(out, ["Z1", "z9", "z10"]);
  assert.deepEqual(input, copy);
  assert.notEqual(out, input);
});

test("naturalSort with key is stable", () => {
  const items = [
    { n: "f10", id: 1 },
    { n: "f2", id: 2 },
    { n: "f10", id: 3 },
    { n: "F2", id: 4 },
    { n: "f2", id: 5 },
    { n: "f1", id: 6 },
  ];
  const out = naturalSort(items, { key: (x) => x.n });
  assert.deepEqual(out.map((x) => x.id), [6, 4, 2, 5, 1, 3]);
  assert.deepEqual(items.map((x) => x.id), [1, 2, 3, 4, 5, 6]);
});

test("naturalSort descending keeps equal keys in input order", () => {
  const items = [
    { n: "v1.9", id: "a" },
    { n: "v1.10", id: "b" },
    { n: "v1.9", id: "c" },
    { n: "v1.10", id: "d" },
    { n: "v1.2", id: "e" },
  ];
  const out = naturalSort(items, { key: (x) => x.n, descending: true });
  assert.deepEqual(out.map((x) => x.id), ["b", "d", "a", "c", "e"]);
  assert.deepEqual(naturalSort(["b2", "b10", "B2"], { descending: true }), ["b10", "b2", "B2"]);
});

finish();

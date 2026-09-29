// Hidden grader for js-markdown-table. cwd = copy of the agent's workspace.
import path from "node:path";
import { pathToFileURL } from "node:url";

let cases = 0;
let passed = 0;
function test(label, fn) {
  cases++;
  try {
    fn();
    passed++;
  } catch (e) {
    console.log(`FAIL ${label}: ${String(e?.message ?? e)}`);
  }
}
function finish() {
  console.log(`SCORE ${passed}/${cases}`);
  process.exit(passed === cases ? 0 : 1);
}

let mod;
try {
  mod = await import(pathToFileURL(path.resolve("table.js")).href);
  if (typeof mod.renderTable !== "function") throw new Error("table.js does not export renderTable");
} catch (e) {
  console.log(`FAIL import table.js: ${e.message}`);
  cases = 1;
  finish();
}

const T = {
  ascii: [[{ a: 1, b: "x" }, { a: 22, b: "yy" }], {}],
  firstSeen: [[{ name: "bolt", qty: 3 }, { qty: 10, size: "M4" }, { color: "red", name: "nut" }], {}],
  center: [[{ id: 1, label: "ab" }, { id: 2, label: "abcde" }], { align: { label: "center", id: "left" } }],
  escaping: [[{ "a|b": "x|y", note: "one\ntwo" }, { "a|b": "|", note: "crlf\r\nend\rx" }], {}],
  mixed: [[{ n: 0, s: "42", f: 1.5, e: null }, { n: -7, s: "7", f: NaN, e: undefined }, { n: null, s: "x" }], {}],
  columnsOpt: [[{ a: 1, b: 2, c: 3 }, { a: 10, c: 30 }], { columns: ["c", "missing", "a"] }],
  emptyRows: [[], { columns: ["id", "name"] }],
  cjk: [[{ name: "日本", code: "abc" }, { name: "ｱｲ", code: "한국어" }, { name: "Ａ1", code: "x" }], { align: { code: "right" } }],
  emoji: [[{ icon: "👍🏽", who: "👨\u200D👩\u200D👧 fam" }, { icon: "🇯🇵", who: "❤\uFE0F love" }, { icon: "❤", who: "✓ ok" }], { align: { icon: "center" } }],
  combining: [[{ word: "nai\u0308ve", n: 1 }, { word: "cafe\u0301 ok", n: 22 }, { word: "zero\u200Bwidth", n: 333 }], {}],
  bools: [[{ ok: true, v: 1 }, { ok: false, v: 2 }], {}],
};

const EXPECTED = {
  "ascii": "|   a | b   |\n| --: | :-- |\n|   1 | x   |\n|  22 | yy  |",
  "firstSeen": "| name | qty | size | color |\n| :--- | --: | :--- | :---- |\n| bolt |   3 |      |       |\n|      |  10 | M4   |       |\n| nut  |     |      | red   |",
  "center": "| id  | label |\n| :-- | :---: |\n| 1   |  ab   |\n| 2   | abcde |",
  "escaping": "| a\\|b | note             |\n| :--- | :--------------- |\n| x\\|y | one<br>two       |\n| \\|   | crlf<br>end<br>x |",
  "mixed": "|   n | s   | f   | e   |\n| --: | :-- | :-- | :-- |\n|   0 | 42  | 1.5 |     |\n|  -7 | 7   | NaN |     |\n|     | x   |     |     |",
  "columnsOpt": "|   c | missing |   a |\n| --: | :------ | --: |\n|   3 |         |   1 |\n|  30 |         |  10 |",
  "emptyRows": "| id  | name |\n| :-- | :--- |",
  "cjk": "| name |   code |\n| :--- | -----: |\n| 日本 |    abc |\n| ｱｲ   | 한국어 |\n| Ａ1  |      x |",
  "emoji": "| icon | who     |\n| :--: | :------ |\n|  👍🏽  | 👨\u200D👩\u200D👧 fam  |\n|  🇯🇵  | ❤\uFE0F love |\n|  ❤   | ✓ ok    |",
  "combining": "| word      |   n |\n| :-------- | --: |\n| nai\u0308ve     |   1 |\n| cafe\u0301 ok   |  22 |\n| zero\u200Bwidth | 333 |",
  "bools": "| ok    |   v |\n| :---- | --: |\n| true  |   1 |\n| false |   2 |"
};

const show = (s) => "\n" + String(s).split("\n").map((l) => "      " + JSON.stringify(l)).join("\n");
for (const [name, [rows, opts]] of Object.entries(T)) {
  test(`table "${name}"`, () => {
    const got = mod.renderTable(rows, opts);
    if (typeof got !== "string") throw new Error(`expected a string, got ${typeof got}`);
    const norm = got.replace(/\n$/, "");
    if (norm !== EXPECTED[name]) throw new Error(`got:${show(norm)}\n    want:${show(EXPECTED[name])}`);
  });
}

test("no columns renders an empty string", () => {
  const a = mod.renderTable([]);
  const b = mod.renderTable([{}, {}]);
  if (a !== "" || b !== "") throw new Error(`got ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
});

test("input rows are not modified", () => {
  const rows = [{ a: 1, b: "x|y" }, { b: null }];
  const before = JSON.stringify(rows);
  mod.renderTable(rows, { align: { a: "center" } });
  if (JSON.stringify(rows) !== before || Object.keys(rows[1]).length !== 1) throw new Error("rows were mutated");
});

const WIDTHS = [
  ["plain", 5], ["日本語", 6], ["ｱ", 1], ["Ａ", 2], ["한국어", 6], ["👍", 2], ["👍🏽", 2],
  ["👨\u200D👩\u200D👧", 2], ["🇯🇵", 2], ["❤\uFE0F", 2], ["❤", 1], ["✓", 1], ["a\u200Bb", 2], ["e\u0301", 1],
  ["nai\u0308ve", 5], ["〜x", 3], ["☕ tea", 6],
];
test("displayWidth", () => {
  if (typeof mod.displayWidth !== "function") throw new Error("table.js does not export displayWidth");
  const bad = WIDTHS.filter(([s, w]) => mod.displayWidth(s) !== w).map(([s, w]) => `${JSON.stringify(s)}: got ${mod.displayWidth(s)}, want ${w}`);
  if (bad.length) throw new Error(bad.join("; "));
});

finish();

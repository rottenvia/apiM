/**
 * Checks the diff and undo behaviour.
 *
 * Run:  npm run test:diff
 *
 * Diffs are easy to get subtly wrong — an off-by-one in the line numbers or a
 * mishandled empty file looks fine until it doesn't.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rm } from "node:fs/promises";

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
const { diffLines, diffStats, diffHunks } = await import(
  pathToFileURL(path.join(ROOT, "src/lib/diff.ts")).href
);
const ws = await import(
  pathToFileURL(path.join(ROOT, "src/lib/workspace.ts")).href
);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

console.log("\napiM diff + undo checks\n");

console.log("1. Diffing");

let lines = diffLines("a\nb\nc\n", "a\nB\nc\n");
let st = diffStats(lines);
check("a changed line shows as one add and one remove",
  st.added === 1 && st.removed === 1, `+${st.added} -${st.removed}`);

check("unchanged lines are kept as context",
  lines.filter((l) => l.kind === "same").length === 2);

lines = diffLines("a\nb\n", "a\nb\n");
check("identical files show no changes", diffStats(lines).added === 0 && diffStats(lines).removed === 0);

lines = diffLines("", "hello\n");
st = diffStats(lines);
check("a new file is all additions", st.added === 1 && st.removed === 0);

lines = diffLines("hello\n", "");
st = diffStats(lines);
check("an emptied file is all removals", st.added === 0 && st.removed === 1);

// Windows line endings must not make every line look changed.
lines = diffLines("a\r\nb\r\n", "a\nb\n");
st = diffStats(lines);
check("CRLF vs LF is not treated as a change",
  st.added === 0 && st.removed === 0, `+${st.added} -${st.removed}`);

lines = diffLines("a\nb\nc\n", "a\nx\nb\nc\n");
st = diffStats(lines);
check("an inserted line is one addition, not a rewrite",
  st.added === 1 && st.removed === 0, `+${st.added} -${st.removed}`);

// Line numbers must line up with the real files.
lines = diffLines("one\ntwo\nthree\n", "one\nTWO\nthree\n");
const removed = lines.find((l) => l.kind === "removed");
const added = lines.find((l) => l.kind === "added");
check("line numbers are correct",
  removed?.oldLine === 2 && added?.newLine === 2,
  `old ${removed?.oldLine}, new ${added?.newLine}`);
check("added lines have no old line number", added?.oldLine === null);

console.log("\n2. Collapsing long files");

const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
const bigChanged = big.replace("line 100", "line 100 CHANGED");
const hunks = diffHunks(diffLines(big, bigChanged), 3);
const shown = hunks.reduce((n, h) => n + h.lines.length, 0);
check("a 1-line change in a 200-line file shows a handful of lines, not 200",
  shown <= 12, `${shown} lines shown`);
check("skipped context is reported", hunks[0]?.skippedBefore > 0,
  `${hunks[0]?.skippedBefore} skipped`);

console.log("\n3. Undo");

const WS = "difftest";
await rm(path.join(DATA_ROOT, "workspaces", WS), { recursive: true, force: true });
await rm(path.join(DATA_ROOT, "workspaces", `${WS}.history`), { recursive: true, force: true });

await ws.writeFile(WS, "app.py", "print('v1')\n");
check("a brand-new file has no previous version",
  (await ws.previousVersion(WS, "app.py")) === null);

await ws.writeFile(WS, "app.py", "print('v2')\n");
const prev = await ws.previousVersion(WS, "app.py");
check("overwriting keeps the old version", prev === "print('v1')\n",
  JSON.stringify(prev));

await ws.writeFile(WS, "app.py", await ws.previousVersion(WS, "app.py"));
const now = (await ws.readFile(WS, "app.py")).content;
check("restoring brings back the old contents", now === "print('v1')\n");
check("the undo is itself undoable",
  (await ws.previousVersion(WS, "app.py")) === "print('v2')\n");

await ws.writeFile(WS, "gone.txt", "important\n");
await ws.deleteFile(WS, "gone.txt");
check("a deleted file can still be recovered",
  (await ws.previousVersion(WS, "gone.txt")) === "important\n");

const listed = (await ws.listFiles(WS)).map((f) => f.path);
check("history files never appear in the workspace listing",
  !listed.some((p) => p.includes(".prev")), listed.join(", "));

console.log("\n" + (fail === 0 ? g(`All ${pass} checks passed.`) : r(`${fail} failed.`)) + "\n");
process.exit(fail === 0 ? 0 : 1);

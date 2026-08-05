/**
 * Checks workspace history — save points and restoring them.
 *
 * Run:  npm run test:snapshots
 *
 * Per-file undo only goes back one step, which does not help when a reply
 * changed four files. These check that "put it back how it was" actually
 * does, including removing files created since.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rm, access } from "node:fs/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const ws = await import(pathToFileURL(path.join(ROOT, "src/lib/workspace.ts")).href);
const S = await import(pathToFileURL(path.join(ROOT, "src/lib/snapshots.ts")).href);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};
const read = (p) => ws.readFile(WS, p).then((r2) => r2.content).catch(() => null);
const exists = (p) => access(p).then(() => true).catch(() => false);

const WS = "snaptest";
await rm(path.join(ROOT, "data"), { recursive: true, force: true });

console.log("\napiM workspace history checks\n");

console.log("1. Saving a point in time");
let snap = await S.createSnapshot(WS, "empty");
check("an empty workspace produces nothing to restore", snap === null);

await ws.writeFile(WS, "a.py", "version 1\n");
await ws.writeFile(WS, "src/b.py", "helper 1\n");
snap = await S.createSnapshot(WS, "First version");
check("a snapshot is created", snap !== null);
check("it counts the files", snap?.fileCount === 2, `${snap?.fileCount}`);
check("it keeps the label", snap?.label === "First version", snap?.label);

console.log("\n2. Restoring undoes a multi-file change");
// The exact case per-file undo can't handle.
await ws.writeFile(WS, "a.py", "version 2 BROKEN\n");
await ws.writeFile(WS, "src/b.py", "helper 2 BROKEN\n");
await ws.writeFile(WS, "c.py", "new file that should not survive\n");

const result = await S.restoreSnapshot(WS, snap.id);
check("both changed files come back",
  (await read("a.py")) === "version 1\n" && (await read("src/b.py")) === "helper 1\n");
check("a file created since is removed", (await read("c.py")) === null,
  `removed ${result.removed}`);
check("the counts are reported", result.restored === 2 && result.removed === 1,
  `restored ${result.restored}, removed ${result.removed}`);

console.log("\n3. Restoring is itself undoable");
const all = await S.listSnapshots(WS);
check("a save point was taken before restoring",
  all.some((s) => s.label === "Before restoring"),
  all.map((s) => s.label).join(", "));

const beforeRestore = all.find((s) => s.label === "Before restoring");
await S.restoreSnapshot(WS, beforeRestore.id);
check("the broken version can be recovered",
  (await read("a.py")) === "version 2 BROKEN\n");

console.log("\n4. Listing");
const list = await S.listSnapshots(WS);
check("newest is first",
  list.length >= 2 && list[0].createdAt >= list[1].createdAt);
check("every entry has a real timestamp",
  list.every((s) => !Number.isNaN(Date.parse(s.createdAt))));

console.log("\n5. Snapshots stay out of the workspace");
const files = (await ws.listFiles(WS)).map((f) => f.path);
check("they never appear as files",
  !files.some((p) => /snapshot|manifest/i.test(p)), files.join(", "));
check("nor get fed to the model as context",
  !files.some((p) => p.includes("..")));

console.log("\n6. Old ones are dropped");
for (let i = 0; i < S.MAX_SNAPSHOTS + 5; i++) {
  await ws.writeFile(WS, "a.py", `iteration ${i}\n`);
  await S.createSnapshot(WS, `Point ${i}`);
}
const capped = await S.listSnapshots(WS);
check("the count is capped", capped.length <= S.MAX_SNAPSHOTS,
  `${capped.length} kept, max ${S.MAX_SNAPSHOTS}`);
check("the most recent survived the prune",
  capped[0].label === `Point ${S.MAX_SNAPSHOTS + 4}`, capped[0].label);

console.log("\n7. Deleting");
const target = capped[0];
await S.deleteSnapshot(WS, target.id);
check("one can be removed",
  !(await S.listSnapshots(WS)).some((s) => s.id === target.id));

await S.deleteAllSnapshots(WS);
check("all can be removed", (await S.listSnapshots(WS)).length === 0);
check("the workspace itself survives", (await read("a.py")) !== null);

console.log("\n8. Bad input");
let threw = false;
try {
  await S.restoreSnapshot(WS, "../../etc");
} catch {
  threw = true;
}
check("a traversal id is rejected", threw);

console.log("\n" + (fail === 0 ? g(`All ${pass} checks passed.`) : r(`${fail} of ${pass + fail} failed.`)) + "\n");
process.exit(fail === 0 ? 0 : 1);

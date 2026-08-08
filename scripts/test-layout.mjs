/**
 * Checks the workspace folder layout and that the model's file tree is
 * refreshed as it works.
 *
 * Run:  npm run test:layout
 *
 * One workspace used to occupy three sibling folders — "<ws>", "<ws>.history"
 * and "<ws>.snapshots" — which made data/workspaces hard to read and made it
 * unclear which folder a deletion was supposed to affect. And the file tree
 * given to the model was built once per reply, so a file deleted on an early
 * round was still listed as present for every round after it.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const W = await load("src/lib/workspace.ts");
const S = await load("src/lib/snapshots.ts");
const C = await load("src/lib/workspace-context.ts");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

const WSROOT = path.join(ROOT, "data", "workspaces");
await fs.rm(WSROOT, { recursive: true, force: true });

console.log("\napiM workspace layout checks\n");

// ------------------------------------------------------------ one folder

console.log("1. One folder per workspace");

const WS = "layouttest";
await W.writeFile(WS, "a.py", "print('a')\n");
await W.writeFile(WS, "b.py", "print('b')\n");

let top = (await fs.readdir(WSROOT)).sort();
check("a new workspace makes exactly one folder", top.length === 1, top.join(", "));

await S.createSnapshot(WS, "before");
await W.writeFile(WS, "a.py", "print('changed')\n");

top = (await fs.readdir(WSROOT)).sort();
check(
  "snapshots and history do not add sibling folders",
  top.length === 1,
  "was three: <ws>, <ws>.history, <ws>.snapshots"
);

const dir = W.workspaceDirectory(WS);
const inside = (await fs.readdir(dir)).sort();
check("history lives inside the workspace", inside.includes(".history"));
check("snapshots live inside the workspace", inside.includes(".snapshots"));
check(
  "both are dot-prefixed",
  W.INTERNAL_DIRS.every((n) => n.startsWith(".")),
  W.INTERNAL_DIRS.join(", ")
);

// --------------------------------------------------- hidden from the model

console.log("\n2. Internals stay invisible");

const listed = (await W.listFiles(WS)).map((f) => f.path);
check(
  "listFiles never returns anything from .history",
  !listed.some((p) => p.includes(".history")),
  listed.join(", ")
);
check(
  "listFiles never returns anything from .snapshots",
  !listed.some((p) => p.includes(".snapshots"))
);
check("real files are still listed", listed.includes("a.py") && listed.includes("b.py"));

const tree = await C.buildWorkspaceContext(WS);
check(
  "the model's file tree excludes the internals",
  !tree.includes(".history") && !tree.includes(".snapshots"),
  "or it would try to read its own backups"
);
check("the model's file tree includes the real files", tree.includes("a.py"));

// A snapshot must not capture the previous snapshots.
const snaps = await S.listSnapshots(WS);
check("a snapshot was recorded", snaps.length >= 1);
check(
  "a snapshot does not contain earlier snapshots",
  snaps.every((s) => s.fileCount <= 2),
  `${snaps[0]?.fileCount} files — 2 real ones exist`
);

// ------------------------------------------------------------- deleting

console.log("\n3. Deleting");

await W.deleteFile(WS, "b.py");
const afterDelete = (await W.listFiles(WS)).map((f) => f.path);
check("a deleted file disappears from listings", !afterDelete.includes("b.py"));
check("the other files survive", afterDelete.includes("a.py"));

const onDisk = (await fs.readdir(dir)).sort();
check("the deleted file is gone from disk", !onDisk.includes("b.py"));
check(
  "deleting does not create another top-level folder",
  (await fs.readdir(WSROOT)).length === 1
);

const treeAfter = await C.buildWorkspaceContext(WS);
check(
  "the model's file tree drops the deleted file",
  !treeAfter.includes("b.py"),
  "stale trees are why replies named files that no longer existed"
);
check("and still shows what remains", treeAfter.includes("a.py"));

// ------------------------------------------------------- tree freshness

console.log("\n4. The tree reflects the current state");

const before = await C.buildWorkspaceContext(WS);
await W.writeFile(WS, "c.py", "print('c')\n");
const after = await C.buildWorkspaceContext(WS);

check("adding a file changes the tree", before !== after);
check("the new file appears", after.includes("c.py"));

await W.deleteFile(WS, "c.py");
const afterRemoval = await C.buildWorkspaceContext(WS);
check("removing it changes the tree back", afterRemoval.includes("c.py") === false);
check(
  "an unchanged workspace produces an identical tree",
  (await C.buildWorkspaceContext(WS)) === afterRemoval,
  "so the refresh can skip rewriting the prompt when nothing moved"
);

// ---------------------------------------------------------------- rename

console.log("\n5. Renaming a workspace");

await W.renameWorkspaceFolder(WS, "renamed");
const afterRename = (await fs.readdir(WSROOT)).sort();
check("renaming still leaves one folder", afterRename.length === 1, afterRename.join(", "));
const renamedInside = (await fs.readdir(path.join(WSROOT, afterRename[0]))).sort();
check("history followed the rename", renamedInside.includes(".history"));
check("snapshots followed the rename", renamedInside.includes(".snapshots"));

// ----------------------------------------------------------------- limits

console.log("\n6. Limits are guard rails, not a quota");

check(
  "a file well past the old 2MB cap is accepted",
  W.MAX_FILE_BYTES >= 100 * 1024 * 1024,
  `${W.MAX_FILE_BYTES / 1024 / 1024} MB — this runs on the user's own disk`
);
check(
  "the file count is not a hosted-service number",
  W.MAX_FILES_PER_WORKSPACE >= 10_000,
  `${W.MAX_FILES_PER_WORKSPACE.toLocaleString()} — was 500`
);

const big = "x".repeat(5 * 1024 * 1024);
await W.writeFile(WS, "big.bin", big);
const bigListed = (await W.listFiles(WS)).find((f) => f.path === "big.bin");
check(
  "a 5MB write actually succeeds",
  Boolean(bigListed) && bigListed.size === big.length,
  "previously refused with 'File is too large to write'"
);
await W.deleteFile(WS, "big.bin");

check(
  "a cap still exists, so a runaway loop is bounded",
  Number.isFinite(W.MAX_FILE_BYTES) && W.MAX_FILE_BYTES > 0
);

// -------------------------------------------------------------- migration

console.log("\n6. Migrating the old three-folder layout");

await fs.rm(WSROOT, { recursive: true, force: true });
await fs.mkdir(path.join(WSROOT, "old"), { recursive: true });
await fs.writeFile(path.join(WSROOT, "old", "main.py"), "print(1)\n");
await fs.mkdir(path.join(WSROOT, "old.history"), { recursive: true });
await fs.writeFile(path.join(WSROOT, "old.history", "main.py.prev"), "OLD\n");
await fs.mkdir(path.join(WSROOT, "old.snapshots", "snap1"), { recursive: true });
await fs.writeFile(
  path.join(WSROOT, "old.snapshots", "snap1", "manifest.json"),
  "{}"
);

check("the old layout starts as three folders", (await fs.readdir(WSROOT)).length === 3);

await W.listFiles("old"); // any touch triggers the migration

const afterMigration = (await fs.readdir(WSROOT)).sort();
check(
  "it collapses to one on first use",
  afterMigration.length === 1,
  afterMigration.join(", ")
);

const oldInside = (await fs.readdir(path.join(WSROOT, "old"))).sort();
check("history moved inside", oldInside.includes(".history"));
check("snapshots moved inside", oldInside.includes(".snapshots"));
check("the real file is untouched", oldInside.includes("main.py"));

const preserved = await fs.readFile(
  path.join(WSROOT, "old", ".history", "main.py.prev"),
  "utf8"
);
check(
  "undo history survives the move",
  preserved.trim() === "OLD",
  "losing it would silently break undo for every existing workspace"
);

await fs.rm(WSROOT, { recursive: true, force: true });

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

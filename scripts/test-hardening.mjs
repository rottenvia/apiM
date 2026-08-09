/**
 * Bugs found by auditing rather than by hitting them.
 *
 * Run:  npm run test:hardening
 *
 * Every check here is a defect that was in the code and is now fixed. None of
 * them had been reported — they are the kind that stay invisible until a
 * workspace gets big, a chat gets deleted, or two things happen at once.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { rm, readdir, stat } from "node:fs/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const ws = await load("src/lib/workspace.ts");
const snaps = await load("src/lib/snapshots.ts");
const L = await load("src/lib/lessons.ts");
const approvals = await load("src/lib/approvals.ts");
const store = await load("src/lib/store.ts");
const route = read("src/app/api/chat/route.ts");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

await rm(path.join(ROOT, "data"), { recursive: true, force: true });

console.log("\napiM hardening checks\n");

// ------------------------------------------------------------------
console.log("1. Snapshots no longer copy the workspace every message");

const WS = "hardsnap";
for (let i = 0; i < 120; i++) {
  await ws.writeFile(WS, `src/m${i}.js`, "x".repeat(4000));
}

const t1 = Date.now();
await snaps.createSnapshot(WS, "first");
const firstMs = Date.now() - t1;

const t2 = Date.now();
await snaps.createSnapshot(WS, "second, nothing changed");
const secondMs = Date.now() - t2;

check(
  "an unchanged snapshot is much cheaper than the first",
  secondMs < firstMs,
  `${firstMs}ms then ${secondMs}ms — this runs before every single message`
);

for (let i = 0; i < 8; i++) await snaps.createSnapshot(WS, `msg ${i}`);

async function dirSize(dir) {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return total;
}
const snapBytes = await dirSize(
  path.join(ws.workspaceDirectory(WS), ".snapshots")
);
const workspaceBytes = 120 * 4000;
check(
  "ten snapshots do not cost ten copies",
  snapBytes < workspaceBytes * 2,
  `${(snapBytes / 1024 / 1024).toFixed(2)}MB for 10 snapshots of a ${(workspaceBytes / 1024 / 1024).toFixed(2)}MB workspace`
);

// ------------------------------------------------------------------
console.log("\n2. Restoring still works, which is the whole point");

await ws.writeFile(WS, "src/m0.js", "COMPLETELY DIFFERENT");
await ws.writeFile(WS, "src/added-later.js", "new file");
const list = await snaps.listSnapshots(WS);
await snaps.restoreSnapshot(WS, list[list.length - 1].id);

const restored = await ws.readFile(WS, "src/m0.js");
check(
  "a changed file comes back",
  restored.content.startsWith("xxxx"),
  "content is shared between snapshots, so this is the check that matters"
);
const after = (await ws.listFiles(WS)).map((f) => f.path);
check(
  "a file created after the snapshot is removed",
  !after.includes("src/added-later.js"),
  "otherwise it is not 'how it was'"
);

// ------------------------------------------------------------------
console.log("\n3. Shared content is freed when snapshots are pruned");

const objects = path.join(ws.workspaceDirectory(WS), ".snapshots", "objects");
const before = (await readdir(objects)).length;

// Rewrite everything, then take enough snapshots to push the old ones out.
for (let i = 0; i < 120; i++) {
  await ws.writeFile(WS, `src/m${i}.js`, "y".repeat(4000));
}
for (let i = 0; i < snaps.MAX_SNAPSHOTS + 4; i++) {
  await snaps.createSnapshot(WS, `churn ${i}`);
}
const afterCount = (await readdir(objects)).length;
check(
  "orphaned content is swept, not kept forever",
  afterCount <= before + 130,
  `${before} objects before, ${afterCount} after replacing every file`
);
check(
  "no temp files are left in the object store",
  (await readdir(objects)).every((n) => !n.endsWith(".tmp"))
);

// ------------------------------------------------------------------
console.log("\n4. Deleting a chat drops its standing permissions");

const CONV = "perm-test-id";
approvals.remember(CONV, "python3", ["app.py"]);
check(
  "an approved command is remembered while the chat exists",
  approvals.isRemembered(CONV, "python3", ["app.py"])
);
await store.deleteConversation(CONV);
check(
  "and forgotten when the chat is deleted",
  !approvals.isRemembered(CONV, "python3", ["app.py"]),
  "consent should not outlive the thing it was granted for"
);

// ------------------------------------------------------------------
console.log("\n5. Concurrent refine passes do not lose lessons");

const RACE = "hardrace";
await rm(path.join(ROOT, "data", "workspaces", RACE), {
  recursive: true,
  force: true,
});
await Promise.all(
  Array.from({ length: 8 }, (_, i) =>
    L.applyLessons(RACE, [
      { text: `fact ${i}`, evidence: `cmd ${i} -> exit 0` },
    ])
  )
);
check(
  "eight simultaneous passes all persist",
  (await L.readLessons(RACE)).length === 8,
  "read-modify-write without a queue silently drops all but the last"
);

const lessonsSrc = read("src/lib/lessons.ts");
check(
  "the lessons file is written atomically",
  /fs\.rename\(tmp, target\)/.test(lessonsSrc),
  "a half-written file parses into *some* lessons, which is worse than none"
);

// ------------------------------------------------------------------
console.log("\n6. The refine pass cannot waste money");

check(
  "it does not run after the user pressed Stop",
  /!req\.signal\.aborted &&/.test(route),
  "reflecting on a cancelled task spends money on work the user rejected"
);
check(
  "outcomes are paired by id, not by array position",
  /const argsById = new Map/.test(route),
  "toolEvents is pre-seeded on resume, so index pairing attached the wrong command to the wrong result"
);

// ------------------------------------------------------------------
console.log("\n7. Resume state is not rewritten every 2.5 seconds");

/*
 * A long agent run's transcript is around a megabyte of JSON. Writing it on
 * every stream checkpoint slowed the stream the user is watching and hammered
 * the disk, purely to protect against a crash in the next few seconds.
 */
check(
  "it is written once per tool round, not per checkpoint",
  /toolRounds > lastResumeRound/.test(route),
  "a megabyte of JSON every 2.5s costs more than it protects"
);

const KEEP = "hardkeep";
const base = {
  id: "a1",
  role: "assistant",
  content: "partial",
  createdAt: new Date().toISOString(),
};
await store.upsertMessage(KEEP, "t", {
  ...base,
  incomplete: true,
  resumeState: { toolRounds: 3, continuations: 0, messages: [{ role: "user", content: "q" }] },
});
await store.upsertMessage(KEEP, "t", { ...base, content: "partial + more", incomplete: true });
const keptMsg = (await store.getConversation(KEEP)).messages[0];
check(
  "a checkpoint that omits it does not erase it",
  Boolean(keptMsg.resumeState),
  "otherwise the reply looks resumable with nothing to resume from"
);
check("but the text still updates", keptMsg.content === "partial + more");

await store.upsertMessage(KEEP, "t", { ...base, content: "done", resumeState: null });
check(
  "an explicit null still clears it when the reply finishes",
  (await store.getConversation(KEEP)).messages[0].resumeState === null,
  "it is the largest field in the record"
);

// ------------------------------------------------------------------
console.log("\n8. Commands actually run on Windows");

/*
 * Reported: every npm command came back "Failed: npm install", and naming the
 * file directly came back "Command not allowed". Neither was a permissions
 * decision — npm has always been on the allow-list. On Windows npm is
 * npm.cmd, not an executable, and spawn() with shell:false cannot launch a
 * batch file; normaliseCommand also stripped only ".exe", so "npm.cmd" read
 * as an unknown tool.
 */
const runnerSrc = read("src/lib/runner.ts");
const procSrc = read("src/lib/processes.ts");
const runner = await load("src/lib/runner.ts");

check(
  "a .cmd shim is recognised as its tool",
  runner.validateCommand("npm.cmd", ["install"]).ok,
  "this is what came back as 'Command not allowed'"
);
check(
  "so is a full Windows path to one",
  runner.validateCommand("C:\\Program Files\\nodejs\\npm.cmd", ["install"]).ok
);
check(
  "the launcher is resolved to a real file before spawning",
  /resolveWindowsLauncher/.test(runnerSrc),
  "spawn with shell:false cannot start a .cmd by name"
);
check(
  "background processes resolve it too",
  /resolveLauncher/.test(procSrc),
  "npm run dev failed the same way"
);
check(
  "the shell stays off",
  /shell: false/.test(runnerSrc) && !/shell: true/.test(runnerSrc),
  "enabling it would hand argument parsing back to cmd.exe"
);
check(
  "batch files are spawned with the flag Node requires",
  /windowsVerbatimArguments: false/.test(runnerSrc)
);
check(
  "shells are still refused",
  !runner.validateCommand("bash", ["-c", "ls"]).ok &&
    !runner.validateCommand("powershell.exe", []).ok,
  "the allow-list is wider, not open"
);
check(
  "a directory cannot smuggle in an unlisted binary",
  !runner.validateCommand("C:\\evil\\rm.exe", []).ok,
  "the basename is checked, and PATH decides what actually runs"
);
check(
  "everyday tooling is available",
  ["pnpm", "yarn", "git", "tsx", "eslint"].every((c) =>
    runner.validateCommand(c, []).ok
  ),
  "the model hit a wall on ordinary requests"
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

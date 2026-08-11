/**
 * The agent losing track of files it was given.
 *
 * Run:  npm run test:agentloss
 *
 * Every check here is a regression from one reported failure: a zip was
 * attached, the model analysed it on the turn it arrived, and every question
 * after that answered "No ZIP in the workspace. Provide the file and I'll
 * analyse it." The archive was on disk the whole time.
 *
 * There were four separate causes, which is why it survived several attempts
 * to fix it. They are tested independently so a partial regression is
 * reported as one specific failure rather than a vague one.
 *
 *   1. The id -> folder mapping only existed in memory, so a cold server
 *      wrote uploads to a second folder named after the raw id.
 *   2. Renaming a workspace onto an existing folder failed outright, leaving
 *      the uploads orphaned rather than merged.
 *   3. Pruning collapsed tool results at 0.7% of the model's context, so a
 *      project read across many rounds was erased before the model answered.
 *   4. read_files silently dropped every path past the tenth.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rm, mkdir, writeFile as fsWrite, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

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
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const ws = await load("src/lib/workspace.ts");
const store = await load("src/lib/store.ts");
const wsctx = await load("src/lib/workspace-context.ts");
const tools = await load("src/lib/tools.ts");
const prune = await load("src/lib/prune.ts");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

const WORK = path.join(DATA_ROOT, "workspaces");
/*
 * Read a directory that may legitimately not exist yet.
 *
 * If an earlier step failed, nothing created it — and crashing with ENOENT
 * hides the check that would have said WHY. An empty list fails the check
 * with a useful message instead of taking the whole suite down.
 */
const readdirSafe = async (dir) => {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
};
await rm(DATA_ROOT, { recursive: true, force: true });

console.log("\napiM agent context-loss checks\n");

// --------------------------------------------------------------------------
console.log("1. An upload survives a server restart");

/*
 * The ordering that broke it: dropping a zip onto an existing chat hits the
 * upload route first. On a freshly started server nothing has read the chat
 * store yet, so the folder mapping is cold. This runs each step in its own
 * process, which is the only way to reproduce a genuinely empty module map.
 */
const CONV = randomUUID();
const SCRATCH = path.join(ROOT, "scripts", ".agentloss-tmp");
await mkdir(SCRATCH, { recursive: true });

/*
 * Each step is a real file run by a real `tsx` process. `--eval` compiles as
 * CommonJS, which rejects the top-level await these need.
 */
let stepNo = 0;
const step = async (body) => {
  const file = path.join(SCRATCH, `step-${stepNo++}.mjs`);
  await fsWrite(
    file,
    `import { appendMessages } from "@/lib/store";
import { writeFile, listFiles } from "@/lib/workspace";
${body}
`,
    "utf8"
  );
  /*
   * `shell` on Windows only.
   *
   * npx is a .cmd shim there, and spawning a batch file without a shell fails
   * with EINVAL — the same CVE-2024-27980 behaviour that broke run_command.
   * Reported from a real Windows run: this suite died before its first check
   * with ENOENT on a directory the failed child never created.
   *
   * `shell: true` is safe HERE and nowhere near the agent: every argument is
   * a constant from this file or a path we just wrote. The runner
   * (lib/tools.ts) still refuses it, because there the arguments come from a
   * model.
   */
  const res = spawnSync("npx", ["tsx", file], {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
    env: { ...process.env, CONV_ID: CONV },
  });
  return (res.stdout ?? "") + (res.stderr ?? "");
};

// The chat exists and has a slug-named folder.
await step(`
await appendMessages(process.env.CONV_ID, "faceit extension chat", [
  { id: "m1", role: "user", content: "hi", createdAt: new Date().toISOString() },
]);
await writeFile(process.env.CONV_ID, "notes.md", "earlier work");
`);

const afterChat = await readdirSafe(WORK);
check(
  "the chat's workspace is named after the chat",
  afterChat.includes("faceit-extension-chat"),
  afterChat.join(", ")
);

// SERVER RESTART. New process, cold map, upload arrives first.
await step(`
for (const f of ["manifest.json", "content.js", "background.js"]) {
  await writeFile(process.env.CONV_ID, "uploads/EXT-Faceit/" + f, "x".repeat(500));
}
`);

const afterUpload = await readdirSafe(WORK);
check(
  "a cold server does not invent a second folder for the same chat",
  afterUpload.length === 1,
  afterUpload.join(", ")
);

// The user sends a message; the agent looks at the workspace.
const seen = await step(`
await appendMessages(process.env.CONV_ID, "faceit extension chat", [
  { id: "m2", role: "user", content: "whats in the zip", createdAt: new Date().toISOString() },
]);
const files = await listFiles(process.env.CONV_ID);
console.log(JSON.stringify(files.map((f) => f.path)));
`);
const visible = JSON.parse(seen.trim().split("\n").pop());
check(
  "the agent can still see the uploaded archive",
  visible.some((p) => p.includes("EXT-Faceit/content.js")),
  `${visible.length} file(s) visible`
);
check(
  "and the files that were there before it",
  visible.includes("notes.md")
);

// --------------------------------------------------------------------------
console.log("\n2. An already-broken workspace repairs itself");

/*
 * Anyone who used the previous build has a chat whose files are split across
 * two folders. Shipping a fix that only prevents new splits would leave them
 * with a zip that stays invisible forever, so the merge is tested too.
 */
await rm(DATA_ROOT, { recursive: true, force: true });
const SPLIT = randomUUID();
await mkdir(path.join(WORK, "split-chat"), { recursive: true });
await fsWrite(path.join(WORK, "split-chat", "notes.md"), "earlier work");
await mkdir(path.join(WORK, SPLIT, "uploads", "EXT-Faceit"), { recursive: true });
await fsWrite(path.join(WORK, SPLIT, "uploads", "EXT-Faceit", "content.js"), "// scanner");

await store.appendMessages(SPLIT, "split chat", [
  { id: "m1", role: "user", content: "q", createdAt: new Date().toISOString() },
]);
const healed = (await ws.listFiles(SPLIT)).map((f) => f.path);
check(
  "the orphaned upload is folded back in",
  healed.some((p) => p.includes("EXT-Faceit/content.js")),
  healed.join(", ")
);
check("nothing that was already there is lost", healed.includes("notes.md"));
const dirsNow = await readdirSafe(WORK);
check("and the duplicate folder is gone", dirsNow.length === 1, dirsNow.join(", "));

// --------------------------------------------------------------------------
console.log("\n2b. A long-running server notices a rename it did not make");

/*
 * The dev server caches the folder name the first time it touches a
 * workspace. Naming the chat renames that folder — and in Next.js the route
 * handlers and the store can be different module instances, so the cached
 * name goes stale and the workspace reports itself empty. Same visible
 * symptom as the original bug, different cause, so it gets its own check.
 */
const STALE = randomUUID();
await ws.writeFile(STALE, "uploads/EXT-Faceit/content.js", "// scanner");
ws.workspaceFolderName(STALE); // cache the id-named folder, as a request would
await store.appendMessages(STALE, "stale cache chat", [
  { id: "m1", role: "user", content: "q", createdAt: new Date().toISOString() },
]);
// Simulate the other module instance: force the name back to the stale value.
ws.setWorkspaceFolderName(STALE, STALE);
const afterStale = (await ws.listFiles(STALE)).map((f) => f.path);
check(
  "files are found under the new folder name",
  afterStale.some((p) => p.includes("EXT-Faceit/content.js")),
  afterStale.length ? afterStale.join(", ") : "reported as empty"
);

// --------------------------------------------------------------------------
console.log("\n3. Bookkeeping stays invisible");

const listed = await ws.listFiles(SPLIT);
check(
  "the id marker is never shown as a file",
  !listed.some((f) => f.path.includes(".workspace-id")),
  "it would appear in the panel and in the model's file tree"
);
const ctx = await wsctx.buildWorkspaceContext(SPLIT);
check("nor in the prompt", !ctx.includes(".workspace-id"));

// --------------------------------------------------------------------------
console.log("\n4. A whole project fits in the prompt");

const BIG = "bigproject";
await rm(path.join(WORK, BIG), { recursive: true, force: true });
for (let i = 0; i < 220; i++) {
  await ws.writeFile(BIG, `uploads/ext/src/module-${i}.js`, "x".repeat(2000));
}
const bigCtx = await wsctx.buildWorkspaceContext(BIG);
const shown = bigCtx.split("\n").filter((l) => /\(\d+(B|KB|MB)\)/.test(l)).length;
check(
  "a 220-file project is listed in full",
  shown === 220,
  `${shown} of 220 shown — asked for "the full structure", a partial tree is a wrong answer`
);
check("so nothing is described as missing", !bigCtx.includes("more (use list_files)"));

// --------------------------------------------------------------------------
console.log("\n5. Reads are not silently discarded");

check(
  "read_files accepts a realistic number of paths",
  tools.MAX_READ_FILES >= 50,
  `limit is ${tools.MAX_READ_FILES}`
);

const many = Array.from({ length: 12 }, (_, i) => `uploads/ext/src/module-${i}.js`);
const readRes = await tools.runTool(BIG, "read_files", { paths: many });
check(
  "twelve files in one call returns twelve",
  (readRes.content.match(/^--- /gm) ?? []).length === 12,
  readRes.summary
);

const tooMany = Array.from({ length: tools.MAX_READ_FILES + 3 }, (_, i) =>
  `uploads/ext/src/module-${i}.js`
);
const overRes = await tools.runTool(BIG, "read_files", { paths: tooMany });
check(
  "going over the limit names the files that were skipped",
  overRes.content.includes("NOT READ") &&
    overRes.content.includes(`module-${tools.MAX_READ_FILES}.js`),
  "a bare count was treated as commentary and the model answered anyway"
);
check(
  "and tells the model to fetch them rather than guess",
  /Call read_files again/.test(overRes.content)
);

// --------------------------------------------------------------------------
console.log("\n6. A mistyped path is recoverable");

/*
 * The reported transcript ends with the model asking for
 * "EXT-—-Faceit-Intelligence-Chrome/content.js", getting "No such file",
 * listing the workspace, and concluding the archive was gone — while the
 * file sat on disk under a slightly different folder name.
 */
const MISS = "misspath";
await rm(path.join(WORK, MISS), { recursive: true, force: true });
await ws.writeFile(MISS, "uploads/EXT-—-Faceit-Intelligence-v3.0.8/content.js", "// scanner");
const missRes = await tools.runTool(MISS, "read_file", {
  path: "EXT-—-Faceit-Intelligence-Chrome/content.js",
});
check("a wrong path still fails", !missRes.ok);
check(
  "but the real path is suggested",
  missRes.content.includes("uploads/EXT-—-Faceit-Intelligence-v3.0.8/content.js"),
  "otherwise the model reports the file as missing"
);
check(
  "and it is told not to claim the file is missing",
  /do not tell the user the file is missing/i.test(missRes.content)
);

// --------------------------------------------------------------------------
console.log("\n7. Pruning is sized for the model in use");

// DeepSeek v4 is a 1M-token model at roughly 3.6 chars per token.
const WINDOW_CHARS = 1_000_000 * 3.6;
check(
  "pruning does not start in the first 5% of the context window",
  prune.PRUNE_THRESHOLD_CHARS > WINDOW_CHARS * 0.05,
  `starts at ${(100 * prune.PRUNE_THRESHOLD_CHARS / WINDOW_CHARS).toFixed(1)}% of the window`
);
check(
  "enough recent reads are kept to describe a project",
  prune.KEEP_VERBATIM_RESULTS >= 50,
  `${prune.KEEP_VERBATIM_RESULTS} kept verbatim`
);

await rm(SCRATCH, { recursive: true, force: true });

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

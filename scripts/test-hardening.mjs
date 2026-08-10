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
import { existsSync } from "node:fs";

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
  /!stopped\(\) &&/.test(route),
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
  "commands are launched through cross-spawn",
  /crossSpawn\(/.test(runnerSrc),
  "resolving the path to npm.cmd only moved the failure from ENOENT to EINVAL"
);
check(
  "background processes use it too",
  /crossSpawn\(/.test(procSrc),
  "npm run dev failed the same way"
);
check(
  "the shell stays off",
  /shell: false/.test(runnerSrc) && !/^\s*shell: true/m.test(runnerSrc),
  "shell:true re-enables the injection CVE-2024-27980 describes, and every argument here comes from a model"
);
check(
  "an argument cannot inject a second command",
  await (async () => {
    const { runCommand } = await load("src/lib/runner.ts");
    const res = await runCommand(
      "injtest",
      "node",
      ["-e", "console.log('safe')", "&& echo PWNED"]
    );
    return !(res.stdout ?? "").includes("PWNED");
  })(),
  "the whole reason not to reach for shell:true"
);
check(
  "real commands actually run",
  await (async () => {
    const { runCommand } = await load("src/lib/runner.ts");
    const res = await runCommand("injtest", "npm", ["--version"]);
    return res.exitCode === 0;
  })(),
  "verified end to end, not just by reading the source"
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

// ------------------------------------------------------------------
console.log("\n9. Getting the files out");

/*
 * Reported as "i cant simply download workspace". The endpoint worked
 * perfectly; the control was a 14px unlabelled icon among four others, in a
 * panel that is `hidden ... lg:flex` — so below 1024px there was no way to
 * download at all. A control nobody can find is the same as a missing one.
 */
const sidePanel = read("src/components/WorkspaceSidePanel.tsx");
const dock = read("src/components/WorkspaceDock.tsx");
const zip = await load("src/lib/zip.ts");

check(
  "the side panel has a download that says what it is",
  /Download all files/.test(sidePanel),
  "an unlabelled icon requires hovering to discover"
);
check(
  "it fetches the bytes rather than navigating to the URL",
  /await fetch\(`\/api\/workspace\/\$\{workspaceId\}\/download`\)/.test(sidePanel),
  "a bare href is an ordinary navigation, which a download manager extension intercepts and then fails to fetch itself"
);
check(
  "the anchor carries a download attribute and a filename",
  /a\.download = match\?\.\[1\] \?\? "workspace\.zip"/.test(sidePanel),
  "without it the browser may navigate instead of saving"
);
check(
  "the blob url is revoked, but not before the save reads it",
  /setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 10_000\)/.test(sidePanel)
);
check(
  "the dock was not given a second, duplicate button",
  !/\/download`/.test(dock),
  "the panel already had one; adding another was noise, not a fix"
);

// The archive itself, including the awkward cases an unpacked zip contains.
const ZWS = "harddl";
await ws.writeFile(ZWS, "app.js", "console.log(1)");
const zdir = ws.workspaceDirectory(ZWS);
const { promises: nfs } = await import("node:fs");
await nfs.mkdir(path.join(zdir, "uploads/EXT-—-Faceit"), { recursive: true });
await nfs.writeFile(
  path.join(zdir, "uploads/EXT-—-Faceit/icon.png"),
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
);

const files = await ws.listFiles(ZWS);
const entries = [];
for (const f of files) {
  entries.push({
    path: f.path,
    content: await nfs.readFile(ws.resolveInside(ZWS, f.path)),
    modified: new Date(f.modifiedAt),
  });
}
const archive = await zip.createZip(entries);

check(
  "the archive has a valid end-of-central-directory record",
  archive.subarray(-22, -18).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06])),
  "a malformed one is what makes Windows refuse to open a zip"
);
check(
  "a binary survives the round trip byte for byte",
  archive.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  "an unpacked extension is full of images"
);
check(
  "a non-ASCII path is carried in the archive",
  archive.includes(Buffer.from("EXT-—-Faceit", "utf8")),
  "the em dash in an unpacked archive folder name"
);

// ------------------------------------------------------------------
console.log("\n10. The reply timeline reads as a sequence");

const timeline = read("src/components/MessageTimeline.tsx");
const toolActivity = read("src/components/ToolActivity.tsx");

check(
  "every row after the first is separated by a rule",
  /border-t border-border\/60 pt-4/.test(timeline),
  "only one line was drawn, above the whole timeline, so rows ran together"
);
check(
  "prose keeps clear of the vertical divider",
  /md:pr-6/.test(timeline) && /break-words/.test(timeline),
  "text was touching or crossing the rule"
);
check(
  "a long file path truncates from the left",
  /dir="rtl"/.test(toolActivity),
  "cutting the end leaves the directory and hides the filename, so every row in an unpacked archive looked identical"
);
check(
  "the full path is still available on hover",
  /title=\{filePath\}/.test(toolActivity)
);

// ------------------------------------------------------------------
console.log("\n11. The cost shown while running matches the final figure");

/*
 * Reported: the price climbs to something like $0.466 during a run and then
 * drops sharply once it finishes.
 *
 * Two causes, both display-only — nothing was ever overcharged.
 *
 *   - the live accumulator kept only prompt/completion/total, dropping
 *     DeepSeek's cache hit/miss split. estimateCost falls back to pricing the
 *     whole prompt as a miss when the split is absent, and a miss costs 120x
 *     a hit, so the running figure was several times too high.
 *   - the `done` event sent the last round's usage rather than the total, so
 *     the number changed a third time after a reload, when the stored record
 *     (which does use the total) was read back.
 */
const pricing = await load("src/lib/pricing.ts");

check(
  "the accumulator carries the cache split",
  /prompt_cache_hit_tokens: 0,\s*\n\s*prompt_cache_miss_tokens: 0,/.test(route),
  "without it every live figure prices cached tokens at the uncached rate"
);
check(
  "each round's split is summed, not overwritten",
  /totalUsage\.prompt_cache_hit_tokens \+= roundHit/.test(route),
  "round one is mostly a miss, later rounds mostly hits"
);
check(
  "a missing miss count is derived rather than dropped",
  /Math\.max\(0, \(u\.prompt_tokens \?\? 0\) - roundHit\)/.test(route)
);
check(
  "the done event reports the accumulated total",
  /usage: totalUsage\.total_tokens \? \{ \.\.\.totalUsage \} : usage/.test(route),
  "it sent the final round alone, so a 20-round task announced round 20's cost"
);

// The gap this closes, at a realistic cache rate.
const withSplit = pricing.estimateCost(
  {
    prompt_tokens: 1_800_000,
    completion_tokens: 190_000,
    prompt_cache_hit_tokens: 1_620_000,
    prompt_cache_miss_tokens: 180_000,
  },
  "deepseek-v4-pro"
);
const withoutSplit = pricing.estimateCost(
  { prompt_tokens: 1_800_000, completion_tokens: 190_000 },
  "deepseek-v4-pro"
);
check(
  "dropping the split really did overstate the cost several times over",
  withoutSplit > withSplit * 3,
  `${withoutSplit.toFixed(3)} against ${withSplit.toFixed(3)} — the jump the user saw`
);

check(
  "the mock reports a cache split, so this stays covered",
  /prompt_cache_hit_tokens/.test(read("scripts/mock-deepseek.mjs")),
  "it reported only totals, so no test could have caught this"
);

// ------------------------------------------------------------------
console.log("\n12. One cost figure, not two to add up");

/*
 * Reported: "161,136 tokens $0.0009 +$0.184 search ... how can 161k tokens be
 * 0.0009? i need total usage cuz it is total".
 *
 * The $0.0009 was correct — nearly all of those tokens were cache hits, which
 * DeepSeek bills at 1/120th of the input rate. But three figures sat in a row
 * with no relationship between them: a token count that belongs only to the
 * model, a model cost that looked impossible next to it, and a search fee
 * that has no token count at all and was two orders of magnitude larger.
 */
const bubbleSrc = read("src/components/MessageBubble.tsx");

check(
  "model and search are added into one number",
  /const cost =\s*\n?\s*modelCost === null && searchCost === 0 \? null : \(modelCost \?\? 0\) \+ searchCost/.test(
    bubbleSrc
  ),
  "leaving the reader to add $0.0009 and $0.184 themselves"
);
check(
  "the separate '+search' figure is gone",
  !/\+\{formatCost\(message\.searchUsd\)\} search/.test(bubbleSrc)
);
check(
  "the split is still available on hover",
  /`Model: \$\{formatCost\(modelCost \?\? 0\)\}`/.test(bubbleSrc) &&
    /Web search: \$\{formatCost\(searchCost\)\}/.test(bubbleSrc)
);
check(
  "the token tooltip explains why a huge count can cost almost nothing",
  /billed at 1\/120th the rate/.test(bubbleSrc),
  "the cache split is the missing explanation"
);

// The arithmetic behind the reported figures.
check(
  "a heavily cached 161k really does cost about a tenth of a cent",
  Math.abs(
    pricing.estimateCost(
      {
        prompt_tokens: 160_000,
        completion_tokens: 1_136,
        prompt_cache_hit_tokens: 159_000,
        prompt_cache_miss_tokens: 1_000,
      },
      "deepseek-v4-flash"
    ) - 0.0009
  ) < 0.0002,
  "so the number was right; only its presentation was wrong"
);

// ------------------------------------------------------------------
console.log("\n13. The app itself, not the agent");

/*
 * Two costs that grew with everything ever written rather than with what is
 * on screen. Neither is about the model.
 */
const { randomUUID } = await import("node:crypto");
const filler = "x".repeat(4000);
for (let i = 0; i < 25; i++) {
  const msgs = [];
  for (let m = 0; m < (i % 5 === 0 ? 60 : 10); m++) {
    msgs.push({
      id: randomUUID(),
      role: m % 2 ? "assistant" : "user",
      content: filler,
      reasoningContent: filler,
      createdAt: new Date().toISOString(),
    });
  }
  await store.appendMessages(randomUUID(), `perf chat ${i}`, msgs);
}

let t0 = Date.now();
const first = await store.listConversations();
const coldMs = Date.now() - t0;
t0 = Date.now();
await store.listConversations();
const warmMs = Date.now() - t0;

check(
  "the sidebar list is cached between refreshes",
  warmMs * 3 < coldMs || warmMs <= 2,
  `${coldMs}ms cold, ${warmMs}ms warm — it re-read and re-parsed every chat in full to show titles`
);

const target = first[0];
const wasCount = target.messageCount;
await store.appendMessages(target.id, target.title, [
  { id: randomUUID(), role: "user", content: "new", createdAt: new Date().toISOString() },
]);
const refreshed = (await store.listConversations()).find((c) => c.id === target.id);
check(
  "and a changed chat is not served stale",
  refreshed.messageCount === wasCount + 1,
  "keyed on size and mtime, so an edit made outside the app is picked up too"
);

const convRouteSrc = read("src/app/api/conversations/[id]/route.ts");
check(
  "opening a chat no longer ships every chain of thought",
  /reasoningLength: reasoningContent\?\.length \?\? 0/.test(convRouteSrc),
  "it was about half the payload, collapsed by default and rarely read"
);
check(
  "the text is fetchable when the panel is opened",
  existsSync(
    path.join(ROOT, "src/app/api/conversations/[id]/reasoning/[messageId]/route.ts")
  ),
  "one small request when expanded, against a large one on every open"
);
check(
  "the panel still appears before its text has loaded",
  /message\.reasoningContent \|\| message\.reasoningLength/.test(
    read("src/components/MessageBubble.tsx")
  ),
  "otherwise a stored reply would look as though it never reasoned"
);
check(
  "expanding it triggers the fetch",
  /if \(!showThinking\) onLoadReasoning\?\.\(message\.id\)/.test(
    read("src/components/MessageBubble.tsx")
  )
);

// ------------------------------------------------------------------
console.log("\n14. Closing the tab is not the same as pressing Stop");

/*
 * The route watched req.signal for everything, and the browser aborts that
 * when its tab closes — so closing a tab killed a run that was thirty rounds
 * in and still writing files into the user's workspace. Those files are the
 * point, so a lost connection now means "nobody is watching", not "stop".
 */
const runs = await load("src/lib/runs.ts");
const routeSrc = read("src/app/api/chat/route.ts");
const pageSrc = read("src/app/page.tsx");

const sig = runs.beginRun("t-1", "c-1");
check(
  "a run is registered and its signal starts clean",
  runs.isRunning("t-1") && !sig.aborted
);
check("it is findable by conversation", runs.activeRuns("c-1").includes("t-1"));
check(
  "only an explicit stop aborts it",
  runs.stopRun("t-1") && sig.aborted,
  "the closed tab aborts req.signal, which the work no longer watches"
);
check(
  "stopping something already finished says so",
  runs.stopRun("t-1") === false,
  "a Stop that silently did nothing is worse than an honest answer"
);
runs.beginRun("t-2", "c-1");
runs.endRun("t-2");
check("finishing releases the run", runs.runCount() === 0);

check(
  "the work watches the run, not the request",
  /const runSignal = beginRun\(assistantMsgId, convId\)/.test(routeSrc) &&
    /const stopped = \(\) => runSignal\.aborted/.test(routeSrc)
);
check(
  "prompts that need a person still follow the connection",
  /AbortSignal\.any\(\[req\.signal, runSignal\]\)/.test(routeSrc),
  "a question with nobody to answer it would hang until the safety ceiling"
);
check(
  "there is a ceiling so a wedged run cannot live forever",
  runs.MAX_RUN_MS > 0 && runs.MAX_RUN_MS <= 60 * 60 * 1000,
  `${runs.MAX_RUN_MS / 60000} minutes`
);
check(
  "Stop tells the server rather than just closing the stream",
  /\/api\/chat\/stop/.test(pageSrc) && /keepalive: true/.test(pageSrc),
  "aborting the fetch alone no longer stops anything"
);
check(
  "the server sends the id Stop needs",
  /messageId: assistantMsgId/.test(routeSrc)
);

// ------------------------------------------------------------------
console.log("\n15. Searching inside messages actually works");

/*
 * searchConversations looked for files ending in .json in the data directory
 * — the layout from before chats were given their own folder. It matched
 * nothing, so search silently returned no results for everything, which
 * reads as "not found" rather than as a bug.
 */
const SEARCH_ID = randomUUID();
await store.appendMessages(SEARCH_ID, "faceit extension work", [
  { id: randomUUID(), role: "user", content: "how do we fix the zip bug", createdAt: new Date().toISOString() },
  { id: randomUUID(), role: "assistant", content: "ensureFolder orphaned the uploads folder", createdAt: new Date().toISOString() },
]);

check(
  "a phrase inside a message is found",
  (await store.searchConversations("zip bug")).length === 1,
  "this returned nothing at all before"
);
check(
  "an identifier buried in a reply is found",
  (await store.searchConversations("ensureFolder")).length === 1
);
check("titles still match", (await store.searchConversations("faceit")).length === 1);
check(
  "a real miss still returns nothing",
  (await store.searchConversations("zzznotpresent")).length === 0
);
check(
  "results carry a snippet, not just a title",
  Boolean((await store.searchConversations("zip bug"))[0]?.snippets?.[0]?.text)
);

// ------------------------------------------------------------------
console.log("\n16. A render crash does not blank the app");

check(
  "there is an error boundary",
  existsSync(path.join(ROOT, "src/app/error.tsx")),
  "an uncaught render error left a white page with no way back"
);
const errSrc = read("src/app/error.tsx");
check(
  "it says the work is safe",
  /on disk and untouched/.test(errSrc),
  "the first question is whether anything was lost"
);
check("it offers a retry", errSrc.includes("onClick={reset}"));
check(
  "it shows the actual message",
  /error\.message/.test(errSrc),
  "a self-hosted user is also the person who can fix it"
);

check(
  "losing the connection is reported as such",
  /No connection\./.test(pageSrc) && /addEventListener\("offline", update\)/.test(pageSrc),
  "a reply stopping mid-sentence otherwise reads as the model failing"
);
check(
  "and it says the work continues without the tab",
  /keeps going on the server/.test(pageSrc)
);

// ------------------------------------------------------------------
console.log("\n17. The workspace listing, which runs constantly");

/*
 * Measured rather than assumed, after an earlier list of "optimizations"
 * turned out to be guesses. Two real costs, both on the path that runs
 * whenever the agent touches a file.
 */
const HOT = "hotlist";
await rm(path.join(ROOT, "data", "workspaces", HOT), {
  recursive: true,
  force: true,
});
for (let i = 0; i < 300; i++) {
  await ws.writeFile(HOT, `uploads/ext/src/m${i}.js`, "x".repeat(500));
}

const listStart = Date.now();
const listed = await ws.listFiles(HOT);
const listMs = Date.now() - listStart;

check(
  "a 300-file listing is quick",
  listMs < 120,
  `${listMs}ms — every file needed its own stat, and they were awaited one at a time`
);
check("and it finds everything", listed.length === 300);
check(
  "the stats are gathered concurrently",
  /const stats = await Promise\.all\(/.test(read("src/lib/workspace.ts")),
  "the calls do not depend on each other, so serialising them was pure latency"
);
check(
  "a file that vanishes mid-walk does not fail the listing",
  /\.catch\(\(\) => null\)/.test(read("src/lib/workspace.ts"))
);
check(
  "sizes and dates still come back",
  listed.every((f) => f.size > 0 && Boolean(f.modifiedAt)),
  "the whole point of the stat call"
);

check(
  "the panel coalesces a burst of writes into one refresh",
  /const scheduleWorkspaceRefresh = useCallback/.test(pageSrc) &&
    /scheduleWorkspaceRefresh\(\);/.test(pageSrc),
  "one write_files call fired 30 full listings back to back — 1.2s of disk work for one final state"
);
check(
  "it is trailing, so the last state is the one fetched",
  /clearTimeout\(refreshTimer\.current\)/.test(pageSrc),
  "a leading debounce would show the state before the writes finished"
);
check(
  "and the timer is cleared on unmount",
  /\(\) => \{\s*\n\s*if \(refreshTimer\.current\) clearTimeout/.test(pageSrc)
);

// ------------------------------------------------------------------
console.log("\n18. Several tools in one round no longer queue");

/*
 * Measured before changing anything. Sixty local file reads take 27ms serial
 * and 23ms parallel — disk was never the problem. A network round trip is:
 * four page fetches serially is about 1.6s where one is 0.4s, and three
 * searches is 4.5s against 1.5s.
 */
const routeText = read("src/app/api/chat/route.ts");

check(
  "network reads in a round are started together",
  /const prefetched = new Map<string, Promise<ToolResult>>\(\)/.test(routeText),
  "each was awaited before the next began"
);
check(
  "only read-only tools are eligible",
  /const PARALLEL_SAFE = new Set\(\[\s*\n\s*"fetch_url",/.test(routeText) &&
    !/PARALLEL_SAFE[\s\S]{0,200}"write_file"/.test(routeText),
  "two writes racing on one path is a corrupt file"
);
check(
  "commands and approvals stay strictly in order",
  !/PARALLEL_SAFE[\s\S]{0,200}"run_command"/.test(routeText),
  "approval prompts arriving out of order would be unreadable"
);
check(
  "results are still awaited in the order the model asked",
  /result = await prefetched\.get\(call\.id\)!/.test(routeText),
  "the transcript has to read as one result after another"
);
check(
  "a failure in a prefetched call is caught, not thrown",
  /\}\)\.catch\(\(error\) => \(\{/.test(routeText),
  "an unhandled rejection would abandon the whole round"
);
check(
  "a single call does not pay for the machinery",
  /if \(calls\.length > 1\) \{/.test(routeText)
);

// read_files ordering, which is what parallelising it could have broken.
const ORD = "ordering";
await rm(path.join(ROOT, "data", "workspaces", ORD), {
  recursive: true,
  force: true,
});
for (const n of ["a", "b", "c"]) await ws.writeFile(ORD, `${n}.js`, `// ${n}`);

const { runTool } = await load("src/lib/tools.ts");
const ordered = await runTool(ORD, "read_files", {
  paths: ["c.js", "MISSING.js", "a.js", "b.js"],
});
const seen = [...ordered.content.matchAll(/--- (.+?) ---/g)].map((m) => m[1]);
check(
  "read_files returns files in the order requested",
  seen.join(",") === "c.js,MISSING.js,a.js,b.js",
  "the model refers to them by position in its own request"
);
check(
  "a missing file is still reported inline without losing the others",
  /could not read/.test(ordered.content) && /Read 3 of 4/.test(ordered.summary)
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

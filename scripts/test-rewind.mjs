/**
 * Rewind to a message — the chat and the workspace files together.
 *
 * Run:  npm run test:rewind
 *
 * Driven through the real route handler against a real data root: real
 * workspace files, real restore points linked the way the chat route links
 * them, and the stored conversation read back from disk. Checks that both
 * the chat and the files come back, that the rewind can itself be undone,
 * that a running reply refuses it, and that "chat only" leaves files alone.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.APIM_DATA_ROOT ??= path.join(ROOT, ".test-data", "rewind");
const DATA_ROOT = path.resolve(process.env.APIM_DATA_ROOT);
await rm(DATA_ROOT, { recursive: true, force: true });

const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const src = (p) => readFileSync(path.join(ROOT, p), "utf8");

const store = await load("src/lib/store.ts");
const ws = await load("src/lib/workspace.ts");
const S = await load("src/lib/snapshots.ts");
const R = await load("src/lib/rewind.ts");
const runs = await load("src/lib/runs.ts");
const route = await load("src/app/api/conversations/[id]/rewind/route.ts");
const { NextRequest } = await import("next/server");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);
let pass = 0,
  fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const read = (id, p) => ws.readFile(id, p).then((f) => f.content).catch(() => null);
const fileList = async (id) => (await ws.listFiles(id)).map((f) => f.path).sort().join(",");
const ids = async (id) => ((await store.getConversation(id))?.messages ?? []).map((m) => m.id);

async function rewind(id, body) {
  const req = new NextRequest(`http://localhost/api/conversations/${id}/rewind`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await route.POST(req, { params: Promise.resolve({ id }) });
  return { status: res.status, data: await res.json() };
}

/**
 * One exchange, the way the chat route does it: store the question, take
 * the start-of-reply snapshot and link it, then the "reply" changes files
 * and is stored.
 */
async function exchange(id, n, question, work) {
  await store.appendMessages(id, "Rewind test", [
    { id: `q${n}`, role: "user", content: question, createdAt: new Date().toISOString() },
  ]);
  const snap = await S.createSnapshot(id, question.slice(0, 80));
  await R.linkRestorePoint(id, id, `a${n}`, snap);
  await work();
  await store.appendMessages(id, "Rewind test", [
    { id: `a${n}`, role: "assistant", content: `done ${n}`, createdAt: new Date().toISOString() },
  ]);
  await sleep(3);
  return snap;
}

console.log("\napiM rewind checks\n");

const C = "rewind-chat";

console.log("1. Each question records its restore point");
await exchange(C, 1, "Build a small app", async () => {
  await ws.writeFile(C, "app.py", "v1\n");
  await ws.writeFile(C, "README.md", "readme\n");
});
const snap2 = await exchange(C, 2, "Add a helper", async () => {
  await ws.writeFile(C, "app.py", "v2\n");
  await ws.writeFile(C, "util.py", "helper\n");
});
const snap3 = await exchange(C, 3, "Refactor it", async () => {
  await ws.writeFile(C, "app.py", "v3\n");
  await ws.deleteFile(C, "README.md");
});
{
  const conv = await store.getConversation(C);
  const q = (id) => conv.messages.find((m) => m.id === id);
  check("the first question records an empty workspace", q("q1").restorePoint?.snapshotId === null,
    JSON.stringify(q("q1").restorePoint));
  check("later questions record their snapshot",
    q("q2").restorePoint?.snapshotId === snap2?.id && q("q3").restorePoint?.snapshotId === snap3?.id);
  check("replies carry no restore point", !q("a1").restorePoint && !q("a2").restorePoint);
}

console.log("\n2. A retry keeps the first restore point; a resume records nothing");
{
  await store.truncateFrom(C, "a3");
  await ws.writeFile(C, "app.py", "v3 again\n");
  const retrySnap = await S.createSnapshot(C, "Refactor it");
  await R.linkRestorePoint(C, C, "a3b", retrySnap);
  await store.appendMessages(C, "Rewind test", [
    { id: "a3b", role: "assistant", content: "done 3b", createdAt: new Date().toISOString() },
  ]);
  const resumeSnap = await S.createSnapshot(C, "Refactor it");
  await R.linkRestorePoint(C, C, "a3b", resumeSnap);
  const q3 = (await store.getConversation(C)).messages.find((m) => m.id === "q3");
  check("the question still points at its first reply's snapshot", q3.restorePoint?.snapshotId === snap3.id,
    q3.restorePoint?.snapshotId);
  await ws.writeFile(C, "app.py", "v3\n");
}

console.log("\n3. Dry run reports and changes nothing");
{
  const before = await ids(C);
  const { status, data } = await rewind(C, { messageId: "temp-123", replyId: "a2", restoreFiles: true, dryRun: true });
  check("200", status === 200, `${status} ${data.error ?? ""}`);
  check("found the question through its reply id", data.messageId === "q2", data.messageId);
  check("counts the question and everything after it", data.removedMessages === 4, `${data.removedMessages}`);
  check("files can be restored", data.files?.available === true && data.files.snapshotId === snap2.id);
  check("the chat is untouched", (await ids(C)).join() === before.join());
  check("the files are untouched", (await read(C, "app.py")) === "v3\n");
}

console.log("\n4. Refused while a reply is running");
{
  const signal = runs.beginRun("running-reply", C);
  const before = await ids(C);
  const { status, data } = await rewind(C, { messageId: "q2", restoreFiles: true });
  check("409", status === 409, `${status}`);
  check("says why", /still running/.test(data.error ?? ""), data.error);
  check("the chat is untouched", (await ids(C)).join() === before.join());
  check("the files are untouched", (await read(C, "app.py")) === "v3\n" && (await read(C, "util.py")) === "helper\n");
  runs.endRun("running-reply", signal);
}

console.log("\n5. Chat only: the conversation rewinds, the files stay");
{
  await store.saveHistorySummary(C, null, {
    text: "summary through the retry", upToId: "a3b", droppedTurns: 0,
    updatedAt: new Date().toISOString(), manual: true, coveredTurns: 6,
  });
  // A client temp id: located by position among questions, confirmed by text.
  const { status, data } = await rewind(C, {
    messageId: "temp-999", ordinal: 2, content: "Refactor it", restoreFiles: false,
  });
  check("200", status === 200, `${status} ${data.error ?? ""}`);
  check("hands back the question text", data.question === "Refactor it", data.question);
  check("the question and its reply are gone", (await ids(C)).join() === "q1,a1,q2,a2", (await ids(C)).join());
  check("files untouched", (await read(C, "app.py")) === "v3\n" && (await read(C, "util.py")) === "helper\n"
    && (await read(C, "README.md")) === null);
  check("no safety snapshot for a chat-only rewind", data.safetySnapshotId === null && data.filesRestored === null);
  const conv = await store.getConversation(C);
  check("a summary whose cursor was cut is dropped", conv.historySummary === undefined);
}

console.log("\n6. Chat and files: both go back to before the question");
let safety;
{
  const { status, data } = await rewind(C, { messageId: "q2", restoreFiles: true });
  check("200", status === 200, `${status} ${data.error ?? ""}`);
  check("the chat ends before the question", (await ids(C)).join() === "q1,a1", (await ids(C)).join());
  check("a changed file comes back", (await read(C, "app.py")) === "v1\n", await read(C, "app.py"));
  check("a deleted file comes back", (await read(C, "README.md")) === "readme\n");
  check("a file created since is removed", (await read(C, "util.py")) === null);
  check("counts are reported", data.filesRestored?.restored === 2 && data.filesRestored?.removed === 1,
    JSON.stringify(data.filesRestored));
  safety = data.safetySnapshotId;
  const snaps = await S.listSnapshots(C);
  const s = snaps.find((x) => x.id === safety);
  check("a safety snapshot was taken and returned", Boolean(s), safety);
  check("it is labelled as the rewind", /^Before rewinding to: Add a helper/.test(s?.label ?? ""), s?.label);
}

console.log("\n7. The rewind can be undone from its safety snapshot");
{
  await S.restoreSnapshot(C, safety);
  check("the files are as they were before the rewind",
    (await read(C, "app.py")) === "v3\n" && (await read(C, "util.py")) === "helper\n" && (await read(C, "README.md")) === null,
    await fileList(C));
}

console.log("\n8. Rewinding to the first question empties the workspace");
{
  const { status, data } = await rewind(C, { messageId: "q1", restoreFiles: true });
  check("200", status === 200, `${status} ${data.error ?? ""}`);
  check("the chat is empty", (await ids(C)).length === 0);
  check("no files remain", (await fileList(C)) === "", await fileList(C));
  check("the question comes back for the composer", data.question === "Build a small app");
  await S.restoreSnapshot(C, data.safetySnapshotId);
  check("and it too can be undone", (await read(C, "app.py")) === "v3\n");
}

console.log("\n9. Nothing changes when it cannot be done");
{
  const C2 = "rewind-errors";
  await store.appendMessages(C2, "Errors", [
    { id: "x1", role: "user", content: "no workspace here", createdAt: new Date().toISOString() },
    { id: "y1", role: "assistant", content: "ok", createdAt: new Date().toISOString() },
  ]);
  await ws.writeFile(C2, "keep.txt", "keep\n");
  let res = await rewind(C2, { messageId: "nope", restoreFiles: false });
  check("an unknown message is 404", res.status === 404, `${res.status}`);
  res = await rewind(C2, { restoreFiles: false });
  check("no message id is 400", res.status === 400, `${res.status}`);
  res = await rewind(C2, { messageId: "x1", restoreFiles: true });
  check("files without a restore point is refused", res.status === 409, `${res.status} ${res.data.error}`);
  check("and nothing was cut", (await ids(C2)).join() === "x1,y1");
  check("or deleted", (await read(C2, "keep.txt")) === "keep\n");
  res = await rewind(C2, { messageId: "x1", restoreFiles: false, dryRun: true });
  check("the dry run says files are unavailable", res.data.files?.available === false && res.data.files.kind === "none",
    JSON.stringify(res.data.files));
  res = await rewind("no-such-chat", { messageId: "x1", restoreFiles: false });
  check("an unsaved chat is 404", res.status === 404, `${res.status}`);
  res = await rewind(C2, { messageId: "x1", restoreFiles: false, workspaceId: "../etc" });
  check("a crafted workspace id is refused", res.status === 400, `${res.status}`);
}

console.log("\n10. Questions from before restore points were linked still rewind files");
{
  const C3 = "rewind-legacy";
  await ws.writeFile(C3, "main.py", "original\n");
  await store.appendMessages(C3, "Legacy", [
    { id: "l1", role: "user", content: "Change main please", createdAt: new Date().toISOString() },
  ]);
  await sleep(3);
  await S.createSnapshot(C3, "Change main please");
  await ws.writeFile(C3, "main.py", "changed\n");
  await store.appendMessages(C3, "Legacy", [
    { id: "m1", role: "assistant", content: "changed", createdAt: new Date().toISOString() },
  ]);
  const { status, data } = await rewind(C3, { messageId: "l1", restoreFiles: true });
  check("found by label and time", status === 200 && data.files?.kind === "snapshot", `${status} ${data.error ?? ""}`);
  check("and restored", (await read(C3, "main.py")) === "original\n");
}

console.log("\n11. An old restore point at the snapshot cap is not pruned by the rewind");
{
  const C4 = "rewind-cap";
  await exchange(C4, 1, "first", async () => ws.writeFile(C4, "a.txt", "1\n"));
  const target = await exchange(C4, 2, "second", async () => ws.writeFile(C4, "a.txt", "2\n"));
  // Fill up to the cap so the target is the oldest surviving snapshot.
  for (let i = 0; i < S.MAX_SNAPSHOTS; i++) {
    const all = await S.listSnapshots(C4);
    if (all.length >= S.MAX_SNAPSHOTS) break;
    await ws.writeFile(C4, "a.txt", `later ${i}\n`);
    await S.createSnapshot(C4, `filler ${i}`);
    await sleep(2);
  }
  const all = await S.listSnapshots(C4);
  check("the target is the oldest at the cap",
    all.length === S.MAX_SNAPSHOTS && all[all.length - 1].id === target.id, `${all.length}`);
  const { status, data } = await rewind(C4, { messageId: "q2", restoreFiles: true });
  check("200", status === 200, `${status} ${data.error ?? ""}`);
  check("its content came back", (await read(C4, "a.txt")) === "1\n", await read(C4, "a.txt"));
}

console.log("\n12. Wiring");
{
  const chat = src("src/app/api/chat/route.ts");
  check("the chat route links each start-of-reply snapshot",
    /const restorePoint = await createSnapshot\([\s\S]{0,200}?\);\s*\/\/[^\n]*\n\s*await linkRestorePoint\(convId, workspace, assistantMsgId, restorePoint\)/.test(chat));
  check("the slash command exists", src("src/lib/slash-commands.ts").includes('name: "rewind"'));
  check("the composer handles it", src("src/components/ChatArea.tsx").includes('case "rewind":'));
  check("the bubble offers it", /Rewind chat and files/.test(src("src/components/RewindPopover.tsx")));
}

await rm(DATA_ROOT, { recursive: true, force: true });
console.log(`\n${pass + fail} checks · ${pass} passed${fail ? ` · ${r(`${fail} failed`)}` : ""}\n`);
process.exit(fail ? 1 : 0);

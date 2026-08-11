/**
 * Checks chats and workspaces use readable, matching folder names.
 *
 * Run:  npm run test:folders
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rm, readdir, access } from "node:fs/promises";

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
const store = await import(pathToFileURL(path.join(ROOT, "src/lib/store.ts")).href);
const ws = await import(pathToFileURL(path.join(ROOT, "src/lib/workspace.ts")).href);
const { slugify, uniqueSlug } = await import(pathToFileURL(path.join(ROOT, "src/lib/slug.ts")).href);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};
const exists = (p) => access(p).then(() => true).catch(() => false);
const CHATS = path.join(DATA_ROOT, "chats");
const WORK = path.join(DATA_ROOT, "workspaces");

await rm(DATA_ROOT, { recursive: true, force: true });

console.log("\napiM folder naming checks\n");

console.log("1. Turning titles into folder names");
check("plain title", slugify("Hello World") === "hello-world", slugify("Hello World"));
check("punctuation is dropped", slugify("What's the plan?!") === "what-s-the-plan", slugify("What's the plan?!"));
check("accents are kept readable", slugify("Café résumé") === "cafe-resume", slugify("Café résumé"));
check("slashes can't make subfolders", !slugify("a/../../b").includes("/"), slugify("a/../../b"));
check("emoji-only titles yield nothing usable", slugify("🎉🎉") === "", JSON.stringify(slugify("🎉🎉")));
check("Windows reserved names are avoided", slugify("CON") === "con-chat", slugify("CON"));
check("long titles are trimmed", slugify("x".repeat(200)).length <= 48, `${slugify("x".repeat(200)).length} chars`);
check("duplicate names get a suffix",
  uniqueSlug("hello", new Set(["hello"]), "id") === "hello-2",
  uniqueSlug("hello", new Set(["hello"]), "id"));

console.log("\n2. A chat becomes a named folder");
const id1 = "11111111-aaaa-bbbb-cccc-000000000001";
await store.appendMessages(id1, "Hello World", [
  { id: "m1", role: "user", content: "hi", createdAt: new Date().toISOString() },
]);
check("folder is named after the title", await exists(path.join(CHATS, "hello-world")));
check("the json is inside it", await exists(path.join(CHATS, "hello-world", "chat.json")));
check("no UUID folder was created", !(await exists(path.join(CHATS, id1))));

console.log("\n3. The workspace matches");
await ws.writeFile(id1, "app.py", "print('hi')\n");
check("workspace uses the same name", await exists(path.join(WORK, "hello-world")),
  (await readdir(WORK).catch(() => [])).join(", "));
check("the file is in there", await exists(path.join(WORK, "hello-world", "app.py")));

console.log("\n4. Renaming the chat renames both");
await store.updateConversation(id1, { title: "Budget Planner" });
check("chat folder followed the rename", await exists(path.join(CHATS, "budget-planner")));
check("old chat folder is gone", !(await exists(path.join(CHATS, "hello-world"))));
check("workspace folder followed too", await exists(path.join(WORK, "budget-planner")),
  (await readdir(WORK).catch(() => [])).join(", "));
check("the file survived the move", await exists(path.join(WORK, "budget-planner", "app.py")));

console.log("\n5. Nothing breaks after the rename");
const conv = await store.getConversation(id1);
check("the chat still loads by id", conv?.title === "Budget Planner");
const files = await ws.listFiles(id1);
check("workspace files still list", files.some((f) => f.path === "app.py"),
  files.map((f) => f.path).join(", "));
const read = await ws.readFile(id1, "app.py");
check("the file still reads", read.content === "print('hi')\n");

console.log("\n6. Two chats with the same title");
const id2 = "22222222-aaaa-bbbb-cccc-000000000002";
await store.appendMessages(id2, "Budget Planner", [
  { id: "m1", role: "user", content: "hi", createdAt: new Date().toISOString() },
]);
check("the second gets its own folder", await exists(path.join(CHATS, "budget-planner-2")));
check("the first is untouched", (await store.getConversation(id1))?.id === id1);
check("both appear in the list", (await store.listConversations()).length === 2);

console.log("\n7. Untitled and odd names still work");
const id3 = "33333333-aaaa-bbbb-cccc-000000000003";
await store.appendMessages(id3, "🎉🎉🎉", [
  { id: "m1", role: "user", content: "hi", createdAt: new Date().toISOString() },
]);
const conv3 = await store.getConversation(id3);
check("an unusable title still saves", conv3?.id === id3);
const dirs = (await readdir(CHATS)).filter((n) => !n.startsWith("."));
check("every folder has a usable name", dirs.every((n) => /^[\w-]+$/.test(n)), dirs.join(", "));

console.log("\n8. Deleting removes the whole folder");
await store.deleteConversation(id2);
check("folder is gone", !(await exists(path.join(CHATS, "budget-planner-2"))));
check("other chats survive", (await store.getConversation(id1))?.id === id1);

console.log("\n" + (fail === 0 ? g(`All ${pass} checks passed.`) : r(`${fail} of ${pass + fail} failed.`)) + "\n");
process.exit(fail === 0 ? 0 : 1);

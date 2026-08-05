/**
 * Checks that two chats can't share a name.
 *
 * Run:  npm run test:titles
 *
 * Names are folder names now, so a duplicate is not cosmetic — two chats
 * called "Hello" would want the same folder.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rm, access, readdir } from "node:fs/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const store = await import(pathToFileURL(path.join(ROOT, "src/lib/store.ts")).href);

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
const CHATS = path.join(ROOT, "data", "chats");
const now = () => new Date().toISOString();
const mk = (id, title) =>
  store.appendMessages(id, title, [{ id: "m1", role: "user", content: "hi", createdAt: now() }]);

await rm(path.join(ROOT, "data"), { recursive: true, force: true });

console.log("\napiM duplicate-name checks\n");

console.log("1. Auto-titles avoid collisions on their own");
await mk("id-1", "Hello");
const t2 = await store.availableTitle("Hello");
check("a second 'Hello' becomes 'Hello 2'", t2 === "Hello 2", t2);
await mk("id-2", t2);
const t3 = await store.availableTitle("Hello");
check("a third becomes 'Hello 3'", (await store.availableTitle("Hello")) === "Hello 3", t3);
check("both chats exist separately", (await store.listConversations()).length === 2);
check("each got its own folder",
  (await exists(path.join(CHATS, "hello"))) && (await exists(path.join(CHATS, "hello-2"))),
  (await readdir(CHATS)).join(", "));

console.log("\n2. Renaming onto a taken name is refused");
let threw = null;
try {
  await store.updateConversation("id-2", { title: "Hello" });
} catch (e) {
  threw = e;
}
check("the rename throws", threw !== null);
check("it is a DuplicateTitleError", threw?.name === "DuplicateTitleError", threw?.name);
check("the message names the title", /Hello/.test(threw?.message ?? ""), threw?.message);
check("the chat kept its old name",
  (await store.getConversation("id-2"))?.title === "Hello 2");
check("its folder did not move", await exists(path.join(CHATS, "hello-2")));

console.log("\n3. Case and spacing don't create a loophole");
for (const variant of ["hello", "HELLO", "  Hello  ", "Hello"]) {
  let blocked = false;
  try {
    await store.updateConversation("id-2", { title: variant });
  } catch {
    blocked = true;
  }
  check(`refuses ${JSON.stringify(variant)}`, blocked);
}

console.log("\n4. Legitimate renames still work");
const ok1 = await store.updateConversation("id-2", { title: "Something Else" });
check("renaming to a free name works", ok1?.title === "Something Else");
check("the folder followed", await exists(path.join(CHATS, "something-else")));

const ok2 = await store.updateConversation("id-2", { title: "Something Else" });
check("renaming to its own current name is not an error", ok2?.title === "Something Else");

const ok3 = await store.updateConversation("id-2", { title: "  Something Else  " });
check("same name with stray spaces is allowed and trimmed",
  ok3?.title === "Something Else", JSON.stringify(ok3?.title));

console.log("\n5. Freeing a name makes it usable again");
await store.deleteConversation("id-1");
const ok4 = await store.updateConversation("id-2", { title: "Hello" });
check("after deleting the other chat, the name is free", ok4?.title === "Hello");
check("its folder is now 'hello'", await exists(path.join(CHATS, "hello")));

console.log("\n6. Archived chats still hold their name");
await mk("id-3", "Archived One");
await store.updateConversation("id-3", { archived: true });
let blockedArchived = false;
try {
  await store.updateConversation("id-2", { title: "Archived One" });
} catch {
  blockedArchived = true;
}
check("an archived chat's name is still taken", blockedArchived);

console.log("\n" + (fail === 0 ? g(`All ${pass} checks passed.`) : r(`${fail} of ${pass + fail} failed.`)) + "\n");
process.exit(fail === 0 ? 0 : 1);

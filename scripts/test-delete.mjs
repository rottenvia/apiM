/**
 * Checks that deleting a chat actually deletes it.
 *
 * Run:  npm run test:delete
 *
 * Deletes used to appear to work and then silently undo themselves: a
 * streaming reply's queued save would write the file back out after the
 * delete had removed it. These checks drive that race directly.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
// file:// URL so this resolves on Windows too, where a bare drive path is
// not a valid module specifier.
const store = await import(
  pathToFileURL(path.join(ROOT, "src", "lib", "store.ts")).href
);

console.log("\napiM delete-chat checks\n");
let pass = 0, fail = 0;
const check = (label, ok, detail="") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  ok ? pass++ : fail++;
};

// 1. Plain delete
const a = "del-plain";
await store.appendMessages(a, "Plain", [{id:"m1",role:"user",content:"hi",createdAt:new Date().toISOString()}]);
check("chat exists before delete", !!(await store.getConversation(a)));
check("delete reports success", await store.deleteConversation(a));
check("chat is gone", !(await store.getConversation(a)));
check("gone from the sidebar list", !(await store.listConversations()).some(c=>c.id===a));

// 2. The reported bug: delete while a save is in flight
const b = "del-race";
await store.appendMessages(b, "Race", [{id:"m1",role:"user",content:"hi",createdAt:new Date().toISOString()}]);
const inFlight = store.upsertMessage(b, "Race", {id:"m2",role:"assistant",content:"streaming reply",createdAt:new Date().toISOString()});
await store.deleteConversation(b);
await inFlight.catch(()=>{});
await new Promise(r=>setTimeout(r,300));
check("deleted mid-reply stays deleted", !(await store.getConversation(b)));

// 3. Writes that arrive AFTER the delete (late checkpoint)
const c = "del-late";
await store.appendMessages(c, "Late", [{id:"m1",role:"user",content:"hi",createdAt:new Date().toISOString()}]);
await store.deleteConversation(c);
await store.upsertMessage(c, "Late", {id:"m2",role:"assistant",content:"late checkpoint",createdAt:new Date().toISOString()}).catch(()=>{});
await new Promise(r=>setTimeout(r,200));
check("a late write cannot resurrect it", !(await store.getConversation(c)));

// 4. Many concurrent writes racing one delete
const d = "del-storm";
await store.appendMessages(d, "Storm", [{id:"m1",role:"user",content:"hi",createdAt:new Date().toISOString()}]);
const storm = Array.from({length:20},(_,i)=>store.upsertMessage(d,"Storm",{id:`s${i}`,role:"assistant",content:`chunk ${i}`,createdAt:new Date().toISOString()}).catch(()=>{}));
await store.deleteConversation(d);
await Promise.all(storm);
await new Promise(r=>setTimeout(r,300));
check("survives 20 concurrent writes", !(await store.getConversation(d)));

// 5. No temp files left behind
const { promises: fs } = await import("node:fs");
const leftovers = (await fs.readdir(path.join(ROOT, "data", "chats")).catch(()=>[])).filter(n=>n.endsWith(".tmp"));
check("no orphaned .tmp files", leftovers.length===0, leftovers.join(", "));

// 6. Deleting something that isn't there
check("deleting a missing chat reports false", (await store.deleteConversation("del-nope")) === false);

// 7. Other chats untouched
const keep = "del-keep";
await store.appendMessages(keep, "Keep me", [{id:"m1",role:"user",content:"still here",createdAt:new Date().toISOString()}]);
await store.deleteConversation("del-plain");
check("unrelated chats survive", !!(await store.getConversation(keep)));

console.log(`\n${fail===0 ? "All "+pass+" checks passed." : fail+" failed."}`);
process.exit(fail===0?0:1);

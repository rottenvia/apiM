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
const leftovers = (await fs.readdir(path.join(DATA_ROOT, "chats")).catch(()=>[])).filter(n=>n.endsWith(".tmp"));
check("no orphaned .tmp files", leftovers.length===0, leftovers.join(", "));

// 6. Deleting something that isn't there
check("deleting a missing chat reports false", (await store.deleteConversation("del-nope")) === false);

// 7. Other chats untouched
const keep = "del-keep";
await store.appendMessages(keep, "Keep me", [{id:"m1",role:"user",content:"still here",createdAt:new Date().toISOString()}]);
await store.deleteConversation("del-plain");
check("unrelated chats survive", !!(await store.getConversation(keep)));


// ---------------------------------------------------------- bulk delete
//
// Asked for: "make multi delete feature so i can delete multiple chat at
// once". The route is driven directly rather than through a server — it is a
// plain function of a Request, and starting Next to POST to it would test
// Next.
console.log("\nBulk delete");

const { POST: bulkDelete } = await import(
  pathToFileURL(path.join(ROOT, "src/app/api/conversations/bulk-delete/route.ts")).href
);
const post = (body) =>
  bulkDelete(
    new Request("http://localhost/api/conversations/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );

const mk = async (id, title) =>
  store.appendMessages(id, title, [
    { id: `${id}-m`, role: "user", content: "hello", createdAt: new Date().toISOString() },
  ]);

for (const n of [1, 2, 3]) await mk(`bulk-${n}`, `Bulk ${n}`);
await mk("bulk-keep", "Keep this one");

let res = await post({ ids: ["bulk-1", "bulk-2", "bulk-3"] });
let data = await res.json();
check("three chats delete in one request", data.deleted.length === 3, JSON.stringify(data));
check("none reported as failed", data.failed.length === 0);
check("they are really gone", !(await store.getConversation("bulk-1")) && !(await store.getConversation("bulk-3")));
check(
  "an unselected chat is untouched",
  !!(await store.getConversation("bulk-keep")),
  "the whole risk of a bulk action is taking something with it"
);

// A partial failure must not abandon the rest, and must be reported.
await mk("bulk-real", "Real one");
res = await post({ ids: ["bulk-real", "bulk-never-existed"] });
data = await res.json();
check(
  "one bad id does not stop the others",
  data.deleted.includes("bulk-real"),
  JSON.stringify(data)
);
check(
  "and the failure is named, not swallowed",
  data.failed.includes("bulk-never-existed"),
  "the client keeps those ticked so they can be retried"
);

// Duplicates would otherwise count twice and report a phantom failure.
await mk("bulk-dupe", "Dupe");
res = await post({ ids: ["bulk-dupe", "bulk-dupe"] });
data = await res.json();
check(
  "the same id twice counts once",
  data.deleted.length === 1 && data.failed.length === 0,
  JSON.stringify(data)
);

// Input the UI would never send, but a stray script might.
check("a non-array body is rejected", (await post({ ids: "bulk-1" })).status === 400);
check("an empty list is rejected", (await post({ ids: [] })).status === 400);
check("malformed JSON is rejected", (await post("{ not json")).status === 400);
check(
  "a huge list is refused rather than attempted",
  (await post({ ids: Array.from({ length: 500 }, (_, i) => `x${i}`) })).status === 400,
  "the client batches; this is the backstop"
);
res = await post({ ids: [null, 42, "", "bulk-nope"] });
check(
  "non-string ids are dropped, not passed through",
  (await res.json()).failed.length === 1,
  "only the one real string survives filtering"
);

console.log("\nDelete one exchange");

const turn = "del-turn";
await store.appendMessages(turn, "Turn", [
  { id: "u1", role: "user", content: "q1", createdAt: new Date().toISOString() },
  { id: "a1", role: "assistant", content: "a1", createdAt: new Date().toISOString() },
  { id: "u2", role: "user", content: "q2", createdAt: new Date().toISOString() },
  { id: "a2", role: "assistant", content: "a2", createdAt: new Date().toISOString() },
]);
let sliced = store.turnSlice(
  (await store.getConversation(turn)).messages,
  3
);
check(
  "deleting an assistant turn includes the question above it",
  sliced.start === 2 && sliced.end === 4,
  JSON.stringify(sliced)
);
sliced = store.turnSlice((await store.getConversation(turn)).messages, 0);
check(
  "deleting a user turn includes the reply below it",
  sliced.start === 0 && sliced.end === 2
);
const gone = await store.deleteTurn(turn, "a2");
check(
  "deleteTurn reports both ids",
  gone.removed.includes("u2") && gone.removed.includes("a2"),
  JSON.stringify(gone)
);
const after = await store.getConversation(turn);
check(
  "the exchange is gone from disk",
  after.messages.length === 2 &&
    after.messages.every((m) => m.id === "u1" || m.id === "a1")
);
check(
  "the other exchange is untouched",
  after.messages.some((m) => m.content === "q1")
);
const last = await store.deleteTurn(turn, "no-such-id", { fallbackLastPair: true });
check(
  "unknown client ids can still drop the last pair",
  last.removed.length === 2 && !(await store.getConversation(turn)).messages.length,
  JSON.stringify(last)
);

const { DELETE: deleteTurnRoute } = await import(
  pathToFileURL(path.join(ROOT, "src/app/api/conversations/[id]/messages/route.ts")).href
);
await store.appendMessages("del-route", "Route", [
  { id: "ru", role: "user", content: "ask", createdAt: new Date().toISOString() },
  { id: "ra", role: "assistant", content: "ans", createdAt: new Date().toISOString() },
]);
const routeRes = await deleteTurnRoute(
  new Request("http://localhost/api/conversations/del-route/messages?message=ra", {
    method: "DELETE",
  }),
  { params: Promise.resolve({ id: "del-route" }) }
);
const routeBody = await routeRes.json();
check(
  "the messages route deletes the whole exchange",
  routeRes.status === 200 &&
    routeBody.removed.includes("ru") &&
    !(await store.getConversation("del-route")).messages.length
);

const pageSrc = (await import("node:fs")).readFileSync(
  path.join(ROOT, "src/app/page.tsx"),
  "utf8"
);
const chatSrc = (await import("node:fs")).readFileSync(
  path.join(ROOT, "src/components/ChatArea.tsx"),
  "utf8"
);
const bubbleSrc = (await import("node:fs")).readFileSync(
  path.join(ROOT, "src/components/MessageBubble.tsx"),
  "utf8"
);
check(
  "the UI persists the delete so the model forgets it too",
  pageSrc.includes("/api/conversations/${convId}/messages")
);
check(
  "assistant replies can be deleted, not only user messages",
  chatSrc.includes("msg.isStreaming ? undefined : onDeleteMessage") &&
    bubbleSrc.includes("Delete this reply and your question")
);

console.log(`\n${fail===0 ? "All "+pass+" checks passed." : fail+" failed."}`);
process.exit(fail===0?0:1);

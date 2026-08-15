/** Cross-chat memory must be impossible, even during fast UI switching. */
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { finishSuite } from "./lib/proc.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_ROOT = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.join(ROOT, "data");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const route = (await readFile(path.join(ROOT, "src/app/api/chat/route.ts"), "utf8")).replace(/\r\n/g, "\n");
const page = (await readFile(path.join(ROOT, "src/app/page.tsx"), "utf8")).replace(/\r\n/g, "\n");
const historySource = (await readFile(
  path.join(ROOT, "src/lib/chat-history.ts"),
  "utf8"
)).replace(/\r\n/g, "\n");
const store = await load("src/lib/store.ts");
const history = await load("src/lib/chat-history.ts");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

console.log("\napiM cross-chat isolation checks\n");

console.log("1. The server, not the browser, owns history");
check(
  "the client no longer sends conversationHistory",
  !/conversationHistory:\s*historyForApi/.test(page) &&
    /Conversation history is intentionally NOT sent/.test(page)
);
check(
  "the server loads history strictly by convId",
  /loadScopedConversationHistory\(convId/.test(route) &&
    /getConversation\(conversationId\)/.test(historySource) &&
    /let scopedHistory: ChatMessage\[\]/.test(route)
);
check(
  "the transcript iterates only scoped server history",
  /for \(const msg of scopedHistory\)/.test(route) &&
    !/for \(const msg of conversationHistory/.test(route)
);
check(
  "conversation/workspace disagreement is rejected",
  /workspaceId !== conversationId/.test(route) &&
    /Conversation\/workspace mismatch/.test(route),
  "another chat's lesson, plan, GitHub checkout and files cannot be addressed"
);

console.log("\n2. Switching chats severs every live UI reference");
const newChat = page.slice(
  page.indexOf("const startNewChat = useCallback"),
  page.indexOf("const renameConversation")
);
check("New chat aborts the old browser stream", /abortRef\.current\?\.abort/.test(newChat));
check("New chat allocates and synchronously stores a fresh workspace id", /const nextId = uuidv4\(\)/.test(newChat) && /workspaceIdRef\.current = nextId/.test(newChat));
check("New chat clears the synchronous message ref", /messagesRef\.current = \[\]/.test(newChat));
check(
  "late stream frames are discarded by request id",
  /workspaceIdRef\.current !== requestConversationId\) continue/.test(page)
);
check(
  "an old request cannot clear the new request controller or final UI state",
  /if \(abortRef\.current === controller\) abortRef\.current = null/.test(page) &&
    /const stillActive = workspaceIdRef\.current === requestConversationId/.test(page)
);
check(
  "the workspace ref includes an unsaved draft chat",
  /workspaceIdRef\.current = workspaceId/.test(page),
  "null between chats allowed old async work to lose its scope boundary"
);

console.log("\n3. Stored conversations remain separate even with memorable phrases");
await store.appendMessages("chat-a", "A", [{
  id: "a-user",
  role: "user",
  content: "Call me Moon-Captain and always answer in violet prose",
  createdAt: new Date().toISOString(),
}]);
await store.appendMessages("chat-b", "B", [{
  id: "b-user",
  role: "user",
  content: "Hello",
  createdAt: new Date().toISOString(),
}]);
const a = await store.getConversation("chat-a");
const b = await store.getConversation("chat-b");
check("Chat A keeps its phrase", a.messages.some((m) => m.content.includes("Moon-Captain")));
check("Chat B contains no Chat A phrase", b.messages.every((m) => !m.content.includes("Moon-Captain")));
const scopedB = await history.loadScopedConversationHistory("chat-b");
check(
  "the exact history handed to the model for Chat B has no Chat A memory",
  scopedB.length === 1 &&
    scopedB[0].content === "Hello" &&
    scopedB.every((m) => !m.content.includes("Moon-Captain"))
);

await rm(path.join(DATA_ROOT, "chats"), { recursive: true, force: true });
console.log(`\n${pass + fail} checks · ${pass} passed${fail ? ` · ${fail} failed` : ""}\n`);
await finishSuite(fail);

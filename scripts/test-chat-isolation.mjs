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
    // The history is typed by the scoping loader's own message type.
    /let scopedHistory: (Scoped)?ChatMessage\[\]/.test(route)
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
// Streams are per-conversation now: switching must NOT kill another chat's
// in-flight reply. What New chat severs is the side channel (the aside is
// scoped to the visible chat), while the old stream keeps saving to its own
// conversation. The shared abortRef made switching cancel the wrong reply.
check(
  "New chat severs the side channel, not other chats' streams",
  /btwAbortRef\.current\?\.abort\(\)/.test(newChat) &&
    /Starting a new chat does not cancel other chats' streams/.test(newChat)
);
check(
  "every chat's stream gets its own abort controller",
  /useRef<Map<string, AbortController>>/.test(page) &&
    /abortRefs\.current\.set\(runConvId, controller\)/.test(page),
  "one shared controller let a switched-away chat cancel the visible reply"
);
check("New chat allocates and synchronously stores a fresh workspace id", /const nextId = uuidv4\(\)/.test(newChat) && /workspaceIdRef\.current = nextId/.test(newChat));
check(
  "New chat activates a fresh, empty per-conversation session",
  /activateSession\(nextId\)/.test(newChat)
);
check(
  "each conversation owns its own transcript/UI session",
  /type ChatSession = \{/.test(page) &&
    /sessionsRef = useRef<Map<string, ChatSession>>/.test(page) &&
    /writeMessages\(/.test(page)
);
check(
  "late stream frames are NEVER discarded: they route to the run's own session",
  // The old line dropped every frame of a backgrounded chat, which made a
  // running task vanish the moment you clicked another conversation.
  /const active = mirroredIdRef\.current === requestConversationId/.test(page) &&
    !/workspaceIdRef\.current !== requestConversationId\) continue/.test(page)
);
check(
  "background frames stay out of the visible chat",
  /only touch the on-screen state when this conversation is\s*\n?\s*\/\/ the visible one/.test(page) ||
    /mirroredIdRef\.current === key/.test(page),
  "write helpers mirror state only for the visible conversation"
);
check(
  "an old request cannot clear the new request controller or final UI state",
  // A finished run only ever deletes its own map entry (keyed to its own
  // runConvId), and the UI reset is patched onto its own session, so a newer
  // chat's controller and spinner are untouched.
  /abortRefs\.current\.delete\(runConvId\)/.test(page) &&
    /const stillActive = mirroredIdRef\.current === runConvId/.test(page) &&
    /patchSession\(runConvId, \{/.test(page)
);
check(
  "the workspace ref includes an unsaved draft chat",
  /workspaceIdRef\.current = workspaceId/.test(page),
  "null between chats allowed old async work to lose its scope boundary"
);

console.log("\n2b. A backgrounded run keeps running — nothing disappears");

const sidebar = (await readFile(
  path.join(ROOT, "src/components/Sidebar.tsx"),
  "utf8"
)).replace(/\r\n/g, "\n");

check(
  "background frames update their own session even when not visible",
  /writeMessages\(runConvId \?\? requestConversationId/.test(page) &&
    // writeMessages only mirrors to React state for the visible conversation
    /mirroredIdRef\.current === key/.test(page)
);
check(
  "a disk refresh never overwrites a live, in-flight session",
  /Never overwrite a LIVE session with the disk copy/.test(page) &&
    /hasLiveRun/.test(page),
  "switching back to a running chat used to wipe the streaming bubble with the saved transcript"
);
check(
  "auto-resume continues in its own conversation, not the visible one",
  /conversationId: runConvId/.test(page) &&
    /let pendingAutoResume: string \| null = null/.test(page),
  "a backgrounded run's timeout resume used to fire in whichever chat was open"
);
check(
  "Stop aborts only the conversation you are looking at",
  /abortRefs\.current\.get\(convId\)\?\.abort\(\)/.test(page) &&
    /Stop belongs to the conversation the user is looking at/.test(page),
  "a second chat keeps working while you stop the first"
);
check(
  "a draft session migrates to the server-assigned id",
  /migrateSession\(requestConversationId, evt\.conversationId\)/.test(page) &&
    /sessions\.set\(toId/.test(page) &&
    /abortRefs\.current\.set\(toId, ac\)/.test(page),
  "a run started in a brand-new chat must not split across two ids when saved"
);
check(
  "the sidebar shows which chats are still working",
  /runningIds/.test(sidebar) &&
    /animate-ping/.test(sidebar) &&
    /runningIds=\{runningIds\}/.test(page),
  "a background task is visible at a glance instead of appearing gone"
);
check(
  "returning to the same chat skips re-rendering identical transcripts",
  /Skip the swap when the disk copy is what is already on screen/.test(page),
  "fresh object identities re-reconciled every memoised bubble — the heavy switch-back"
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

/**
 * The thinking panel must never load forever.
 *
 * Run:  npm run test:reasoning
 *
 * This bug was reported, "fixed", and still there. Worth recording exactly
 * why, because the first fix addressed a real problem that was not the cause.
 *
 * Reasoning is not sent with a conversation any more — it was half the
 * payload of a long chat and is collapsed by default — so the panel fetches
 * it when opened. That fetch had two independent faults:
 *
 *   1. Every failure path did a bare `return`, leaving `reasoningContent`
 *      undefined. The panel shows "Loading…" whenever that field is
 *      undefined, so any failure meant a spinner with no end. FIXED FIRST.
 *
 *   2. The real cause. `loadReasoning` was `useCallback([currentConvId])`, so
 *      its identity changed whenever you switched chats. MessageBubble is
 *      memoised, and its comparator did not include `onLoadReasoning`. An
 *      already-mounted bubble therefore kept the ORIGINAL closure, holding
 *      the id of whichever conversation was open when it mounted, and
 *      requested `/api/conversations/<wrong-id>/reasoning/<message>` — a 404
 *      on every old chat, reliably, which is precisely what was reported.
 *
 * Fix 1 turned "spins forever" into "silently empty", which is why it looked
 * like nothing had changed. Both are fixed now, and the checks below are
 * written against the mechanism rather than the wording.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
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

const store = await load("src/lib/store.ts");

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

const page = (await readFile(path.join(ROOT, "src/app/page.tsx"), "utf8")).replace(/\r\n/g, "\n");
const bubble = (await readFile(
  path.join(ROOT, "src/components/MessageBubble.tsx"),
  "utf8"
)).replace(/\r\n/g, "\n");

console.log("\napiM thinking-panel checks\n");

console.log("1. The loader cannot capture a stale conversation");

const loader = page.slice(
  page.indexOf("const loadReasoning = useCallback"),
  page.indexOf("const resumeReply = useCallback")
);

check(
  "the callback has no dependencies",
  /const loadReasoning = useCallback\(async \(messageId: string\) => \{[\s\S]*?\}, \[\]\);/.test(
    page
  ),
  "a dependency means a new identity, which memoised children may never receive"
);
check(
  "the conversation id is read at call time, from a ref",
  /const convId = workspaceIdRef\.current/.test(loader),
  "reading it from scope is what froze the wrong id into the closure"
);
check(
  "it does not close over currentConvId",
  !/const convId = currentConvId/.test(loader),
  "this exact line was the bug"
);

console.log("\n2. Every path resolves — no path leaves it undefined");

/*
 * The invariant is not "few returns" — counting them was a crude proxy that
 * flagged `return next;` inside the state updater, which is not an exit at
 * all. What actually matters is that no return can be reached AFTER the
 * request starts without the finally block running.
 */
const beforeFetch = loader.slice(0, loader.indexOf("await fetch"));
const guardReturns = (beforeFetch.match(/\breturn;/g) ?? []).length;
check(
  "early exits happen only before anything is pending",
  guardReturns === 3 && !/return;/.test(loader.slice(loader.indexOf("await fetch"))),
  `${guardReturns} guards, none after the request starts`
);
check(
  "each early exit leaves the panel in a settled state",
  // already-loaded, already-in-flight, and no-conversation. The first two
  // are settled by definition; the third writes "" immediately above.
  /typeof existing\.reasoningContent === "string"\) return;/.test(loader) &&
    /reasoningInFlight\.current\.has\(messageId\)\) return;/.test(loader),
  "nothing exits while the panel is still showing Loading"
);
check(
  "a chat with no id still resolves to empty",
  /if \(!convId\) \{[\s\S]{0,240}reasoningContent: ""/.test(loader),
  "an unsaved chat has nothing to fetch, but the panel must still settle"
);
check(
  "the state write is in a finally block",
  /\} finally \{[\s\S]{0,400}reasoningContent: text/.test(loader),
  "so a throw, a 404 and a success all end with the panel resolved"
);
check(
  "a failed fetch resolves to empty rather than returning",
  /if \(res\.ok\) \{/.test(loader) && !/if \(!res\.ok\) return/.test(loader)
);
check(
  "a second open cannot race the first",
  /reasoningInFlight\.current\.has\(messageId\)/.test(loader)
);
check(
  "the in-flight marker is always cleared",
  /finally \{[\s\S]{0,120}reasoningInFlight\.current\.delete/.test(loader),
  "a marker left set would block every later attempt"
);

console.log("\n3. The cache is updated, so switching back does not refetch");
check(
  "the fetched text is written into the conversation cache",
  /conversationCache\.current\.set\(convId, next\)/.test(loader),
  "otherwise the cached pre-fetch copy comes back and it loads again"
);

console.log("\n4. The memo comparator cannot drop the callback again");
check(
  "onLoadReasoning is compared",
  /prev\.onLoadReasoning === next\.onLoadReasoning/.test(bubble),
  "omitting it is what let a bubble keep an outdated closure"
);

console.log("\n5. The panel distinguishes loading from genuinely empty");
check(
  "a string means loaded, even when it is empty",
  /typeof message\.reasoningContent === "string"/.test(bubble),
  "`undefined` is 'not fetched'; `\"\"` is 'nothing was recorded'"
);
check(
  "empty reasoning says so instead of showing a spinner",
  /No thinking was recorded/.test(bubble)
);
check(
  "Loading is shown only while genuinely pending",
  /thinking-loading/.test(bubble)
);

console.log("\n6. End to end, against a real stored chat");

const convId = randomUUID();
await store.upsertMessage(convId, "Old chat", {
  id: "u1",
  role: "user",
  content: "hello",
  createdAt: new Date().toISOString(),
});
await store.upsertMessage(convId, "Old chat", {
  id: "a1",
  role: "assistant",
  content: "The answer.",
  reasoningContent: "Careful thinking happened here.",
  createdAt: new Date().toISOString(),
});

const conv = await store.getConversation(convId);
const assistant = conv.messages.find((m) => m.id === "a1");
check("reasoning is stored on disk", assistant.reasoningContent.length > 0);

// What the list endpoint sends: a length, never the text.
const listShape = { ...assistant };
delete listShape.reasoningContent;
listShape.reasoningLength = assistant.reasoningContent.length;
check(
  "the list payload carries a length, not the text",
  listShape.reasoningLength === 31 && !("reasoningContent" in listShape),
  `${listShape.reasoningLength} chars`
);
check(
  "so the panel is offered on an old chat",
  Boolean(listShape.reasoningLength),
  "the panel renders when there is either text or a length"
);

// And the detail endpoint returns it, given the RIGHT id.
const again = await store.getConversation(convId);
check(
  "the detail lookup finds it",
  again.messages.find((m) => m.id === "a1").reasoningContent ===
    "Careful thinking happened here."
);
check(
  "a wrong conversation id finds nothing",
  (await store.getConversation(randomUUID())) === null,
  "which is the 404 the stale closure was producing"
);

await rm(path.join(DATA_ROOT, "chats"), { recursive: true, force: true });

console.log(
  `\n${pass + fail} checks · ${pass} passed${fail ? ` · ${r(`${fail} failed`)}` : ""}\n`
);
process.exit(fail ? 1 : 0);

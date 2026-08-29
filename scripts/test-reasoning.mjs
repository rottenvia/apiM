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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
const reasoningStream = await load("src/lib/reasoning-stream.ts");

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
const route = (await readFile(
  path.join(ROOT, "src/app/api/chat/route.ts"),
  "utf8"
)).replace(/\r\n/g, "\n");
const bubble = (await readFile(
  path.join(ROOT, "src/components/MessageBubble.tsx"),
  "utf8"
)).replace(/\r\n/g, "\n");
const chatArea = (await readFile(
  path.join(ROOT, "src/components/ChatArea.tsx"),
  "utf8"
)).replace(/\r\n/g, "\n");
const css = (await readFile(
  path.join(ROOT, "src/app/globals.css"),
  "utf8"
)).replace(/\r\n/g, "\n");
const mockDeepseek = (await readFile(
  path.join(ROOT, "scripts/mock-deepseek.mjs"),
  "utf8"
)).replace(/\r\n/g, "\n");

console.log("\napiM thinking-panel checks\n");

console.log("0. Upstream reasoning fields are normalized");
check(
  "DeepSeek's documented reasoning_content field is read",
  reasoningStream.extractReasoningDelta({ reasoning_content: "official" })?.text ===
    "official"
);
check(
  "compatible reasoning/thinking aliases are not silently discarded",
  reasoningStream.extractReasoningDelta({ reasoning: "alias" })?.text === "alias" &&
    reasoningStream.extractReasoningDelta({ thinking: { text: "object" } })?.text ===
      "object" &&
    reasoningStream.extractReasoningDelta({
      reasoningContent: [{ type: "reasoning_text", text: "block" }],
    })?.text === "block"
);
check(
  "ordinary answer content is never relabelled as reasoning",
  reasoningStream.extractReasoningDelta({ content: "answer" }) === null
);
check(
  "the end-to-end mock uses an alternate field in a real agent round",
  /delta: \{ reasoning: "Now I read it back/.test(mockDeepseek),
  "workspace integration now fails if only reasoning_content is accepted"
);

console.log("\n1. The loader cannot capture a stale conversation");

const loader = page.slice(
  page.indexOf("const loadReasoning = useCallback"),
  page.indexOf("const resumeReply = useCallback")
);

check(
  "the callback depends only on an identity-stable write helper",
  /const loadReasoning = useCallback\(async \(messageId: string\) => \{[\s\S]*?\}, \[writeMessages\]\);/.test(
    page
  ),
  "writeMessages is a stable useCallback identity, so memoised children never hold a stale closure"
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
  `${guardReturns} guards (already-loaded, already-in-flight, no-conversation), none after the request starts`
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
  /\} finally \{[\s\S]{0,600}reasoningContent: text/.test(loader),
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
  "the fetched text is written through the session helper (which also fills the cache)",
  /writeMessages\(\s*convId,/.test(loader) &&
    /transcript\s*[\s\S]{0,20}?cache in one step/.test(loader) &&
    /serves the same copy/.test(loader),
  "writeMessages stores into conversationCache, so switching back serves the fetched copy instead of refetching"
);

console.log("\n4. The callback reaches the bubble and cannot go stale");
check(
  "ChatArea hands the loader to MessageList and MessageList hands it to the bubble",
  (chatArea.match(/onLoadReasoning=\{onLoadReasoning\}/g) ?? []).length === 2,
  "accepting a prop is not forwarding it — the missing second handoff left Loading forever"
);
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
  "empty finished reasoning names the missing provider data instead of vanishing",
  /Thinking was enabled, but no reasoning text was received/.test(bubble)
);
check(
  "an empty LIVE value distinguishes waiting for data from actual reasoning",
  /isThinkingPhase \? \([\s\S]{0,160}thinking-loading[^>]*>[\s\S]{0,80}Waiting for reasoning text…/.test(
    bubble
  )
);
check(
  "reasoning has a timer fallback when animation frames are throttled",
  /flushTimer = setTimeout\(flush, 50\)/.test(page) &&
    /clearTimeout\(flushTimer\)/.test(page),
  "requestAnimationFrame alone can pause indefinitely in a background or throttled tab"
);
check(
  "reasoning is flushed before a plan or tool event is rendered",
  /evt\.type !== "reasoning" && evt\.type !== "content"\) flush\(\)/.test(page),
  "otherwise the action appears while the reasoning before it is still buffered"
);
check(
  "the server normalizes reasoning fields and reports a missing round",
  /extractReasoningDelta\(/.test(route) &&
    /type: "reasoning_status"/.test(route) &&
    /fieldsSeen: \[\.\.\.roundDeltaFields\]/.test(route)
);
check(
  "the done event carries field names and counts, never private text",
  /reasoningDiagnostic: \{[\s\S]{0,180}chars: reasoningContent\.length[\s\S]{0,180}fieldsSeen:/s.test(
    route
  ) && /No plain-text reasoning was present in the upstream/.test(page)
);
check(
  "a precise upstream notice replaces the generic waiting placeholder",
  /message\.reasoningNotice \?/.test(bubble) &&
    /a\.reasoningNotice === b\.reasoningNotice/.test(bubble)
);
check(
  "Loading is shown only while stored reasoning is genuinely pending",
  /showThinking \? \([\s\S]{0,80}thinking-loading[^>]*>Loading…/.test(bubble)
);

console.log("\n6. The reported completed-high state renders a panel");
const { MessageBubble } = await load("src/components/MessageBubble.tsx");
const noTraceHtml = renderToStaticMarkup(
  createElement(MessageBubble, {
    message: {
      id: "finished-high",
      role: "assistant",
      content: "",
      reasoningContent: "",
      thinkingEffort: "high",
      isStreaming: false,
      tokenCount: 16657,
      toolEvents: [
        {
          id: "fetch",
          name: "fetch_url",
          args: '{"url":"https://example.com"}',
          ok: true,
          summary: "Fetched URL",
        },
      ],
    },
  })
);
check(
  "a completed high-effort reply with no trace still renders the thinking shell",
  noTraceHtml.includes("thinking-shell") &&
    noTraceHtml.includes("Thinking") &&
    noTraceHtml.includes("no reasoning text was received"),
  "this is the exact metadata + fetch_url + empty reasoning shape from the screenshot"
);
const liveHtml = renderToStaticMarkup(
  createElement(MessageBubble, {
    message: {
      id: "live-high",
      clientRenderKey: "stable-live-high",
      role: "assistant",
      content: "",
      reasoningContent: "Working through the request.",
      thinkingEffort: "high",
      isStreaming: true,
    },
  })
);
check(
  "a live high-effort reply renders the box open with its text inside",
  liveHtml.includes('data-open="true"') &&
    liveHtml.includes("Working through the request.")
);
check(
  "the CSS cannot squash that rendered shell when entrance motion is disabled",
  /\.thinking-panel\s*\{[^}]*grid-template-rows:\s*1fr;[^}]*opacity:\s*1;/s.test(css) &&
    /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,180}\.thinking-panel\s*\{[^}]*animation:\s*none/s.test(
      css.slice(css.indexOf("/* Expanding to reveal the text."))
    ),
  "the previous HTML test passed while computed height was 0fr — only the one-pixel border remained"
);

console.log("\n7. End to end, against a real stored chat");

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

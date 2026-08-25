/**
 * "btw" is a note to the RUNNING task, not a side question.
 *
 * Run:  npm run test:btw
 *
 * While a reply is in flight, "btw it's a dead DLL, don't touch it" must
 * reach the running agent at its next thinking step, with nothing that was
 * running interrupted, and it must stay in the conversation afterwards so it
 * keeps steering later turns. Every check below guards one of those
 * properties:
 *
 *   1. the note physically reaches the transcript of the running task
 *      (real store round-trip + the round-boundary drain);
 *   2. the route is a plain queue endpoint — no model call, no keys;
 *   3. the model is told what a mid-run note is (standing prompt order);
 *   4. the client contract: one small POST, a chip in the transcript, a
 *      dock that says where the note is;
 *   5. what the old design got right is kept: the prefix only arms while a
 *      task runs, the button becomes Send not Stop, and the dock's dismiss
 *      never touches the main task's abort.
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { readFileSync } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const api = read("src/app/api/btw/route.ts");
const dock = read("src/components/BtwDock.tsx");
const chat = read("src/components/ChatArea.tsx");
const page = read("src/app/page.tsx");
const css = read("src/app/globals.css");
const routeSrc = read("src/app/api/chat/route.ts");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

console.log("\napiM btw checks\n");

// ------------------------------------------------------------------
console.log("1. The note physically reaches the running task");

/**
 * Functional round-trip against the real file-backed store, in a scratch
 * data root so the user's conversations are untouched.
 */
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apim-btw-"));
process.env.APIM_DATA_ROOT = dataRoot;

const {
  appendMessages,
  appendBtwNote,
  drainBtwNotes,
  getConversation,
} = await import("@/lib/store");
const { serializeForApi, MID_RUN_NOTE_LABEL } = await import("@/lib/transcript");
const { loadScopedConversationHistory } = await import("@/lib/chat-history");

const CONV = "btw-conv-1";
await appendMessages(CONV, "btw test", [
  {
    id: "m-user-1",
    role: "user",
    content: "decompile this binary and tell me what it does",
    createdAt: new Date().toISOString(),
  },
]);

// Queue a note the way the route does…
await appendBtwNote(CONV, "it's a dead DLL, don't touch it");

// …and drain it the way the agent loop does.
const drained = await drainBtwNotes(CONV);
check(
  "a queued note comes back on the next drain",
  drained.length === 1 &&
    drained[0].text === "it's a dead DLL, don't touch it" &&
    drained[0].wireText === "it's a dead DLL, don't touch it",
  "a text-only note carries wireText === text"
);
check(
  "a drained note is drained exactly once",
  (await drainBtwNotes(CONV)).length === 0,
  "re-delivering a note would double-steer the same instruction"
);

// The queue survives an append after the drain (a note posted while round N
// runs must wait for round N+1, not be lost).
await appendBtwNote(CONV, "also skip the strings");
const second = await drainBtwNotes(CONV);
check(
  "notes posted after a drain wait for the next one",
  second.length === 1 && second[0].text === "also skip the strings"
);

// A note with a dropped attachment keeps its three parts intact: the typed
// text, the model-facing wire text (file blocks inlined), and the stored
// attachments (pixels / "saved at" metadata).
const attached = {
  text: "look at the crash",
  wireText:
    "Attached file: screenshot-1.png\n```png\n<data-url-stripped-in-tests>\n```\n\nlook at the crash",
  attachments: [
    {
      name: "screenshot-1.png",
      kind: "image",
      dataUrl: "data:image/png;base64,AAAA",
    },
  ],
};
await appendBtwNote(CONV, attached);
const third = await drainBtwNotes(CONV);
check(
  "a note with attachments round-trips all three parts",
  third.length === 1 &&
    third[0].text === "look at the crash" &&
    third[0].wireText?.includes("Attached file: screenshot-1.png") === true &&
    third[0].attachments?.[0]?.dataUrl === "data:image/png;base64,AAAA"
);

// The note serializes on the wire with its label, and only when it is a note.
const wire = serializeForApi([
  { role: "user", content: "decompile this binary" },
  { role: "user", content: "it's a dead DLL, don't touch it", note: true },
]);
check(
  "the model sees the mid-run label on the wire",
  wire[1].content === `[${MID_RUN_NOTE_LABEL} it's a dead DLL, don't touch it]`,
  `serializes as: ${wire[1].content}`
);
check(
  "an ordinary user message is left untouched",
  wire[0].content === "decompile this binary"
);

// A note WITH a screenshot serializes as parts (text + image_url): the label
// must land on the text part and the pixels must survive untouched.
const wireParts = serializeForApi([
  {
    role: "user",
    note: true,
    content: [
      { type: "text", text: "look at the crash" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ],
  },
]);
check(
  "a note with a screenshot keeps the label on its text part",
  wireParts[0].content[0].text === `[${MID_RUN_NOTE_LABEL} look at the crash]`
);
check(
  "…and the pixels go out intact",
  wireParts[0].content[1].image_url.url === "data:image/png;base64,AAAA"
);

// The drain block in the round loop: it must run at a round boundary
// (after `round += 1`), before the wire transcript for that round is built,
// push the note onto the live transcript, and persist it as a real user
// message — otherwise the note vanishes when the reply finishes and
// resumeState is dropped.
const drainStart = routeSrc.indexOf("drainBtwNotes(convId)");
const roundInc = routeSrc.indexOf("round += 1;");
// The import at the top of the file is not a call; find the first use after
// the drain.
const wireBuild = routeSrc.indexOf("serializeForApi(", drainStart);
check(
  "the drain sits at the top of the round loop, before the wire build",
  drainStart > -1 && roundInc > -1 && drainStart > roundInc && wireBuild > drainStart,
  "a note posted mid-round must land before the next model call"
);
const drainBlock = routeSrc.slice(
  routeSrc.indexOf("Drain steering notes"),
  routeSrc.indexOf("const toolAcc = new ToolCallAccumulator();")
);
check(
  "a drained note joins the live transcript through the attachment builder",
  /buildUserContent\(\s*note\.wireText \|\| note\.text,\s*note\.attachments,\s*vision\s*\)/.test(
    drainBlock
  ),
  "native vision gets the pixels; blind models the description blocks"
);
check(
  "…and is persisted as a real user message with its attachments",
  /appendMessages\(convId, title, \[\s*\{[^]*?attachments: note\.attachments[^]*?note: true[^]*?\},?\s*\]\)/.test(
    drainBlock
  ),
  "without persistence the note vanishes when the reply completes"
);
check(
  "…storing the typed text, not the file blocks",
  /content: note\.text/.test(drainBlock),
  "the blocks are rebuilt from the attachments on replay"
);
check(
  "the UI is told the note was read, with the persisted id, round and files",
  /send\(\{\s*type: "btw_note_accepted",\s*id: noteId,\s*note: note\.text,\s*round/.test(
    drainBlock
  ) && /attachments: note\.attachments/.test(drainBlock)
);

// Replay: a persisted note must come back through scoped history flagged,
// so the NEXT run re-labels it identically.
await appendMessages(CONV, "btw test", [
  {
    id: "m-note-1",
    role: "user",
    content: "it's a dead DLL, don't touch it",
    note: true,
    createdAt: new Date().toISOString(),
  },
]);
const history = await loadScopedConversationHistory(CONV);
const historyNote = history.find((m) => m.content === "it's a dead DLL, don't touch it");
check(
  "a persisted note is replayed with its note flag",
  historyNote?.note === true,
  "without the flag the next run reads it as plain history"
);

// A note for a conversation that does not exist is a 404, not a ghost chat.
let ghostErr = null;
try {
  await appendBtwNote("no-such-conversation", "hello");
} catch (e) {
  ghostErr = e;
}
check(
  "a note for an unknown conversation throws (route → 404)",
  ghostErr instanceof Error &&
    (await getConversation("no-such-conversation")) == null,
  "a ghost chat whose only content is a steering note is worse than an error"
);

// ------------------------------------------------------------------
console.log("\n2. The route is a plain queue endpoint");

// Strip comments, then assert no provider or agent machinery is left: the
// only thing this route may do is queue the note.
const apiCode = api
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");
check(
  "no model call — no provider, no fetch, no helper resolution",
  !/fetch\(|resolveHelperTarget|streamChat|openai|deepseek|anthropic|reasoning/i.test(apiCode),
  "the note costs the next round a few dozen tokens and nothing else"
);
check(
  "it takes only a conversationId and a note",
  /conversationId is required/.test(api) && /A note is required/.test(api)
);
check(
  "it queues through the store, not a side file",
  /appendBtwNote\(conversationId, \{[\s\S]{0,120}text: note,[\s\S]{0,120}wireText[\s\S]{0,120}attachments/.test(
    api
  )
);
check(
  "a note is a course correction, not a document",
  /MAX_NOTE_CHARS = 2000/.test(api)
);

/** POST the actual route handler. */
const { NextRequest } = await import("next/server");
const { POST } = await import("../src/app/api/btw/route");

const post = (body) =>
  POST(
    new NextRequest("http://localhost/api/btw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );

const okRes = await post({ conversationId: CONV, note: "  keep the symbols  " });
check(
  "POST {conversationId, note} → {queued:true}",
  okRes.status === 200 && (await okRes.json()).queued === true
);
check(
  "…and it lands in the queue",
  (await getConversation(CONV)).btwNotes?.some(
    (n) => n.text === "keep the symbols"
  ) === true
);

const withFileRes = await post({
  conversationId: CONV,
  note: "decompile this one",
  wireText: "Attached file: evil.dll\nsaved at uploads/binaries/evil.dll\n\ndecompile this one",
  attachments: [
    { name: "evil.dll", kind: "text" },
    { name: "shot.png", kind: "image", dataUrl: "data:image/png;base64,BBBB" },
  ],
});
check(
  "POST with wireText + attachments → {queued:true}",
  withFileRes.status === 200 && (await withFileRes.json()).queued === true
);
const queuedWithFile = (await getConversation(CONV))
  .btwNotes?.find((n) => n.text === "decompile this one");
check(
  "…and the attachment note keeps wire text and stored attachments",
  queuedWithFile?.wireText?.includes("evil.dll") === true &&
    queuedWithFile?.attachments?.length === 2 &&
    queuedWithFile.attachments.find((a) => a.name === "shot.png")
      ?.dataUrl === "data:image/png;base64,BBBB"
);

const badAttachRes = await post({
  conversationId: CONV,
  note: "hello",
  attachments: "not-an-array",
});
check("malformed attachments are a 400, never a queued poison", badAttachRes.status === 400);

const emptyRes = await post({ conversationId: CONV, note: "   " });
check("an empty note is a 400", emptyRes.status === 400);

const longRes = await post({ conversationId: CONV, note: "x".repeat(2001) });
check("a note over the limit is a 400", longRes.status === 400);

const noConvRes = await post({ note: "hello" });
check("a missing conversationId is a 400", noConvRes.status === 400);

const ghostRes = await post({ conversationId: "no-such-conversation", note: "hello" });
check("an unknown conversation is a 404", ghostRes.status === 404);

// ------------------------------------------------------------------
console.log("\n3. The model is told what a mid-run note is");

// The prompt is tested as the model will actually receive it: the exported
// value, not the source text (which is split across concatenated literals).
const { BASE_PROMPT } = await import("@/lib/plugins");
check(
  "the standing base prompt explains the label",
  /Mid-run user notes/.test(BASE_PROMPT) &&
    BASE_PROMPT.includes(MID_RUN_NOTE_LABEL),
  "without it the model may treat a note as a new task"
);
check(
  "…and how to act on it: adjust and continue, never restart",
  /not[\s\S]{0,120}as a new task/.test(BASE_PROMPT) &&
    /continue from where you were/.test(BASE_PROMPT)
);

// ------------------------------------------------------------------
console.log("\n4. The client contract");

const sendBtwNote = page.slice(
  page.indexOf("const sendBtwNote = useCallback("),
  page.indexOf("/** Latest messages + sender")
);
check(
  "the client posts the note trio — no keys",
  /conversationId: currentConvId,[\s\S]{0,80}note: text,[\s\S]{0,80}wireText,[\s\S]{0,80}attachments/.test(
    sendBtwNote
  ) && !/ApiKey|opencodeKey|openrouterKey|localApi/.test(sendBtwNote),
  "wireText + attachments are the same pair a normal send posts"
);
check(
  "the dock tracks sending → queued",
  /status: "sending"/.test(sendBtwNote) && /status: "queued"/.test(sendBtwNote)
);

check(
  "btw_note_accepted appends the chip to the transcript",
  /case "btw_note_accepted"/.test(page) &&
    /isNote: true/.test(page.slice(page.indexOf("case \"btw_note_accepted\""), page.indexOf("case \"btw_note_accepted\"") + 1500))
);
check(
  "…and marks the dock entry read, with the round it landed in",
  /status: "accepted", round: evt\.round/.test(page)
);
check(
  "…and the chip shows the files that rode along",
  /attachments: evt\.attachments/.test(
    page.slice(
      page.indexOf("case \"btw_note_accepted\""),
      page.indexOf("case \"btw_note_accepted\"") + 1500
    )
  )
);
check(
  "a btw send consumes its attachments like a normal send does",
  /onAskBtw\?\.\(\s*btwNote,[\s\S]{0,300}buildMessageWithAttachments\(btwNote, attachments/.test(
    chat
  ) &&
    /onAskBtw\?\.\([\s\S]{0,600}setAttachments\(\[\]\)/.test(chat),
  "a dropped file left behind after the note is a silent loss"
);
check(
  "a reloaded conversation maps the flag back to the chip",
  /isNote: m\.note === true/.test(page)
);
check(
  "the transcript renders a note as a compact chip, not a task bubble",
  /message\.isNote/.test(read("src/components/MessageBubble.tsx")) &&
    /passed while the task was running/.test(read("src/components/MessageBubble.tsx"))
);
check(
  "the dock says where the note is, not what the answer was",
  /status: "sending" \| "queued" \| "accepted"/.test(dock) &&
    /read by the task at step/.test(dock) &&
    !/answer/.test(dock.replace(/<!--[\s\S]*?-->/g, "")),
  "a note has no answer — its answer is the task changing course"
);
check(
  "…and names any attachment, so a file is never mistaken for text",
  /attachmentNames\?\.length/.test(dock) &&
    /attachmentNames: attachments\.map\(\(a\) => a\.name\)/.test(page)
);
check(
  "a queued note fades on its own — the dock is a confirmation, not a record",
  /scheduleBtwDismiss\(id\)/.test(page) &&
    /if \(acceptedId\) scheduleBtwDismiss\(acceptedId\)/.test(page) &&
    /setTimeout\([\s\S]{0,120}prev\.id === id \? null : prev/.test(page),
  "the transcript chip that appears when the task reads the note is the record"
);
check(
  "a failed note is not auto-dismissed — that one needs to be seen",
  /const queued = res\.ok && !data\.error;/.test(page) &&
    /if \(queued\) scheduleBtwDismiss\(id\)/.test(page),
  "only a clean hand-off fades; an error stays until dismissed"
);
check(
  "the dock no longer asks properly or watches the main task",
  !/onAskProperly|mainTaskRunning/.test(dock) &&
    !/onAskProperly|mainTaskRunning=\{/.test(chat)
);

// ------------------------------------------------------------------
console.log("\n5. What the old design got right is kept");

check(
  "the prefix only arms while a task is running",
  /const btwNote = isLoading && btwMatch/.test(chat),
  "with the agent idle, 'btw ...' is just a normal message"
);
check(
  "the button becomes Send, not Stop, while a note is composed",
  /isLoading && isBtw \?/.test(chat),
  "pressing Stop is the opposite of what typing btw meant"
);
check(
  "Stop is still reachable when not composing a note",
  /\) : isLoading \? \(/.test(chat)
);
check(
  "the note has its own abort controller",
  /btwAbortRef/.test(page),
  "dismissing a note must not stop the main task"
);
check(
  "…and dismiss aborts only the note's request",
  /const dismissBtw = useCallback\(\(\) => \{[\s\S]{0,80}clearBtwDismiss\(\);[\s\S]{0,80}btwAbortRef\.current\?\.abort\(\);[\s\S]{0,80}btwAbortRef\.current = null;[\s\S]{0,80}setBtwEntry\(null\);[\s\S]{0,40}\}, \[\]\)/.test(
    page
  ),
  "if this ever touches the run's abort, Stop gained a second meaning"
);
check(
  "leaving the conversation closes the dock with the note in flight",
  /btwAbortRef\.current\?\.abort\(\);\s*setBtwEntry\(null\);/.test(
    page.slice(page.indexOf("const loadConversation"), page.indexOf("const startNewChat"))
  )
);

// ------------------------------------------------------------------
console.log("\n6. It does not disturb what you are reading");

check(
  "the dock sits outside the message list",
  /\{btwEntry && \(/.test(chat) &&
    chat.indexOf("{btwEntry && (") < chat.indexOf("Composer — the relative wrapper")
);
check(
  "it animates up from the composer, where you typed it",
  /@keyframes btw-enter/.test(css) && /translateY\(6px\)/.test(css) &&
    /\.btw-dock/.test(css)
);
check(
  "the waiting indicator is one dot, not a second spinner",
  /@keyframes btw-breathe/.test(css) && !/btw-spin/.test(css)
);
check(
  "the note-send button is teal, matching the channel",
  /\.send-btn\.btw-send/.test(css)
);
check(
  "reduced motion is respected",
  /prefers-reduced-motion[\s\S]*?\.btw-dock/.test(css)
);

// Clean up the scratch data root.
fs.rmSync(dataRoot, { recursive: true, force: true });

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

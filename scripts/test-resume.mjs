/**
 * Finishing what was started, and not paying for it twice.
 *
 * Run:  npm run test:resume
 *
 * Four reported problems, all about work being thrown away:
 *
 *   1. A reply that hit the output ceiling was silently treated as finished.
 *      finish_reason was never read anywhere in the app, so nothing could
 *      tell "done" from "cut off mid-sentence".
 *   2. A write_file cut off by that ceiling produced unparseable arguments,
 *      the file never landed, and the model was told only "invalid tool
 *      arguments" — so it moved on instead of finishing the file.
 *   3. "Try again" discarded every tool result the model had gathered and
 *      re-ran the whole task from the first token, at full price.
 *   4. Rewriting the file tree inside the system message invalidated
 *      DeepSeek's prefix cache on every file change, at 120x the cached rate.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const { toolCallsAreBalanced } = await load("src/lib/prune.ts");
const { rebuildResumeFromStored, rebuiltResumeInstruction } = await load(
  "src/lib/rebuild-resume.ts"
);
const { serializeForApi } = await load("src/lib/transcript.ts");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

const route = read("src/app/api/chat/route.ts");
const providers = read("src/lib/providers.ts");
const store = read("src/lib/store.ts");
const bubble = read("src/components/MessageBubble.tsx");
const panel = read("src/components/WorkspaceSidePanel.tsx");
const page = read("src/app/page.tsx");
const chatArea = read("src/components/ChatArea.tsx");
const convRoute = read("src/app/api/conversations/[id]/route.ts");

console.log("\napiM resume / output-limit / cache checks\n");

// -------------------------------------------------------------- task 1
console.log("1. The app notices when the model ran out of room");

check(
  "finish_reason is read from the stream",
  /finish_reason/.test(route),
  "it was never read anywhere — 'done' and 'cut off' looked identical"
);
check(
  "it is captured before the empty-delta guard",
  route.indexOf("roundFinishReason = reason") <
    route.indexOf("if (!delta) continue"),
  "it arrives on a frame with no delta, so reading it after would miss it"
);
check(
  "hitting the limit triggers a continuation, not a stop",
  /truncated && calls\.length === 0/.test(route) &&
    /continuations < MAX_CONTINUATIONS/.test(route)
);
check(
  "the continuation tells the model not to repeat itself",
  /do not repeat anything you\s*\+?\s*"?\s*already wrote/s.test(route) ||
    /do not repeat anything you already wrote/.test(route.replace(/"\s*\+\s*"/g, ""))
);
check(
  "continuations are capped so a stuck model cannot loop",
  /MAX_CONTINUATIONS = \d+/.test(route),
  (route.match(/MAX_CONTINUATIONS = \d+/) ?? [""])[0]
);
check(
  "a reply stopped at the ceiling is not saved as complete",
  /incomplete: hitOutputCeiling/.test(route),
  "marked complete it looked finished while ending mid-sentence"
);

// -------------------------------------------------------------- task 2
console.log("\n2. A file cut off mid-write is finished, not abandoned");

check(
  "a truncated tool call is recognised as such",
  /looksTruncated/.test(route) && /Unterminated|Unexpected end/.test(route),
  "arguments are valid JSON right up to where the budget ran out"
);
check(
  "the model is told the call was cut off, not malformed",
  /cut off by the\s*\+?\s*.?output limit/s.test(route.replace(/"\s*\+\s*"/g, "")) ||
    /was cut off by the output limit/.test(route.replace(/"\s*\+\s*\n?\s*"/g, ""))
);
check(
  "and told to split the file rather than resend it whole",
  /Do NOT resend it/.test(route.replace(/"\s*\+\s*\n?\s*"/g, "")) &&
    /edit_file/.test(route)
);

// -------------------------------------------------------------- task 3
console.log("\n3. Resuming keeps the work already paid for");

check(
  "tool results are persisted, not just the fact a tool ran",
  /resumeState/.test(store) && /messages: unknown\[\]/.test(store),
  "toolEvents recorded THAT a file was read, never what it said"
);
check(
  "the route accepts a resume request",
  /resumeMessageId/.test(route)
);
check(
  "a resumed reply reuses its own id instead of adding a second bubble",
  /const assistantMsgId = resumeMessageId \?\? uuidv4\(\)/.test(route)
);
check(
  "the saved transcript replaces the freshly built one",
  /transcript\.length = 0/.test(route) &&
    /transcript\.push\(\.\.\.folded\.messages\)/.test(route),
  "compacted on the way in — see lib/compact"
);
check(
  "rounds already spent are carried over on resume",
  /toolRounds = resumed\?\.toolRounds \?\? 0/.test(route),
  "the ask-early nudge and plan checks need the real length of the run"
);
check(
  "continuations already used carry over too",
  /continuations = resumed\?\.continuations \?\? 0/.test(route)
);
check(
  "text already shown is kept, so the reply extends",
  /assistantContent = resumedContent/.test(route)
);
check(
  "the thinking and the actions carry over as well",
  /reasoningContent = resumedReasoning/.test(route) &&
    /\[\.\.\.resumedToolEvents\]/.test(route) &&
    /\[\.\.\.resumedTimeline\]/.test(route),
  "the user asked to see the thinking process on resume"
);
check(
  "the stale file tree inside the saved transcript is dropped",
  /Current workspace contents/.test(route) && /transcript\.splice\(i, 1\)/.test(route),
  "the workspace has moved on since the reply stopped"
);
check(
  "a finished reply does not keep resume state",
  // Matches the condition, not its formatting. This was pinned to the exact
  // string `resumeState: hitOutputCeiling`, so adding a second reason to
  // resume (the spending limit) broke the test while the behaviour was fine.
  // A check that fails when the code gets more correct is worse than no check.
  /resumeState:[\s\S]{0,200}?hitOutputCeiling[\s\S]{0,80}?\?[\s\S]{0,120}?messages: transcript[\s\S]{0,40}?:\s*null/.test(
    route
  ),
  "it is the largest field in the record"
);
check(
  "an unfinished reply keeps it, whatever ended the run",
  /hitOutputCeiling \|\| stoppedByBudget/.test(route),
  "running out of room and running out of budget both leave work worth keeping"
);
check(
  "the saved transcript is never sent to the browser",
  /const \{ resumeState, \.\.\.rest \} = m/.test(convRoute) &&
    /canResume,\s*\n\s*\};/.test(convRoute) &&
    !/return \{ \.\.\.m,/.test(convRoute),
  "it can run to megabytes; the UI only needs a boolean"
);
check(
  "the UI offers Continue only when there is state to resume",
  /onResume && message\.canResume/.test(bubble)
);
check(
  "Continue is the primary action, Start over the quiet one",
  bubble.indexOf("Continue<") < bubble.indexOf("Start over") ||
    bubble.indexOf(">\n                    Continue") < bubble.indexOf("Start over"),
  "continuing keeps the files already written"
);
check(
  "resume does not resend the reply as browser-supplied history",
  /Conversation history is intentionally NOT sent/.test(page) &&
    !/conversationHistory:\s*historyForApi/.test(page) &&
    /loadScopedConversationHistory\(convId/.test(route),
  "the server rebuilds context from the addressed conversation only"
);

// ------------------------------------------------------- task 3b
console.log("\n3b. Chats from before the fix can be resumed too");

/*
 * The first version refused these, on the grounds that the upstream
 * transcript was never saved. That was too pessimistic: a stored reply keeps
 * the reasoning, the partial prose, the event order, and the COMPLETE
 * arguments of every tool call — including the whole contents of any file it
 * wrote. Only a read's output is genuinely missing, and those files are still
 * on disk.
 */
const oldReply = {
  id: "a1",
  role: "assistant",
  content: "I've set up the engine. Now writing the render",
  reasoningContent: "The user wants a game. Engine first, then rendering.",
  incomplete: true,
  timeline: [
    { kind: "text", text: "I've set up the engine. " },
    { kind: "tool", id: "c1" },
    { kind: "tool", id: "c2" },
    { kind: "text", text: "Now writing the render" },
  ],
  toolEvents: [
    { id: "c1", name: "write_file", args: '{"path":"engine.js","content":"export class Engine {}"}', ok: true, summary: "Created engine.js" },
    { id: "c2", name: "read_file", args: '{"path":"config.json"}', ok: true, summary: "Read config.json" },
  ],
  createdAt: new Date().toISOString(),
};

const rb = rebuildResumeFromStored(oldReply);
check("an old interrupted reply can be rebuilt", Boolean(rb));
check(
  "the rebuilt transcript is valid for the API",
  toolCallsAreBalanced(rb.messages) &&
    serializeForApi(rb.messages).length === rb.messages.length,
  "an orphaned tool call is a 400 from DeepSeek"
);
check(
  "the model's own reasoning is carried over",
  rb.messages.some((m) => m.reasoning_content?.includes("Engine first")),
  "it was stored all along"
);
check(
  "the full contents of a written file survive",
  JSON.stringify(rb.messages).includes("export class Engine {}"),
  "toolEvents keeps the complete arguments, not a summary"
);
check(
  "a write is reported as already done",
  rb.keptActions === 1 && /already took effect/.test(rebuiltResumeInstruction(rb)),
  "redoing it would overwrite work that is on disk"
);
check(
  "a lost read is named as lost, not faked",
  rb.lostResults === 1 &&
    rb.messages.some((m) => m.role === "tool" && /output was not kept/.test(m.content)),
  "pretending it is intact makes the model describe a file it cannot see"
);
check(
  "and it is told to just read the file again",
  /call the tool again/i.test(rebuiltResumeInstruction(rb))
);
check(
  "text before and after the tools keeps its order",
  rb.messages[0].content.startsWith("I've set up") &&
    rb.messages[rb.messages.length - 1].content === "Now writing the render",
  "the reply narrated as it worked"
);
check(
  "rounds already spent are counted, not reset",
  /toolRounds: \(prior\.toolEvents \?\? \[\]\)\.length/.test(route),
  "an old reply still has to know how long it already worked"
);
check(
  "a reply with nothing in it is not offered as resumable",
  rebuildResumeFromStored({ id: "x", role: "assistant", content: "", createdAt: "" }) === null
);
check(
  "old chats are marked resumable by the API",
  /Boolean\(m\.toolEvents\?\.length\)/.test(convRoute),
  "requiring resumeState hid the option on every existing chat"
);

// ------------------------------------------------------- task 3c
console.log("\n3c. Running out of balance mid-task keeps the work");

/*
 * The case that started this. A 402 (or 401/429) returned immediately without
 * saving anything, so a run that had already written files left only an error
 * bubble — the whole task was unrecoverable and had to be bought again.
 */
check(
  "work is checkpointed before the API error is surfaced",
  route.indexOf("Could not save work before failing") !== -1 &&
    route.indexOf("Could not save work before failing") <
      route.indexOf("providerHttpError("),
  "it returned first and saved nothing"
);
check(
  "the checkpoint includes resume state",
  /Could not save work before failing[\s\S]{0,80}/.test(route) &&
    /if \(assistantContent \|\| toolEvents\.length \|\| reasoningContent\)/.test(route)
);
check(
  "the balance message says the work is safe",
  /add credit and press Continue/.test(providers),
  "otherwise the user assumes it is all gone"
);
check(
  "the error does not overwrite a reply that had progress",
  /hadWork\s*\?\s*\{ incomplete: true, canResume: true/.test(page),
  "replacing the content with the error destroyed what had been written"
);
check(
  "a reply with nothing in it still shows a plain error",
  /: \{ content: `⚠️ \$\{evt\.error\}`, isError: true \}/.test(page),
  "an empty failure should not pretend to be resumable"
);
check(
  "the banner shows why it stopped",
  /message\.errorNotice \?\? "This reply stopped before it finished"/.test(bubble),
  "'insufficient balance' is more use than 'interrupted'"
);

// ------------------------------------------------------- task 3d
console.log("\n3d. Resuming is findable");

/*
 * Reported: "i didnt resume even once, and i dont know where the button is."
 * It was an 11px pill on the right of a thin bar, attached to a reply that by
 * then had scrolled far up. An action worth tens of cents was the quietest
 * thing in its own notice.
 */
check(
  "Resume is a full-width primary button, not a pill",
  /flex flex-1 items-center justify-center[^"]*bg-\[#cfa25a\]/.test(bubble),
  "it sat at text-[11px] in a corner and was never found"
);
check(
  "it is labelled Resume",
  />\s*Resume\s*</.test(bubble),
  "the word the user reached for"
);
check(
  "the banner explains what resuming keeps",
  /Everything it did is saved/.test(bubble),
  "otherwise there is no reason to prefer it over starting over"
);
check(
  "starting over is de-emphasised when resuming is possible",
  /message\.canResume\s*\?\s*"flex-none text-\[#cfa25a\]/.test(bubble),
  "it buys the same work twice"
);
check(
  "a reply that only got as far as reasoning is still resumable",
  /current\?\.reasoningContent\?\.trim\(\)/.test(page),
  "running out of balance mid-thought is the most common interruption, and it produced a bare error with no way back"
);

console.log("\n3e. And it can be typed instead");

check(
  "a typed resume word continues the last reply",
  /RESUME_WORDS\.has\(input\.trim\(\)\.toLowerCase\(\)\)/.test(chatArea),
  "after a long run you are at the bottom; the button may be far above"
);
check(
  "the accepted words are the obvious ones",
  /"resume",[\s\S]{0,120}"continue",/.test(chatArea)
);
check(
  "only when something is actually resumable",
  // Matches the guard, not one exact line. The branch was widened so that
  // "resume, and also skip the tests" resumes WITH that instruction instead
  // of falling through and being sent as a brand-new message — which is what
  // silently threw the extra words away.
  /if \(canResumeLast\) \{[\s\S]{0,400}?RESUME_WORDS\.has\(lower\)/.test(chatArea),
  "otherwise an ordinary message would be swallowed"
);
check(
  "Resume can hand the job to a different model",
  /onResume\?: \(assistantId: string, model\?: string\) => void/.test(bubble) &&
    /onResume\(message\.id, m\.id\)/.test(bubble),
  "a run that stalled on Pro can be finished on Flash for a sixth of the price"
);
check(
  "the override applies to this reply only",
  /const activeModel = options\?\.modelOverride \?\? model/.test(page) &&
    /model: activeModel/.test(page),
  "it must not quietly rewrite the model setting for every later message"
);
check(
  "the saved transcript is what gets replayed, whichever model finishes it",
  /resumeMessageId: assistantId/.test(page),
  "the point is that the work already paid for is reused"
);
check(
  "extra words after it become an instruction, not a lost message",
  /onResumeLast\?\.\(withNote\[2\]\.trim\(\)\)/.test(chatArea),
  '"resume but skip the tests" used to resume and drop the condition'
);
check(
  "only the newest reply, never one further up",
  /const last = messages\[messages\.length - 1\]/.test(page),
  "reaching back into the transcript would continue something already moved on from"
);
check(
  "the composer says the command exists",
  /Type \\"resume\\" to carry on/.test(chatArea),
  "a shortcut nobody knows about is not a shortcut"
);

// -------------------------------------------------------------- task 4
console.log("\n4. The prompt cache is not thrown away on every write");

check(
  "the file tree is no longer inside the system message",
  !/workspaceInstruction \+\n\s*workspaceFiles/.test(route),
  "one character changed there invalidated the whole cached prefix"
);
check(
  "it is appended as its own message instead",
  /const setFileTree = \(text: string\)/.test(route) &&
    /Current workspace contents/.test(route)
);
check(
  "the tree is a system message, not a trailing user one",
  /transcript\.push\(\{ role: "system", content: body \}\)/.test(route),
  "as a user message it looked like the request and buried the real question"
);
check(
  "the base system message contains neither tree nor plugin directives",
  // Later additive blocks (binary ledger, findings, ...) are allowed to sit
  // between workspaceInstruction and lessonsBlock; tree and plugins are not.
  /workspaceInstruction \+(\s*\w+Block \+)*\s*lessonsBlock,/.test(route) &&
    !/workspaceFiles \+/.test(route) &&
    /role: "system", content: pluginDirectives/.test(route)
);

// The refresh must never split a tool_call from its reply, which is a 400.
const t = [{ role: "system", content: "s" }, { role: "user", content: "q" }];
let idx = -1;
const setTree = (v) => {
  const body = `Current workspace contents: ${v}`;
  if (idx === -1) { t.push({ role: "user", content: body }); idx = t.length - 1; }
  else t[idx] = { role: "user", content: body };
};
const refresh = (v) => { if (idx !== -1) { t.splice(idx, 1); idx = -1; } setTree(v); };
setTree("v0");
for (let i = 0; i < 5; i++) {
  t.push({
    role: "assistant", content: null, reasoning_content: "r",
    tool_calls: [
      { id: `a${i}`, type: "function", function: { name: "write_file", arguments: "{}" } },
      { id: `b${i}`, type: "function", function: { name: "read_file", arguments: "{}" } },
    ],
  });
  t.push({ role: "tool", tool_call_id: `a${i}`, content: "ok" });
  t.push({ role: "tool", tool_call_id: `b${i}`, content: "ok" });
  refresh(`v${i + 1}`);
}
check("refreshing the tree keeps every tool call paired", toolCallsAreBalanced(t));
check(
  "only one tree message ever exists",
  t.filter((m) => typeof m.content === "string" && m.content.startsWith("Current workspace")).length === 1
);
check("the tree stays the last message", t[t.length - 1].content.startsWith("Current workspace"));
check(
  "no tool_call is separated from its reply",
  t.every((m, i) => !(m.role === "assistant" && m.tool_calls) || t[i + 1]?.role === "tool")
);

// -------------------------------------------------------------- task 5
console.log("\n5. An uploaded zip arrives collapsed");

check(
  "uploads and everything under it start closed",
  /dirPath === "uploads" \|\| dirPath\.startsWith\("uploads\/"\)/.test(panel),
  "a project of hundreds of files buried everything else"
);
check(
  "folders the agent creates still start open",
  /const defaultClosed/.test(panel) && /allDirPaths\(tree\)/.test(panel),
  "only uploads is collapsed, not the whole tree"
);
check(
  "opening a folder by hand survives the tree rebuilding",
  /userOpened/.test(panel) && /userClosed/.test(panel),
  "it used to snap shut again whenever a file changed"
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

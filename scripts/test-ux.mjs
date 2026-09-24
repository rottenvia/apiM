/**
 * Four reported interface problems, each pinned so it cannot come back.
 *
 * Run:  npm run test:ux
 *
 * These are all layout and default-state bugs, so they are checked against
 * the source rather than a rendered tree — there is no DOM in this suite and
 * adding one to assert "the question is below the text" would test React, not
 * apiM. What matters is the ORDER things appear in the file, and that is
 * exactly what these assert.
 *
 * Reported:
 *   "questions ... ideally should be below text it written"
 *   "thinking literally hidden now, i cant see thinking process"
 *   "web seems like useless feature ... never gets something from it"
 *   "wanted to add mini button like sources to see on which step of planning"
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { finishSuite } from "./lib/proc.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const read = async (p) =>
  (await readFile(path.join(ROOT, p), "utf8")).replace(/\r\n/g, "\n");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

const bubble = await read("src/components/MessageBubble.tsx");
const chatArea = await read("src/components/ChatArea.tsx");
const route = await read("src/app/api/chat/route.ts");
const toolActivity = await read("src/components/ToolActivity.tsx");

console.log("\napiM — the reported interface problems\n");

// ------------------------------------------------- 1. question placement

console.log('1. "questions should be below text it written"');

/*
 * Order in the file is order on screen: these are siblings in one column with
 * no ordering CSS between them, so comparing indices is the real property.
 */
const atQuestion = bubble.indexOf("message.pendingQuestion && onAnswerQuestion");
const atFlatText = bubble.indexOf("{!useTimeline && (displayContent || !message.isStreaming) && (");
const atTimeline = bubble.indexOf("<MessageTimeline");

check("the question block exists", atQuestion !== -1);
check(
  "it renders AFTER the reply text",
  atQuestion > atFlatText && atFlatText !== -1,
  "before this you met the buttons above the sentence explaining them"
);
check(
  "and after the timeline, which is the other way a reply is shown",
  atQuestion > atTimeline && atTimeline !== -1,
  "both rendering paths have to agree, or it moves depending on the reply"
);
check(
  "the reason is written down next to it",
  /which is backwards/.test(bubble),
  "so it is not silently reordered again later"
);

// --------------------------------------------------------- 2. thinking

console.log('\n2. "thinking literally hidden now, i cant see thinking process"');

check(
  "a reply watched live opens its reasoning as a box",
  // wentLive latches from startedLive: a reply watched live opens, and a
  // resumed historical reply that later starts streaming opens too.
  /const \[startedLive\] = useState\(\(\) => Boolean\(message\.isStreaming\)\)/.test(
    bubble
  ) &&
    /const wentLiveRef = useRef\(startedLive\)/.test(bubble) &&
    /const autoOpen = Boolean\(wentLive && hasThinking\)/.test(bubble) &&
    /const showThinking = userSetThinking \?\? autoOpen;/.test(bubble),
  "the old derived rule collapsed on the first prose token and left only a line"
);
check(
  "it is derived during render, not set from an effect",
  !/useEffect\([^)]*\{\s*if \(thinkingTouched/.test(bubble) &&
    /userSetThinking \?\?/.test(bubble),
  "lint was right: state computable from props should not round-trip"
);
check(
  "an explicit click wins over the default, permanently",
  /setUserSetThinking/.test(bubble),
  "nothing should move the panel under someone who chose"
);
check(
  "a reply mounted from history still starts compact",
  // The wentLive latch starts from the mount-time value, so a historical
  // bubble (isStreaming false at mount) stays compact until it is resumed.
  /startedLive.*Boolean\(message\.isStreaming\)/.test(bubble) &&
    /const wentLiveRef = useRef\(startedLive\)/.test(bubble) &&
    /wentLive && hasThinking/.test(bubble),
  "a stored reply mounts with isStreaming false; the live reply stays open"
);
check(
  "the saved-reasoning loader reaches every bubble",
  (chatArea.match(/onLoadReasoning=\{onLoadReasoning\}/g) ?? []).length === 2,
  "one handoff is ChatArea -> MessageList; the second must be MessageList -> MessageBubble"
);

const css = await read("src/app/globals.css");
check(
  "progress is inside the header, not a line pretending to be the panel",
  /isThinkingPhase && <Dots size=\{3\}/.test(bubble) &&
    !/thinking-line/.test(bubble) &&
    !/\.thinking-line/.test(css),
  "the screenshot showed a line where the missing box should have been"
);
check(
  "the panel keeps a visible border when idle",
  /\.thinking-shell \{[\s\S]{0,600}?border: 1px solid var\(--color-border\)/.test(css),
  "a finished panel with no edge leaves its text loose on the page"
);

// ------------------------------------------------------- 3. web search

console.log('\n3. "web seems like useless feature"');

/*
 * web_search itself works — verified by running it against a stub Tavily and
 * reading what came back: real titles, URLs and extracts reach the model.
 * The bug was the same shape as the browse one: the tool is withheld when no
 * key is set, while the prompt promised it unconditionally.
 */
check(
  "the prompt only promises web_search when the toggle is on and a key exists",
  /\$\{webSearchMode !== "off" && canSearch \? "When you hit something you do not know/.test(route),
  "otherwise the model is told to use a tool it cannot see"
);
check(
  "and says plainly when there is none",
  /There is no web_search tool available in this reply/.test(route)
);
check(
  "it tells the model to admit it rather than guess",
  /say so instead of guessing, and name what you would have searched for/.test(route),
  "a wrong assumption compounds over every round after it"
);
check(
  "the cost of a search is stated, since it is several model calls",
  /One web_search costs several model calls of its own/.test(route),
  "query planning and a sufficiency judge run around every search"
);

const tools = await read("src/lib/tools.ts");
const toolLimits = await read("src/lib/tool-limits.ts");
check(
  "results still carry real page text, not just links",
  // 700 may be spelled as the constant — the refactor to limits.searchSnippet
  // is fine; what must not come back is a smaller default, so the constant
  // itself is pinned here too.
  (/hit\.content \?\? ""\)\.slice\(0, (700|limits\.searchSnippet)\)/.test(tools) &&
    /DEFAULT_SEARCH_SNIPPET = 700;/.test(toolLimits)),
  "700 chars per hit, up to 8 hits"
);

// ------------------------------------------------- 4. the plan step pill

console.log('\n4. "mini button like sources to see which step of planning"');

const atPill = bubble.indexOf("Which step the plan is on, in one pill");
check("the pill exists", atPill !== -1);
check(
  "it shows the current step and the total",
  /Step \$\{planCurrent\.id\}\/\$\{message\.plan\.steps\.length\}/.test(bubble),
  '"Step 3/7" answers the question without scrolling'
);
check(
  "the current step is the one being done, or the next one up",
  /find\(\(s\) => s\.state === "doing"\)[\s\S]{0,120}find\(\(s\) => s\.state === "todo"\)/.test(
    bubble
  )
);
check(
  "a finished plan says so rather than showing a step",
  /steps\.length\}\/\$\{message\.plan\.steps\.length\} done`/.test(bubble),
  '"7/7 done" rather than a step number that no longer exists'
);
check(
  "blocked steps are surfaced on the pill",
  /planBlocked > 0 && ` · \$\{planBlocked\} blocked`/.test(bubble),
  "being stuck is the thing most worth seeing at a glance"
);
check(
  "it scrolls to the full panel instead of duplicating it",
  /planRef\.current\?\.scrollIntoView/.test(bubble),
  "two views of the same steps would drift apart"
);
check(
    "the big panel is still there",
    // \s+ rather than a literal space: prettier wraps the JSX attributes and
    // the panel itself is exactly what must not disappear.
    /<PlanPanel\s+plan=\{message\.plan\}/.test(bubble),
    "explicitly asked to keep it"
  );
check(
  "the meta row renders for a reply that has only a plan",
  /message\.plan && message\.plan\.steps\.length > 0\s*\)/.test(
    bubble.slice(bubble.indexOf("const hasMeta"), bubble.indexOf("const hasMeta") + 600)
  ),
  "otherwise the pill is invisible during the run, when it matters most"
);

// ------------------------------------- 5. asking before spending a fortune

console.log('\n5. "spent a millions of tokens before understanding what i wanted"');

check(
  "a long run with no plan and no question gets pushed to ask",
  /!plan &&\s*!askedEarly &&\s*toolRounds >= 8/.test(route),
  "the tool description said ask early; nothing noticed when it did not"
);
check(
  "it only fires once",
  /askedEarly = true;/.test(route) && /let askedEarly = false;/.test(route),
  "nagging costs a round and produces worse answers"
);
check(
  "it does not fire when a plan exists",
  /!plan &&/.test(route),
  "a plan means the goal was at least written down"
);
check(
  "it tells the model to ignore it if nothing is ambiguous",
  /If nothing is genuinely ambiguous, ignore this/.test(route),
  "a forced question on a clear task is pure cost"
);

// ------------------------------------------- 6. the panel that never mounted

console.log('\n6. "no thinking showing"');

/*
 * The panel was gated on `reasoningContent || reasoningLength`, and a new
 * streaming message starts with reasoningContent = "" — which is falsy. So
 * for the seconds before the first reasoning token arrives there was no panel
 * at all, and on a short reply that is the entire reply. The sweep animation
 * lives inside that block, so it could not run either.
 */
check(
  "the panel mounts whenever thinking was requested, not only once text arrives",
  /const thinkingRequested = Boolean\([\s\S]{0,100}thinkingEffort !== "none"/.test(
    bubble
  ) &&
    /const hasThinking = reasoningChars > 0 \|\| thinkingRequested;/.test(bubble) &&
    /\{hasThinking && !thinkLoading && \(/.test(bubble) &&
    /const thinkLoading = isThinkingPhase && !panelHasContent;/.test(bubble),
  "a completed high-effort reply with no returned trace must still have a box — thinkLoading needs a live phase, so done replies always mount"
);
check(
  "an effort of none still shows nothing",
  /thinkingEffort !== "none"/.test(bubble),
  "the model was told not to think, so there is correctly nothing to show"
);

const page = await read("src/app/page.tsx");
check(
  "the resolved effort reaches the LIVE message, not just the finished one",
  /m\.id === streamingId\s*\?\s*\{ \.\.\.m, thinkingEffort: evt\.resolvedEffort \}/.test(
    page
  ),
  "finalMeta is merged at the end, which is far too late to open a panel"
);
check(
  "only the effort is applied early, not the whole meta block",
  !/\.\.\.finalMeta[\s\S]{0,80}streamingId\s*\?/.test(page),
  "search and cost numbers are not final mid-reply"
);

// ------------------------------------------------- 7. what a plugin costs

console.log('\n7. "caveman spends more token than it saves"');

const plugins = await load("src/lib/plugins.ts");
const est = (t) => Math.ceil(t.length / 3.6);
const withState = (ids) =>
  plugins.AVAILABLE_PLUGINS.map((p) => ({ ...p, enabled: ids.includes(p.id) }));

const caveBlock = plugins.buildPluginDirectives(withState(["caveman"]));
const caveTokens = est(caveBlock);
const rule = plugins.AVAILABLE_PLUGINS.find((p) => p.id === "caveman").prompt;
const wrapper = caveTokens - est(rule);

check(
  "nothing is added when no plugin is on",
  plugins.buildPluginDirectives(withState([])) === "",
  "byte-identical for anyone not using plugins"
);
/*
 * The wrapper carries six real properties — outranks, whole conversation,
 * silent, conflict order, newest-message override, self-check — and each is
 * pinned by test:plugins because dropping one changed behaviour when it was
 * dropped before. So it cannot go to nothing. What it must not be is the
 * 264-token essay that made a token-saving plugin cost more than it saved.
 */
check(
  "the wrapper is a fraction of what it was",
  wrapper <= 90,
  `~${wrapper} tokens, was 264 — and it still carries all six directives`
);
check(
  "one token-saving plugin costs well under 150 tokens a round",
  caveTokens < 150,
  `~${caveTokens} tokens, was ~378`
);
check(
  "break-even is under 100 output tokens per round",
  Math.ceil((caveTokens * 0.435) / 0.87) < 100,
  `~${Math.ceil((caveTokens * 0.435) / 0.87)} output tokens, was 189`
);

/*
 * Position was the thing that made plugins work, not volume. Shortening the
 * wrapper must not quietly undo it.
 */
check(
  "the block is framed as direct system-level behavior",
  /system-level response settings/i.test(caveBlock)
);
check(
  "and is still applied silently",
  /silently/i.test(caveBlock),
  "announcing the plugin wastes the tokens it exists to save"
);
check(
  "and is a dedicated system message moved to the tail each round",
  /role: "system", content: pluginDirectives/.test(route) &&
    /round \+= 1;\s*appendPluginDirectives\(\)/.test(route),
  "role plus recency, not rhetorical jailbreak wording, gives it weight"
);

const modal = await read("src/components/PluginsModal.tsx");
check(
  "the modal shows what the active plugins cost",
  /tokens per request/.test(modal),
  "an invisible standing charge is how this went unnoticed"
);
check(
  "and says the cost is per request, not one-off",
  /Added to every request/.test(modal)
);

/*
 * The panel opened for exactly one frame.
 *
 * Reported twice. The first fix mounted it earlier, which was a real bug —
 * but mounting does no good if it closes a moment later, and that is what was
 * happening. Measured by driving a real reply through a mock DeepSeek and
 * counting frames: meta, ONE reasoning frame, then fifteen content frames.
 * The open test was `isStreaming && !message.content`, so the first content
 * token shut it. One frame open, then a line.
 */
console.log('\n8. The thinking panel stays a box long enough to read');

check(
  "the open state no longer keys off the answer being empty",
  !/userSetThinking \?\?\s*\n?\s*Boolean\(message\.isStreaming && !message\.content\)/.test(
    bubble
  ),
  "the first content token flipped that false while reasoning was still coming"
);
check(
  "it tracks which stream is arriving — reasoning or prose",
  /arriveRef/.test(bubble) &&
    /contentLen > arriveRef\.current\.c/.test(bubble) &&
    /reasoningLen > arriveRef\.current\.r/.test(bubble),
  "the honest signal for the active amber/progress treatment"
);
check(
  "the amber tint and header progress use the active signal",
  /isThinkingPhase = Boolean\([\s\S]{0,160}message\.isStreaming &&[\s\S]{0,80}hasThinking &&[\s\S]{0,120}arriveRef/.test(
    bubble
  ) && /data-thinking=\{isThinkingPhase\}/.test(bubble),
  "the box can stay open after the active animation correctly finishes"
);
check(
  "prose no longer latches the box gray — interleaved reasoning keeps it live",
  !/reasoningGrewRef\.current\.done = true;/.test(bubble) &&
    !/last: "content" \? true/.test(bubble) &&
    /arriveRef\.current\?\.last === "reasoning"/.test(bubble),
  "the old one-way latch grayed the box and dropped Follow/Free while Pro models were still reasoning"
);
check(
  "a frame carrying both deltas keeps the box live, not resting",
  bubble.indexOf("contentLen > arriveRef.current.c") <
    bubble.indexOf("reasoningLen > arriveRef.current.r"),
  "reasoning is checked last, so a tie stays in the reasoning seat"
);
check(
  "finishing the stream does not collapse a live panel",
  /const autoOpen = Boolean\(wentLive && hasThinking\)/.test(bubble) &&
    !/autoOpen = Boolean\([^;]*message\.isStreaming/.test(bubble),
  "autoOpen intentionally has no live isStreaming dependency"
);
check(
  "the bubble is not remounted when its temporary id becomes the saved id",
  /clientRenderKey: existing\?\.clientRenderKey \?\? streamingId/.test(page) &&
    /key=\{msg\.clientRenderKey \?\? msg\.id\}/.test(chatArea),
  "changing the React key erased startedLive at the exact moment done arrived"
);
check(
  "a finished configured mode keeps the panel even with no returned trace",
  /const hasThinking = reasoningChars > 0 \|\| thinkingRequested;/.test(bubble) &&
    /no reasoning text was received/.test(bubble),
  "the box should explain missing provider data, not vanish"
);
check(
  "the open shell is explicitly styled as a surface",
  /data-open=\{thinkBodyOpen\}/.test(bubble) &&
    /\.thinking-shell\[data-open='true'\]/.test(css),
  "expanded reasoning must read as a box, not text between hairlines"
);
check(
  "the outer animation has a visible fallback",
  /\.thinking-panel\s*\{[^}]*grid-template-rows:\s*1fr;[^}]*opacity:\s*1;/s.test(css),
  "the old 0fr fallback left only the border whenever reduced motion disabled the animation"
);
check(
  "the empty live box says it is waiting for text, not duplicate Thinking",
  /Waiting for reasoning text…/.test(bubble) &&
    /const STREAM_FLUSH_MIN_MS = 100;/.test(page),
  "the header owns Thinking; the body becomes real text within one 100ms flush"
);
check(
  "a ref, so active-phase tracking schedules no extra render",
  /const arriveRef = useRef<\{[\s\S]{0,120}\} \| null>\(null\);/.test(bubble)
);
check(
  "thinking disabled still shows nothing",
  /message\.thinkingEffort !== "none"/.test(bubble)
);

/*
 * And the collapsed row has to look like a control.
 *
 * "its an line" — once shut, a bare "Thinking" gives no hint it contains
 * anything, so it reads as decoration rather than something to click.
 */
check(
  "the collapsed row says how much reasoning is inside",
  /Thought for \$\{/.test(bubble),
  "a length makes it obviously openable"
);
check(
  "it reads the stored length too, for reopened chats",
  /reasoningLen \|\| message\.reasoningLength/.test(bubble),
  "an old chat sends only the length and fetches the body on demand"
);
check(
  "the live label ticks thinking tokens, the finished one shows tok/s",
  /formatThinkTokens\(reasoningChars \/ 4\)/.test(bubble) &&
    /tok\/s/.test(bubble) &&
    /thinkingTokens \/ \(thoughtMs \/ 1000\)/.test(bubble),
  "billed tokens over the first-to-last-token span — generation speed, not network"
);
check(
  "the thinking panel follows new text without measuring layout",
  bubble.includes("el.scrollTop = Number.MAX_SAFE_INTEGER"),
  "same write-only trick as the chat pane — no forced layout per frame"
);

console.log("\n9. scrolling up while it types yanks me back");

/*
 * Reported: while the answer is printing, scrolling up to read earlier text
 * holds you for about two seconds and then dumps you back at the caret.
 *
 * scrollIntoView walks every ancestor and fights the user's gesture.
 * Pin-in-React-state is stale across a token flush. Follow must set this
 * pane's scrollTop only, and a wheel upward must unpin before the next
 * token can drag them down.
 */
check(
  "follow never uses scrollIntoView on the live transcript",
  !chatArea.includes("messagesEndRef.current?.scrollIntoView"),
  "that walks ancestors and yanks the view back to the caret"
);
check(
  "it writes this pane's scrollTop instead — without measuring",
  chatArea.includes("el.scrollTop = Number.MAX_SAFE_INTEGER"),
  "reading scrollHeight would force a full-transcript layout on every flush"
);
check(
  "a wheel upward unpins immediately",
  chatArea.includes("e.deltaY < 0") && chatArea.includes("setPinned(false)"),
  "waiting for onScroll lets the next token re-pin and snap them back"
);
check(
  "the browser is not allowed to re-anchor the caret after we let go",
  chatArea.includes("overflow-anchor:none")
);

console.log("\n10. find-in-chat must not freeze the app while typing");

/*
 * Reported: opening find in a big thinking-heavy chat and typing a word froze
 * the whole UI for ~30 seconds. Size is not the reason — even a megabyte of
 * text is milliseconds to scan — the freeze was synchronous re-render work on
 * every keystroke: the query went to every bubble, every bubble rebuilt a
 * highlighting components map, and react-markdown re-parsed the full reply.
 */
const chatSearch = await read("src/lib/chat-search.ts");

check(
  "the index scan runs against a deferred query, not the live input",
  /useDeferredValue\(findQuery\)/.test(chatArea),
  "deferred renders are interruptible, so the input keeps up while highlighting catches up"
);
check(
  "bubbles without a match never receive the query",
  /bubbleSearchQuery/.test(chatArea) &&
    /messageHasMatch\(msg\.content/.test(chatArea) &&
    /searchQuery=\{bubbleSearchQuery\}/.test(chatArea),
  "a memoised bubble with an undefined searchQuery never re-parses"
);
check(
  "there is a first-match-only test for skipping",
  /export function messageHasMatch/.test(chatSearch),
  "one regex search decides whether a bubble is in the result set"
);
check(
  "markdown is parsed by a memoised body keyed on content and query",
  /const MarkdownBody = memo\(/.test(bubble) &&
    /<MarkdownBody content=\{liveContent\} regex=\{searchRegex\}/.test(bubble) &&
    /useDeferredValue\(displayContent\)/.test(bubble),
  "unrelated re-renders can no longer re-parse the markdown"
);
check(
  "stepping next/prev flips an attribute instead of re-parsing",
  /markActiveHit\(/.test(bubble) &&
    /data-active-match/.test(bubble) &&
    /querySelectorAll[^;]*search-hit/.test(bubble) &&
    !/highlightingComponents\(searchRegex, activeMatchIndex\)/.test(bubble),
  "the highlight map is keyed on the regex alone; the active mark is DOM-only"
);

console.log("\n11. one status row while waiting; edit never drops the question");

/*
 * Reported: during a video wait the UI stacked FOUR voices — the thinking
 * panel, the dots row, the elapsed row and the retry line — which read as
 * a mess. The dots row and the elapsed row are now ONE status row; the
 * retry line stays its own row (remount safety) but aligns under the
 * status row's text column, and huge bodies format as 541M, not 540880k.
 * Also reported: editing a message dropped the question from the list
 * (sendMessage's optimistic update removes the regenerateFromId message)
 * and older edits moved the exchange to the bottom with later exchanges
 * stranded, so the model re-answered already-solved material.
 */
check(
  "the status line is one mark, one word, one clock",
  chatArea.indexOf("function StatusRow(") !== -1 &&
    chatArea.indexOf("function StatusRow(") <
      chatArea.indexOf("export function ChatArea({") &&
    /const t = setInterval\(\(\) => setSeconds/.test(chatArea) &&
    /STAGE_LABELS\[stage \?\? "thinking"\]/.test(chatArea) &&
    !/<Dots size=/.test(chatArea) &&
    /retryText \?\? `\$\{STAGE_LABELS/.test(chatArea),
  "module level keeps the interval identity stable; a retry morphs the word in place instead of stacking a row"
);
check(
  "the thinking panel stays unmounted until reasoning lands",
  /\{hasThinking && !thinkLoading && \(/.test(bubble),
  "the status line speaks alone in the silent gap — two voices with two clocks was the mess"
);
check(
  "the wait lines start at the assistant bubble's content edge",
  (chatArea.match(/<div className="flex justify-start px-4 p[by]-2">/g) ?? [])
    .length === 3,
  "status row, retry banner and request line all px-4 like the bubble — px-1 left them hanging left of the thinking panel"
);
check(
  "the retry banner survives only for mid-run retries",
  /\{retryNotice && streamingHasOutput && \(/.test(chatArea),
  "pre-output the retry morphs the status word; the banner would be the second voice again"
);
check(
  "video sends announce what the provider is doing",
  /watching your video — replies can take a few minutes/.test(chatArea),
  "an elapsed counter alone would not explain minutes of prefill"
);
check(
  "the flag is stamped at send time in both send paths",
  (chatArea.match(/videoWaitRef\.current = attachments\.some/g) || []).length ===
    2,
  "main send + btw send; a stale flag from the previous round would mislabel it"
);
  check(
    "the retry banner starts at the dots' left edge, one column for the whole wait",
    /<span[^>]{0,80}text-\[11px\] leading-4 tabular-nums text-warning"/.test(chatArea),
    "the old indent sat right of the dots; the banner shares their left edge now — pinned on the span markup itself so prose can never fake it"
  );
  check(
    "the composer chip row wraps instead of scrolling controls out of view",
    /flex min-w-0 flex-1 flex-wrap items-center gap-1\.5/.test(chatArea) &&
      !/no-scrollbar flex min-w-0 flex-1/.test(chatArea),
    "overflow-x-auto + no-scrollbar silently ate the effort selector on narrow windows"
  );
check(
  "the message hover row clusters actions on one side instead of scattering them",
  /mt-1 flex items-center justify-end gap-1/.test(bubble),
  "the old justify-between pushed Edit and Delete to opposite edges"
);
check(
  "copy sits in the hover row, before edit",
  /"Copy message text"/.test(bubble) &&
    bubble.indexOf("Copy message text") < bubble.indexOf("Edit and resend"),
  "copy, edit, delete — one cluster, right-aligned"
);
check(
  "the edit textarea never opens smaller than the message it edits",
  /rows=\{Math\.max\(/.test(bubble) &&
    /message\.content\.split\("\\n"\)\.length \+ 1/.test(bubble),
  "the old editor sized rows from the draft only, collapsing a 3-line message"
);

console.log("\n12. switching chats cancels, shows a skeleton, and skips identical swaps");

/*
 * Reported: big chats load with nothing on screen, and fast-clicking
 * several chats piles up full-transcript downloads with no cancellation —
 * each one freezing the tab in turn. The newest click now kills the
 * previous load, an empty screen shows placeholder bubbles meanwhile, and
 * the skip-identical-swap check compares structure instead of object
 * identity (a re-parse builds fresh identities, so `===` never fired on
 * agent chats and every click re-rendered the whole transcript).
 */
check(
  "clicking another chat aborts the in-flight load",
  (page.match(/loadAbortRef\.current\?\.abort\(\);/g) ?? []).length === 2 &&
    /signal: loadController\.signal,/.test(page),
  "switching chats and starting a new one both kill the queued load — without it, each queued parse froze the tab in turn"
);
check(
  "a loading chat shows placeholder bubbles, not a vacuum",
  /function ConversationSkeleton\(\)/.test(chatArea) &&
    /conversationLoading \? \(/.test(chatArea) &&
    /conversationLoading=\{loadingConv !== null && messages\.length === 0\}/.test(
      page
    ),
  "cached transcripts paint instantly, so the skeleton only ever covers real waits"
);
check(
  "the skip-identical-swap check compares structure, not identity",
  /sameIds\(o\.toolEvents, m\.toolEvents\)/.test(page) &&
    /sameTimeline\(o\.timeline, m\.timeline\)/.test(page) &&
    !/o\.toolEvents === m\.toolEvents/.test(page),
  "event history is append-only, so id sequences are enough"
);

console.log("\n12b. a fast model must feel fast while it types");
check(
  "a streaming bubble renders deferred markdown, never plain walls",
  /const liveContent = message\.isStreaming \? deferredContent : displayContent;/.test(
    bubble
  ) &&
    /const deferred = index < deferredCount && !bubbleSearchQuery;/.test(
      chatArea
    ),
  "formatting follows the text a few frames behind instead of blocking it"
);
check(
  "tool rows memoise their arg parsing on the args string",
  /memo\(function ToolRow/.test(toolActivity) &&
    /useMemo\(\(\) => argContent\(args\), \[args\]\)/.test(toolActivity),
  "a write's args hold the whole file body — parsing that per frame per tool is the heavy feel"
);
check(
  "the live Thinking label ticks seconds through a stalled stream",
  /function ThinkingClock/.test(bubble) &&
    /isThinkingPhase \? \(/.test(bubble) &&
    /<ThinkingClock \/>/.test(bubble),
  "the status row unmounts at the first token — this is the stall signal after that"
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
await finishSuite(fail);

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
const route = await read("src/app/api/chat/route.ts");

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
  "the panel is open while reasoning is the only content",
  /message\.isStreaming && !message\.content/.test(bubble) &&
    /const showThinking =/.test(bubble),
  "it used to default to closed, so the only thing on screen was hidden"
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
  "a finished reply still opens closed",
  /Boolean\(message\.isStreaming && !message\.content\)/.test(bubble),
  "reopening an old chat should show the answer, not the reasoning"
);

const css = await read("src/app/globals.css");
check(
  "the progress line under the label still exists",
  /\.thinking-line/.test(css),
  "reported as invisible — it only ran while the panel was collapsed"
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
  "the prompt only promises web_search when a key exists",
  /\$\{canSearch \? "When you hit something you do not know/.test(route),
  "otherwise the model is told to use a tool it cannot see"
);
check(
  "and says plainly when there is none",
  /There is no web_search in this workspace/.test(route)
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
check(
  "results still carry real page text, not just links",
  /hit\.content \?\? ""\)\.slice\(0, 700\)/.test(tools),
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
  /<PlanPanel plan=\{message\.plan\}/.test(bubble),
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
  "the panel mounts when reasoning is expected, not only once text arrives",
  /message\.isStreaming &&\s*message\.thinkingEffort &&\s*message\.thinkingEffort !== "none"/.test(
    bubble
  ),
  'reasoningContent starts as "" and "" is falsy'
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
  "the block still states that it outranks what came before",
  /outrank/i.test(caveBlock)
);
check(
  "and is still applied silently",
  /silently/i.test(caveBlock),
  "announcing the plugin wastes the tokens it exists to save"
);
check(
  "and is still the last thing in the system prompt",
  /lessonsBlock \+\s*pluginDirectives/.test(route),
  "later text wins the argument; that is why it moved here originally"
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

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
await finishSuite(fail);

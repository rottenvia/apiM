/**
 * Asking something on the side without disturbing the running task.
 *
 * Run:  npm run test:btw
 *
 * The danger this feature has to avoid is specific. The agent's next round
 * reads `conversationHistory`, which is built from `messages`. If an aside
 * ever landed there, the long task you deliberately did not interrupt would
 * start answering your trivia question instead. Every check in section 1 is
 * guarding that.
 *
 * The second danger is two writers on one workspace: the main task editing
 * files while a side question also has tools. That is a corruption bug, so
 * the aside is sent with no tools at all.
 */
import path from "node:path";
import { readFileSync } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const api = read("src/app/api/btw/route.ts");
const dock = read("src/components/BtwDock.tsx");
const chat = read("src/components/ChatArea.tsx");
const page = read("src/app/page.tsx");
const css = read("src/app/globals.css");

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
console.log("1. It cannot derail the running task");

/** Body of askBtw, which is the only place an aside is handled. */
const askBtw = page.slice(
  page.indexOf("const askBtw = useCallback("),
  page.indexOf("/** Latest messages + sender")
);

check(
  "an aside never enters the message list",
  !/setMessages/.test(askBtw),
  "conversationHistory is built from messages — this is the whole risk"
);
check(
  "and is never persisted to the conversation",
  !/upsertMessage|appendMessages/.test(api),
  "a saved aside would be replayed as history on the next round"
);
check(
  "it is held in its own state instead",
  /const \[btwEntry, setBtwEntry\]/.test(page)
);
check(
  "it is not given the in-flight reply",
  !/assistantContent|streamingId/.test(askBtw) && /role === "user"/.test(askBtw),
  "only the last thing the user actually typed, for pronouns"
);

// ------------------------------------------------------------------
console.log("\n2. It cannot fight the task over the workspace");

check(
  "no tools are sent with the request",
  !/^\s*tools:/m.test(api),
  "two writers on one workspace mid-edit is a corruption bug"
);
check(
  "the model is told it cannot run or edit",
  /cannot run commands or edit files/.test(api)
);
check(
  "it still gets the file tree, so 'where is X' works",
  /buildWorkspaceContext/.test(api)
);

// ------------------------------------------------------------------
console.log("\n3. Stop keeps exactly one meaning");

check(
  "the aside has its own abort controller",
  /btwAbortRef/.test(page) && !/abortRef\.current\?\.abort\(\)/.test(
    page.slice(page.indexOf("const dismissBtw"), page.indexOf("const askBtw"))
  ),
  "dismissing an aside must not stop the main task"
);
check(
  "dismissing aborts only the aside",
  /btwAbortRef\.current\?\.abort\(\)/.test(page)
);
check(
  "the dock has its own dismiss control",
  /onDismiss/.test(dock) && /aria-label=\{entry\.pending \? "Cancel this question" : "Dismiss"\}/.test(dock),
  "two controls that do different things never share a place"
);

// ------------------------------------------------------------------
console.log("\n4. It only exists when there is something to be beside");

check(
  "the prefix is only active while a task is running",
  /const btwQuestion = isLoading && btwMatch/.test(chat),
  "with the agent idle, 'btw ...' is just a normal message"
);
check(
  "the send button becomes Send, not Stop, for an aside",
  /isLoading && isBtw \?/.test(chat),
  "pressing Stop is the opposite of what typing btw meant"
);
check(
  "Stop is still reachable when not composing an aside",
  /\) : isLoading \? \(/.test(chat)
);

// ------------------------------------------------------------------
console.log("\n5. It does not disturb what you are reading");

check(
  "the dock sits outside the message list",
  page.indexOf("btwEntry={btwEntry}") > 0 &&
    /\{btwEntry && \(/.test(chat) &&
    chat.indexOf("{btwEntry && (") > chat.indexOf("</div>\n\n      {/* Composer") - 4000,
  "a parallel exchange inside the transcript breaks its reading order"
);
check(
  "collapsed, it is a single row",
  /grid-template-rows: 0fr/.test(css) && /\.btw-body/.test(css),
  "an aside must never push the reply you are reading around"
);
check(
  "it animates up from the composer, where you typed it",
  /@keyframes btw-enter/.test(css) && /translateY\(6px\)/.test(css)
);
check(
  "the waiting indicator is one dot, not a second spinner",
  /@keyframes btw-breathe/.test(css) && !/btw-spin/.test(css),
  "two spinners at once reads as one thing broken"
);
check(
  "reduced motion is respected",
  /prefers-reduced-motion[\s\S]*\.btw-dock/.test(css)
);

// ------------------------------------------------------------------
console.log("\n6. It stays cheap");

check(
  "it uses the cheap helper, never Pro",
  /resolveHelperTarget/.test(api) && !/deepseek-v4-pro/.test(api),
  "an aside costing more than the task's next round defeats the point"
);
check(
  "thinking is disabled on DeepSeek helpers",
  /thinking: \{ type: "disabled" \}/.test(api)
);
check("output is capped", /MAX_OUTPUT_TOKENS = \d+/.test(api));
check(
  "only one aside at a time",
  /btwAbortRef\.current\?\.abort\(\);[\s\S]{0,120}new AbortController/.test(page),
  "a dock with a queue in it stops being an aside"
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

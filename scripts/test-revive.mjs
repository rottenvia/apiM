/**
 * Auto-continuing a model that stopped mid-task.
 *
 * Run:  npm run test:revive
 *
 * Ox (and sometimes others) will halt without hitting any app limit and
 * wait for the user to type "continue". The loop already continues after
 * an output-ceiling cut. This covers the other case: a voluntary stop
 * that still looks unfinished.
 *
 * The hard rule: continue from the saved transcript. Never rebuild.
 * And never more than a couple of times — restarting the same work ten
 * times is worse than stopping.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const read = (p) => readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const R = await load("src/lib/revive.ts");
const route = read("src/app/api/chat/route.ts");
const page = read("src/app/page.tsx");

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

const base = {
  content: "",
  roundContent: "",
  toolRounds: 4,
  toolsUsed: ["read_file", "write_file"],
  planComplete: null,
  planBlocked: false,
  finishReason: "stop",
};

console.log("\napiM mid-task revive checks\n");

console.log("1. What counts as an unfinished stop");

check(
  "\"say continue\" is treated as a premature stop",
  R.detectPrematureStop({
    ...base,
    roundContent: "I have to stop here. Say continue and I will keep going.",
  }) === "limit_language"
);
check(
  "an inner token-limit excuse is treated the same",
  R.detectPrematureStop({
    ...base,
    roundContent: "I hit the context window, so I will pick this up next turn.",
  }) === "limit_language"
);
check(
  "tools then silence is unfinished",
  R.detectPrematureStop({ ...base, roundContent: "" }) === "empty_after_work"
);
check(
  "stopping mid-sentence after real work is unfinished",
  R.detectPrematureStop({
    ...base,
    roundContent:
      "After reading client.dll the hook lives in CreateMove and the write is the return address at",
  }) === "mid_sentence"
);
check(
  "describing the next action and then stopping is unfinished",
  R.detectPrematureStop({
    ...base,
    roundContent: "The file is in place. I'll now write the tests for the parser.",
  }) === "dangling_next"
);
check(
  "an unfinished plan is unfinished even if the prose sounds done",
  R.detectPrematureStop({
    ...base,
    planComplete: false,
    roundContent: "All done! I have completed the task.",
  }) === "unfinished_plan"
);
check(
  "a provider abort after work is unfinished",
  R.detectPrematureStop({
    ...base,
    finishReason: "content_filter",
    roundContent: "Working on the last file.",
  }) === "provider_abort"
);

console.log("\n2. What must be left alone");

check(
  "a finished chat answer is not revived",
  R.detectPrematureStop({
    ...base,
    toolRounds: 0,
    toolsUsed: [],
    roundContent: "Paris is the capital of France.",
  }) === null,
  "reviving a Q&A wastes a round and pads the answer"
);
check(
  "a real question to the user is not revived",
  R.detectPrematureStop({
    ...base,
    roundContent: "The hook can live in CreateMove or FrameStageNotify.\n\nWhich one do you want?",
  }) === null,
  "they have to answer; continuing would guess"
);
check(
  "a completed plan with a closing summary is left alone",
  R.detectPrematureStop({
    ...base,
    planComplete: true,
    roundContent: "All done. Here's what I changed: parser.py now handles empty input.",
  }) === null
);
check(
  "a blocked plan is a correct ending",
  R.detectPrematureStop({
    ...base,
    planComplete: false,
    planBlocked: true,
    roundContent: "I cannot go further without the API key.",
  }) === null,
  "pushing would teach the model to fake completion"
);
check(
  "a closing period on a finished task is not mid-sentence",
  R.detectPrematureStop({
    ...base,
    planComplete: true,
    roundContent: "Verified it works. The tests passed.",
  }) === null
);

console.log("\n3. The continue is a shove, not a rebuild");

const instruction = R.reviveInstruction("limit_language");
check(
  "it says this is not a new request",
  /not a new request/.test(instruction)
);
check(
  "it forbids rewriting files already on disk",
  /do not rewrite files/.test(instruction)
);
check(
  "it forbids restarting the plan",
  /do not restart the plan/.test(instruction)
);
check(
  "it tells the model to continue from where it stopped",
  /Continue from exactly where you left off/.test(instruction)
);
check(
  "the cap is two, not ten",
  R.MAX_AUTO_REVIVES === 2,
  `${R.MAX_AUTO_REVIVES} — enough to ride out an Ox inner-limit stop, not a loop`
);

console.log("\n4. It is wired into the live loop");

check(
  "the route calls the detector when the model stops talking",
  /const premature = detectPrematureStop\(/.test(route)
);
check(
  "a hit continues the same transcript, it does not rebuild",
  /content: reviveInstruction\(premature\)/.test(route) &&
    /autoRevives < MAX_AUTO_REVIVES/.test(route) &&
    /continue;/.test(route),
  "Resume already knows how to replay; this just fires it"
);
check(
  "the counter starts at zero on every request",
  /let autoRevives = 0;/.test(route),
  "an explicit Resume is the user asking us to try again"
);
check(
  "the UI says it is continuing, not hung",
  /The model stopped mid-task — continuing from where it left off/.test(page)
);
check(
  "the ask-early nudge now actually continues the loop",
  route.indexOf("askedEarly = true;") !== -1 &&
    route.indexOf("askedEarly = true;") <
      route.indexOf('send({ type: "status", stage: "working" });') &&
    /call ask_user NOW[\s\S]{0,500}continue;/.test(route),
  "it used to push a message and then break, so the model never saw it"
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

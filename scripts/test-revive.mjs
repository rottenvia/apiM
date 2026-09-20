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
  "the same excuse in the thinking box is treated the same",
  R.detectPrematureStop({
    ...base,
    toolRounds: 0,
    toolsUsed: [],
    roundContent: "",
    reasoning:
      "I have a lot left to do here but I have to stop. Say continue and I will keep going from this exact point.",
  }) === "limit_language",
  "Ox writes the limit excuse in reasoning, not in the visible answer"
);
check(
  "thinking then silence is a cut, not a finished chat answer",
  R.detectPrematureStop({
    ...base,
    toolRounds: 0,
    toolsUsed: [],
    roundContent: "",
    reasoning:
      "First I need to look at the logging path, then read console.cpp, then decide whether the hook belongs in CreateMove. The file is large so I will start by searching for the logger factory and the sink that writes to the console.",
  }) === "thinking_cut"
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
  "a polite sign-off on a finished answer is not an inner-limit stop",
  R.detectPrematureStop({
    ...base,
    toolRounds: 3,
    roundContent:
      "The module is written and the hook is wired. Pausing here for now — say continue if you want more tweaks.",
    reasoning: "Wrapping up.",
  }) === null,
  "casual goodbye language used to trip the limit detector on a concluded reply"
);
check(
  "the same sign-off over a mid-word cut IS a limit stop",
  (() => {
    const reason = R.detectPrematureStop({
      ...base,
      roundContent:
        "The module is written. Continuing with the FastSwitch wiring — pausing here for now, the next handler re-arms the weapon switch on the next tick and re-arms the we",
      content:
        "The module is written. Continuing with the FastSwitch wiring — pausing here for now, the next handler re-arms the weapon switch on the next tick and re-arms the we",
    });
    return reason === "limit_language" || reason === "mid_sentence";
  })(),
  "soft language plus real truncation is still a stop (either reason revives)"
);
check(
  "an explicit 'I have to stop' still flags on a substantial reply",
  R.detectPrematureStop({
    ...base,
    roundContent:
      "The layout is done and matches the notes. I have to stop here. Say continue and I will keep going.",
  }) === "limit_language",
  "explicit abort declarations are hard language, not sign-offs"
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
    "a finished answer that invites iteration is not an inner-limit stop",
    R.detectPrematureStop({
      ...base,
      toolRounds: 3,
      roundContent:
        "All done — the file is on disk. You can pick this up anytime; just say continue if you want tweaks.",
      reasoning: "Wrapping up.",
    }) === null,
    "the same closing language used to trip the limit detector on a done task"
  );
  check(
    "a finished answer is not flagged by limit mutters in its thinking",
    R.detectPrematureStop({
      ...base,
      toolRounds: 3,
      roundContent:
        "All done. Here's what I changed: parser.py now handles empty input.",
      reasoning:
        "Long round — I have to stop planning and just write the summary now.",
    }) === null,
    "the thought box mutters about stopping on the way to a normal ending"
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
  /content: reviveInstruction\(premature, roundRanWithoutTools\)/.test(route) &&
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
  "a premature stop that cannot be auto-continued stays resumable",
  /if \(premature\) stoppedPrematurely = premature;/.test(route) &&
    /Boolean\(stoppedPrematurely\)/.test(route),
  "after two auto-revives the reply used to be saved as complete"
);
check(
  "reasoning is passed into the detector",
  /reasoning: reasoningContent/.test(route),
  "the excuse is usually in the thought box"
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

console.log("\n5. Narrated intent without action is a stop, not an answer");

for (const [shape, detail] of [
  ["Let me read main.cpp to see the current state and make the necessary edits.", "no 'now', verb outside the old list"],
  ["ok, let me make three edits now.", "'make' was never a trigger verb"],
  ["I will start by checking the decoder for the z escape.", "adverb + gerund"],
  ["I need to fix the parser first before anything else works.", "'need to' form"],
  ["The file is in place. I must verify the build before continuing.", "'must' form"],
]) {
  check(
    `intent shape revives: "${shape.slice(0, 42)}…"`,
    R.detectPrematureStop({ ...base, roundContent: shape }) === "dangling_next",
    detail
  );
}
check(
  "intent outranks the unfinished plan",
  R.detectPrematureStop({
    ...base,
    planComplete: false,
    roundContent: "Let me read the next file.",
  }) === "dangling_next",
  "'your plan has steps left' tells the model nothing it doesn't know"
);
check(
  "intent fires on a planned run before the first tool call",
  R.detectPrematureStop({
    ...base,
    toolRounds: 0,
    toolsUsed: [],
    planComplete: false,
    roundContent: "Let me read main.cpp first.",
  }) === "dangling_next",
  "the plan is the task context that makes narration a stall"
);
check(
  "intent without tools or plan is left alone",
  R.detectPrematureStop({
    ...base,
    toolRounds: 0,
    toolsUsed: [],
    roundContent: "Let me check the reference for you.",
  }) === null,
  "'let me check…' is just how a chat answer begins"
);
for (const [shape, why] of [
  ["Let me explain how this works in detail.", "presentation verb"],
  ["Let me know if you want any changes.", "'let me know'"],
  ["Let me make sure I understand the requirements.", "'make sure' idiom"],
  ["I have to stop here for now.", "a stop declaration, not intent"],
]) {
  check(
    `lookalike left alone: "${shape.slice(0, 40)}…"`,
    R.detectPrematureStop({ ...base, roundContent: shape }) !== "dangling_next",
    why
  );
}

console.log("\n6. The shove names the failure, and blames the harness when due");

const dangle = R.reviveInstruction("dangling_next");
check(
  "the dangling shove orders a tool call, not more words",
  /call the tool/.test(dangle) && /Do not narrate/.test(dangle),
  "'continue from where you left off' read as approval of the narration"
);
check(
  "the dangling shove still forbids redo",
  /continue from exactly/.test(dangle) && /no redo/.test(dangle)
);
const degraded = R.reviveInstruction("dangling_next", true);
check(
  "a tool-less round is named as harness-caused",
  /ran without tools/.test(degraded) && /offered again/.test(degraded),
  "blaming the model for a stripped round teaches it to narrate harder"
);
check(
  "the plain shove is unchanged without the flag",
  !/ran without tools/.test(R.reviveInstruction("limit_language")),
  "one default argument, zero behavior change for old callers"
);
check(
  "the stop notice names the narration stall",
  /describing its next action/.test(R.prematureStopNotice("dangling_next"))
);

console.log("\n7. Degraded rounds are tracked into the stop notice");

check(
  "a tool-less recovery sets the round flag and counts it",
  /roundRanWithoutTools = !\("tools" in retryBody\);/.test(route) &&
    /roundRanWithoutTools = true;/.test(route) &&
    /degradedRoundsThisRun \+= 1;/.test(route),
  "fold recoveries keep tools — only stripped ones count"
);
check(
  "tool-less recoveries are logged per round",
  /continuing without tools/.test(route) &&
    /continuing smaller and without tools/.test(route)
);
check(
  "the stop notice carries the degraded-round count",
  /ran without tools after rejections/.test(route),
  "finished runs stay quiet — only stalled ones explain"
);
check(
  "the plan nudge names narrated idleness",
  /describesImminentAction\(roundContent/.test(route) &&
    /described the next action instead of doing it/.test(route)
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

/**
 * Run grounding: the pinned goal and the honest plan.
 *
 * Run:  npm run test:grounding
 *
 * Two drift modes from one long free-model session:
 *
 *   1. Task resurrection — after hours failing at task B the model decided
 *      task A (lucid in history and the summary) was the real job and went
 *      back to it. The goal pin restates THIS run's request at the tail of
 *      every round, so the last thing read before each decision is the
 *      current goal. Steering beats the request beats the newest history
 *      turn, so Resume, regenerate, and mid-run redirects pin correctly.
 *   2. Plan drift — doing step 2 while believing step 4, narrating
 *      "step 2 done" without ever calling update_plan. The compliance nudge
 *      fires after six tool rounds without an update, or immediately when
 *      the round's prose claims a finish the plan does not show.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const read = (p) => readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const G = await load("src/lib/goal-pin.ts");
const P = await load("src/lib/plan.ts");
const RS = await load("src/lib/request-size.ts");
const route = read("src/app/api/chat/route.ts");

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

const GOAL = "Fix the luradevit sandbox so Instance.new resolves inside it";
const OLDER = "Write a Roblox script that greets the player warmly today";

// --- goal resolution precedence ---
check("a substantive request pins itself", (() => {
  const out = G.resolveRunGoal({ userText: GOAL, historyLastUser: OLDER, steeringText: null });
  return out === GOAL;
})());
check("steering beats the request it redirects", (() => {
  const out = G.resolveRunGoal({
    userText: GOAL,
    historyLastUser: OLDER,
    steeringText: "Stop that approach entirely and fix the decoder first now",
  });
  return out === "Stop that approach entirely and fix the decoder first now";
})());
check("resume filler falls back to the original request", (() => {
  const out = G.resolveRunGoal({ userText: "continue", historyLastUser: OLDER, steeringText: null });
  return out === OLDER;
})());
check("short filler pins nothing anywhere", (() => {
  const out = G.resolveRunGoal({ userText: "ok", historyLastUser: "yes", steeringText: null });
  return out === null;
})());
check("no sources at all pins nothing", (() => {
  const out = G.resolveRunGoal({ userText: "", historyLastUser: null, steeringText: null });
  return out === null;
})());

// --- pin rendering ---
check("rendered pin opens with the marker and names the task", (() => {
  const t = G.renderGoalPin(GOAL);
  return t.startsWith(G.GOAL_PIN_MARKER) && t.includes(GOAL);
})());
check("rendered pin demotes the summary and old tasks", (() => {
  const t = G.renderGoalPin(GOAL);
  return t.includes("do not resume it unasked") && t.includes("background");
})());
check("a giant request pins as a capped head, never whole", (() => {
  const t = G.renderGoalPin(`Prefix instruction sentence here. ${"p".repeat(5000)}`);
  return (
    t.includes("Prefix instruction sentence") &&
    t.includes("request truncated") &&
    t.length < 2000
  );
})());

// --- finish-claim detection ---
check("plain prose claims nothing", !P.stepClaimedComplete("Let me read the sandbox file first."));
check("a bare done claim fires", P.stepClaimedComplete("Step 2 is done, moving on."));
check("the paste's phrasing fires", P.stepClaimedComplete("Right — Step 2's core fix is verified, rebuilding now."));
check("ranges and completion verbs fire", P.stepClaimedComplete("Steps 3-4 are complete, tested locally."));
check("negations are not claims", (() => {
  const a = P.stepClaimedComplete("Step 2 is not done yet, still failing.");
  const b = P.stepClaimedComplete("Step 2 isn't finished, one anchor left.");
  return !a && !b;
})());
check("the nudge names the count and demands the tool call", (() => {
  const t = P.buildStalePlanNudge(8, false);
  return (
    t.startsWith(P.PLAN_NUDGE_MARKER) &&
    t.includes("8 tool rounds") &&
    t.includes("update_plan NOW") &&
    t.includes("do not count")
  );
})());
check("a prose claim adds the record-or-retract rider", (() => {
  const t = P.buildStalePlanNudge(2, true);
  return t.includes("claimed a finished step in prose") && t.includes("retract");
})());

// --- request-size bucket ---
check("goal content gets its own size bucket", (() => {
  const parts = RS.breakdownRequestMessages(
    [{ role: "system", content: `${G.GOAL_PIN_MARKER}\nabc` }],
    0
  );
  return parts.some((p) => p.label === "goal" && p.chars > 0);
})());

// --- route wiring ---
check(
  "route refreshes both tail pins by marker each round",
  /m\.content\.startsWith\(GOAL_PIN_MARKER\) \|\|\s*m\.content\.startsWith\(PLAN_NUDGE_MARKER\)/.test(
    route
  )
);
check(
  "route resolves the goal from request, history, and steering",
  /resolveRunGoal\(\{\s*userText,\s*historyLastUser,\s*steeringText: lastSteeringText,\s*\}\)/.test(
    route
  )
);
check(
  "route derives the history fallback from pre-run user turns, skipping notes",
  /\.filter\(\s*\(m\) =>\s*m\.role === "user" &&\s*m\.note !== true/.test(route)
);
check(
  "compliance resets on both plan writes and seeds on load",
  (route.match(/lastPlanUpdateToolRound = toolRounds;/g) ?? []).length === 2 &&
    route.includes("lastPlanUpdateToolRound = resumed?.toolRounds ?? 0;")
);
check(
  "steering notes feed the pin at the btw drain",
  /for \(const note of midRunNotes\) \{\s*const noteId = uuidv4\(\);\s*(\/\/[^\n]*\n\s*)*if \(\(note\.text \|\| ""\)\.trim\(\)\) \{\s*lastSteeringText = note\.text\.trim\(\);/.test(
    route
  )
);
check(
  "nudge fires on staleness or claim, never on a finished plan",
  /if \(plan && !planIsComplete\(plan\)\) \{/.test(route) &&
    /roundsSincePlanUpdate >= PLAN_STALE_AFTER_TOOL_ROUNDS \|\|\s*claimed/.test(route) &&
    /stepClaimedComplete\(roundContent\)/.test(route)
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

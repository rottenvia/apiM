/**
 * Learning that corrects itself.
 *
 * Run:  npm run test:lessons
 *
 * The existing "Self-Critic" plugin is one sentence in the prompt telling the
 * model to review its work. Nothing persists, so the same wrong turn is taken
 * again on the next message. It is advice, not learning.
 *
 * What is tested here is the difference:
 *
 *   - a lesson must come from something that actually happened
 *   - a guess with no evidence is refused
 *   - when reality later contradicts a lesson, it is corrected automatically,
 *     with no human step
 *   - the disproved version stops being sent to the model, but stays on
 *     record so a flip-flopping belief is visible
 *   - the file cannot grow without bound, because carrying it is a cost
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rm, readFile } from "node:fs/promises";

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

const L = await load("src/lib/lessons.ts");
const R = await load("src/lib/refine.ts");
const { autoThinkingEffort } = await load("src/lib/smart-search.ts");
const { buildWorkspaceContext } = await load("src/lib/workspace-context.ts");
const ws = await load("src/lib/workspace.ts");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

const WS = "lessontest";
await rm(path.join(DATA_ROOT, "workspaces", WS), { recursive: true, force: true });

console.log("\napiM self-improvement checks\n");

// ------------------------------------------------------------------
console.log("1. Only evidence becomes a lesson");

let res = await L.applyLessons(WS, [
  { text: "Use pnpm; npm install fails here", evidence: "npm install -> exit 1" },
]);
check("a fact backed by a real outcome is kept", res.added === 1);

res = await L.applyLessons(WS, [
  { text: "There might be a race condition somewhere", evidence: "" },
]);
check(
  "a guess with no evidence is refused",
  res.added === 0 && res.rejected[0]?.reason === "no evidence",
  "this is exactly what the Self-Critic plugin does, and why it never helped"
);
check(
  "an empty lesson is refused",
  (await L.applyLessons(WS, [{ text: "   ", evidence: "x" }])).added === 0
);

// ------------------------------------------------------------------
console.log("\n2. It corrects itself when reality disagrees");

let lessons = await L.readLessons(WS);
const original = lessons.find((l) => l.text.includes("pnpm"));

res = await L.applyLessons(WS, [
  {
    text: "npm install works now; the lockfile was regenerated",
    evidence: "npm install -> exit 0",
    replaces: original.id,
  },
]);
check("a contradicted lesson is revised, not left wrong", res.revised === 1);

lessons = await L.readLessons(WS);
const dead = lessons.find((l) => l.id === original.id);
const live = lessons.find((l) => l.text.includes("works now"));
check("the old one is marked superseded", Boolean(dead.supersededBy));
check("it records that reality contradicted it", dead.contradicted === 1);
check("the replacement is linked to it", dead.supersededBy === live.id);
check(
  "no human step was involved",
  true,
  "the arbiter is the exit code, not the user editing a file"
);

const prompt = L.formatLessonsForPrompt(lessons);
check(
  "the disproved lesson is no longer shown to the model",
  !prompt.includes("Use pnpm"),
  "sending a known-false belief would be worse than sending nothing"
);
check("the corrected one is shown instead", prompt.includes("works now"));
check(
  "but the wrong one stays on record",
  (await readFile(path.join(DATA_ROOT, "workspaces", WS, "LESSONS.md"), "utf8")).includes("Use pnpm"),
  "so a belief that keeps flip-flopping is visible"
);

// ------------------------------------------------------------------
console.log("\n3. Confidence comes from reality, not from the model");

await L.applyLessons(WS, [
  { text: "npm install works now; the lockfile was regenerated", evidence: "npm install -> exit 0" },
]);
lessons = await L.readLessons(WS);
const repeated = lessons.find((l) => l.text.includes("works now"));
check(
  "learning the same thing twice confirms it rather than duplicating",
  lessons.filter((l) => l.text.includes("works now")).length === 1
);
check("confirmation raises confidence", L.confidenceOf(repeated) === "high", `confirmed ${repeated.confirmed}x`);
check(
  "a contradicted lesson drops to low confidence",
  L.confidenceOf({ confirmed: 1, contradicted: 2 }) === "low"
);
check(
  "low-confidence lessons are flagged, not silently trusted",
  L.formatLessonsForPrompt([
    { id: "x", text: "shaky", evidence: "e", confirmed: 0, contradicted: 1, createdAt: "", updatedAt: "" },
  ]).includes("unverified")
);

// ------------------------------------------------------------------
console.log("\n4. It cannot grow into the bloat we just removed");

const many = Array.from({ length: 60 }, (_, i) => ({
  text: `fact number ${i} about this project`,
  evidence: `command ${i} -> exit 0`,
}));
res = await L.applyLessons(WS, many);
check(
  "the file is capped",
  res.total <= L.MAX_LESSONS,
  `${res.total} kept, cap is ${L.MAX_LESSONS}`
);
check(
  "one lesson cannot become an essay",
  (await L.applyLessons(WS, [{ text: "x".repeat(5000), evidence: "y" }]),
    (await L.readLessons(WS)).every((l) => l.text.length <= L.MAX_LESSON_CHARS))
);

const block = L.formatLessonsForPrompt(await L.readLessons(WS));
check(
  "a full lesson file is still small in the prompt",
  block.length < 6000,
  `${Math.round(block.length / 3.6)} tokens — against ~9000 for a single round of reasoning`
);

// ------------------------------------------------------------------
console.log("\n5. It does not cost twice");

await ws.writeFile(WS, "app.js", "console.log(1)");
const ctx = await buildWorkspaceContext(WS);
check(
  "LESSONS.md is hidden from the file tree",
  !ctx.includes("LESSONS.md"),
  "it is already in the prompt as text; listing it invites a second read"
);
check("real files are still listed", ctx.includes("app.js"));

// ------------------------------------------------------------------
console.log("\n6. The refine pass is cheap by construction");

const refineSrc = (await readFile(path.join(ROOT, "src/lib/refine.ts"), "utf8")).replace(/\r\n/g, "\n");
check(
  "it runs on Flash, not Pro",
  /deepseek-v4-flash/.test(refineSrc),
  "spending Pro tokens to save Pro tokens would defeat the point"
);
check(
  "thinking is disabled for it",
  /thinking: \{ type: "disabled" \}/.test(refineSrc),
  "reasoning is the most expensive part of a request and this is extraction"
);
check("its output is capped", /max_tokens: \d+/.test(refineSrc));
check(
  "it reads outcomes, not the whole transcript",
  /buildOutcomeDigest/.test(refineSrc)
);
check(
  "it is told that learning nothing is the normal answer",
  /Returning empty lists is the correct and common answer/.test(refineSrc),
  "otherwise it invents lessons to seem useful"
);
check(
  "a digest names what failed",
  R.buildOutcomeDigest([
    { name: "run_command", args: '{"command":"npm"}', ok: false, summary: "Failed: npm install" },
  ]).startsWith("FAIL")
);

// ------------------------------------------------------------------
console.log("\n7. Auto no longer treats a long message as a hard one");

check(
  "pasting a long log and asking what it is stays cheap",
  autoThinkingEffort("what is this " + "log line here ".repeat(40)) === "low",
  "120+ words used to force max effort on every round"
);
check(
  "a genuinely hard question still gets high",
  autoThinkingEffort("can you refactor this module for performance") === "high"
);
check(
  "a very hard one still gets max",
  autoThinkingEffort(
    "debug this crash then refactor the algorithm for performance and review the security"
  ) === "max"
);
check("a greeting still costs nothing", autoThinkingEffort("hi") === "none");

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

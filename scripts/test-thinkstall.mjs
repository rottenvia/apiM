/**
 * Think-only stalls: thinking that eats the whole output budget.
 *
 * Run:  npm run test:thinkstall
 *
 * On max effort, reasoning and the answer share one output budget, so a
 * long deliberation can end in `length` with no content and no tool call.
 * The run used to shove once — with thinking "disabled" by sending no
 * disable signal at all on OpenRouter lanes — and then stop mid-task,
 * which is the "it thought for minutes and then stopped" report. Now the
 * dead think is trimmed instead of replayed, two shoves stand between one
 * dead think and a dead run, and the third strike names thinking in the
 * banner instead of blaming a long answer.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const read = (p) => readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const route = read("src/app/api/chat/route.ts");
const storeSrc = read("src/lib/store.ts");
const page = read("src/app/page.tsx");
const bubble = read("src/components/MessageBubble.tsx");
const providers = await load("src/lib/providers.ts");

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

// --- the disable is real now ---
{
  const body = {};
  providers.applyThinking(body, "openai", false, "none");
  check(
    "thinking-off on OpenRouter lanes sends reasoning effort none",
    body.reasoning?.effort === "none",
    "omitting the field left GLM/Nemotron thinking by provider default"
  );
}

// --- the dead think is trimmed, not replayed ---
check(
  "each think-only strike is counted",
  route.includes("let thinkOnlyStalls = 0;") &&
    route.indexOf("thinkOnlyStalls += 1;") >
      route.indexOf("const thinkOnlyCut =")
);
check(
  "the dead think is replaced by a tombstone",
  route.includes(
    "`[thinking produced no output — ${roundReasoning.length} chars trimmed]`"
  ),
  "resending a full dead think costs it again on every recovery turn"
);
check(
  "two shoves stand between one dead think and a dead run",
  route.includes("if (thinkNudges < 2) {") &&
    route.includes("or call a tool NOW, briefly.")
);
check(
  "the recovery turns announce themselves as one of two",
  /reason: "thinking_budget",\s*n: thinkNudges,\s*of: 2,/.test(route)
);
check(
  "the third strike stops at the ceiling and names thinking",
  route.includes("thinkCeiling = true;") &&
    route.includes(
      "It thought through the whole output budget three times without writing anything"
    )
);

// --- the ending carries the stall count ---
check(
  "done and save both ship the stall count",
  (route.match(/thinkOnlyStalls,/g) ?? []).length === 2
);
check(
  "server, store and client type the stall count",
  route.includes("thinkOnlyStalls: number;") &&
    storeSrc.includes("thinkOnlyStalls: number;") &&
    (page.match(/thinkOnlyStalls: number;/g) ?? []).length === 2,
  "server done type, StoredMessage, client done event, client Message"
);
check(
  "the footer shows repeated think-only stalls",
  bubble.includes("· thought ${message.ending.thinkOnlyStalls}×, empty") &&
    bubble.includes("message.ending.thinkOnlyStalls >= 2")
);
check(
  "the footer tooltip explains the stalls",
  bubble.includes("Think-only stalls:")
);

// --- outage retries wait out blinks, then fail with a way back ---
check(
  "empty-stream backoff grows between attempts",
  route.includes("emptyStreamRetries === 1 ? 1_500 : 4_000;") &&
    route.includes("await sleep(emptyRetryDelayMs, runSignal);")
);
check(
  "a no-work outage error still offers Try again",
  /content: `⚠️ \$\{evt\.error\}`,\s*isError: true,[\s\S]{0,700}?incomplete: true,/.test(
    page
  ) && !/: \{\s*content: `⚠️ \$\{evt\.error\}`[\s\S]{0,700}?canResume: true/.test(page),
  "incomplete without canResume: Try again, not a pretend Resume"
);
check(
  "the no-work banner says Try again re-sends the turn",
  bubble.includes("Nothing arrived, so there is nothing to resume")
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

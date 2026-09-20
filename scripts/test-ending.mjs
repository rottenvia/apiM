/**
 * End-of-reply telemetry: why the reply is exactly as long as it is.
 *
 * Run:  npm run test:ending
 *
 * "2k chars and stopping" on a clean chat must answer itself. Every
 * truncation path either auto-continues or raises a visible banner — so a
 * silent short stop means the model ended it. The footer now carries the
 * proof on every reply: the final finish_reason plus what the continuation
 * pools spent. `stop` with zero continuations means the model ended it
 * itself (Resume, not a bug report, is the remedy); anything else names
 * the cutter.
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

// --- server captures the ending every round ---
check(
  "route keeps the final round's finish_reason",
  route.includes("let lastFinishReason: string | null = null;")
);
check(
  "capture runs after the ending is classified each round",
  route.indexOf("lastFinishReason = roundFinishReason || null;") >
    route.indexOf("const truncated = hardTruncated || streamCut;")
);
check(
  "done frame carries finish plus both continuation pools",
  /ending: \{\s*finish: lastFinishReason,\s*continuedOutput: continuations,\s*continuedConnection: streamCuts,\s*\},/.test(
    route
  )
);
check(
  "server done type declares the ending",
  /type: "done";[\s\S]{0,800}?ending: \{\s*finish: string \| null;/.test(route)
);
check(
  "saved message persists the ending for reloads",
  (route.match(/continuedOutput: continuations,/g) ?? []).length === 2
);

// --- store + client plumb it through ---
check(
  "StoredMessage types the ending",
  /ending\?: \{\s*finish: string \| null;\s*continuedOutput: number;\s*continuedConnection: number;\s*\} \| null;/.test(
    storeSrc
  )
);
check(
  "client done event types the ending",
  /type: "done";[\s\S]{0,900}?ending\?: \{\s*finish: string \| null;/.test(page)
);
check(
  "client Message types the ending",
  /How the reply ended: final finish_reason plus continuations spent\. \*\/\s*ending\?: \{/.test(
    page
  )
);
check(
  "done handler passes the ending into the bubble",
  /contextBreakdown: evt\.contextBreakdown,\s*ending: evt\.ending,/.test(page)
);
check(
  "reload mapping restores the ending from stored messages",
  page.includes('ending: (m.ending as Message["ending"]) ?? undefined,')
);

// --- footer renders it ---
check(
  "footer shows the finish word with continuation counts",
  bubble.includes("· {message.ending.finish ?? ") &&
    bubble.includes("cont")
);
check(
  "footer tooltip names the reason and both pools",
  bubble.includes("Final finish_reason:") &&
    bubble.includes("Output-limit continuations:") &&
    bubble.includes("Connection-cut continuations:")
);
check(
  "footer hides when there is no ending to report",
  /message\.ending &&\s*\(message\.ending\.finish \|\|/.test(bubble)
);
check(
  "bubble memo rerenders on ending changes",
  bubble.includes("a.ending === b.ending &&")
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

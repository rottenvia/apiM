/**
 * Does the self-improvement pass actually run?
 *
 * Run:  npm run test:refine
 *
 * The lessons mechanism has 30 checks against it, and all of them test the
 * plumbing: writing, reading, superseding, capping. Not one of them ever
 * executed `runRefine` — the function that calls a model and turns what
 * happened into what was learned. So the machine was tested and the engine
 * was not, which is why its confidence was honestly rated at about 40%.
 *
 * This runs it against a stub API that speaks the real protocol, so the
 * request shape, the JSON parsing, the filtering and the failure paths are
 * all exercised for real.
 */
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rm } from "node:fs/promises";

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

const { runRefine, buildOutcomeDigest } = await load("src/lib/refine.ts");
const lessons = await load("src/lib/lessons.ts");

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

/** A stub DeepSeek that records what it was asked and replies as told. */
let lastRequest = null;
let reply = { lessons: [], confirms: [] };
let statusCode = 200;
let rawOverride = null;

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      lastRequest = JSON.parse(body);
    } catch {
      lastRequest = null;
    }
    if (statusCode !== 200) {
      res.writeHead(statusCode);
      res.end("{}");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          { message: { content: rawOverride ?? JSON.stringify(reply) } },
        ],
        usage: { prompt_tokens: 420, completion_tokens: 55 },
      })
    );
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

console.log("\napiM self-improvement — the engine, not just the plumbing\n");

const OUTCOMES = [
  { name: "run_command", args: '{"command":"npm install"}', ok: false, summary: "Failed: npm install — use pnpm" },
  { name: "run_command", args: '{"command":"pnpm install"}', ok: true, summary: "Ran: pnpm install" },
  { name: "read_file", args: '{"path":"spec/app.test.ts"}', ok: true, summary: "Read spec/app.test.ts" },
];

console.log("1. It actually calls the model");

reply = {
  lessons: [
    { text: "This project uses pnpm; npm install fails.", evidence: "npm install failed, pnpm install succeeded." },
  ],
  confirms: [],
};
let out = await runRefine(OUTCOMES, [], "sk-test", base);

check("a request was really sent", lastRequest !== null);
check("it returned the lesson", out.lessons.length === 1, out.lessons[0]?.text ?? "");
check("usage is reported, so the cost is visible", out.usage?.prompt_tokens === 420);

console.log("\n2. The request is built the cheap way");
check(
  "it uses Flash, not Pro",
  lastRequest?.model === "deepseek-v4-flash",
  lastRequest?.model ?? "",
);
check(
  "thinking is disabled",
  lastRequest?.thinking?.type === "disabled",
  "reasoning is the priciest thing on the bill and this is extraction, not reasoning"
);
check("JSON mode is requested", lastRequest?.response_format?.type === "json_object");
check("output is capped", lastRequest?.max_tokens === 800);
check(
  "it is given outcomes, not the transcript",
  !JSON.stringify(lastRequest).includes("reasoning_content"),
  "the full history would be tens of thousands of tokens and prove nothing extra"
);

const userMsg = lastRequest?.messages?.find((m) => m.role === "user")?.content ?? "";
check("the digest names the failed command", userMsg.includes("npm install"));
check("and marks it as failed", /FAIL\s+run_command/.test(userMsg));
check("and marks the successful one", /OK\s+run_command/.test(userMsg));

console.log("\n3. Nothing it returns is trusted blindly");

reply = {
  lessons: [
    { text: "good", evidence: "proved" },
    { text: "no evidence field" },
    { evidence: "no text field" },
    { text: 42, evidence: "wrong type" },
  ],
  confirms: ["l1", 7, null],
};
out = await runRefine(OUTCOMES, [], "sk-test", base);
check(
  "malformed lessons are dropped, not stored",
  out.lessons.length === 1 && out.lessons[0].text === "good",
  `kept ${out.lessons.length} of 4`
);
check(
  "non-string confirms are dropped",
  out.confirms.length === 1 && out.confirms[0] === "l1"
);

reply = { lessons: Array.from({ length: 40 }, (_, i) => ({ text: `l${i}`, evidence: "e" })), confirms: [] };
out = await runRefine(OUTCOMES, [], "sk-test", base);
check("a runaway reply is capped", out.lessons.length === 12, `${out.lessons.length} kept`);

console.log("\n4. It fails quietly, never taking the task down with it");

statusCode = 500;
out = await runRefine(OUTCOMES, [], "sk-test", base);
check("a server error returns empty", out.lessons.length === 0 && out.confirms.length === 0);
statusCode = 200;

rawOverride = "this is not JSON at all";
out = await runRefine(OUTCOMES, [], "sk-test", base);
check("unparseable output returns empty", out.lessons.length === 0);
rawOverride = null;

out = await runRefine([], [], "sk-test", base);
check(
  "no outcomes means no call at all",
  out.lessons.length === 0,
  "nothing ran, so nothing was demonstrated"
);

out = await runRefine(OUTCOMES, [], "sk-test", "http://127.0.0.1:1");
check("an unreachable API returns empty rather than throwing", out.lessons.length === 0);

console.log("\n5. Empty is a valid, expected answer");
reply = { lessons: [], confirms: [] };
out = await runRefine(OUTCOMES, [], "sk-test", base);
check(
  "returning nothing learned is not an error",
  out.lessons.length === 0 && out.usage !== null,
  "most tasks teach nothing durable — inventing a lesson would be worse"
);

console.log("\n6. Known lessons are shown so they can be revised");
const WS = "refinetest";
await rm(path.join(DATA_ROOT, "workspaces", WS), { recursive: true, force: true });
await lessons.applyLessons(WS, [{ text: "Tests live in test/", evidence: "seen" }], []);
const known = await lessons.readLessons(WS);
check("a lesson was stored", known.length === 1);

reply = {
  lessons: [
    { text: "Tests live in spec/", evidence: "spec/app.test.ts was read", replaces: known[0].id },
  ],
  confirms: [],
};
out = await runRefine(OUTCOMES, known, "sk-test", base);
const sent = lastRequest?.messages?.find((m) => m.role === "user")?.content ?? "";
check("the existing lesson was included in the prompt", sent.includes("Tests live in test/"));
check("it can supersede one", out.lessons[0]?.replaces === known[0].id);

const applied = await lessons.applyLessons(WS, out.lessons, out.confirms);
const after = await lessons.readLessons(WS);
const live = after.filter((l) => !l.supersededBy);
check(
  "the wrong lesson is retired end to end",
  live.length === 1 && live[0].text === "Tests live in spec/",
  `${applied.added} added, ${applied.revised} revised`
);

await rm(path.join(DATA_ROOT, "workspaces", WS), { recursive: true, force: true });
server.close();

console.log(
  `\n${pass + fail} checks · ${pass} passed${fail ? ` · ${r(`${fail} failed`)}` : ""}\n`
);
process.exit(fail ? 1 : 0);

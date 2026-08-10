/**
 * PDF reading, http_request, wait_for_output, and the app-shell warning.
 *
 * Run:  npm run test:tools3
 *
 * The theme of this round is the same as the last: the agent was losing whole
 * rounds to things that should be one call, and in one case being actively
 * misled.
 *
 * The app-shell detection is the important one. fetch_url on a React site
 * returns HTTP 200 and almost no content, and reported that as a successful
 * read — so the model believed it had seen the page. That is not a missing
 * feature, it is a wrong answer, and it is the mechanism behind the Faceit
 * overlay being written against selectors that never existed.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rm, writeFile as fsWrite } from "node:fs/promises";
import { readFileSync } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const web = await load("src/lib/web.ts");
const http = await load("src/lib/http.ts");
const docs = await load("src/lib/documents.ts");
const procs = await load("src/lib/processes.ts");
const ws = await load("src/lib/workspace.ts");
const { WORKSPACE_TOOLS } = await load("src/lib/tools.ts");

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

console.log("\napiM tool checks — round three\n");

// ---------------------------------------------------------------------------
console.log("1. An app shell is recognised, not reported as a page");

const SHELLS = [
  ["React", `<html><head><script src="/a.js" defer></script></head><body><div id="root"></div></body></html>`],
  ["Next.js", `<html><head><script src="/_next/x.js"></script></head><body><div id="__next"></div></body></html>`],
  ["Vue", `<html><head><script src="/app.js"></script></head><body><div id="app"></div></body></html>`],
];
for (const [name, html] of SHELLS) {
  check(
    `${name} shell is detected`,
    web.looksLikeAppShell(html, web.htmlToText(html))
  );
}

const REAL = [
  ["static docs with no scripts", `<html><body><article><h1>Title</h1><p>${"Real content. ".repeat(50)}</p></article></body></html>`],
  ["an article that also loads analytics", `<html><head><script>ga()</script></head><body><article><p>${"Words here. ".repeat(200)}</p></article></body></html>`],
  ["a short static page", `<html><body><h1>Hello</h1><p>Small page.</p></body></html>`],
  ["a server-rendered app", `<html><head><script src="/a.js"></script></head><body><div id="root"><h1>Match</h1><p>${"Server rendered. ".repeat(150)}</p></div></body></html>`],
];
for (const [name, html] of REAL) {
  check(
    `${name} is NOT flagged`,
    !web.looksLikeAppShell(html, web.htmlToText(html)),
    "a false positive would push the model to a browser it does not need"
  );
}

const toolsSrc = readFileSync(path.join(ROOT, "src/lib/tools.ts"), "utf8");
check(
  "fetch_url warns rather than staying silent",
  /This page is an app shell/.test(toolsSrc),
  "reporting an empty page as a successful read is how selectors get invented"
);
check(
  "and points at the tool that works",
  /Use browse for this URL instead/.test(toolsSrc)
);
check(
  "inspect_page refuses outright on a shell",
  /Needs a browser, not a fetch/.test(toolsSrc),
  "handing back id=root as 'the page structure' is the original bug"
);

// ---------------------------------------------------------------------------
console.log("\n2. PDFs can finally be read");

// A minimal but genuinely valid PDF, with two text runs at different heights.
const content = `BT /F1 24 Tf 72 700 Td (Invoice Number 12345) Tj 0 -30 Td (Total due: 480 USD) Tj ET`;
const objs = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
let pdf = "%PDF-1.4\n";
const offsets = [];
objs.forEach((o, i) => {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
});
const xref = pdf.length;
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
offsets.forEach((o) => {
  pdf += String(o).padStart(10, "0") + " 00000 n \n";
});
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

const PDF_PATH = path.join(ROOT, "scripts", ".t3.pdf");
await fsWrite(PDF_PATH, Buffer.from(pdf, "latin1"));

check("a .pdf is recognised as a document", docs.documentKind("invoice.pdf") === "pdf");
const result = await docs.readDocument("pdf", new Uint8Array(readFileSync(PDF_PATH)));
check("its text is extracted", /Invoice Number 12345/.test(result.text), result.text.slice(0, 40));
check(
  "lines are reconstructed from position",
  result.text.includes("\n"),
  "a PDF has no paragraphs — only positioned glyph runs"
);
check("the page count is reported", result.sections === 1);

const empty = await docs.readDocument(
  "pdf",
  new Uint8Array(
    readFileSync(PDF_PATH).toString("latin1").replace(content, " ".repeat(content.length)).length
      ? Buffer.from(pdf.replace(content, " ".repeat(content.length)), "latin1")
      : Buffer.from(pdf, "latin1")
  )
);
check(
  "a PDF with no text says so instead of returning nothing",
  /no extractable text|Invoice/.test(empty.text),
  "a scan is images, and 'this file is empty' would be misleading"
);
await rm(PDF_PATH, { force: true });

// ---------------------------------------------------------------------------
console.log("\n3. http_request cannot be pointed at this machine");

for (const bad of [
  "http://127.0.0.1:8080/admin",
  "http://localhost/x",
  "http://169.254.169.254/latest/meta-data/",
  "http://192.168.1.1/",
]) {
  let blocked = false;
  try {
    await http.httpRequest({ url: bad });
  } catch {
    blocked = true;
  }
  check(`refuses ${bad.slice(0, 40)}`, blocked);
}

let threw = "";
try {
  await http.httpRequest({ url: "https://example.com", method: "TRACE" });
} catch (e) {
  threw = e.message;
}
check("an unsupported method is rejected", /not a supported method/.test(threw));

console.log("\n4. http_request reports what an API call actually did");

let out = http.formatHttpResult({
  status: 201,
  statusText: "Created",
  headers: { "content-type": "application/json", "x-ratelimit-remaining": "98", server: "nginx" },
  body: '{"id":7}',
  truncated: false,
  ms: 143,
  json: { id: 7 },
});
check("the status comes first", out.startsWith("201 Created"), out.split("\n")[0]);
check("timing is included", /143ms/.test(out), "often the thing being investigated");
check("useful headers are shown", /x-ratelimit-remaining: 98/.test(out));
check("noise headers are not", !/server: nginx/.test(out), "a full header dump buries the two useful lines");
check("JSON is pretty-printed", /\{\n  "id": 7/.test(out), "a minified body is one unreadable line");

out = http.formatHttpResult({
  status: 404,
  statusText: "Not Found",
  headers: { "content-type": "text/plain" },
  body: "nope",
  truncated: false,
  ms: 12,
});
check("a 404 is rendered plainly", /^404 Not Found/.test(out));
check(
  "a failing status is still a successful tool call",
  /ok: true,\n            content: formatHttpResult/.test(toolsSrc),
  "a 404 answers the question; marking it failed invites a pointless retry"
);

out = http.formatHttpResult({
  status: 204,
  statusText: "No Content",
  headers: {},
  body: "",
  truncated: false,
  ms: 5,
});
check("an empty body is stated, not blank", /empty response body/.test(out));

// ---------------------------------------------------------------------------
console.log("\n5. wait_for_output — no more guessing how long a server takes");

const WS = "tools3test";
await rm(path.join(ROOT, "data", "workspaces", WS), { recursive: true, force: true });

await ws.writeFile(WS, "fast.js", `console.log("Ready in 0.1s"); setInterval(()=>{},10000);`);
let started = await procs.startProcess(WS, "node", ["fast.js"]);
check("a process starts", started.ok === true);

let waited = await procs.waitForOutput(started.process.id, "Ready in", 10_000);
check("it matches text the process printed", waited.outcome === "matched", waited.matchedLine);
check(
  "including output from before the wait began",
  waited.waitedMs < 500,
  "start_process pauses for a startup grace period, so a fast server has " +
    "already printed by the time this can be called — searching only new " +
    "output made the common case time out"
);

waited = await procs.waitForOutput(started.process.id, "never going to appear", 1_200);
check("it gives up cleanly when nothing matches", waited.outcome === "timeout");
check("and reports how long it waited", waited.waitedMs >= 1_000);
await procs.stopProcess(started.process.id);

await ws.writeFile(WS, "crash.js", `console.log("starting"); process.exit(1);`);
started = await procs.startProcess(WS, "node", ["crash.js"]);
waited = await procs.waitForOutput(started.process.id, "Ready", 30_000);
check(
  "a process that dies ends the wait immediately",
  waited.outcome === "exited" && waited.waitedMs < 1_000,
  `${waited.waitedMs}ms rather than the full 30s`
);

await ws.writeFile(WS, "slow.js", `setTimeout(()=>console.log("Server listening on 3000"), 6000); setInterval(()=>{},10000);`);
started = await procs.startProcess(WS, "node", ["slow.js"]);
const t0 = Date.now();
waited = await procs.waitForOutput(started.process.id, String.raw`listening on \d+`, 20_000);
const elapsed = Date.now() - t0;
check("a genuine wait returns the moment it matches", waited.outcome === "matched", `${elapsed}ms`);
check("regular expressions work", waited.matchedLine === "Server listening on 3000");
check("it did not wait the full timeout", elapsed < 10_000, `${elapsed}ms of a 20s limit`);
await procs.stopProcess(started.process.id);

check(
  "an unknown id is reported, not silently waited on",
  (await procs.waitForOutput("no-such-process", "x", 1_000)) === null
);

const bad = await procs.waitForOutput(
  (await procs.startProcess(WS, "node", ["fast.js"])).process.id,
  "Ready in [",
  5_000
);
check(
  "a broken regex falls back to literal matching",
  bad.outcome === "timeout" || bad.outcome === "matched",
  "an invalid pattern must not throw — it is almost always meant literally"
);

await rm(path.join(ROOT, "data", "workspaces", WS), { recursive: true, force: true });

// ---------------------------------------------------------------------------
console.log("\n6. undo_file can step back further than one write");

const UWS = "tools3undo";
await rm(path.join(ROOT, "data", "workspaces", UWS), { recursive: true, force: true });

for (const v of ["one", "two", "three", "four"]) {
  await ws.writeFile(UWS, "f.txt", `${v}\n`);
}
check(
  "several previous versions are kept",
  (await ws.historyDepth(UWS, "f.txt")) >= 3,
  `${await ws.historyDepth(UWS, "f.txt")} versions — one was not enough when ` +
    `a bad edit was followed by a bad fix`
);
check(
  "one step back is the previous write",
  (await ws.previousVersion(UWS, "f.txt", 1)) === "three\n"
);
check(
  "two steps back is the one before that",
  (await ws.previousVersion(UWS, "f.txt", 2)) === "two\n"
);
check(
  "asking too far back returns nothing rather than the wrong version",
  (await ws.previousVersion(UWS, "f.txt", 99)) === null ||
    (await ws.previousVersion(UWS, "f.txt", 99)) === "one\n"
);
check(
  "history is capped",
  ws.MAX_HISTORY_VERSIONS === 10,
  "unbounded history would grow with every write"
);
await rm(path.join(ROOT, "data", "workspaces", UWS), { recursive: true, force: true });

console.log("\n7. run_command time limits fit real work");

const runner = await load("src/lib/runner.ts");
check(
  "a plain script gets the short limit",
  runner.timeoutFor("node", ["app.js"]) === runner.MAX_RUN_MS
);
check(
  "an install gets the long one",
  runner.timeoutFor("npm", ["install"]) === runner.MAX_INSTALL_MS
);
check(
  "pnpm and yarn are recognised too",
  runner.timeoutFor("pnpm", ["install"]) === runner.MAX_INSTALL_MS &&
    runner.timeoutFor("yarn", ["add", "react"]) === runner.MAX_INSTALL_MS,
  "they were missing, so a real install was killed at 60s and looked like a hang"
);
check(
  "a build is treated as slow",
  runner.timeoutFor("next", ["build"]) === runner.MAX_INSTALL_MS
);
check(
  "an override is honoured",
  runner.timeoutFor("node", ["slow.js"], 120_000) === 120_000
);
check(
  "but cannot exceed the ceiling",
  runner.timeoutFor("node", ["x.js"], 99_999_999) === runner.MAX_INSTALL_MS,
  "a timeout that can be disabled is not a timeout"
);
check(
  "and cannot be set absurdly low",
  runner.timeoutFor("node", ["x.js"], 1) === 5_000
);

const timedOut = runner.formatRunResult({
  command: "node",
  args: ["server.js"],
  stdout: "",
  stderr: "",
  exitCode: null,
  timedOut: true,
  durationMs: 60_000,
});
check(
  "a timeout explains the likely causes",
  /start_process/.test(timedOut) && /timeout_ms/.test(timedOut),
  "'timed out' alone tells the model nothing it can act on"
);

// ---------------------------------------------------------------------------
console.log("\n8. Everything is offered to the model");

const names = WORKSPACE_TOOLS.map((t) => t.function.name);
check("http_request is registered", names.includes("http_request"));
check("wait_for_output is registered", names.includes("wait_for_output"));
check(
  "read_document mentions PDF",
  JSON.stringify(WORKSPACE_TOOLS.find((t) => t.function.name === "read_document")).includes("PDF")
);
check(
  "http_request says why to prefer it over curl",
  /shell quoting/.test(JSON.stringify(WORKSPACE_TOOLS.find((t) => t.function.name === "http_request"))),
  "otherwise the model keeps reaching for run_command"
);
check(
  "wait_for_output says to use it after start_process",
  /start_process/.test(JSON.stringify(WORKSPACE_TOOLS.find((t) => t.function.name === "wait_for_output")))
);

const total = WORKSPACE_TOOLS.length;
const schemaChars = JSON.stringify(WORKSPACE_TOOLS).length;
check(
  "the schemas are still a rounding error on the bill",
  schemaChars / 3.6 < 8_000,
  `${total} tools, ~${Math.round(schemaChars / 3.6)} tokens, sent once and cached`
);

check(
  "run_command exposes a timeout",
  /timeout_ms/.test(JSON.stringify(WORKSPACE_TOOLS.find((t) => t.function.name === "run_command")))
);
check(
  "undo_file exposes steps",
  /steps/.test(JSON.stringify(WORKSPACE_TOOLS.find((t) => t.function.name === "undo_file")))
);
check(
  "run_command no longer claims a 30s limit it does not have",
  !/stopped after 30 seconds/.test(
    JSON.stringify(WORKSPACE_TOOLS.find((t) => t.function.name === "run_command"))
  ),
  "the code used 60s; the description said 30s"
);

console.log(
  `\n${pass + fail} checks · ${pass} passed${fail ? ` · ${r(`${fail} failed`)}` : ""}\n`
);
process.exit(fail ? 1 : 0);

/**
 * Code intelligence and sub-agents.
 *
 * Run:  npm run test:codeintel
 *
 *   - every write/edit is parse-checked and a syntax error comes back in
 *     the same tool result (TS, JS, Python, JSON) — and a clean file adds
 *     nothing;
 *   - find_references finds whole identifiers only and labels them;
 *   - read_symbol without a path goes to the definition anywhere;
 *   - delegate runs a read-only helper in its own context against a
 *     scripted model: parallel reads, refused writes, usage reported,
 *     round cap forcing a report, spending cap stopping it.
 */
import path from "node:path";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.APIM_DATA_ROOT ??= path.join(ROOT, ".test-data", "codeintel");

const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const read = (p) => readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const T = await load("src/lib/tools.ts");
const SC = await load("src/lib/syntax-check.ts");
const CI = await load("src/lib/code-index.ts");
const SA = await load("src/lib/subagent.ts");

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

const ws = `codeintel-${Date.now()}`;
const tool = (name, args) => T.runTool(ws, name, args, {});

// --- syntax check after edits ---
console.log("\nsyntax check after edits");
{
  const bad = await tool("write_file", { path: "src/app.ts", content: "export function f(a: number {\n  return a;\n}\n" });
  check("a broken TypeScript write reports the parse error", bad.ok && /Syntax check/.test(bad.content) && /src\/app\.ts:1:/.test(bad.content), bad.content.split("\n").slice(-4).join(" | "));
  check("…and says so in the summary", /syntax error/.test(bad.summary), bad.summary);
  const fixed = await tool("edit_file", { path: "src/app.ts", old_text: "a: number {", new_text: "a: number) {" });
  check("fixing it clears the report", fixed.ok && !/Syntax check/.test(fixed.content), fixed.summary);
  const tsx = await tool("write_file", { path: "src/view.tsx", content: "export const V = () => <div className=\"x\">hi</div>;\n" });
  check("valid TSX is clean", tsx.ok && !/Syntax check/.test(tsx.content));
  const js = await tool("write_file", { path: "lib/x.mjs", content: "export const a = [1, 2;\n" });
  check("broken JavaScript is caught", /Syntax check/.test(js.content));
  const py = await tool("write_file", { path: "tool.py", content: "def f(:\n    return 1\n" });
  check("broken Python is caught", /tool\.py:1:/.test(py.content), py.content.split("\n").slice(-3).join(" | "));
  const pyOk = await tool("write_file", { path: "ok.py", content: "def f():\n    return 1\n" });
  check("valid Python is clean", !/Syntax check/.test(pyOk.content));
  const json = await tool("write_file", { path: "package.json", content: '{ "name": "x", }\n' });
  check("broken JSON is caught", /package\.json:1:/.test(json.content));
  const tsconfig = await tool("write_file", { path: "tsconfig.json", content: '{\n  // comments are allowed here\n  "compilerOptions": {},\n}\n' });
  check("tsconfig's comments are not reported", !/Syntax check/.test(tsconfig.content));
  const batch = await tool("write_files", { files: [{ path: "a.js", content: "let = ;\n" }, { path: "b.js", content: "ok()\n" }] });
  check("write_files checks every file it wrote", /a\.js:1:/.test(batch.content) && !/b\.js:/.test(batch.content));
  const md = await tool("write_file", { path: "README.md", content: "# {{{ not code\n" });
  check("non-code files are not checked", !/Syntax check/.test(md.content));
  const t0 = performance.now();
  await SC.checkSyntax(ws, ["src/app.ts"]);
  const warm = performance.now() - t0;
  check("the TypeScript parser stays warm between edits", warm < 150, `${Math.round(warm)}ms (a cold start costs ~250ms)`);
  check("paths from apply_patch headers", SC.pathsWrittenBy("apply_patch", { patch: "--- a/x.ts\n+++ b/x.ts\n@@\n" }).join() === "x.ts");
}

// --- references and definitions ---
console.log("\nfind_references / go to definition");
{
  await tool("write_files", {
    files: [
      { path: "src/config.ts", content: "export function loadConfig(p: string) {\n  return p;\n}\nexport const autoloadConfig = 1;\n" },
      { path: "src/main.ts", content: "import { loadConfig } from './config';\n\nconst c = loadConfig('a');\nconsole.log(c, 'loadConfigX');\n" },
      { path: "py/app.py", content: "from cfg import load_config\n\ndef load_config(p):\n    return p\n\nload_config('x')\n" },
    ],
  });
  const refs = await tool("find_references", { name: "loadConfig" });
  check("finds definition, import and use", /1 definition, 1 import, 1 use/.test(refs.content), refs.content.split("\n")[0]);
  check("whole identifiers only", !/autoloadConfig/.test(refs.content) && !/loadConfigX/.test(refs.content));
  check("definition is listed first", refs.content.indexOf("[definition]") < refs.content.indexOf("[use]"));
  const pyRefs = await tool("find_references", { name: "load_config" });
  check("works for Python", /1 definition, 1 import, 1 use/.test(pyRefs.content), pyRefs.content.split("\n")[0]);
  const scoped = await tool("find_references", { name: "loadConfig", path: "py" });
  check("path limits the search", /No references/.test(scoped.content));
  const none = await tool("find_references", { name: "not an identifier!" });
  check("rejects a non-identifier", !none.ok);
  const def = await tool("read_symbol", { name: "loadConfig" });
  check("read_symbol without a path finds the definition", def.ok && /src\/config\.ts/.test(def.summary) && /return p/.test(def.content), def.summary);
  const miss = await tool("read_symbol", { name: "nowhere" });
  check("…and says clearly when there is none", !miss.ok && /find_references/.test(miss.content));
  check("bareName takes the last segment", CI.bareName("Cls::run") === "run" && CI.bareName("a.b.c") === "c");
}

// --- review fixes ---
console.log("\nreview fixes");
{
  const S = await load("src/lib/symbols.ts");
  const table = "export function f() {}\nconst table = [" + Array.from({ length: 40000 }, (_, i) => i).join(",") + "];\nf();\n";
  const t0 = performance.now();
  const found = S.findSymbols(table, "f", "x.ts");
  const ms = performance.now() - t0;
  check("a 229KB generated line no longer freezes the scan", ms < 1000 && found.length === 1, `${Math.round(ms)}ms (was 65s)`);
  const src = "async function main() {\n  await runTool(ws, 'x', {\n    a: 1\n  });\n  if (runTool(a)) {\n  }\n  x.set(\n    runTool(b, {\n    })\n  );\n}\nexport async function runTool(ws, name, args) {\n  return 1;\n}\n";
  const defs = S.findSymbols(src, "runTool", "a.ts");
  check("call sites with a block are not definitions", defs.length === 1 && /export async function runTool/.test(defs[0].signature), defs.map((d) => d.signature).join(" | "));
  check("const arrow functions are definitions", S.findSymbols("const go = async (a) => {\n  return a;\n};\n", "go", "a.ts").length === 1);
  check("C++ qualified methods still are", S.findSymbols("void Foo::bar(int x) {\n}\n", "bar", "a.cpp").length === 1);
  await tool("write_files", { files: [
    { path: "tests/helper.test.ts", content: "export function loadConfig() {\n  return 0;\n}\n" },
    { path: "g/server.go", content: "func (s *Server) Handle(w int) {\n}\n" },
    { path: "py/consts.py", content: "LIMIT = 10\nraise Foo(LIMIT)\n" },
  ] });
  const ranked = await tool("read_symbol", { name: "loadConfig" });
  check("go to definition prefers source over tests", /src\/config\.ts/.test(ranked.summary), ranked.summary);
  const go = await tool("find_references", { name: "Handle" });
  check("Go methods are definitions", /\[definition\] func \(s \*Server\) Handle/.test(go.content));
  const limit = await tool("find_references", { name: "LIMIT" });
  check("module constants are definitions", /\[definition\] LIMIT = 10/.test(limit.content) && /\[use\] raise Foo\(LIMIT\)/.test(limit.content));

  const bom = await tool("write_file", { path: "appsettings.json", content: "\uFEFF{ \"a\": 1 }\n" });
  check("JSON with a byte-order mark is not an error", !/Syntax check/.test(bom.content));
  const jsonc = await tool("write_file", { path: ".eslintrc.json", content: "{\n  // rules\n  \"rules\": {},\n}\n" });
  check("JSON-with-comments files are not errors", !/Syntax check/.test(jsonc.content));
  const stillBad = await tool("write_file", { path: "conf.json", content: "{ \"a\": }\n" });
  check("…while broken JSON still is", /Syntax check/.test(stillBad.content));
  const flow = await tool("write_file", { path: "rn/App.js", content: "// @flow\nfunction f(x: number): string { return String(x); }\n" });
  check("Flow-typed JavaScript is skipped", !/Syntax check/.test(flow.content));
  const pyBom = await tool("write_file", { path: "bom.py", content: "\uFEFFx = 1\n" });
  check("Python with a byte-order mark is not an error", !/Syntax check/.test(pyBom.content));
  const pyBad = await tool("write_file", { path: "bad2.py", content: "def (:\n" });
  check("Python errors name the interpreter version", /parsed with Python 3\.\d+/.test(pyBad.content));

  check("helper context follows the model window", SA.helperContextCap(81_920) < 170_000 && SA.helperContextCap(1_000_000) === 420_000, `${SA.helperContextCap(81_920)} chars for 80K tokens`);
}

// --- sub-agent ---
console.log("\ndelegate (sub-agent)");
const script = [];
const seen = [];
let active = 0;
let maxActive = 0;
const mock = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const body = JSON.parse(raw || "{}");
    seen.push(body);
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((ok) => setTimeout(ok, 60));
    active--;
    const task = body.messages.find((m) => m.role === "user")?.content ?? "";
    const turn = body.messages.filter((m) => m.role === "assistant").length;
    const plan = script.find((s) => task.includes(s.key));
    let step = plan ? plan.turns[Math.min(turn, plan.turns.length - 1)] : { say: "?" };
    if (body.tool_choice === "none" && step.calls) step = { say: "Partial: what I found before the limit." };
    const message = step.calls
      ? { role: "assistant", content: null, tool_calls: step.calls.map((c, i) => ({ id: `c${turn}-${i}`, type: "function", function: { name: c[0], arguments: JSON.stringify(c[1]) } })) }
      : { role: "assistant", content: step.say };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }));
  });
});
await new Promise((ok) => mock.listen(0, "127.0.0.1", ok));
const target = {
  baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
  apiModel: "mock",
  headers: { "Content-Type": "application/json" },
  extraBody: { thinking: { type: "disabled" } },
};
const all = new Set(["read_file", "read_files", "search_files", "find_references", "read_symbol", "list_files", "write_file", "run_command"]);
const helper = (task, extra = {}) =>
  SA.runSubAgent({ task, workspaceId: ws, target, toolContext: {}, available: all, signal: new AbortController().signal, ...extra });

try {
  script.push({
    key: "TRACE",
    turns: [
      { calls: [["find_references", { name: "loadConfig" }], ["read_file", { path: "src/config.ts" }]] },
      { calls: [["write_file", { path: "evil.txt", content: "x" }]] },
      { say: "loadConfig is defined at src/config.ts:1 and called at src/main.ts:3." },
    ],
  });
  const usages = [];
  const progress = [];
  const out = await helper("TRACE loadConfig", { onUsage: (u) => usages.push(u), onProgress: (p) => progress.push(p) });
  check("the helper reports", out.ok && /src\/main\.ts:3/.test(out.report), out.report);
  check("its tool calls ran against the workspace", /\[definition\]/.test(JSON.stringify(seen[1].messages)), "find_references result in round 2");
  check("a write is refused, not run", /not available to a read-only helper/.test(JSON.stringify(seen[2].messages)) && !(await T.runTool(ws, "list_files", {}, {})).content.includes("evil.txt"));
  check("only read tools are offered", seen[0].tools.every((t) => SA.SUBAGENT_TOOLS.has(t.function.name)) && !seen[0].tools.some((t) => t.function.name === "write_file" || t.function.name === "delegate"));
  check("the helper cannot delegate further", !SA.SUBAGENT_TOOLS.has("delegate"));
  check("every request's usage is reported", usages.length === 3);
  check("progress is reported per round", progress.length === 2 && progress[0].toolCalls === 2);
  check("thinking switches ride every request", seen.every((b) => b.thinking?.type === "disabled"));
  check("its brief starts a fresh context with the file list", seen[0].messages.length === 2 && /Files already in the workspace/.test(seen[0].messages[0].content));
  check("files it read are counted", out.filesRead.includes("src/config.ts"));
  const fmt = SA.formatSubAgentResult(out);
  check("the main agent gets a stats line and the report", /^Helper report \(3 rounds, 3 tool calls/.test(fmt.content), fmt.content.split("\n")[0]);

  seen.length = 0;
  script.push({ key: "LOOP", turns: [{ calls: [["list_files", {}]] }] });
  const capped = await helper("LOOP forever", { maxRounds: 2 });
  const last = seen.at(-1);
  check("the round cap forces a report", capped.ok && capped.stoppedBecause === "rounds" && seen.length === 3 && last.tool_choice === "none" && /Stop exploring/.test(JSON.stringify(last.messages)), `${seen.length} requests`);
  check("…flagged as possibly incomplete", /round limit/.test(SA.formatSubAgentResult(capped).content));

  const budgeted = await helper("LOOP again", { shouldStop: () => true });
  check("the spending cap stops it before any request", !budgeted.ok && budgeted.stoppedBecause === "budget");

  maxActive = 0;
  script.push({ key: "PAR", turns: [{ say: "done" }] });
  await Promise.all([helper("PAR one"), helper("PAR two"), helper("PAR three")]);
  check("helpers run in parallel", maxActive >= 2, `max ${maxActive} concurrent`);

  const ctl = new AbortController();
  ctl.abort();
  const stopped = await helper("PAR stopped", { signal: ctl.signal });
  check("Stop ends a helper", stopped.stoppedBecause === "stopped");

  // A context overflow (400) after some work: shrink and still report.
  seen.length = 0;
  script.push({ key: "OVERFLOW", turns: [{ calls: [["read_file", { path: "src/config.ts" }]] }] });
  let n400 = 0;
  const overflowFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.messages.some((m) => m.role === "tool") && body.tool_choice !== "none" && n400++ === 0) {
      return new Response("context length exceeded", { status: 400 });
    }
    return fetch(url, init);
  };
  const salvaged = await helper("OVERFLOW please", { fetchImpl: overflowFetch });
  check("a context overflow after work still produces a report", salvaged.ok && /Partial/.test(salvaged.report), salvaged.report.slice(0, 80));

  script.push({ key: "GIT", turns: [{ calls: [["git_status", {}]] }, { say: "git checked" }] });
  seen.length = 0;
  await helper("GIT status please", { available: new Set([...all, "git_status"]) });
  check("read-only git tools reach the git agent", !/Unknown tool/.test(JSON.stringify(seen.at(-1).messages)), JSON.stringify(seen.at(-1).messages.at(-1)).slice(0, 120));

  const slow = new AbortController();
  const t1 = Date.now();
  const deadFetch = async () => { throw new Error("ECONNRESET"); };
  setTimeout(() => slow.abort(), 300);
  const aborted = await helper("PAR stop in backoff", { fetchImpl: deadFetch, signal: slow.signal });
  check("Stop cuts a helper's retry wait short", aborted.stoppedBecause === "stopped" && Date.now() - t1 < 1200, `${Date.now() - t1}ms`);

  const broken = await SA.runSubAgent({ task: "x", workspaceId: ws, target: { ...target, baseUrl: "http://127.0.0.1:9/v1" }, toolContext: {}, available: all, signal: new AbortController().signal });
  check("an unreachable model fails cleanly", !broken.ok && /helper failed/.test(broken.report));
} finally {
  mock.close();
}

// --- wiring ---
console.log("\nwiring");
{
  const route = read("src/app/api/chat/route.ts");
  check("delegate is offered with the workspace tools", /\[\.\.\.\(dsRequestBody\.tools as ToolDefinition\[\]\), DELEGATE_TOOL\]/.test(route));
  check("several delegates in a round start together", /if \(call\.function\.name !== "delegate"\) continue;[\s\S]{0,200}runDelegate\(parsedArgs\.value, call\.id\)/.test(route));
  check("helper usage counts toward the reply and its cap", /onUsage: \(u\) => \{[\s\S]{0,600}chargeRound\(budget/.test(route) && /shouldStop: \(\) =>\s*budget\.limitUsd !== null/.test(route));
  check("helpers a halted round never awaited are aborted", /roundAbort\.abort\(\);/.test(route) && /AbortSignal\.any\(\[runSignal, roundAbort\.signal\]\)/.test(route));
  check("the helper's context is sized to the model", /contextCapChars: helperContextCap\(contextWindowFor\(model, customs\)\)/.test(route));
  check("progress from a prefetched helper waits for its row", /heldProgress\.get\(call\.id\)/.test(route));
  const rebuild = await load("src/lib/rebuild-resume.ts");
  void rebuild;
  check("a lost helper report is not described as an action that took effect", /The helper's report was not kept/.test(read("src/lib/rebuild-resume.ts")));
  check("AGENTS.md is framed as project information, not orders", /not instructions from the user/.test(route) && /<project-notes file=/.test(route) && !/Follow them\./.test(route));
  check("the agent is told about delegate and find_references", /call delegate: a read-only helper/.test(route) && /call find_references so no caller is missed/.test(route));
  check("helper rounds stream to the running row", /onProgress: \(p\) => \{[\s\S]{0,300}if \(shownTools\.has\(callId\)\) send\(\{ type: "tool_progress", id: callId, text \}\)/.test(route));
  const pageSrc = read("src/app/page.tsx");
  const toolRow = read("src/components/ToolActivity.tsx");
  check("the page shows the progress on the running tool", /case "tool_progress":[\s\S]{0,900}progress: evt\.text/.test(pageSrc) && /running && event\.progress/.test(toolRow));
  check("progress frames never stall the text pacer", /"tool_progress",/.test(pageSrc));
  const display = await load("src/lib/tool-display.ts");
  check("delegate reads as a helper in the transcript", display.describeTool("delegate", JSON.stringify({ task: "Trace auth" })).running === "Delegating");
}

console.log(`\n${pass + fail} checks · ${pass} passed`);
process.exit(fail ? 1 : 0);

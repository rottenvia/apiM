/**
 * Checks the agent's awareness tools.
 *
 * Run:  npm run test:agent
 *
 * These exist to stop the model working blind — searching instead of guessing
 * which file to open, and knowing what already exists before it writes.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rm } from "node:fs/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const ws = await import(pathToFileURL(path.join(ROOT, "src/lib/workspace.ts")).href);
const { buildWorkspaceContext } = await import(
  pathToFileURL(path.join(ROOT, "src/lib/workspace-context.ts")).href
);
const { runTool } = await import(pathToFileURL(path.join(ROOT, "src/lib/tools.ts")).href);
const { WORKSPACE_TOOLS } = await import(pathToFileURL(path.join(ROOT, "src/lib/tools.ts")).href);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

const WS = "agenttest";
await rm(path.join(ROOT, "data", "workspaces", WS), { recursive: true, force: true });

console.log("\napiM agent capability checks\n");

await ws.writeFile(WS, "main.py", "from helper import greet\n\ndef main():\n    greet('world')\n");
await ws.writeFile(WS, "helper.py", "def greet(name):\n    print(f'Hello {name}')\n");
await ws.writeFile(WS, "src/utils.py", "def slugify(text):\n    return text.lower()\n");
await ws.writeFile(WS, "README.md", "# Project\n");

console.log("1. The model is told what already exists");
const ctx = await buildWorkspaceContext(WS);
check("the tree names every file",
  ["main.py", "helper.py", "utils.py", "README.md"].every((f) => ctx.includes(f)));
check("subdirectories are grouped", ctx.includes("src/"), ctx.split("\n").find((l) => l.includes("src")) ?? "");
check("sizes are included so a stub is distinguishable", /\(\d+B\)/.test(ctx));
check("it tells the model to edit rather than duplicate",
  /near-duplicate/i.test(ctx));

const empty = await buildWorkspaceContext("agenttest-empty");
check("an empty workspace says so briefly", /empty/i.test(empty) && empty.length < 120,
  `${empty.trim().length} chars`);

console.log("\n2. Searching instead of opening files one by one");
let res = await runTool(WS, "search_files", { query: "greet" });
check("finds matches across files", res.ok && res.content.includes("helper.py"));
check("reports file and line number", /helper\.py:\d+:/.test(res.content),
  res.content.split("\n")[0]);
check("finds every occurrence", res.content.split("\n").length >= 3,
  `${res.content.split("\n").length} hits`);

res = await runTool(WS, "search_files", { query: "GREET", case_sensitive: true });
check("case-sensitive search respects case", res.content.includes("No matches"));

res = await runTool(WS, "search_files", { query: "def .*ify", regex: true });
check("regex search works", res.ok && res.content.includes("utils.py"));

res = await runTool(WS, "search_files", { query: "[unclosed", regex: true });
check("a broken regex is reported, not thrown",
  !res.ok && /Invalid regular expression/i.test(res.content));

res = await runTool(WS, "search_files", { query: "def", glob: "*.md" });
check("glob narrows the search", res.content.includes("No matches"));

res = await runTool(WS, "search_files", { query: "nothingmatchesthis" });
check("no matches is a clean answer, not an error", res.ok && /No matches/.test(res.content));

console.log("\n3. Reading several files in one round");
res = await runTool(WS, "read_files", { paths: ["main.py", "helper.py"] });
check("both files come back", res.ok && res.content.includes("def greet") && res.content.includes("def main"));
check("each is labelled", (res.content.match(/^--- /gm) ?? []).length === 2);

res = await runTool(WS, "read_files", { paths: ["main.py", "does-not-exist.py"] });
check("a missing file doesn't lose the others",
  res.content.includes("def main") && /could not read/i.test(res.content));

res = await runTool(WS, "read_files", { paths: [] });
check("an empty list is rejected clearly", !res.ok);

console.log("\n4. The tools are actually offered to the model");
const names = WORKSPACE_TOOLS.map((t) => t.function.name);
for (const n of ["search_files", "read_files", "run_command", "write_file", "edit_file"]) {
  check(`${n} is exposed`, names.includes(n));
}

console.log("\n5. Search can't escape the workspace");
await ws.writeFile("agenttest-other", "secret.txt", "PRIVATE DATA\n");
res = await runTool(WS, "search_files", { query: "PRIVATE" });
check("another workspace is not searched", res.content.includes("No matches"));

console.log("\n" + (fail === 0 ? g(`All ${pass} checks passed.`) : r(`${fail} of ${pass + fail} failed.`)) + "\n");
process.exit(fail === 0 ? 0 : 1);

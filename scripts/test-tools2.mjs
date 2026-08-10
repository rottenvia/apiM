/**
 * The tool improvements: edit tolerance, line ranges, search context,
 * apply_patch and run_tests.
 *
 * Run:  npm run test:tools2
 *
 * Each of these came from measuring a real weakness rather than from a guess.
 * Two of the four things I originally claimed were wrong were not wrong at
 * all — search_files already had regex and globs — so everything asserted
 * here is checked against behaviour, not against my description of it.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rm } from "node:fs/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const ws = await load("src/lib/workspace.ts");
const { runTool, WORKSPACE_TOOLS } = await load("src/lib/tools.ts");
const patch = await load("src/lib/patch.ts");
const testing = await load("src/lib/testing.ts");

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

const WS = "tools2test";
await rm(path.join(ROOT, "data", "workspaces", WS), { recursive: true, force: true });

console.log("\napiM tool capability checks\n");

// ---------------------------------------------------------------------------
console.log("1. edit_file tolerates re-indented text, without guessing");

const PY = "class A:\n    def greet(self, name):\n        return f'hi {name}'\n\n    def other(self):\n        pass\n";

await ws.writeFile(WS, "a.py", PY);
let res = await ws.editFile(
  WS,
  "a.py",
  "def greet(self, name):\n    return f'hi {name}'",
  "def greet(self, name):\n    return f'hello {name}'"
);
let body = (await ws.readFile(WS, "a.py")).content;
check("an edit with the wrong indentation still lands", res.replaced);
check(
  "and the file's own indentation is preserved",
  body.includes("    def greet(self, name):\n        return f'hello {name}'"),
  "inserting the model's indentation verbatim would break Python"
);
check("the rest of the file is untouched", body.includes("    def other(self):"));

await ws.writeFile(WS, "b.js", "function add(a, b) {\n  return a + b;\n}\n");
res = await ws.editFile(
  WS,
  "b.js",
  "function add( a , b ) {\n  return a + b;\n}",
  "function add(a, b) {\n  return a + b + 0;\n}"
);
check("spacing around punctuation is tolerated", res.replaced, "add( a , b ) vs add(a, b)");

await ws.writeFile(WS, "c.txt", "hello world\n");
res = await ws.editFile(WS, "c.txt", "hello world", "goodbye world");
check(
  "an exact match still behaves exactly as before",
  (await ws.readFile(WS, "c.txt")).content === "goodbye world\n"
);

await ws.writeFile(WS, "d.py", "def f():\n    pass\n\ndef f():\n    pass\n");
let threw = "";
try {
  await ws.editFile(WS, "d.py", "def f():\n  pass", "X");
} catch (e) {
  threw = e.message;
}
check(
  "an ambiguous match is still refused",
  /more than once/.test(threw),
  "tolerance must never mean choosing between two candidates"
);

threw = "";
try {
  await ws.editFile(WS, "c.txt", "text that is simply not there", "X");
} catch (e) {
  threw = e.message;
}
check("genuinely absent text still fails", /not found/.test(threw));

// ---------------------------------------------------------------------------
console.log("\n2. read_file can read part of a file");

await ws.writeFile(
  WS,
  "big.py",
  Array.from({ length: 12 }, (_, i) => `line ${i + 1} content`).join("\n") + "\n"
);

res = await runTool(WS, "read_file", { path: "big.py", start_line: 3, end_line: 5 });
check("a range returns only those lines", res.content.split("\n").filter((l) => /^\s*\d+ \|/.test(l)).length === 3);
check("lines are numbered", /3 \| line 3 content/.test(res.content), "an unnumbered slice invites off-by-N reasoning");
check("the range is stated with the total", /lines 3-5 of 13/.test(res.content));
check("the summary says what was read", res.summary === "Read big.py lines 3-5");

res = await runTool(WS, "read_file", { path: "big.py" });
check("no range still reads the whole file", res.content.includes("line 12 content") && res.summary === "Read big.py");

res = await runTool(WS, "read_file", { path: "big.py", start_line: 999 });
check("a range past the end is an error, not empty output", !res.ok, res.summary);

res = await runTool(WS, "read_file", { path: "big.py", start_line: 10, end_line: 999 });
check("an end past the last line is clamped", res.ok && /lines 10-13/.test(res.content));

// ---------------------------------------------------------------------------
console.log("\n3. search_files can show surrounding lines");

await ws.writeFile(
  WS,
  "srch.py",
  "def load(path):\n    if not path:\n        return None\n    return open(path).read()\n\ndef save(p, d):\n    return None\n"
);

res = await runTool(WS, "search_files", { query: "return None", context: 2 });
check("context lines are included", /def load\(path\)/.test(res.content), "so the model can tell which function a hit is in");
check("the matching line is marked", />\s+3\s/.test(res.content), "otherwise it reasons about a neighbouring line");
check("both matches are distinguishable", /def save/.test(res.content));

res = await runTool(WS, "search_files", { query: "return None" });
check(
  "without context the output is unchanged",
  res.content === "srch.py:3: return None\nsrch.py:7: return None"
);

// These already worked — asserted so a future change cannot quietly remove
// them, and because I wrongly claimed they were missing.
res = await runTool(WS, "search_files", { query: "def \\w+\\(", regex: true });
check("regex search works", res.ok && /def load/.test(res.content));
res = await runTool(WS, "search_files", { query: "RETURN NONE", case_sensitive: true });
check("case-sensitive search works", /No matches/.test(res.content));
res = await runTool(WS, "search_files", { query: "return", glob: "*.js" });
check("glob filtering works", !/srch\.py/.test(res.content));

// ---------------------------------------------------------------------------
console.log("\n4. apply_patch — several changes to one file, atomically");

await ws.writeFile(WS, "app.py", "def a():\n    return 1\n\ndef b():\n    return 2\n\ndef c():\n    return 3\n");

res = await runTool(WS, "apply_patch", {
  path: "app.py",
  patch:
    "@@ -1,2 +1,2 @@\n def a():\n-    return 1\n+    return 100\n" +
    "@@ -7,2 +7,2 @@\n def c():\n-    return 3\n+    return 300\n",
});
body = (await ws.readFile(WS, "app.py")).content;
check("two hunks apply in one call", res.ok, res.summary);
check("the first change landed", body.includes("return 100"));
check("the second landed too", body.includes("return 300"));
check("the untouched function is unchanged", body.includes("def b():\n    return 2"));
check("it reports the changed path", res.changedPath === "app.py");

const before = (await ws.readFile(WS, "app.py")).content;
res = await runTool(WS, "apply_patch", {
  path: "app.py",
  patch: "@@ -1,2 +1,2 @@\n def a():\n-    return 999\n+    x\n",
});
check("a hunk that does not match is refused", !res.ok);
check(
  "and the file is left completely untouched",
  (await ws.readFile(WS, "app.py")).content === before,
  "a half-applied patch is worse than a rejected one"
);
check("the error says what it expected", /expected to find/.test(res.content));

// Line numbers are a hint, not a requirement.
const shifted = patch.applyPatch(
  "// a new comment line\n// and another\ndef a():\n    return 1\n",
  "@@ -1,2 +1,2 @@\n def a():\n-    return 1\n+    return 2\n"
);
check(
  "a hunk with stale line numbers still applies",
  shifted.content.includes("return 2"),
  "models reproduce @@ headers imprecisely; content is what matters"
);

let patchThrew = "";
try {
  patch.applyPatch("a\nb\n", "not a diff at all");
} catch (e) {
  patchThrew = e.message;
}
check("text that is not a diff is rejected clearly", /@@ hunks/.test(patchThrew));

// ---------------------------------------------------------------------------
console.log("\n5. run_tests — the verdict, not the wall of output");

let s = testing.parseTestOutput(
  "pytest",
  "tests/test_x.py .F\nFAILED tests/test_x.py::test_bad - AssertionError: boom\n1 failed, 1 passed in 0.03s\n",
  "",
  1
);
check("pytest counts are read", s.passed === 1 && s.failed === 1);
check("it is not marked ok", s.ok === false);
check("the failing test is named", s.failures[0].name === "tests/test_x.py::test_bad");
check("with its assertion message", /boom/.test(s.failures[0].detail));

let out = testing.formatTestSummary(s, "");
check("the summary is short", out.split("\n").length <= 6, `${out.split("\n").length} lines`);
check("and names the failure", /test_bad/.test(out));

s = testing.parseTestOutput("vitest", " Tests  1 failed | 3 passed (4)\n", "", 1);
check("vitest counts are read", s.passed === 3 && s.failed === 1);

s = testing.parseTestOutput("jest", "Tests:       1 failed, 2 skipped, 5 passed\n", "", 1);
check("jest counts are read", s.passed === 5 && s.failed === 1 && s.skipped === 2);

s = testing.parseTestOutput(
  "cargo",
  "test result: FAILED. 3 passed; 1 failed; 0 ignored\n",
  "",
  101
);
check("cargo counts are read", s.passed === 3 && s.failed === 1);

s = testing.parseTestOutput("pytest", "5 passed in 0.10s\n", "", 0);
check("a clean run is reported as one line", testing.formatTestSummary(s, "") === "pytest: 5 passed. Everything passed.");

s = testing.parseTestOutput("mystery", "output from a runner nobody has seen", "", 0);
check(
  "unrecognised output NEVER claims a pass",
  s.unparsed === true && !/Everything passed/.test(testing.formatTestSummary(s, "raw")),
  "silently reporting success is the worst possible failure for this tool"
);
check(
  "and it hands back the raw output instead",
  /verbatim/.test(testing.formatTestSummary(s, "raw output here"))
);

console.log("\n6. Runner detection reads the project, not a guess");

const DETECT = path.join(ROOT, "data", "workspaces", `${WS}-detect`);
await rm(DETECT, { recursive: true, force: true });
await ws.writeFile(`${WS}-detect`, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
let runner = await testing.detectRunner(DETECT);
check("a package.json test script is found", runner?.command === "npm", runner?.because);

await rm(DETECT, { recursive: true, force: true });
await ws.writeFile(`${WS}-detect`, "package.json", JSON.stringify({ scripts: { test: 'echo "Error: no test specified"' } }));
runner = await testing.detectRunner(DETECT);
check(
  "the npm init placeholder is not mistaken for a suite",
  runner === null,
  "it exits non-zero and would look like a failing test run"
);

await rm(DETECT, { recursive: true, force: true });
await ws.writeFile(`${WS}-detect`, "pytest.ini", "[pytest]\n");
runner = await testing.detectRunner(DETECT);
check("pytest config is found", runner?.command === "pytest", runner?.because);

await rm(DETECT, { recursive: true, force: true });
await ws.writeFile(`${WS}-detect`, "tests/test_a.py", "def test_x():\n    pass\n");
runner = await testing.detectRunner(DETECT);
check("a bare tests/ directory is enough", runner?.command === "pytest", runner?.because);

await rm(DETECT, { recursive: true, force: true });
await ws.writeFile(`${WS}-detect`, "Cargo.toml", "[package]\n");
runner = await testing.detectRunner(DETECT);
check("cargo is found", runner?.command === "cargo");

await rm(DETECT, { recursive: true, force: true });
await ws.writeFile(`${WS}-detect`, "readme.md", "nothing here");
runner = await testing.detectRunner(DETECT);
check("a project with no tests says so rather than guessing", runner === null);

console.log("\n7. The new tools are offered to the model");
const names = WORKSPACE_TOOLS.map((t) => t.function.name);
check("run_tests is registered", names.includes("run_tests"));
check("apply_patch is registered", names.includes("apply_patch"));
check("read_file advertises the line range", 
  JSON.stringify(WORKSPACE_TOOLS.find((t) => t.function.name === "read_file")).includes("start_line"));
check("search_files advertises context",
  JSON.stringify(WORKSPACE_TOOLS.find((t) => t.function.name === "search_files")).includes("context"));

await rm(path.join(ROOT, "data", "workspaces", WS), { recursive: true, force: true });
await rm(DETECT, { recursive: true, force: true });

console.log(
  `\n${pass + fail} checks · ${pass} passed${fail ? ` · ${r(`${fail} failed`)}` : ""}\n`
);
process.exit(fail ? 1 : 0);

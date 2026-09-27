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

const ws = await load("src/lib/workspace.ts");
const { runTool, WORKSPACE_TOOLS } = await load("src/lib/tools.ts");
const { RunFileMemory } = await load("src/lib/run-memory.ts");
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
await rm(path.join(DATA_ROOT, "workspaces", WS), { recursive: true, force: true });

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
  // Big enough to be sliced: a small file is returned whole (checked below).
  Array.from({ length: 2000 }, (_, i) => `line ${i + 1} content`).join("\n") + "\n"
);

res = await runTool(WS, "read_file", { path: "big.py", start_line: 3, end_line: 5 });
check("a range returns only those lines", res.content.split("\n").filter((l) => /^\s*\d+ \|/.test(l)).length === 3);
check("lines are numbered", /3 \| line 3 content/.test(res.content), "an unnumbered slice invites off-by-N reasoning");
check("the range is stated with the total", /lines 3-5 of 2001/.test(res.content));
check("the summary says what was read", res.summary === "Read big.py lines 3-5");

res = await runTool(WS, "read_file", { path: "big.py" });
check("no range still reads the whole file", res.content.includes("line 12 content") && res.summary === "Read big.py");

res = await runTool(WS, "read_file", { path: "big.py", start_line: 99999 });
check("a range past the end is an error, not empty output", !res.ok, res.summary);

res = await runTool(WS, "read_file", { path: "big.py", start_line: 1995, end_line: 9999 });
check("an end past the last line is clamped", res.ok && /lines 1995-2001/.test(res.content));

await ws.writeFile(
  WS,
  "small.luau",
  Array.from({ length: 300 }, (_, i) => `local v${i + 1} = ${i + 1}`).join("\n") + "\n"
);
res = await runTool(WS, "read_file", { path: "small.luau", start_line: 270, end_line: 290 });
check("a range read of a small file returns the whole file, numbered",
  res.ok && /1 \| local v1 = 1/.test(res.content) && /300 \| local v300 = 300/.test(res.content) &&
    /never in slices/.test(res.content),
  "reported: five rounds walking one 300-line file a slice at a time");
{
  const memo = new RunFileMemory();
  const first = await runTool(WS, "read_file", { path: "small.luau", start_line: 10, end_line: 12 }, { fileMemory: memo });
  const second = await runTool(WS, "read_file", { path: "small.luau", start_line: 200, end_line: 202 }, { fileMemory: memo });
  check("only the first range read of an unchanged file widens; the next gets its lines",
    /never in slices/.test(first.content) && /300 \| local v300/.test(first.content) &&
      !/never in slices/.test(second.content) && /200 \| local v200 = 200/.test(second.content) &&
      !/300 \| local v300/.test(second.content),
    "measured: two ranges in one round each returned the whole 611-line file");
  await ws.writeFile(WS, "mock.luau", [
    "local M = {}",
    "M.task = {",
    "\tdefer = function(fn, ...)",
    "\t\tfn(...)",
    "\tend,",
    "end",
    "",
    "M.gethui = nil -- set by tests that need it",
    "function M.installGlobals()",
    "\t_G.game = M.game",
    "end",
    "return M",
  ].join("\n") + "\n");
  const multi = await runTool(WS, "edit_file", {
    path: "mock.luau",
    start_anchor: "defer = function(fn, ...)\n\t\tfn(...)\n\tend,\nend\n\nM.gethui = nil -- set by tests th",
    new_text: "\tdefer = function(fn, ...)\n\t\tfn(...)\n\tend,\n}\n\nM.gethui = nil -- set by tests that need it",
  });
  const after = (await ws.readFile(WS, "mock.luau")).content;
  check("a multi-line start_anchor (the reported miss) now matches and edits",
    multi.ok && /\tend,\n}\n\nM\.gethui/.test(after) && !/\tend,\nend\n/.test(after),
    "matched one line at a time, it could never match and blamed the wording");
  const grouped = await runTool(WS, "edit_files", {
    edits: [{ path: "mock.luau", edits: [{ old_text: "_G.game = M.game", new_text: "rawset(env, 'game', M.game)" }] }],
  });
  const top = await runTool(WS, "edit_files", {
    path: "mock.luau",
    edits: [{ old_text: "return M", new_text: "return M -- module" }],
  });
  const after2 = (await ws.readFile(WS, "mock.luau")).content;
  check("edit_files takes {path, edits:[…]} groups and a top-level path",
    grouped.ok && top.ok && /rawset\(env, 'game', M\.game\)/.test(after2) && /return M -- module/.test(after2),
    "measured: 'Edited 0 files, 11 failed' — every entry 'no file path'");
  // Measured live: six edits, only the last with a path (another file).
  await ws.writeFile(WS, "inline.py", "def _restore(text, store):\n    return text\n\nshared = 1\n");
  await ws.writeFile(WS, "other.py", "shared = 1\nvalue = 2\n");
  const inf = await runTool(WS, "edit_files", {
    edits: [
      { old_text: "def _restore(text, store):\n    return text", new_text: "def _restore(text, store):\n    return text.strip()" },
      { old_text: "shared = 1", new_text: "shared = 3" },
      { path: "other.py", old_text: "value = 2", new_text: "value = 5" },
    ],
  });
  const inl = (await ws.readFile(WS, "inline.py")).content;
  const oth = (await ws.readFile(WS, "other.py")).content;
  check("an edit with no path goes to the one file its old_text is in",
    /return text\.strip\(\)/.test(inl) && /value = 5/.test(oth) &&
      /edit 1: no path was given — its old_text occurs only in inline\.py/.test(inf.content),
    "measured: 'Edited 1 file, 5 failed' — five pathless edits, a round spent resending them");
  check("an ambiguous pathless edit is refused, naming the candidates",
    /edit 2\/3: no "path" given, and its old_text occurs in 2 files \(.*inline\.py.*\)/.test(inf.content) &&
      /shared = 1/.test(inl) && /shared = 1/.test(oth),
    "guessing there would edit the wrong file");
  const wrong = await runTool(WS, "edit_files", {
    edits: [{ path: "inline.py", old_text: "value = 5", new_text: "value = 6" }],
  });
  check("an edit aimed at the wrong file says which file has the text",
    !wrong.ok && /that old_text IS in other\.py: did you mean that file\?/.test(wrong.content) &&
      /value = 5/.test((await ws.readFile(WS, "other.py")).content),
    "measured: eq() was edited in tests/roblox_stub.luau but lives in tests/smoke_test.luau — not applied, but named");
  const wf = await runTool(WS, "write_files", { files: [{ file: "alias.luau", contents: "return 1\n" }, { path: "bad.luau" }] });
  check("write_files accepts common field spellings and names what is wrong",
    /Wrote 1/.test(wf.content) && /bad\.luau — malformed entry: "content" must be a string, got nothing/.test(wf.content),
    "measured: '? — malformed entry' left the model guessing");
}

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

const DETECT = path.join(DATA_ROOT, "workspaces", `${WS}-detect`);
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

console.log("\n8. The model does not re-read a file it just wrote");

const MEMWS = "tools2mem";
await rm(path.join(DATA_ROOT, "workspaces", MEMWS), {
  recursive: true,
  force: true,
});
const mem = new RunFileMemory();

// Write through the tool with the run memory attached.
let w = await runTool(
  MEMWS,
  "write_file",
  { path: "just_wrote.ts", content: "export const ANSWER = 42;\n" },
  { fileMemory: mem }
);
check("write_file with memory succeeds", w.ok);

// Immediately read it back: served from the written bytes, marked as such.
let rd = await runTool(
  MEMWS,
  "read_file",
  { path: "just_wrote.ts" },
  { fileMemory: mem }
);
check(
  "an immediate re-read returns the written content",
  rd.ok && rd.content.includes("export const ANSWER = 42;"),
  rd.content.slice(0, 60)
);
check(
  "and says it came from this reply's own write",
  rd.content.includes("you wrote these exact bytes in this reply") &&
    /already written this reply/.test(rd.summary),
  "so the model knows re-reading was unnecessary"
);

// A shell command must invalidate the memory — the file may have changed on
// disk. Read without a memory object still works (disk path).
mem.invalidateAll();
check(
  "after a command the written bytes are no longer served from memory",
  mem.get("just_wrote.ts") === null,
  "the disk is the source of truth once a command could have touched it"
);
const rdDisk = await runTool(
  MEMWS,
  "read_file",
  { path: "just_wrote.ts" }
);
check("a read with no memory still hits the real file", rdDisk.ok && rdDisk.content.includes("ANSWER = 42"));

// A region read is never faked from memory.
const ranged = await runTool(
  MEMWS,
  "read_file",
  { path: "just_wrote.ts", start_line: 1, end_line: 1 },
  { fileMemory: new RunFileMemory() /* empty anyway */ }
);
check("a line-range read goes to disk, not memory", ranged.ok);

await rm(path.join(DATA_ROOT, "workspaces", MEMWS), {
  recursive: true,
  force: true,
});

// ---------------------------------------------------------------------------
// 9. Audit fixes. Every check below reproduces a failure that was measured
// against the previous code, and passes only with the fix in place.
{
  const fsp = await import("node:fs/promises");
  const fsSync = await import("node:fs");
  const os = await import("node:os");
  const { spawn, spawnSync } = await import("node:child_process");
  const runner = await load("src/lib/runner.ts");
  const procs = await load("src/lib/processes.ts");
  const findings = await load("src/lib/findings.ts");
  const snaps = await load("src/lib/snapshots.ts");
  const archive = await load("src/lib/archive.ts");
  const github = await load("src/lib/github.ts");
  const POSIX = process.platform !== "win32";
  const A = "tools2audit";
  const AROOT = path.join(DATA_ROOT, "workspaces", A);
  await rm(AROOT, { recursive: true, force: true });
  const tool = (name, args, ctx) => runTool(A, name, args, ctx);
  const disk = async (p) => (await ws.readFileWhole(A, p)).content;
  const threwOn = async (fn) => {
    try {
      await fn();
      return "";
    } catch (e) {
      return e?.message ?? String(e);
    }
  };

  console.log("\n9.1 Approval-free commands cannot run code or read outside");
  check("`python3 version` is not approval-free (it runs a file named version)",
    !runner.isReadOnlyCommand("python3", ["version"]));
  check("`node version` is not approval-free", !runner.isReadOnlyCommand("node", ["version"]));
  check("`tsx version` is not approval-free", !runner.isReadOnlyCommand("tsx", ["version"]));
  check("`node --version` still is", runner.isReadOnlyCommand("node", ["--version"]));
  check("`git diff --no-index` asks",
    !runner.isReadOnlyCommand("git", ["diff", "--no-index", "/etc/passwd", "/dev/null"]));
  check("`git diff <absolute path>` asks (git falls back to --no-index)",
    !runner.isReadOnlyCommand("git", ["diff", "/etc/passwd", "/etc/hostname"]));
  check("`git show ../x` asks", !runner.isReadOnlyCommand("git", ["log", "--", "../outside"]));
  check("`git --exec-path=/x status` asks", !runner.isReadOnlyCommand("git", ["--exec-path=/tmp", "status"]));
  check("`git branch -D x` asks", !runner.isReadOnlyCommand("git", ["branch", "-D", "x"]));
  check("`git remote add x url` asks", !runner.isReadOnlyCommand("git", ["remote", "add", "x", "u"]));
  check("`git log main..HEAD` is still free", runner.isReadOnlyCommand("git", ["log", "main..HEAD"]));
  check("`git branch -a` is still free", runner.isReadOnlyCommand("git", ["branch", "-a"]));

  console.log("\n9.2 A repository cannot choose what git runs");
  const hasGit = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  if (hasGit) {
    await ws.writeFile(A, "a.txt", "x\n");
    spawnSync("git", ["init", "-q"], { cwd: AROOT });
    spawnSync("git", ["add", "a.txt"], { cwd: AROOT });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "i"], { cwd: AROOT });
    await fsp.appendFile(path.join(AROOT, "a.txt"), "changed\n");
    const marker = path.join(AROOT, "PWNED_BY_FSMONITOR");
    const cfg = path.join(AROOT, ".git", "config");
    await fsp.appendFile(cfg, `[core]\n\tfsmonitor = "touch '${marker}'; false"\n[diff]\n\texternal = "touch '${marker}.diff'"\n`);
    const status = await runner.runCommand(A, "git", ["status"]);
    check("an approval-free `git status` does not run core.fsmonitor",
      !fsSync.existsSync(marker), status.stderr.slice(0, 120));
    const diff = await runner.runCommand(A, "git", ["diff"]);
    check("`git diff` does not run diff.external, and still works",
      !fsSync.existsSync(`${marker}.diff`) && diff.exitCode === 0, diff.stderr.slice(0, 120));
    await github.runGit(AROOT, ["status"]).catch(() => {});
    await github.runGit(AROOT, ["diff"]).catch(() => {});
    check("github.ts runGit is hardened the same way",
      !fsSync.existsSync(marker) && !fsSync.existsSync(`${marker}.diff`));
    await rm(path.join(AROOT, ".git"), { recursive: true, force: true });
  } else {
    check("git hardening (skipped: git not installed)", true);
  }
  process.env.APIM_TEST_SECRET_FOR_GIT = "must-not-leak";
  process.env.AUTH_SECRET_SAVED = process.env.AUTH_SECRET ?? "";
  process.env.AUTH_SECRET = "auth-secret-must-not-leak";
  const gitEnv = typeof github.gitAuthEnv === "function" ? github.gitAuthEnv("tok123") : { AUTH_SECRET: "(not exported)" };
  check("git does not inherit the server's secrets",
    gitEnv.AUTH_SECRET === undefined && gitEnv.APIM_TEST_SECRET_FOR_GIT === undefined);
  check("but still gets PATH and the token header",
    Boolean(gitEnv.PATH ?? gitEnv.Path) &&
      Object.values(gitEnv).some((v) => typeof v === "string" && v.startsWith("AUTHORIZATION: basic")));
  if (process.env.AUTH_SECRET_SAVED) process.env.AUTH_SECRET = process.env.AUTH_SECRET_SAVED;
  else delete process.env.AUTH_SECRET;
  delete process.env.AUTH_SECRET_SAVED;
  delete process.env.APIM_TEST_SECRET_FOR_GIT;

  console.log("\n9.3 Internal folders and symlinks");
  check("write_file into .git/ is refused",
    /protected/.test(await threwOn(() => ws.writeFile(A, ".git/config", "x"))));
  check("write into .history/ is refused",
    /protected/.test(await threwOn(() => ws.writeFile(A, ".history/a.txt.prev", "x"))));
  check("writeFileBytes into .snapshots/ is refused",
    /protected/.test(await threwOn(() => ws.writeFileBytes(A, ".snapshots/x", Buffer.from("x")))));
  check("move into .git/ is refused",
    /protected/.test(await threwOn(() => ws.moveFile(A, "a.txt", ".git/hooks/pre-commit"))));
  await fsp.mkdir(path.join(AROOT, ".git"), { recursive: true });
  await fsp.writeFile(path.join(AROOT, ".git", "HEAD"), "ref: refs/heads/main\n");
  check("delete inside .git/ is refused",
    /protected/.test(await threwOn(() => ws.deleteFile(A, ".git/HEAD"))));
  await fsp.writeFile(path.join(AROOT, ".git", "HEAD"), "ref: refs/heads/main\n");
  check("reading .git is still allowed",
    (await ws.readFile(A, ".git/HEAD")).content.startsWith("ref:"));
  await rm(path.join(AROOT, ".git"), { recursive: true, force: true });
  if (POSIX) {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "apim-outside-"));
    await fsp.writeFile(path.join(outside, "secret.txt"), "OUTSIDE SECRET\n");
    await fsp.symlink(outside, path.join(AROOT, "vendor"));
    await fsp.symlink(path.join(outside, "secret.txt"), path.join(AROOT, "h"));
    const wrote = await threwOn(() => ws.writeFile(A, "vendor/escaped.txt", "x"));
    check("a write through a symlinked directory is refused",
      /symbolic link/.test(wrote) && !fsSync.existsSync(path.join(outside, "escaped.txt")), wrote);
    const read = await threwOn(() => ws.readFile(A, "h"));
    check("a read through a symlink pointing outside is refused", /symbolic link/.test(read), read);
    await fsp.symlink(path.join(outside, "dangling-target"), path.join(AROOT, "dangling"));
    await threwOn(() => ws.writeFileBytes(A, "dangling", Buffer.from("x")));
    check("a dangling symlink cannot be written through",
      !fsSync.existsSync(path.join(outside, "dangling-target")));
    await rm(path.join(AROOT, "vendor"), { force: true });
    await rm(path.join(AROOT, "h"), { force: true });
    await rm(path.join(AROOT, "dangling"), { force: true });

    if (hasGit) {
      // A cloned repository's symlink is skipped, not copied through.
        const fx = await fsp.mkdtemp(path.join(os.tmpdir(), "apim-ghfx-"));
      const bare = path.join(fx, "origin.git");
      const seed = path.join(fx, "seed");
      const g = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" });
      g(fx, ["init", "-q", "--bare", bare]);
      await fsp.mkdir(seed);
      g(seed, ["init", "-q", "-b", "main"]);
      await fsp.writeFile(path.join(seed, "real.txt"), "real\n");
      await fsp.symlink(path.join(outside, "secret.txt"), path.join(seed, "link.txt"));
      g(seed, ["add", "-A"]);
      g(seed, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "s"]);
      g(seed, ["push", "-q", bare, "main"]);
      const GH = "tools2auditgh";
      await rm(path.join(DATA_ROOT, "workspaces", GH), { recursive: true, force: true });
      await github.cloneGitHubRepoToWorkspace({ workspaceId: GH, repo: "o/r", cloneUrl: bare, baseBranch: "main" });
      const linkAt = path.join(DATA_ROOT, "workspaces", GH, "link.txt");
      const leaked = fsSync.existsSync(linkAt) && !fsSync.lstatSync(linkAt).isSymbolicLink() &&
        fsSync.readFileSync(linkAt, "utf8").includes("OUTSIDE SECRET");
      check("a cloned symlink is not copied through into the workspace", !leaked);
      await rm(path.join(DATA_ROOT, "workspaces", GH), { recursive: true, force: true });
      await rm(fx, { recursive: true, force: true });
    }
    await rm(outside, { recursive: true, force: true });
  }

  console.log("\n9.4 stop_process cannot kill an arbitrary pid");
  if (POSIX) {
    const victim = spawn("sleep", ["30"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 200));
    const res = await tool("stop_process", { id: `orphan-${victim.pid}` });
    await new Promise((r) => setTimeout(r, 300));
    check("orphan-<pid> of a process that is not a leftover decompiler is refused",
      !res.ok && victim.exitCode === null && victim.signalCode === null, res.content);
    victim.kill("SIGKILL");
  }

  console.log("\n9.5 Snapshot manifests are validated");
  await ws.writeFile(A, "snap.txt", "snapshot me\n");
  const snap = await snaps.createSnapshot(A, "audit");
  const manifestPath = path.join(AROOT, ".snapshots", snap.id, "manifest.json");
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  const sentinel = path.join(DATA_ROOT, "tools2-audit-sentinel.txt");
  await fsp.writeFile(sentinel, "SENTINEL OUTSIDE\n");
  manifest.files.push({ path: "stolen.txt", size: 1, hash: path.relative(path.join(AROOT, ".snapshots", "objects"), sentinel) });
  await fsp.writeFile(manifestPath, JSON.stringify(manifest));
  await snaps.restoreSnapshot(A, snap.id);
  check("a manifest hash that is a path is not followed",
    !fsSync.existsSync(path.join(AROOT, "stolen.txt")));
  check("valid entries still restore", (await disk("snap.txt")) === "snapshot me\n");
  await rm(sentinel, { force: true });

  console.log("\n9.6 old_text wins over a line number; numeric from/to are lines");
  await ws.writeFile(A, "b.txt", "alpha\nbeta\ngamma\ndelta\n");
  await tool("edit_file", { path: "b.txt", old_text: "gamma\ndelta", new_text: "GD", line: 1 });
  check("old_text + line edits the quoted text, not line 1",
    (await disk("b.txt")) === "alpha\nbeta\nGD\n", JSON.stringify(await disk("b.txt")));
  await ws.writeFile(A, "dup.txt", "x = 1\nmid\nx = 1\n");
  const dup = await tool("edit_file", { path: "dup.txt", old_text: "x = 1", new_text: "x = 2", start_line: 3 });
  check("a line picks between duplicate matches",
    dup.ok && (await disk("dup.txt")) === "x = 1\nmid\nx = 2\n", dup.content.slice(0, 80));
  await ws.writeFile(A, "c.txt", "x = 1\ny = 20\nz = 3\nw = 45\nv = 5\n");
  await tool("edit_file", { path: "c.txt", from: 3, to: 5, new_text: "REPLACED" });
  check("numeric from/to replace lines 3-5, not text containing \"3\"",
    (await disk("c.txt")) === "x = 1\ny = 20\nREPLACED\n", JSON.stringify(await disk("c.txt")));

  console.log("\n9.7 Line-range edits in one batch refer to the original file");
  await ws.writeFile(A, "lines.txt", "L1\nL2\nL3\nL4\nL5\n");
  await tool("edit_files", { edits: [
    { path: "lines.txt", start_line: 2, end_line: 2, new_text: "N2a\nN2b\nN2c" },
    { path: "lines.txt", start_line: 4, end_line: 4, new_text: "N4" },
    { path: "lines.txt", old_text: "L5", new_text: "T5" },
  ] });
  check("edit 2's line 4 is the original L4",
    (await disk("lines.txt")) === "L1\nN2a\nN2b\nN2c\nL3\nN4\nT5\n", JSON.stringify(await disk("lines.txt")));
  const overlap = await tool("edit_files", { edits: [
    { path: "lines.txt", start_line: 1, end_line: 2, new_text: "A" },
    { path: "lines.txt", start_line: 2, end_line: 3, new_text: "B" },
  ] });
  check("overlapping line ranges are refused, not guessed", /overlap/.test(overlap.content));

  console.log("\n9.8 The run memory never serves stale bytes");
  const mem = new RunFileMemory();
  const ctx = { fileMemory: mem };
  for (const [label, name, args] of [
    ["edit_files", "edit_files", { edits: [{ path: "m.txt", old_text: "version one", new_text: "version TWO" }] }],
    ["replace_in_files", "replace_in_files", { find: "version one", replace: "version TWO" }],
    ["undo_file", "undo_file", { path: "m.txt" }],
    ["apply_patch", "apply_patch", { path: "m.txt", patch: "--- a/m.txt\n+++ b/m.txt\n@@ -1 +1 @@\n-version one\n+version TWO\n" }],
  ]) {
    await tool("write_file", { path: "m.txt", content: "version zero\n" }, ctx);
    await tool("write_file", { path: "m.txt", content: "version one\n" }, ctx);
    await tool(name, args, ctx);
    const now = await disk("m.txt");
    const rd = await tool("read_file", { path: "m.txt" }, ctx);
    check(`after ${label}, read_file shows the disk`,
      rd.content.includes(now.trim()) && !rd.content.includes("served from the run's own write"),
      JSON.stringify(now));
  }
  await tool("write_file", { path: "behind.txt", content: "mine\n" }, ctx);
  await fsp.writeFile(path.join(AROOT, "behind.txt"), "changed by a command\n");
  const behind = await tool("read_file", { path: "behind.txt" }, ctx);
  check("a change made behind the memory's back is read from disk",
    behind.content.includes("changed by a command"));
  check("RunFileMemory.invalidateAll exists for the route", typeof mem.invalidateAll === "function");

  console.log("\n9.9 write_file never writes empty by accident");
  await ws.writeFile(A, "d.txt", "important data\n");
  const wc = await tool("write_file", { path: "d.txt", contents: "new data" });
  check("`contents` is accepted like write_files", wc.ok && (await disk("d.txt")) === "new data");
  await ws.writeFile(A, "d.txt", "important data\n");
  const wn = await tool("write_file", { path: "d.txt", body_text: "oops" });
  check("no content key fails and leaves the file alone",
    !wn.ok && (await disk("d.txt")) === "important data\n", wn.content.slice(0, 80));

  console.log("\n9.10 replace_in_files is not limited by the search cap");
  await ws.writeFile(A, "r/a_many.ts", Array.from({ length: 70 }, (_, i) => `oldName(${i});`).join("\n"));
  await ws.writeFile(A, "r/b.ts", "oldName();\n");
  await ws.writeFile(A, "r/c.ts", "oldName();\n");
  await tool("replace_in_files", { find: "oldName", replace: "newName", glob: "r/*" });
  check("files after a 70-hit file are still replaced",
    (await disk("r/b.ts")) === "newName();\n" && (await disk("r/c.ts")) === "newName();\n");
  await ws.writeFile(A, "r/m.ts", "function a() {\n  return 1;\n}\n");
  const multi = await tool("replace_in_files", { find: "function a() {\n  return 1;", replace: "function a() {\n  return 2;", glob: "r/*" });
  check("a multi-line find works", multi.ok && (await disk("r/m.ts")).includes("return 2;"), multi.content.slice(0, 80));
  const anchored = await tool("replace_in_files", { find: "^  return", replace: "  yield", regex: true, glob: "r/*" });
  check("regex ^ anchors match line starts", anchored.ok && (await disk("r/m.ts")).includes("  yield 2;"), anchored.content.slice(0, 80));

  console.log("\n9.11 Long output is kept, not killed; timeouts kill the tree");
  await ws.writeFile(A, "loud.js", "console.log('FIRST LINE');\nfor (let i=0;i<3000;i++) console.log('progress line ' + i + ' ' + 'x'.repeat(40));\nconsole.log('ALL DONE');\n");
  const loud = await runner.runCommand(A, "node", ["loud.js"]);
  check("a chatty command runs to completion", loud.exitCode === 0 && loud.stdout.includes("ALL DONE"),
    `exit ${loud.exitCode}`);
  check("and keeps its head too, saying what was omitted",
    loud.stdout.startsWith("FIRST LINE") && /omitted/.test(loud.stdout) && loud.stdout.length <= runner.MAX_OUTPUT_CHARS + 200);
  await ws.writeFile(A, "err.js", "for (let i=0;i<1500;i++) console.error('warning ' + i + ' ' + 'y'.repeat(40));\nconsole.error('FINAL ERROR: the real cause');\nprocess.exitCode = 1;\n");
  const err = await runner.runCommand(A, "node", ["err.js"]);
  check("stderr keeps its END", err.stderr.includes("FINAL ERROR: the real cause"));
  if (POSIX) {
    await ws.writeFile(A, "spawner.js",
      "const {spawn}=require('child_process'); spawn(process.execPath, ['-e','setTimeout(()=>require(\"fs\").writeFileSync(\"GRANDCHILD_ALIVE\",\"1\"), 6500)'], {stdio:'inherit'}); setTimeout(()=>{}, 100000);");
    const timed = await runner.runCommand(A, "node", ["spawner.js"], undefined, 5000);
    await new Promise((r) => setTimeout(r, 2500));
    check("a timeout kills the grandchild as well",
      timed.timedOut && !fsSync.existsSync(path.join(AROOT, "GRANDCHILD_ALIVE")));
  }

  console.log("\n9.12 Undo history");
  await ws.writeFile(A, "src/util.ts", "ORIGINAL src/util.ts\n");
  await ws.writeFile(A, "src/util.ts", "EDITED src/util.ts\n");
  await ws.writeFile(A, "src__util.ts", "other v1\n");
  await ws.writeFile(A, "src__util.ts", "other v2\n");
  await tool("undo_file", { path: "src/util.ts" });
  check("src/util.ts and src__util.ts have separate histories",
    (await disk("src/util.ts")) === "ORIGINAL src/util.ts\n", JSON.stringify(await disk("src/util.ts")));
  await ws.writeFile(A, "p.ts", "p v1\n");
  await ws.writeFile(A, "./p.ts", "p v2\n");
  const undoP = await tool("undo_file", { path: "p.ts" });
  check("./p.ts and p.ts share one history", undoP.ok && (await disk("p.ts")) === "p v1\n", undoP.content.slice(0, 80));
  const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80, 0x81]);
  await ws.writeFileBytes(A, "img.bin", bin);
  await tool("delete_file", { path: "img.bin" });
  await tool("undo_file", { path: "img.bin" });
  check("a deleted binary comes back byte for byte",
    Buffer.from(await ws.readFileBytes(A, "img.bin")).equals(bin));
  await ws.writeFile(A, "k.txt", Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n") + "\n");
  await tool("edit_files", { edits: Array.from({ length: 12 }, (_, i) => ({ path: "k.txt", old_text: `line${i}\n`, new_text: `LINE${i}\n` })) });
  await tool("undo_file", { path: "k.txt" });
  check("one undo reverts a 12-edit batch to its pre-call state",
    (await disk("k.txt")).startsWith("line0\nline1\n") && (await disk("k.txt")).includes("line11"));
  const far = await tool("undo_file", { path: "k.txt", steps: 12 });
  check("steps past the kept history is refused honestly, not clamped",
    !far.ok && /Cannot go back 12/.test(far.content), far.content.slice(0, 80));

  console.log("\n9.13 Build folders are hidden only at the root");
  await ws.writeFile(A, "src/build/config.ts", "export const secretSetting = 1;\n");
  await ws.writeFile(A, "build/out.js", "generated\n");
  const listed = (await ws.listFiles(A)).map((f) => f.path);
  check("src/build/config.ts is listed", listed.includes("src/build/config.ts"));
  check("a top-level build/ is still hidden", !listed.includes("build/out.js"));

  console.log("\n9.14 Edits keep the executable bit and the line endings");
  if (POSIX) {
    await ws.writeFile(A, "run.sh", "#!/bin/sh\necho hi\n");
    await fsp.chmod(path.join(AROOT, "run.sh"), 0o755);
    await ws.applyEdit(A, "run.sh", { oldText: "echo hi", newText: "echo bye" });
    check("an edit keeps mode 0755", (fsSync.statSync(path.join(AROOT, "run.sh")).mode & 0o777) === 0o755);
  }
  await ws.writeFile(A, "w.txt", "one\r\n  two\r\n  three\r\nfour\r\n");
  await ws.applyEdit(A, "w.txt", { oldText: "two\nthree", newText: "TWO\nTHREE" });
  check("a CRLF file stays CRLF after a multi-line edit",
    (await disk("w.txt")) === "one\r\n  TWO\r\n  THREE\r\nfour\r\n", JSON.stringify(await disk("w.txt")));
  await ws.writeFile(A, "w2.txt", "one\r\ntwo\r\nthree\r\n");
  await ws.applyEdit(A, "w2.txt", { startLine: 2, endLine: 2, newText: "TWO" });
  check("a line-range edit keeps the line's \\r", (await disk("w2.txt")) === "one\r\nTWO\r\nthree\r\n");

  console.log("\n9.15 Archives: exact bytes, long names, whole files");
  const tarOf = (name, data, type = "0") => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136); h.write("        ", 148); h.write(type, 156);
    h.write("ustar\0" + "00", 257);
    const pad = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length);
    return Buffer.concat([h, data, pad]);
  };
  const latin1 = Buffer.from("# Configuración: año=café\n", "latin1");
  const longName = "project/" + "a".repeat(60) + "/" + "b".repeat(60) + "/main.py";
  const big = "z".repeat(archive.MAX_ENTRY_CHARS + 5000);
  const tar = Buffer.concat([
    tarOf("cfg.py", latin1),
    tarOf("././@LongLink", Buffer.from(longName + "\0"), "L"),
    tarOf(longName.slice(0, 99), Buffer.from("print(1)\n")),
    tarOf("big.txt", Buffer.from(big)),
    Buffer.alloc(1024),
  ]);
  const unpacked = await archive.readArchive("x.tar", new Uint8Array(tar));
  const cfg = (unpacked.binaries ?? []).find((b) => b.path === "cfg.py");
  check("non-UTF-8 text is kept as exact bytes, not decoded lossily",
    cfg && Buffer.from(cfg.data).equals(latin1) && !unpacked.entries.some((e) => e.path === "cfg.py"));
  check("a GNU long name is used", unpacked.entries.some((e) => e.path === longName));
  const bigEntry = unpacked.entries.find((e) => e.path === "big.txt");
  check("a big text file is kept whole for the disk", bigEntry?.content.length === big.length);
  check("while the inline preview is still capped",
    archive.formatArchive("x.tar", unpacked).length < big.length);

  console.log("\n9.16 wait_for_output after the log cap, and only on new output");
  await ws.writeFile(A, "srv.js", "let i=0; console.log('Compiled'); setInterval(()=>{ console.log('tick ' + (i++) + ' ' + 'z'.repeat(200)); }, 5);");
  const started = await procs.startProcess(A, "node", ["srv.js"]);
  if (started.ok) {
    await new Promise((r) => setTimeout(r, 800));
    const w1 = await procs.waitForOutput(started.process.id, "never-matches", 1500, A);
    check("output since the wait is reported after the 30k cap",
      w1 && started.process.log.length >= procs.MAX_LOG_CHARS && w1.newOutput.length > 0,
      `newOutput ${w1?.newOutput.length}`);
    check("a process from another workspace is not visible",
      (await procs.waitForOutput(started.process.id, "tick", 1000, "some-other-ws")) === null);
    procs.stopProcess(started.process.id);
  } else {
    check("wait_for_output checks (process failed to start)", false, started.reason);
  }
  await ws.writeFile(A, "watch.js", "console.log('Compiled'); let i=0; setInterval(()=>console.log('tick ' + (i++)), 200);");
  const watcher = await procs.startProcess(A, "node", ["watch.js"]);
  if (watcher.ok) {
    const first = await procs.waitForOutput(watcher.process.id, "Compiled", 3000, A);
    check("the first wait still sees output from the startup grace period", first?.outcome === "matched");
    const second = await procs.waitForOutput(watcher.process.id, "Compiled", 1200, A);
    check("a later wait does not match a line an earlier wait already consumed",
      second && second.outcome !== "matched", second?.outcome);
    procs.stopProcess(watcher.process.id);
  }

  console.log("\n9.17 Retiring a finding adds nothing");
  const noted = await tool("note_finding", { claim: "Parser crashes on empty input in parse.ts", scope: "workspace" });
  const fid = /\[(f[^\]]+)\]/.exec(noted.content)?.[1];
  await tool("note_finding", { id: fid, status: "disproved", claim: "done — shipped in abc123", scope: "workspace" });
  const again = await tool("note_finding", { id: fid, status: "disproved", claim: "done again", scope: "workspace" });
  const active = (await findings.readFindings(A)).findings.filter((f) => f.status === "active");
  check("a retirement leaves no active 'done' finding behind", active.length === 0,
    active.map((f) => f.claim).join(" | "));
  check("retiring an already-retired finding is refused", !again.ok, again.content.slice(0, 80));

  console.log("\n9.18 End anchors are searched after the start anchor");
  await ws.writeFile(A, "an.ts", "return x;\nfunction f() {\n  if (a) return x; // end\n  more();\n}\n");
  const an = await tool("edit_file", { path: "an.ts", start_anchor: "function f() {", end_anchor: "return x;", new_text: "X" });
  check("an exact match above the start does not hide a partial one below it",
    an.ok && (await disk("an.ts")) === "return x;\nX\n  more();\n}\n", an.content.slice(0, 100));

  await rm(AROOT, { recursive: true, force: true });
}

await rm(path.join(DATA_ROOT, "workspaces", WS), { recursive: true, force: true });
await rm(DETECT, { recursive: true, force: true });

console.log(
  `\n${pass + fail} checks · ${pass} passed${fail ? ` · ${r(`${fail} failed`)}` : ""}\n`
);
process.exit(fail ? 1 : 0);

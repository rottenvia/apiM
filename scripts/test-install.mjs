/**
 * Checks that the agent can install packages, and that they stay in the
 * workspace.
 *
 * Run:  npm run test:install
 *
 * `pip install` failed for two reasons that had nothing to do with the
 * allow-list, where pip has always been permitted. The spawned environment
 * was missing the variables Windows Python needs, and since PEP 668 the
 * system interpreter refuses to be written to at all. These assert the fix
 * and, just as importantly, that packages do not escape the workspace.
 *
 * The install test needs a network and is skipped without one.
 */
import path from "node:path";
import { PYTHON, havePython, finishSuite } from "./lib/proc.mjs";
import { pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";

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

const R = await load("src/lib/runner.ts");
const W = await load("src/lib/workspace.ts");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const y = (s) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0, skip = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};
const skipped = (label, why) => {
  console.log(`  ${y("SKIP")}  ${label}${d("  " + why)}`);
  skip++;
};

const WS = "installtest";
const wsDir = path.join(DATA_ROOT, "workspaces", WS);
await fs.rm(wsDir, { recursive: true, force: true });

console.log("\napiM package install checks\n");

// ------------------------------------------------------------ allow-list

console.log("1. Install tools are permitted");

for (const cmd of ["pip", "pip3", "npm", "python", PYTHON]) {
  check(`${cmd} is allowed`, R.isAllowedCommand(cmd));
}
check(
  "an install gets the long timeout, not the short one",
  R.timeoutFor("pip3", ["install", "requests"]) === R.MAX_INSTALL_MS,
  `${R.MAX_INSTALL_MS / 1000}s — a real install exceeds the ordinary limit`
);
check(
  "an ordinary command keeps the short timeout",
  R.timeoutFor(PYTHON, ["app.py"]) === R.MAX_RUN_MS,
  "so a runaway loop is still caught quickly"
);

// --------------------------------------------------------------- the venv

console.log("\n2. Python runs in a workspace virtualenv");

/*
 * Skipped, not failed, when there is no Python.
 *
 * This section genuinely needs an interpreter — it is about virtualenvs. On a
 * Windows machine without one, every check here failed with "Python was not
 * found; run without arguments to install from the Microsoft Store", which
 * says nothing about whether apiM works and trains you to skim red output.
 *
 * Windows also ships a stub named `python` that prints that advert and exits
 * non-zero, so merely finding the command is not enough — havePython() checks
 * it actually reports a version.
 */
const pythonAvailable = await havePython();
// Declared out here because later sections use it too.
let res;

if (!pythonAvailable) {
  skipped("python runs at all", `${PYTHON} is not installed on this machine`);
  skipped("a virtualenv was created inside the workspace", "needs python");
  skipped("python reports the workspace venv as its prefix", "needs python");
  skipped("pip is the venv's pip, not the system one", "needs python");
  skipped("the package imports on the very next run", "needs python");
  skipped("the interpreter is isolated from the system one", "needs python");
  skipped("API keys are not visible to anything the model runs", "needs python");
} else {

res = await R.runCommand(WS, PYTHON, ["-c", "print('ok')"]);
check("python runs at all", res.exitCode === 0, res.stderr.slice(0, 80));

const venvDir = path.join(wsDir, ".packages", "venv");
const hasVenv = await fs.access(venvDir).then(() => true).catch(() => false);
check(
  "a virtualenv was created inside the workspace",
  hasVenv,
  "since PEP 668 the system interpreter refuses pip entirely"
);

res = await R.runCommand(WS, PYTHON, ["-c", "import sys; print(sys.prefix)"]);
check(
  "python reports the workspace venv as its prefix",
  res.stdout.includes(".packages"),
  res.stdout.trim().slice(0, 90)
);

res = await R.runCommand(WS, "pip3", ["--version"]);
check(
  "pip is the venv's pip, not the system one",
  res.exitCode === 0 && res.stdout.includes(".packages"),
  res.stdout.trim().slice(0, 90)
);

} // end: python is available

// ------------------------------------------------------------- installing

console.log("\n3. Installing");

const online = pythonAvailable && await fetch("https://pypi.org/simple/", {
  method: "HEAD",
  signal: AbortSignal.timeout(4000),
}).then((r2) => r2.ok).catch(() => false);

if (!online) {
  skipped("pip install succeeds", "no network");
  skipped("the package imports on the next run", "no network");
} else {
  res = await R.runCommand(WS, "pip3", ["install", "requests"]);
  check(
    "pip install succeeds",
    res.exitCode === 0,
    res.exitCode === 0
      ? "no externally-managed-environment error"
      : (res.stderr || res.stdout).slice(-160)
  );

  await W.writeFile(WS, "use.py", "import requests\nprint(requests.__version__)\n");
  res = await R.runCommand(WS, PYTHON, ["use.py"]);
  check(
    "the package imports on the very next run",
    res.exitCode === 0,
    res.exitCode === 0
      ? res.stdout.trim()
      : (res.stderr || "").split("\n").pop()
  );
}

// ----------------------------------------------------- staying contained

console.log("\n4. Packages stay in the workspace");

const listed = (await W.listFiles(WS)).map((f) => f.path);
check(
  "installed packages never appear in the file tree",
  !listed.some((p) => p.includes(".packages")),
  listed.join(", ") || "(empty)"
);
check(
  "the user's own files still appear",
  listed.length === 0 || listed.some((p) => p.endsWith(".py"))
);

const onDisk = await fs.readdir(wsDir).catch(() => []);
if (pythonAvailable) {
  check(
    "the package directory sits inside the workspace",
    onDisk.includes(".packages"),
    "so deleting the workspace removes them"
  );
} else {
  // .packages only exists once a venv has been created, which needs python.
  skipped("the package directory sits inside the workspace", "needs python");
}

// The whole point: nothing landed on the user's machine.
if (pythonAvailable) {
  res = await R.runCommand(WS, PYTHON, [
    "-c",
    "import sys; print('SYSTEM' if sys.prefix == sys.base_prefix else 'ISOLATED')",
  ]);
  check(
    "the interpreter is isolated from the system one",
    res.stdout.includes("ISOLATED"),
    res.stdout.trim()
  );
}
/*
 * No `else skipped(...)` here: this check is already declared skipped in the
 * block at the top, alongside the rest of the python-dependent ones.
 *
 * Without the guard it ran anyway on a machine with no python, printing both
 * SKIP and FAIL for the same check name and inflating the totals. It was
 * counted twice — once as skipped, once as failed — which is how a suite can
 * report more checks than it has.
 */

// --------------------------------------------------------- still guarded

console.log("\n5. The guards still hold");

check("a shell is still refused", !R.isAllowedCommand("bash"));
check("cmd is still refused", !R.isAllowedCommand("cmd"));
check("powershell is still refused", !R.isAllowedCommand("powershell"));
// curl is allowed now — see test-web.mjs. Something never on the list:
check("an arbitrary binary is still refused", !R.isAllowedCommand("nmap"));

const bad = R.validateCommand("bash", ["-c", "echo hi"]);
check(
  "the refusal explains what to do instead",
  !bad.ok && /Run the interpreter directly/.test(bad.reason)
);

// Same guard, same reason: declared skipped at the top when there is no
// python, so running it here too would double-count it.
if (pythonAvailable) {
  res = await R.runCommand(WS, PYTHON, [
    "-c",
    "import os; print(os.environ.get('DEEPSEEK_API_KEY') or 'ABSENT')",
  ]);
  check(
    "API keys are not visible to anything the model runs",
    res.stdout.includes("ABSENT"),
    "the minimal environment is what makes running commands survivable"
  );
}

await fs.rm(wsDir, { recursive: true, force: true });

console.log(
  `\n${pass + fail + skip} checks · ${g(pass + " passed")}` +
    `${fail ? " · " + r(fail + " failed") : ""}` +
    `${skip ? " · " + y(skip + " skipped") : ""}\n`
);
await finishSuite(fail);

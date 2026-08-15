/**
 * A small, paste-safe summary of a test run.
 *
 * Run:  npm run report
 *
 * Why this exists: pasting raw terminal output into a chat box kept failing
 * with "something went wrong". Test output is full of things a web form
 * dislikes — ANSI colour escapes, box-drawing characters, the ✓ and ·
 * symbols, carriage returns from Windows, and several thousand lines of it.
 *
 * This runs the suite, throws away everything that passed, and prints only
 * what is wrong, as plain ASCII, usually in under thirty lines. It also
 * writes the same text to report.txt so the file can be attached instead of
 * pasted.
 *
 * Deliberately reports LESS than `npm test`. The full output is for reading
 * on your own machine; this is for sending to someone who cannot see it.
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { npmCommand } from "./lib/proc.mjs";
import os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Reduce text to something any input box will accept.
 *
 * Colour codes and box-drawing are the two things most likely to break a
 * paste; the rest is belt and braces. Anything outside printable ASCII
 * becomes a plain equivalent or is dropped, so what you send is what I see.
 */
function plain(text) {
  return (
    text
      // ANSI colour and cursor codes.
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
      // Windows line endings, which double up when pasted.
      .replace(/\r/g, "")
      // The symbols this project prints in summaries.
      .replace(/[·•]/g, "-")
      .replace(/[✓✔]/g, "ok")
      .replace(/[✕✖×]/g, "x")
      .replace(/[─━—–]/g, "-")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/…/g, "...")
      // Anything else non-ASCII: drop rather than risk it.
      .replace(/[^\x09\x0a\x20-\x7e]/g, "")
  );
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const invocation =
      cmd === "npm" ? npmCommand(ROOT, args) : { cmd, args, shell: false };
    const child = spawn(invocation.cmd, invocation.args, {
      cwd: ROOT,
      shell: invocation.shell,
      env: { ...process.env, NO_COLOR: "1" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ code: 1, out: String(e) }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const lines = [];
const say = (s = "") => {
  lines.push(s);
  console.log(s);
};

say("apiM report");
say("-----------");
say(`platform : ${os.platform()} ${os.release()}`);
say(`node     : ${process.version}`);

const rev = await run("git", ["rev-parse", "--short", "HEAD"]);
say(`commit   : ${plain(rev.out).trim() || "unknown"}`);
say("");

// --- the test suite ---------------------------------------------------------
say("Running the test suite. This takes a couple of minutes...");
say("");

const tests = await run("npm", ["test"]);
const text = plain(tests.out);

const summary = /(\d+) checks across (\d+) suites/.exec(text);
say(summary ? summary[0] : "no summary line found");

if (tests.code === 0) {
  say("RESULT: everything passed");
} else {
  say("RESULT: something failed");
  say("");

  /*
   * Suite names, not check names.
   *
   * The runner prints "  FAIL  plan   43 checks   3.2s" for a suite and
   * "  FAIL  <sentence>" for an individual check inside one. My first version
   * matched both and produced a nonsense list like
   * "plan, one-character, \"ok\", \"done\"" — the check names dressed up as
   * suites. The suite lines are the ones followed by a check count.
   */
  const failedSuites = [
    ...text.matchAll(/^\s*FAIL\s+(\S+)\s+(?:\d+ checks|no summary)/gm),
  ].map((m) => m[1]);
  if (failedSuites.length) {
    say(`failing suites: ${failedSuites.join(", ")}`);
    say("");
  }

  /*
   * The runner already prints a compact block per failing suite. Everything
   * from that heading onward is the useful part; the hundreds of PASS lines
   * above it are not.
   */
  /*
   * Match one suite as well as many.
   *
   * The runner pluralises: "3 suites failed:" but "1 suite failed:". This
   * searched for the literal "suites failed:", so when exactly one suite
   * failed the heading never matched and the whole detail block was dropped.
   *
   * That is precisely what a real Windows run produced — "failing suites:
   * refine" followed by nothing at all, so the report named the problem and
   * withheld the evidence, in the one case where there is least to print.
   * Found by re-reading this against the runner's output, not by a test:
   * the report has no suite of its own, which is its own gap.
   */
  const heading = /^\s*\d+ suites? failed:/m.exec(text);
  const at = heading ? heading.index : -1;
  if (at !== -1) {
    for (const line of text.slice(at).split("\n").slice(0, 80)) {
      if (line.trim()) say(line.replace(/\s+$/, ""));
    }
  }
}

// --- typecheck and lint -----------------------------------------------------
say("");
const tc = await run("npm", ["run", "typecheck"]);
say(`typecheck: ${tc.code === 0 ? "clean" : "FAILED"}`);
if (tc.code !== 0) {
  for (const line of plain(tc.out).split("\n").slice(-15)) {
    if (line.trim()) say(`  ${line.trim()}`);
  }
}

const lint = await run("npm", ["run", "lint"]);
say(`lint     : ${lint.code === 0 ? "clean" : "FAILED"}`);
if (lint.code !== 0) {
  // Lint can produce thousands of lines; the count and a sample is enough.
  const problems = /(\d+) problems? \((\d+) errors?/.exec(plain(lint.out));
  if (problems) say(`  ${problems[0]}`);
  for (const line of plain(lint.out).split("\n").filter((l) => /error/.test(l)).slice(0, 10)) {
    say(`  ${line.trim()}`);
  }
}

// --- optional extras --------------------------------------------------------
say("");
/*
 * Resolved here, not in a spawned node -e.
 *
 * The inline script was passed through cmd.exe on Windows (shell is needed
 * for npm), which ate the quotes and left node parsing
 * "import('playwright-core').then(()=" — a syntax error printed as the
 * browser status. Reported from a real Windows run.
 *
 * createRequire.resolve answers the same question in-process, with no shell
 * and nothing to quote.
 */
let browserStatus = "not installed";
try {
  const { createRequire } = await import("node:module");
  createRequire(path.join(ROOT, "package.json")).resolve("playwright-core");
  browserStatus = "installed";
} catch {
  browserStatus = "not installed (run: npm run browser:install)";
}
say(`browser  : ${browserStatus}`);

const out = lines.join("\n") + "\n";
const file = path.join(ROOT, "report.txt");
await writeFile(file, out, "utf8");

console.log("");
console.log(`Saved to ${file}`);
console.log("Attach that file, or copy the text above.");

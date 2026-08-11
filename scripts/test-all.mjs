/**
 * Run every test, with one command.
 *
 * Run:  npm test
 *
 * There were thirty-five separate test commands and no way to run them all.
 * That is a real gap: a suite you have to remember to invoke piece by piece
 * is a suite that gets partly run, and the parts nobody remembers are exactly
 * where regressions live. Several times this session I ran ten of them by
 * hand and missed the eleventh.
 *
 * Three things this has to get right, all learned by getting them wrong:
 *
 *   1. **Some tests start a real server.** Those cannot run at the same time
 *      as each other — they bind ports, and a second one arriving mid-startup
 *      fails in a way that looks like a broken app rather than a busy port.
 *      They are run one at a time, after everything else.
 *
 *   2. **One test costs real money.** `test:real` calls the actual DeepSeek
 *      API and asks for your key interactively. It is excluded unless you ask
 *      for it, because a command called "test" should never be able to spend
 *      anything.
 *
 *   3. **A crash is not a pass.** Counting only the summary line means a
 *      script that dies before printing one is silently skipped. Exit codes
 *      decide; the summary is only used for the count.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const IS_WINDOWS = process.platform === "win32";

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (c) => (s) => (COLOR ? `\x1b[${c}m${s}\x1b[0m` : s);
const bold = wrap(1);
const dim = wrap(2);
const green = wrap(32);
const red = wrap(31);
const yellow = wrap(33);

/**
 * Tests that start a Next dev server.
 *
 * They take 10-60 seconds each and cannot overlap, so they go last and go
 * alone. Running them first would make the fast feedback wait on the slow.
 */
const NEEDS_SERVER = new Set(["workspace", "auth", "plan"]);

/**
 * Excluded from `npm test`.
 *
 * `real` spends money on the live API and prompts for a key — a test command
 * must never be able to do either without being asked. `search` is a live
 * search check kept for hand-running.
 */
const OPT_IN = new Set(["real"]);

function runOne(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    /*
     * Each suite gets its own data directory.
     *
     * Six suites clear `data/` to start from a known state. That is correct
     * on its own and destructive in parallel — they delete each other's
     * fixtures mid-run, and the resulting failures look like real bugs in the
     * app. Building this runner is how that was found: nine suites failed
     * together and every one of them passed alone.
     *
     * The app reads the same variable, so the code under test and the test
     * agree on where the files are.
     */
    const dataRoot = path.join(ROOT, ".test-data", name);

    const child = spawn("npm", ["run", `test:${name}`], {
      cwd: ROOT,
      // npm is a .cmd shim on Windows and cannot be spawned without a shell.
      // The arguments here are constants from this file, not model output.
      shell: IS_WINDOWS,
      env: { ...process.env, NO_COLOR: "1", APIM_DATA_ROOT: dataRoot },
    });

    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));

    child.on("error", (err) =>
      resolve({ name, ok: false, checks: 0, ms: Date.now() - started, output: String(err) })
    );

    child.on("close", (code) => {
      // Both summary shapes in this repo: "42 checks · 42 passed" and
      // "All 42 checks passed."
      const a = /(\d+) checks · (\d+) passed/.exec(output);
      const b = /All (\d+) checks passed/.exec(output);
      const checks = a ? Number(a[2]) : b ? Number(b[1]) : 0;
      const failed = a ? Number(a[1]) - Number(a[2]) : 0;

      resolve({
        name,
        // The exit code is the authority. A script that crashed before
        // printing a summary must not be counted as passing.
        ok: code === 0 && failed === 0,
        checks,
        failed,
        ms: Date.now() - started,
        output,
      });
    });
  });
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const all = Object.keys(pkg.scripts)
    .filter((s) => s.startsWith("test:"))
    .map((s) => s.slice(5))
    .filter((n) => !OPT_IN.has(n));

  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const selected = only.length ? all.filter((n) => only.includes(n)) : all;

  const fast = selected.filter((n) => !NEEDS_SERVER.has(n));
  const serial = selected.filter((n) => NEEDS_SERVER.has(n));

  console.log(bold(`\napiM — running ${selected.length} test suites\n`));
  if (serial.length) {
    console.log(
      dim(
        `  ${fast.length} in parallel, then ${serial.length} that need a ` +
          `server (those are slower)\n`
      )
    );
  }

  // A previous run's directories would let a suite see stale fixtures and
  // "pass" for the wrong reason.
  await rm(path.join(ROOT, ".test-data"), { recursive: true, force: true });

  const results = [];
  const report = (r) => {
    const label = r.ok ? green("PASS") : red("FAIL");
    const count = r.checks ? dim(`${r.checks} checks`) : dim("no summary");
    const time = dim(`${(r.ms / 1000).toFixed(1)}s`);
    console.log(`  ${label}  ${r.name.padEnd(14)} ${count.padEnd(22)} ${time}`);
    results.push(r);
  };

  /*
   * Parallel, but bounded.
   *
   * These are mostly filesystem work in a shared data/ directory, and thirty
   * node processes at once on a laptop is slower than eight, not faster.
   */
  const CONCURRENCY = 6;
  const queue = [...fast];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      report(await runOne(next));
    }
  });
  await Promise.all(workers);

  for (const name of serial) {
    report(await runOne(name));
  }

  const failed = results.filter((r) => !r.ok);
  const totalChecks = results.reduce((a, b) => a + b.checks, 0);
  const totalMs = results.reduce((a, b) => a + b.ms, 0);

  console.log(
    bold(
      `\n  ${totalChecks} checks across ${results.length} suites` +
        `  ${dim(`(${(totalMs / 1000).toFixed(0)}s of work)`)}\n`
    )
  );

  if (failed.length === 0) {
    // Only on success: on failure the directories are the evidence.
    await rm(path.join(ROOT, ".test-data"), { recursive: true, force: true });
    console.log(green(`  Everything passed.\n`));
    console.log(
      dim(
        `  Not included: npm run test:real (calls the live API and costs a ` +
          `fraction of a cent).\n`
      )
    );
    return 0;
  }

  console.log(red(`  ${failed.length} suite${failed.length === 1 ? "" : "s"} failed:\n`));
  for (const r of failed) {
    console.log(yellow(`  ── ${r.name} ──`));
    // Only the failing lines and the summary: the full output of a large
    // suite would bury the one line that matters.
    const lines = r.output.split("\n");
    const interesting = lines.filter(
      (l) => /FAIL|Error|error:|✖|Cannot|not found/.test(l) && l.trim()
    );
    for (const line of interesting.slice(0, 12)) console.log(`    ${line.trim()}`);
    if (interesting.length === 0) {
      // Crashed without a recognisable failure line — show the tail instead
      // of nothing, which is the case where "no summary" appears above.
      for (const line of lines.slice(-8)) {
        if (line.trim()) console.log(`    ${line.trim()}`);
      }
    }
    console.log(dim(`    (run it alone: npm run test:${r.name})\n`));
  }
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

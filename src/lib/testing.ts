/**
 * Running the project's tests and reporting only what matters.
 *
 * ## Why a tool, when `run_command` can already run pytest
 *
 * Because of what comes back. A test run prints hundreds of lines — progress
 * dots, a coverage table, timing, and a stack trace for each failure. The
 * agent currently receives all of it as one wall of text, has to work out
 * which runner produced it, then find the failures inside it. That output is
 * then resent on every subsequent round for the rest of the task.
 *
 * Three costs, all avoidable:
 *
 *   1. **Tokens.** A 400-line pytest run is ~4k tokens. Ten rounds later it
 *      has been paid for ten times. The useful part is usually under 20 lines.
 *   2. **Attention.** The failure is buried, so the model sometimes fixes the
 *      wrong thing, or declares success because it saw "1 passed".
 *   3. **A wasted round.** It has to guess the command first. `pytest`?
 *      `npm test`? `cargo test`? Guessing wrong costs a round to find out.
 *
 * This detects the runner from what is actually in the workspace, runs it, and
 * returns a verdict plus only the failures.
 *
 * ## What it deliberately does not do
 *
 * It does not hide the raw output — that is available in full on request, and
 * a summariser that drops the one line you needed is worse than no
 * summariser. It just does not send it by default.
 */

import path from "node:path";
import { promises as fs } from "node:fs";

export interface TestRunner {
  /** Identifier, e.g. "pytest". */
  name: string;
  command: string;
  args: string[];
  /** Why this runner was picked, so a wrong guess is debuggable. */
  because: string;
}

/** One failing test, extracted from the runner's output. */
export interface TestFailure {
  name: string;
  /** The error line, or the assertion, with surrounding detail trimmed. */
  detail: string;
  /** File and line, when the runner reports them. */
  location?: string;
}

export interface TestSummary {
  runner: string;
  passed: number;
  failed: number;
  skipped: number;
  /** True when the runner exited zero AND nothing was reported failing. */
  ok: boolean;
  failures: TestFailure[];
  /** Set when the output could not be parsed, so nothing is silently lost. */
  unparsed?: boolean;
}

/**
 * Work out how this project runs its tests.
 *
 * Ordered by specificity: a JS project with a `test` script means that script
 * is the intended entry point, even if vitest is also installed, because the
 * script may set environment variables the bare binary would not.
 */
export async function detectRunner(
  workspaceDir: string
): Promise<TestRunner | null> {
  const exists = async (rel: string) => {
    try {
      await fs.access(path.join(workspaceDir, rel));
      return true;
    } catch {
      return false;
    }
  };

  // --- JavaScript / TypeScript --------------------------------------------
  if (await exists("package.json")) {
    try {
      const pkg = JSON.parse(
        await fs.readFile(path.join(workspaceDir, "package.json"), "utf8")
      ) as { scripts?: Record<string, string> };
      const script = pkg.scripts?.test;
      // The default `npm init` placeholder is not a test suite.
      if (script && !/no test specified/i.test(script)) {
        return {
          name: "npm test",
          command: "npm",
          args: ["test", "--silent"],
          because: 'package.json has a "test" script',
        };
      }
      if (pkg.scripts?.vitest || (await exists("vitest.config.ts"))) {
        return {
          name: "vitest",
          command: "npx",
          args: ["vitest", "run", "--reporter=verbose"],
          because: "a vitest config is present",
        };
      }
      if (await exists("jest.config.js")) {
        return {
          name: "jest",
          command: "npx",
          args: ["jest", "--ci"],
          because: "a jest config is present",
        };
      }
    } catch {
      /* an unreadable package.json is not fatal — fall through */
    }
  }

  // --- Python --------------------------------------------------------------
  for (const marker of ["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"]) {
    if (await exists(marker)) {
      return {
        name: "pytest",
        command: "pytest",
        args: ["-q", "--no-header", "-rN"],
        because: `${marker} is present`,
      };
    }
  }
  for (const dir of ["tests", "test"]) {
    if (await exists(dir)) {
      return {
        name: "pytest",
        command: "pytest",
        args: ["-q", "--no-header", "-rN", dir],
        because: `a ${dir}/ directory exists`,
      };
    }
  }

  // --- Others --------------------------------------------------------------
  if (await exists("Cargo.toml")) {
    return {
      name: "cargo test",
      command: "cargo",
      args: ["test"],
      because: "Cargo.toml is present",
    };
  }
  if (await exists("go.mod")) {
    return {
      name: "go test",
      command: "go",
      args: ["test", "./..."],
      because: "go.mod is present",
    };
  }

  return null;
}

/** Strip terminal colour codes, which otherwise break every pattern below. */
function clean(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Pull the verdict and the failures out of a runner's output.
 *
 * Every parser here is written against one runner's real format, and every
 * one falls back to `unparsed` rather than guessing. A summary that quietly
 * reports "0 failed" because it did not recognise the output would be the
 * worst possible failure mode for this tool — the agent would believe the
 * suite passed.
 */
export function parseTestOutput(
  runner: string,
  stdout: string,
  stderr: string,
  exitCode: number
): TestSummary {
  const text = clean(`${stdout}\n${stderr}`);
  const base: TestSummary = {
    runner,
    passed: 0,
    failed: 0,
    skipped: 0,
    ok: exitCode === 0,
    failures: [],
  };

  // --- pytest --------------------------------------------------------------
  // "5 passed, 2 failed, 1 skipped in 0.42s"
  const pyTotals = /(?:^|\n)=*\s*(?:(\d+) failed)?[,\s]*(?:(\d+) passed)?[,\s]*(?:(\d+) skipped)?[^\n]*in [\d.]+s/i.exec(
    text
  );
  if (pyTotals && (pyTotals[1] || pyTotals[2] || pyTotals[3])) {
    base.failed = Number(pyTotals[1] ?? 0);
    base.passed = Number(pyTotals[2] ?? 0);
    base.skipped = Number(pyTotals[3] ?? 0);
    base.ok = base.failed === 0 && exitCode === 0;

    // "FAILED tests/test_app.py::test_login - AssertionError: expected 200"
    for (const m of text.matchAll(/^FAILED\s+(\S+)\s*(?:-\s*(.*))?$/gm)) {
      base.failures.push({
        name: m[1],
        detail: (m[2] ?? "").trim() || "failed",
        location: m[1].split("::")[0],
      });
    }
    // Older pytest prints a header block instead of a FAILED line.
    if (base.failures.length === 0) {
      for (const m of text.matchAll(/^_+ (\S+) _+$/gm)) {
        base.failures.push({ name: m[1], detail: "see output" });
      }
    }
    return base;
  }

  // --- vitest / jest -------------------------------------------------------
  // "Tests  2 failed | 5 passed (7)"
  const vitest = /Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed/i.exec(text);
  const jest = /Tests:\s+(?:(\d+) failed,\s*)?(?:(\d+) skipped,\s*)?(\d+) passed/i.exec(
    text
  );
  if (vitest || jest) {
    if (vitest) {
      base.failed = Number(vitest[1] ?? 0);
      base.passed = Number(vitest[2] ?? 0);
    } else if (jest) {
      base.failed = Number(jest[1] ?? 0);
      base.skipped = Number(jest[2] ?? 0);
      base.passed = Number(jest[3] ?? 0);
    }
    base.ok = base.failed === 0 && exitCode === 0;

    for (const m of text.matchAll(/^\s*(?:FAIL|×|✕)\s+(.+)$/gm)) {
      const name = m[1].trim();
      if (name) base.failures.push({ name, detail: "failed" });
    }
    return base;
  }

  /*
   * --- node --test (TAP) ---------------------------------------------------
   *
   * Node's own test runner ships with Node, needs no install, and is what a
   * small project most often has. It was not recognised, so a green run came
   * back as "All 0 tests passed" — a true-sounding sentence with the count
   * silently wrong — and a red one fell through to the "not recognised" path,
   * which is honest but names no failures.
   *
   * Found by writing a real node --test fixture in the dispatch suite and
   * reading what came back, rather than by reading this file.
   *
   * Checked before Go because Go's detector is a loose /^(ok|FAIL|---)\s/,
   * and TAP's "ok 1 - name" lines match it.
   */
  const tapCounts = /^# pass (\d+)$/m.exec(text);
  if (tapCounts && /^# tests \d+$/m.test(text)) {
    base.passed = Number(tapCounts[1]);
    base.failed = Number((/^# fail (\d+)$/m.exec(text) ?? [])[1] ?? 0);
    base.skipped = Number((/^# skipped (\d+)$/m.exec(text) ?? [])[1] ?? 0);
    base.ok = base.failed === 0 && exitCode === 0;

    // "not ok 1 - the name" is TAP's failure line. The trailing " # SKIP"
    // marker means it was skipped, not failed, so those are left out.
    for (const m of text.matchAll(/^not ok \d+ - (.+)$/gm)) {
      const name = m[1].replace(/\s*#\s*(SKIP|TODO).*$/i, "").trim();
      if (name && base.failures.length < 20) {
        base.failures.push({ name, detail: "failed" });
      }
    }
    return base;
  }

  // --- cargo ---------------------------------------------------------------
  const cargo = /test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/.exec(
    text
  );
  if (cargo) {
    base.passed = Number(cargo[1]);
    base.failed = Number(cargo[2]);
    base.skipped = Number(cargo[3]);
    base.ok = base.failed === 0 && exitCode === 0;
    for (const m of text.matchAll(/^\s{4}(\S+)$/gm)) {
      if (base.failures.length < 20) {
        base.failures.push({ name: m[1], detail: "failed" });
      }
    }
    return base;
  }

  // --- go ------------------------------------------------------------------
  if (/^(ok|FAIL|---)\s/m.test(text)) {
    for (const m of text.matchAll(/^--- FAIL: (\S+)/gm)) {
      base.failures.push({ name: m[1], detail: "failed" });
    }
    base.failed = base.failures.length;
    base.passed = (text.match(/^--- PASS/gm) ?? []).length;
    base.ok = base.failed === 0 && exitCode === 0;
    return base;
  }

  // Recognised nothing. Say so rather than reporting a clean run.
  base.unparsed = true;
  base.ok = exitCode === 0;
  return base;
}

/**
 * Render the summary for the model.
 *
 * The whole point is that this is short. A passing run is one line; a failing
 * one is the failures and nothing else.
 */
export function formatTestSummary(
  summary: TestSummary,
  rawOutput: string
): string {
  if (summary.unparsed) {
    // Never claim a result that was not understood. The raw output is
    // included here precisely because the structured path failed.
    const tail = rawOutput.split("\n").slice(-40).join("\n");
    return (
      `Ran ${summary.runner}. The output format was not recognised, so here ` +
      `are the last 40 lines verbatim — read them rather than trusting a ` +
      `summary:\n\n${tail}`
    );
  }

  const counts =
    `${summary.passed} passed` +
    (summary.failed ? `, ${summary.failed} failed` : "") +
    (summary.skipped ? `, ${summary.skipped} skipped` : "");

  if (summary.ok) {
    return `${summary.runner}: ${counts}. Everything passed.`;
  }

  const lines = [`${summary.runner}: ${counts}.`, ""];
  if (summary.failures.length === 0) {
    lines.push(
      "The runner exited non-zero but named no failing test — this is " +
        "usually a collection error or a crash before the suite ran. Use " +
        "run_command to see the full output."
    );
  } else {
    lines.push("Failing:");
    for (const f of summary.failures.slice(0, 25)) {
      lines.push(`  ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    }
    if (summary.failures.length > 25) {
      lines.push(`  … and ${summary.failures.length - 25} more`);
    }
  }
  return lines.join("\n");
}

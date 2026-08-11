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
   * --- node --test ---------------------------------------------------------
   *
   * Node's own runner ships with Node and needs no install, so it is a likely
   * suite for a small project. It has TWO output formats and which one you
   * get depends on the Node version:
   *
   *   Node 22 and earlier, piped:  TAP        "# pass 1"
   *   Node 23 and later,   always: spec       "i pass 1"   (a real U+2139)
   *
   * Node 23 changed the non-TTY default from tap to spec to match TTY. So the
   * TAP parser I added worked on my Node 22 machine and did nothing on the
   * reported Node 24 run — "All 0 tests passed" for a green suite, and no
   * named failures for a red one.
   *
   * Both are matched here, by the counter lines they share, with the leading
   * marker left unanchored so the symbol never has to be spelled out. That
   * also survives --test-reporter being set explicitly either way.
   *
   * Checked before Go, whose detector is a loose /^(ok|FAIL|---)\s/ that TAP's
   * "ok 1 - name" lines would otherwise match first.
   */
  const nodeCount = (label: string): number | null => {
    // Leading marker is "# " (tap) or a symbol (spec); both then have the
    // label, whitespace and a number, and nothing else on the line.
    const m = new RegExp(`^\\s*\\S?\\s*${label}\\s+(\\d+)\\s*$`, "m").exec(text);
    return m ? Number(m[1]) : null;
  };

  const nodeTotal = nodeCount("tests");
  const nodePass = nodeCount("pass");
  const nodeFail = nodeCount("fail");
  if (nodeTotal !== null && nodePass !== null && nodeFail !== null) {
    base.passed = nodePass;
    base.failed = nodeFail;
    base.skipped = nodeCount("skipped") ?? 0;
    base.ok = base.failed === 0 && exitCode === 0;

    /*
     * Failure names, from whichever format produced them.
     *
     *   tap:   "not ok 1 - the name"
     *   spec:  a cross, then the name and a duration
     *
     * The spec pattern deliberately requires the trailing "(1.23ms)" so it
     * cannot match a stack-trace line that happens to start with a symbol.
     */
    for (const m of text.matchAll(/^not ok \d+ - (.+)$/gm)) {
      const name = m[1].replace(/\s*#\s*(SKIP|TODO).*$/i, "").trim();
      if (name && base.failures.length < 20) {
        base.failures.push({ name, detail: "failed" });
      }
    }
    if (base.failures.length === 0) {
      /*
       * De-duplicated, because spec prints each failure twice: once inline
       * as it happens, and again in the "failing tests:" block at the end.
       * Verified against real `node --test --test-reporter=spec` output — one
       * failing test came back as two identical entries, which would tell the
       * model it had two problems to fix instead of one.
       */
      const seen = new Set<string>();
      for (const m of text.matchAll(
        /^\s*[\u2716\u00d7x\u2717]\s+(.+?)\s+\([\d.]+m?s\)\s*$/gim
      )) {
        const name = m[1].trim();
        if (name && !seen.has(name) && base.failures.length < 20) {
          seen.add(name);
          base.failures.push({ name, detail: "failed" });
        }
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

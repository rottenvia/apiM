/**
 * Cross-platform process helpers.
 *
 * Windows has no process groups and no `lsof`, and `npx` is a .cmd shim that
 * Node cannot spawn without a shell. Everything here exists to paper over
 * those three differences so the scripts behave the same on Windows, macOS
 * and Linux.
 */
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const IS_WINDOWS = process.platform === "win32";

/**
 * Absolute path to Next's CLI entry point.
 *
 * Running it with `process.execPath` avoids `npx` entirely. On Windows `npx`
 * is `npx.cmd`, and spawning a .cmd without a shell fails with ENOENT; with a
 * shell it becomes a quoting minefield. Next ships a plain .js file, so we
 * just run that with the Node we are already using.
 */
export function nextBin(root) {
  const require = createRequire(path.join(root, "package.json"));
  return require.resolve("next/dist/bin/next");
}

/** Picks a port nothing is listening on, so runs can never collide. */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    // Port 0 asks the OS for any free port.
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Kills a process and everything it started.
 *
 * This matters more than it sounds: `next dev` spawns a separate server
 * process, and killing only the parent leaves that server holding the port.
 * A later run then fails to bind but the port still answers, so tests appear
 * to pass while talking to a stale build.
 */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (IS_WINDOWS) {
      // /T = whole tree, /F = force. Windows has no process groups.
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
    } else {
      // Negative pid targets the process group created by `detached: true`.
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Spawns a background process that can be killed cleanly on any platform. */
export function spawnTracked(cmd, args, opts = {}) {
  return spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    // Only Unix gets its own process group; on Windows `detached` would
    // instead pop open a new console window.
    detached: !IS_WINDOWS,
    ...opts,
  });
}

/** Waits until a URL answers, or gives up. */
export async function waitForServer(url, timeoutMs, isDead) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isDead?.()) return false;
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return false;
}

/**
 * The Python command that exists on this platform.
 *
 * Windows installs `python`; most Linux and macOS setups only expose
 * `python3`. `src/lib/runner.ts` has always picked correctly — the TESTS
 * hardcoded `python3`, so three suites failed on Windows with "Python was not
 * found" while the code they were testing was fine.
 *
 * A test that fails for a reason unrelated to the thing under test is worse
 * than no test: it trains you to skim red output.
 */
export const PYTHON = IS_WINDOWS ? "python" : "python3";

/** True when a Python interpreter is actually callable here. */
export async function havePython() {
  const { spawnSync } = await import("node:child_process");
  const res = spawnSync(PYTHON, ["--version"], {
    encoding: "utf8",
    shell: IS_WINDOWS,
  });
  // Windows ships a stub that prints a Microsoft Store advert and exits 9009.
  return res.status === 0 && /Python \d/.test(`${res.stdout}${res.stderr}`);
}

/**
 * Read a source file for assertions, with line endings normalised.
 *
 * Several suites check that the code contains a particular shape — that a
 * guard exists, that a tool is wired up. Those patterns are written with
 * "\n", and on Windows git checks the repository out with CRLF, so every
 * multi-line pattern silently fails to match.
 *
 * Reported from a real Windows run: one tools3 check failed for exactly this
 * reason while the code it was testing was correct. The assertion was about
 * behaviour, so the line endings should never have been part of it.
 *
 * Tabs are left alone; only the carriage returns go.
 */
export async function readSource(file) {
  const { readFile } = await import("node:fs/promises");
  return (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
}

/** Synchronous form, for suites that read at module scope. */
export function readSourceSync(file) {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/**
 * How to invoke npm without a shell.
 *
 * `spawn("npm", args, { shell: true })` works, but Node 24 now warns on every
 * call — "Passing args to a child process with shell option true can lead to
 * security vulnerabilities" — which is noise in the middle of a test report,
 * and the warning is fair: with a shell, arguments are concatenated rather
 * than escaped.
 *
 * npm ships as npm-cli.js, a plain JavaScript file. Running that with the
 * Node we are already using needs no shell, no .cmd shim, and no quoting.
 * The same trick nextBin() uses for Next.
 *
 * Falls back to the shell form if npm cannot be located, since a working
 * noisy command beats a silent broken one.
 */
export function npmCommand(root, args) {
  /*
   * npm tells us where it lives.
   *
   * `npm_execpath` is set by npm itself for every script it runs, and points
   * at npm-cli.js. Both callers here ARE npm scripts, so it is always
   * available — and it is exact, rather than a guess at where npm might be
   * installed, which varies wildly between nvm, Volta, Homebrew and the
   * Windows installer.
   */
  const cli = process.env.npm_execpath;
  if (cli && cli.endsWith(".js")) {
    return { cmd: process.execPath, args: [cli, ...args], shell: false };
  }
  // Run directly from a bare `node scripts/...` — fall back to the shell form.
  return { cmd: "npm", args, shell: IS_WINDOWS };
}

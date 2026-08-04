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

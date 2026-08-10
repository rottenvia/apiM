import { spawn, type ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import { promises as fs } from "node:fs";
import { workspaceDirectory } from "@/lib/workspace";
import { validateCommand, describeCommand } from "@/lib/runner";

/**
 * Long-running processes: dev servers, watchers, anything that never exits.
 *
 * runCommand waits for a process to finish, which is correct for a script and
 * useless for a server — the request would hang until the timeout and then
 * report failure for something working perfectly. These are started and left
 * running instead, with their output buffered so the model can read it later.
 *
 * Held in memory deliberately. A tracked process cannot outlive the server
 * that spawned it, so persisting the list would only produce stale entries
 * pointing at pids that no longer exist.
 */

export const MAX_LOG_CHARS = 30_000;
export const MAX_PROCESSES_PER_WORKSPACE = 4;
/** Long enough for a slow toolchain to bind a port, short enough to notice. */
export const STARTUP_GRACE_MS = 4_000;

export interface TrackedProcess {
  id: string;
  workspaceId: string;
  command: string;
  args: string[];
  display: string;
  pid: number | undefined;
  startedAt: number;
  /** Set once the process ends on its own or is stopped. */
  exitedAt: number | null;
  exitCode: number | null;
  stoppedByUser: boolean;
  log: string;
  truncated: boolean;
  child: ChildProcess;
}

const processes = new Map<string, TrackedProcess>();

let counter = 0;
function nextId(): string {
  counter += 1;
  return `proc-${counter}-${Date.now().toString(36)}`;
}

function append(proc: TrackedProcess, chunk: string): void {
  proc.log += chunk;
  if (proc.log.length > MAX_LOG_CHARS) {
    // Keep the tail: a server's useful output is the most recent error, not
    // the startup banner from ten minutes ago.
    proc.log = proc.log.slice(proc.log.length - MAX_LOG_CHARS);
    proc.truncated = true;
  }
}

export function isRunning(proc: TrackedProcess): boolean {
  return proc.exitedAt === null;
}

export function listProcesses(workspaceId: string): TrackedProcess[] {
  return [...processes.values()]
    .filter((p) => p.workspaceId === workspaceId)
    .sort((a, b) => a.startedAt - b.startedAt);
}

export function getProcess(id: string): TrackedProcess | undefined {
  return processes.get(id);
}

/**
 * Starts a process and returns once it has had a moment to fail.
 *
 * The grace period exists because a command that dies instantly — a syntax
 * error, a missing module, a port already in use — is the common case, and
 * reporting "started successfully" for something already dead would send the
 * model off building on a false premise.
 */
export async function startProcess(
  workspaceId: string,
  command: string,
  args: string[]
): Promise<
  | { ok: true; process: TrackedProcess; diedImmediately: boolean }
  | { ok: false; reason: string }
> {
  registerShutdownCleanup();
  pruneProcesses();

  const check = validateCommand(command, args, workspaceDirectory(workspaceId));
  if (!check.ok) return { ok: false, reason: check.reason };

  const running = listProcesses(workspaceId).filter(isRunning);
  if (running.length >= MAX_PROCESSES_PER_WORKSPACE) {
    return {
      ok: false,
      reason:
        `Already running ${running.length} background processes in this ` +
        `workspace, which is the limit. Stop one first: ` +
        running.map((p) => `${p.id} (${p.display})`).join(", "),
    };
  }

  const cwd = workspaceDirectory(workspaceId);
  await fs.mkdir(cwd, { recursive: true });

  let child: ChildProcess;
  try {
    // cross-spawn for the same reason as run_command: `npm run dev` is a
    // .cmd shim on Windows and a plain spawn cannot start it. See the long
    // note in lib/runner.ts.
    child = crossSpawn(check.command, check.args, {
      cwd,
      shell: false,
      windowsHide: true,
      // Own process group on Unix, so killing it also kills anything it
      // spawned — a dev server that forks a child would otherwise survive
      // and keep the port bound.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: cwd,
        TEMP: cwd,
        TMP: cwd,
        PYTHONUNBUFFERED: "1",
        NO_COLOR: "1",
        // Not CI=1 here: some dev servers refuse to start in watch mode when
        // they think they are on a build machine.
        FORCE_COLOR: "0",
      } as unknown as NodeJS.ProcessEnv,
    });
  } catch (err) {
    return {
      ok: false,
      reason: `Could not start ${check.command}: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
    };
  }

  const proc: TrackedProcess = {
    id: nextId(),
    workspaceId,
    command: check.command,
    args: check.args,
    display: describeCommand(check.command, check.args),
    pid: child.pid,
    startedAt: Date.now(),
    exitedAt: null,
    exitCode: null,
    stoppedByUser: false,
    log: "",
    truncated: false,
    child,
  };

  child.stdout?.on("data", (d) => append(proc, d.toString()));
  child.stderr?.on("data", (d) => append(proc, d.toString()));

  child.on("error", (err) => {
    append(proc, `\n[failed to start: ${err.message}]\n`);
    proc.exitedAt = Date.now();
  });

  child.on("close", (code) => {
    proc.exitedAt = Date.now();
    proc.exitCode = code;
  });

  processes.set(proc.id, proc);

  // Give it a moment, then report whether it is actually alive.
  await new Promise((r) => setTimeout(r, STARTUP_GRACE_MS));

  return { ok: true, process: proc, diedImmediately: !isRunning(proc) };
}

/** Stops a process and everything it started. */
export function stopProcess(id: string): boolean {
  const proc = processes.get(id);
  if (!proc) return false;
  if (!isRunning(proc)) return true;

  proc.stoppedByUser = true;

  try {
    if (process.platform === "win32") {
      // Windows has no process groups; taskkill /T covers the tree.
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        windowsHide: true,
      });
    } else if (proc.pid) {
      // Negative pid targets the group created by `detached`.
      process.kill(-proc.pid, "SIGKILL");
    }
  } catch {
    try {
      proc.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }

  return true;
}

export function stopAll(workspaceId: string): number {
  let stopped = 0;
  for (const proc of listProcesses(workspaceId)) {
    if (isRunning(proc)) {
      stopProcess(proc.id);
      stopped++;
    }
  }
  return stopped;
}

/**
 * Drops finished processes that nobody is going to read.
 *
 * Without this the map grows for the lifetime of the server. Exited entries
 * are kept briefly so the model can still read why something died.
 */
export function pruneProcesses(maxAgeMs = 10 * 60 * 1000): void {
  const now = Date.now();
  for (const [id, proc] of processes) {
    if (proc.exitedAt !== null && now - proc.exitedAt > maxAgeMs) {
      processes.delete(id);
    }
  }
}

/**
 * Stops everything on shutdown.
 *
 * A detached process survives the parent, so without this a dev server keeps
 * running after the app is closed — holding a port, invisible, with no way to
 * find it except Task Manager. Registered once, since the handlers are
 * process-wide and a dev server reloading modules would otherwise stack them.
 */
let shutdownHooked = false;

export function registerShutdownCleanup(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;

  const cleanup = () => {
    for (const proc of processes.values()) {
      if (isRunning(proc)) stopProcess(proc.id);
    }
  };

  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
}

/** Formats a process for the model. */
export function describeProcess(proc: TrackedProcess): string {
  const alive = isRunning(proc);
  const seconds = Math.round(
    ((proc.exitedAt ?? Date.now()) - proc.startedAt) / 1000
  );

  const status = alive
    ? `running (${seconds}s)`
    : proc.stoppedByUser
      ? "stopped"
      : `exited with code ${proc.exitCode ?? "unknown"} after ${seconds}s`;

  return `${proc.id}: ${proc.display} — ${status}`;
}

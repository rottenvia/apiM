import { spawn, type ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import { promises as fs } from "node:fs";
import { workspaceDirectory } from "@/lib/workspace";
import {
  validateCommand,
  describeCommand,
  platformCommandName,
} from "@/lib/runner";

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

/** Longest a single wait may block. A dev server that slow has a problem. */
export const MAX_WAIT_MS = 120_000;

export interface WaitResult {
  /** "matched" | "exited" | "timeout" */
  outcome: "matched" | "exited" | "timeout";
  /** Output produced since the wait began. */
  newOutput: string;
  /** The line that matched, when one did. */
  matchedLine?: string;
  waitedMs: number;
}

/**
 * Block until a process prints something, exits, or runs out of time.
 *
 * The gap this fills: after `start_process`, the agent has no way to know
 * when the thing is ready. Its options were to read the log immediately —
 * which is empty, because the server has not booted — or to guess a sleep.
 * Both are wrong in the same expensive way: a round spent finding out that
 * nothing has happened yet, then another guess, then another round.
 *
 * "Wait until it prints Ready" is what a person does, and it is exactly
 * expressible. One round, and it returns the moment the condition is met
 * rather than after a fixed delay.
 *
 * Exiting counts as an outcome, not an error. A process that dies during
 * startup will never print the pattern, and waiting the full timeout for
 * something already dead is the worst case this must avoid.
 */
export async function waitForOutput(
  id: string,
  pattern: string,
  timeoutMs: number
): Promise<WaitResult | null> {
  const proc = processes.get(id);
  if (!proc) return null;

  const limit = Math.min(Math.max(1000, timeoutMs), MAX_WAIT_MS);
  const started = Date.now();

  /*
   * Search the whole log, not just what arrives from now on.
   *
   * My first version recorded the log length at the start of the wait and
   * only matched text after it, reasoning that a stale banner should not
   * satisfy a fresh wait. Testing killed that: `start_process` deliberately
   * pauses for a startup grace period before returning, and a fast server
   * prints "Ready" during it. So by the time the agent could possibly call
   * this, the line it is waiting for was already in the buffer — and the wait
   * ran to its full timeout while the answer sat there.
   *
   * That is the common case, not an edge case: the faster the process, the
   * more reliably it broke.
   *
   * Matching the whole log makes an already-satisfied wait return instantly,
   * which is correct — "wait until it says Ready" is satisfied by it having
   * already said Ready. The output reported back is still only what is new,
   * so the model is not re-shown text it has seen.
   */
  const from = proc.log.length;

  let regex: RegExp | null = null;
  if (pattern) {
    try {
      regex = new RegExp(pattern, "i");
    } catch {
      // A pattern that will not compile is treated as literal text, which is
      // almost always what was meant — "Ready in 1.2s" contains no valid
      // regex intent but does contain characters that break one.
      regex = null;
    }
  }

  const matches = (text: string): string | null => {
    if (!pattern) return null;
    for (const line of text.split("\n")) {
      if (regex ? regex.test(line) : line.toLowerCase().includes(pattern.toLowerCase())) {
        return line.trim();
      }
    }
    return null;
  };

  // Polling rather than hooking the stream: `append` is called from several
  // places and a listener would have to be unregistered on every exit path.
  // 100ms is imperceptible next to a process start and costs nothing.
  for (;;) {
    const sinceStart = proc.log.slice(from);
    // Matched against everything the process has said; reported as only what
    // is new. See the note above on why the whole log has to be searched.
    const hit = matches(proc.log);
    if (hit) {
      return {
        outcome: "matched",
        newOutput: sinceStart,
        matchedLine: hit,
        waitedMs: Date.now() - started,
      };
    }
    if (!isRunning(proc)) {
      return {
        outcome: "exited",
        newOutput: sinceStart,
        waitedMs: Date.now() - started,
      };
    }
    if (Date.now() - started >= limit) {
      return {
        outcome: "timeout",
        newOutput: sinceStart,
        waitedMs: Date.now() - started,
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
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
    // Resolve platform aliases through the SAME function as run_command.
    // On Windows `python3` is commonly the Microsoft Store shim while the
    // installed interpreter is `python`; running tools disagreed because only
    // run_command applied this mapping.
    const executable = platformCommandName(check.command);

    // cross-spawn for the same reason as run_command: `npm run dev` is a
    // .cmd shim on Windows and a plain spawn cannot start it. See the long
    // note in lib/runner.ts.
    child = crossSpawn(executable, check.args, {
      cwd,
      shell: false,
      windowsHide: true,
      // Own process group on Unix, so killing it also kills anything it
      // spawned — a dev server that forks a child would otherwise survive
      // and keep the port bound.
      detached: process.platform !== "win32",
      /*
       * stdin is a pipe, not "ignore".
       *
       * It was closed, so a process that asks a question was unanswerable —
       * the agent could watch a prompt appear and had no way to reply. That
       * covers a lot of ordinary work: `npm init`, a migration asking to
       * confirm, a REPL, anything with a "continue? [y/N]".
       *
       * Worse than being unable to answer, a closed stdin makes some tools
       * read EOF and abort with a confusing error rather than prompting, so
       * the failure did not even look like a missing feature.
       */
      stdio: ["pipe", "pipe", "pipe"],
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
/**
 * Send a line to a running process's stdin.
 *
 * The missing half of `read_process`: the agent could watch a program ask a
 * question and had no way to answer it. `npm init`, a migration confirming a
 * destructive step, a REPL, anything with "continue? [y/N]" — all of it was
 * a dead end that looked like the process had hung.
 *
 * A newline is appended unless one is already there, because a program
 * waiting on readline gets nothing until the line is terminated, and
 * forgetting that produces exactly the same silent hang the feature is meant
 * to fix.
 *
 * Returns a reason rather than throwing: this runs inside the agent loop and
 * a thrown error there abandons the round.
 */
export function writeToProcess(
  id: string,
  input: string
): { ok: boolean; reason?: string } {
  const proc = processes.get(id);
  if (!proc) return { ok: false, reason: "No such process." };
  /*
   * Both flags, because `exitedAt` lags.
   *
   * It is set on the child's 'exit' event, which arrives a tick or two after
   * the kill. stopProcess() sets `stoppedByUser` synchronously, so for a
   * short window after stopping, isRunning() still says true — and a write
   * in that window reported success while going nowhere.
   *
   * Caught by a test that stopped a process and immediately wrote to it,
   * which is exactly what an agent does when it decides mid-answer to send
   * one more line.
   */
  if (!isRunning(proc) || proc.stoppedByUser) {
    return {
      ok: false,
      reason: proc.stoppedByUser
        ? "That process was stopped."
        : `That process already exited (code ${proc.exitCode ?? "unknown"}).`,
    };
  }
  const stdin = proc.child.stdin;
  if (!stdin || stdin.destroyed) {
    return { ok: false, reason: "That process is not accepting input." };
  }

  const line = input.endsWith("\n") ? input : `${input}\n`;
  try {
    stdin.write(line);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Could not write to it.",
    };
  }

  /*
   * Echoed into the log, marked as ours.
   *
   * Terminals show what you typed; a pipe does not. Without this the
   * transcript reads as a question followed by an unexplained answer, and
   * neither the agent nor the user can tell what was actually sent.
   */
  append(proc, `\n> ${line}`);
  return { ok: true };
}

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

import { spawn } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { workspaceDirectory } from "@/lib/workspace";

/**
 * Runs a command the model asked for.
 *
 * Without a container the protection is layered: only known interpreters can
 * be launched, never a shell; the working directory is the workspace; and
 * everything is wall-clock limited. The user approving each command is the
 * outermost layer and the one that actually matters — these checks exist so a
 * mistake is survivable, not so approval can be skipped.
 */

export const MAX_RUN_MS = 30_000;
/** Truncate output so one runaway loop can't fill the context window. */
export const MAX_OUTPUT_CHARS = 20_000;

export class RunError extends Error {}

export interface RunResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
}

/**
 * Programs the model may launch.
 *
 * An allow-list, not a block-list: enumerating dangerous commands is a losing
 * game, since anything that can spawn a process can reach the rest. Notably
 * absent are `sh`, `bash`, `cmd` and `powershell` — a shell would make every
 * other check here pointless.
 */
const ALLOWED = new Set([
  "python",
  "python3",
  "node",
  "npm",
  "npx",
  "pip",
  "pip3",
  "tsc",
  "go",
  "cargo",
  "rustc",
  "java",
  "javac",
  "ruby",
  "php",
  "dotnet",
  "pytest",
  "jest",
  "vitest",
]);

/** Rejected outright: these exist to run arbitrary shell text. */
const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
]);

export function isAllowedCommand(command: string): boolean {
  return ALLOWED.has(normaliseCommand(command));
}

export function allowedCommands(): string[] {
  return [...ALLOWED].sort();
}

/** Strips any path and a Windows .exe, so `/usr/bin/python3` is `python3`. */
function normaliseCommand(command: string): string {
  const base = path.basename(String(command).trim().toLowerCase());
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

/**
 * Checks a command before it is shown to the user for approval.
 *
 * Returns a reason rather than throwing, so the model can be told what was
 * wrong and try something else.
 */
export function validateCommand(
  command: unknown,
  args: unknown
): { ok: true; command: string; args: string[] } | { ok: false; reason: string } {
  if (typeof command !== "string" || !command.trim()) {
    return { ok: false, reason: "A command is required." };
  }

  const name = normaliseCommand(command);

  if (SHELLS.has(name)) {
    return {
      ok: false,
      reason:
        "Shells are not available. Run the interpreter directly, e.g. " +
        '`python app.py` rather than `sh -c "python app.py"`.',
    };
  }

  if (!ALLOWED.has(name)) {
    return {
      ok: false,
      reason:
        `"${name}" is not an allowed command. Allowed: ` +
        `${allowedCommands().join(", ")}.`,
    };
  }

  if (args !== undefined && !Array.isArray(args)) {
    return {
      ok: false,
      reason: "args must be a list of strings, not a single string.",
    };
  }

  const list = (args ?? []) as unknown[];
  const clean: string[] = [];

  for (const arg of list) {
    if (typeof arg !== "string") {
      return { ok: false, reason: "Every argument must be a string." };
    }
    // A NUL byte can truncate a path inside a C library, so a name that looks
    // safe here becomes a different one by the time the OS sees it.
    if (arg.includes("\0")) {
      return { ok: false, reason: "Arguments must not contain NUL bytes." };
    }
    clean.push(arg);
  }

  return { ok: true, command: name, args: clean };
}

/** A single line summarising what will run, for the approval prompt. */
export function describeCommand(command: string, args: string[]): string {
  const quoted = args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a));
  return [command, ...quoted].join(" ");
}

function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  return {
    // Keep the end: errors and stack traces are almost always last.
    text: text.slice(text.length - MAX_OUTPUT_CHARS),
    truncated: true,
  };
}

/**
 * Actually runs it.
 *
 * `shell: false` is the important line — arguments are handed to the OS as a
 * list, so `; rm -rf ~` is a literal argument rather than a second command.
 */
export async function runCommand(
  workspaceId: string,
  command: string,
  args: string[],
  signal?: AbortSignal
): Promise<RunResult> {
  const check = validateCommand(command, args);
  if (!check.ok) throw new RunError(check.reason);

  const cwd = workspaceDirectory(workspaceId);
  await fs.mkdir(cwd, { recursive: true });

  const started = Date.now();

  return new Promise<RunResult>((resolve) => {
    // The env is cast because Next augments ProcessEnv with required keys,
    // and passing a deliberately minimal environment is the point here.
    const child = spawn(check.command, check.args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        // A deliberately small environment. Passing the real one leaks API
        // keys and tokens into any process the model runs.
        PATH: process.env.PATH ?? "",
        HOME: cwd,
        TEMP: cwd,
        TMP: cwd,
        // Unbuffered, or a crashing script's output never arrives.
        PYTHONUNBUFFERED: "1",
        NO_COLOR: "1",
        CI: "1",
      } as unknown as NodeJS.ProcessEnv,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);

      const out = clip(stdout);
      const err = clip(stderr);
      resolve({
        command: check.command,
        args: check.args,
        stdout: out.text,
        stderr: err.text,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        truncated: out.truncated || err.truncated,
      });
    };

    const kill = () => {
      try {
        // Negative pid would target a process group, but detached isn't set
        // here; SIGKILL on the child is enough for an interpreter.
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      // Resolve even if the process ignores the signal, so an unkillable
      // child can't leave the request hanging forever.
      setTimeout(() => finish(null), 500);
    }, MAX_RUN_MS);

    const onAbort = () => {
      kill();
      finish(null);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (d) => {
      // Cap in memory too: clipping only at the end would still let a runaway
      // loop consume gigabytes first.
      if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += d.toString();
      else if (!timedOut) kill();
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += d.toString();
    });

    child.on("error", (err) => {
      stderr += `\nFailed to start ${check.command}: ${err.message}`;
      finish(null);
    });

    child.on("close", (code) => finish(code));
  });
}

/** Formats a result for the model. */
export function formatRunResult(result: RunResult): string {
  const parts: string[] = [];

  parts.push(`$ ${describeCommand(result.command, result.args)}`);

  if (result.timedOut) {
    parts.push(
      `\nTimed out after ${Math.round(MAX_RUN_MS / 1000)}s and was stopped. ` +
        `If this was an interactive program or a server, it will never finish ` +
        `on its own — run something that exits.`
    );
  }

  if (result.stdout.trim()) parts.push(`\nOutput:\n${result.stdout.trim()}`);
  if (result.stderr.trim()) parts.push(`\nErrors:\n${result.stderr.trim()}`);

  if (!result.stdout.trim() && !result.stderr.trim() && !result.timedOut) {
    parts.push("\n(no output)");
  }

  if (!result.timedOut) {
    parts.push(
      `\nExit code: ${result.exitCode ?? "unknown"}` +
        (result.exitCode === 0 ? " (success)" : " (failed)")
    );
  }

  if (result.truncated) {
    parts.push("\n(output was long; only the end is shown)");
  }

  return parts.join("\n");
}

import { spawn } from "node:child_process";
import crossSpawn from "cross-spawn";
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

/**
 * Wall-clock limit per command.
 *
 * 30s was too short for real work: `npm install` and `pip install` on
 * anything substantial exceed it, and the model reads the kill as a failure
 * and starts "fixing" code that was never broken. Installs get longer since
 * they are the common slow case; everything else stays tight so a runaway
 * loop is caught quickly.
 */
export const MAX_RUN_MS = 60_000;
export const MAX_INSTALL_MS = 300_000;

/** Package managers, where a slow run is normal rather than a hang. */
const SLOW_COMMANDS = new Set(["npm", "npx", "pip", "pip3", "cargo", "go", "dotnet"]);

export function timeoutFor(command: string, args: string[]): number {
  if (!SLOW_COMMANDS.has(command)) return MAX_RUN_MS;
  const installing = args.some((a) =>
    ["install", "i", "add", "ci", "get", "restore", "build", "mod"].includes(a)
  );
  return installing ? MAX_INSTALL_MS : MAX_RUN_MS;
}
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
  // Everyday tooling that was missing, so the model hit a wall on ordinary
  // requests. Each of these runs a defined job and takes its input as
  // arguments; none of them is a way to execute arbitrary text, which is the
  // line this list draws.
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "tsx",
  "eslint",
  "prettier",
  "vite",
  "next",
  "git",
  "make",
  "gcc",
  "g++",
  "uv",
  "poetry",
  "ruff",
  "black",
  "mypy",
  /*
   * Network and inspection tools.
   *
   * curl and wget were missing, which meant the agent had no way to reach
   * anything outside the workspace even for a trivial check. They take their
   * target as an argument and cannot execute arbitrary text, so they belong
   * on the same footing as the rest of this list.
   *
   * `which` and `where` are here because the model kept reaching for them to
   * diagnose its own failures and being told the command was not allowed,
   * which made a tooling problem look like a permissions one.
   */
  "curl",
  "wget",
  "which",
  "where",
  "git",
  "unzip",
  "tar",
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
  /*
   * A path and a Windows extension both reduce to the bare tool name.
   *
   * Only `.exe` was stripped, so when the model worked around a failing
   * `npm install` by naming the file directly — `npm.cmd`, or the full
   * `C:\\Program Files\\nodejs\\npm.cmd` — the allow-list saw a name it did
   * not recognise and answered "Command not allowed". That reads as a
   * permissions decision about npm, which was never the case: npm is on the
   * list. The check simply did not know that `npm.cmd` is npm.
   *
   * The basename is taken first, so a directory cannot smuggle anything in:
   * "C:/evil/npm.cmd" still resolves to "npm", and the launcher is then
   * looked up on PATH rather than run from wherever the model pointed.
   */
  const base = path.basename(
    String(command).trim().toLowerCase().replace(/\\/g, "/")
  );
  for (const ext of [".exe", ".cmd", ".bat", ".com", ".ps1"]) {
    if (base.endsWith(ext)) return base.slice(0, -ext.length);
  }
  return base;
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
 * Where packages go.
 *
 * Installing into the system interpreter would put the model's dependencies
 * on the user's machine permanently, which is exactly what "it only touches
 * the workspace" is supposed to rule out. Pointing the tool caches inside the
 * workspace keeps an install local to the project that asked for it, so
 * deleting the workspace really does undo it.
 */
export const PACKAGE_DIR = ".packages";

/**
 * The environment a spawned command sees.
 *
 * Deliberately small — passing the real environment would hand every API key
 * in .env to anything the model runs. But it was previously *too* small:
 * HOME, TEMP and TMP all pointed at the workspace while the variables Windows
 * actually uses were absent, so pip could not find a cache, a config, or a
 * writable temp directory, and Python could not load its socket and TLS DLLs
 * without SYSTEMROOT. `pip install` failed for environment reasons that had
 * nothing to do with the allow-list.
 */
function baseEnv(cwd: string): NodeJS.ProcessEnv {
  const local = path.join(cwd, ...[PACKAGE_DIR]);

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: cwd,
    TEMP: cwd,
    TMP: cwd,

    // Unbuffered, or a crashing script's output never arrives.
    PYTHONUNBUFFERED: "1",
    NO_COLOR: "1",
    CI: "1",

    // Install into the workspace rather than the system interpreter, and put
    // them on the import path so the very next `python` run can use them.
    PYTHONUSERBASE: local,
    PYTHONPATH: local,
    PIP_CACHE_DIR: path.join(local, "pip-cache"),
    // Nothing here is a shell, so pip's "you should add this to PATH" notice
    // is noise the model would otherwise try to act on.
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_WARN_SCRIPT_LOCATION: "1",

    // npm equivalents, so `npm install -g` is contained too.
    npm_config_cache: path.join(local, "npm-cache"),
    npm_config_prefix: local,
  };

  // Windows needs these or Python cannot load the DLLs behind socket and ssl,
  // which is a network failure that looks like PyPI being unreachable.
  for (const key of [
    "SYSTEMROOT",
    "SystemRoot",
    "windir",
    "COMSPEC",
    "PATHEXT",
    "SYSTEMDRIVE",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }

  // Deliberately still absent: APPDATA, USERPROFILE and LOCALAPPDATA. Those
  // point at the real user profile, and the whole aim is that an install
  // lands in the workspace instead. PYTHONUSERBASE covers what pip needs.
  return env as unknown as NodeJS.ProcessEnv;
}

/**
 * The base environment, plus the workspace venv when one applies.
 *
 * Putting the venv's bin directory first on PATH and setting VIRTUAL_ENV is
 * exactly what `activate` does, so pip installs into it and the next python
 * run imports from it without the model needing to know it exists.
 */
function childEnv(cwd: string, venvPath: string | null): NodeJS.ProcessEnv {
  const env = baseEnv(cwd);
  if (!venvPath) return env;

  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...env,
    VIRTUAL_ENV: path.dirname(venvPath),
    PATH: `${venvPath}${sep}${env.PATH ?? ""}`,
    // PYTHONPATH pointing at the user-base would shadow the venv's own
    // site-packages and reintroduce the split it exists to avoid.
    PYTHONPATH: undefined,
    PYTHONUSERBASE: undefined,
  } as unknown as NodeJS.ProcessEnv;
}

/**
 * Why this uses cross-spawn rather than node's spawn directly.
 *
 * On Windows npm, npx, tsx, eslint and most JS tooling are `.cmd` shims, not
 * executables. Two separate things go wrong with a plain spawn:
 *
 *   - `spawn("npm", ...)` fails with ENOENT, because there is no file called
 *     exactly "npm" — the extension is required.
 *   - `spawn("npm.cmd", ...)` fails with EINVAL, because since
 *     CVE-2024-27980 node refuses to launch a batch file unless `shell` is
 *     enabled. The vulnerability was that arguments passed to a `.cmd` are
 *     re-parsed by cmd.exe, so a crafted argument could inject a second
 *     command; node's mitigation was to refuse outright.
 *
 * Resolving the path to `npm.cmd` fixes the first and walks straight into the
 * second, which is what happened here: the error changed from "not found" to
 * EINVAL.
 *
 * `shell: true` is the fix everyone reaches for and it is the wrong one for
 * this app. It re-enables exactly the injection the CVE describes, and every
 * argument this runner handles comes from a language model — the one source
 * you would least want feeding unescaped text to a shell. Node 24 also emits
 * a deprecation warning for it.
 *
 * cross-spawn does what the mitigation intends: it detects a `.cmd`, invokes
 * it as `cmd.exe /c`, and escapes the arguments itself so cmd.exe cannot
 * reinterpret them. On Unix it is a thin pass-through to spawn. It is the
 * approach node's own advisory points at and what most cross-platform CLIs
 * use.
 */

/** Interpreters whose packages belong in the workspace venv. */
const PYTHON_COMMANDS = new Set(["python", "python3", "pip", "pip3", "pytest"]);

/**
 * Platform-specific location of the venv's executables.
 *
 * The path segments are joined from an array rather than passed as literals
 * because Turbopack resolves a literal `path.join` at build time, records the
 * directory as a dependency, and walks it. A virtualenv holds an absolute
 * symlink to the system interpreter, which it reads as escaping the project
 * root and panics on — so a build would fail purely because a package had
 * been installed.
 */
function venvDir(cwd: string): string {
  return path.join(cwd, ...[PACKAGE_DIR, "venv"]);
}

function venvBin(cwd: string): string {
  return path.join(
    venvDir(cwd),
    ...[process.platform === "win32" ? "Scripts" : "bin"]
  );
}

/**
 * Ensure a virtualenv exists for this workspace, and return its bin directory.
 *
 * Since PEP 668, Debian, Ubuntu, Fedora and Homebrew Python all refuse a
 * plain `pip install` with "externally-managed-environment" — they will not
 * let anything write into the interpreter the OS depends on. The usual
 * workaround, --break-system-packages, does exactly what its name says and
 * installs system-wide, which is the opposite of keeping the agent inside the
 * workspace.
 *
 * A venv in the workspace solves both at once: pip is satisfied, and the
 * packages live in a folder that disappears with the workspace. Created on
 * first use rather than up front, so a workspace that never installs anything
 * never pays for it.
 *
 * Returns null when a venv cannot be made, in which case the command runs
 * against the system interpreter exactly as before.
 */
async function ensureVenv(cwd: string): Promise<string | null> {
  const bin = venvBin(cwd);
  const marker = path.join(
    bin,
    ...[process.platform === "win32" ? "python.exe" : "python"]
  );

  try {
    await fs.access(marker);
    return bin;
  } catch {
    /* not created yet */
  }

  const created = await new Promise<boolean>((resolve) => {
    const child = spawn(
      process.platform === "win32" ? "python" : "python3",
      ["-m", "venv", venvDir(cwd)],
      {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: "ignore",
        env: baseEnv(cwd),
      }
    );
    // Creating a venv copies the interpreter, so allow more than a trivial
    // command but far less than an install.
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 120_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });

  if (!created) return null;
  try {
    await fs.access(marker);
    return bin;
  } catch {
    return null;
  }
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

  // Python work runs inside a workspace-local virtualenv. Created on first
  // use; if it cannot be created we fall through to the system interpreter
  // rather than failing the command outright.
  const venvPath = PYTHON_COMMANDS.has(check.command)
    ? await ensureVenv(cwd)
    : null;

  // Spawn the venv's own executable. Relying on PATH alone is not enough on
  // Windows, where a bare "python" can still resolve elsewhere.
  const executable = venvPath
    ? path.join(
        venvPath,
        ...[process.platform === "win32" ? `${check.command}.exe` : check.command]
      )
    : check.command;
  // The venv's own executable when it has one, otherwise the bare name —
  // cross-spawn resolves it, including the .cmd shims on Windows.
  const resolved = venvPath
    ? await fs
        .access(executable)
        .then(() => executable)
        .catch(() => check.command)
    : check.command;

  const started = Date.now();

  return new Promise<RunResult>((resolve) => {
    // The env is cast because Next augments ProcessEnv with required keys,
    // and passing a deliberately minimal environment is the point here.
    // shell stays false: cross-spawn handles .cmd by invoking cmd.exe itself
    // with escaped arguments, which is the safe form of what `shell: true`
    // would do unsafely.
    const child = crossSpawn(resolved, check.args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv(cwd, venvPath),
    });

    const limitMs = timeoutFor(check.command, check.args);

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
    }, limitMs);

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
      `\nTimed out after ${Math.round(
        timeoutFor(result.command, result.args) / 1000
      )}s and was stopped. ` +
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

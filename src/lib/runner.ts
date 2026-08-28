import { spawn } from "node:child_process";
import crossSpawn from "cross-spawn";
import path from "node:path";
import { promises as fs, statSync } from "node:fs";
import { workspaceDirectory } from "@/lib/workspace";
import { checkBrowserPolicy } from "@/lib/browser-policy";

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

/**
 * Package managers and build tools, where a slow run is normal, not a hang.
 *
 * The list was missing every JS package manager except npm, so `pnpm install`
 * on a real project was killed at 60 seconds and reported as a timeout —
 * indistinguishable, to the model, from a command that had genuinely hung. It
 * would then retry, and be killed again.
 */
const SLOW_COMMANDS = new Set([
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "cargo",
  "go",
  "dotnet",
  "make",
  "gcc",
  "g++",
  "tsc",
  "next",
  "vite",
]);

/** Subcommands that mean "this will take a while". */
const SLOW_SUBCOMMANDS = new Set([
  "install",
  "i",
  "add",
  "ci",
  "get",
  "restore",
  "build",
  "mod",
  "sync",
  "update",
  "compile",
  "bundle",
]);

/**
 * How long a command may run.
 *
 * `override` lets the model ask for longer when it knows the job is slow —
 * capped, because the point of a timeout is that a genuinely hung process is
 * eventually reclaimed. The default stays deliberately short: a command that
 * has produced nothing in a minute is usually waiting for input that will
 * never come, and that is the case worth failing fast on.
 */
export function timeoutFor(
  command: string,
  args: string[],
  override?: number | null
): number {
  const base = SLOW_COMMANDS.has(command)
    ? args.some((a) => SLOW_SUBCOMMANDS.has(a))
      ? MAX_INSTALL_MS
      : MAX_RUN_MS
    : MAX_RUN_MS;

  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.min(Math.max(5_000, Math.trunc(override)), MAX_INSTALL_MS);
  }
  return base;
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
  /** Set when the program could not be spawned at all (missing binary, etc). */
  error?: string;
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
  "cmake",
  "msbuild",
  "cl",
  "clang",
  "clang++",
  "clang-cl",
  "gcc",
  "g++",
  "csc",
  "vbc",
  "link",
  "rc",
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
  // Read-only inspection tools the model uses to diagnose its own work.
  // They take their target as an argument; shells stay blocked.
  "grep",
  "rg",
  "find",
  "diff",
  "cat",
  "wc",
  "head",
  "tail",
  "ls",
  "echo",
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

/**
 * Commands that only look at things.
 *
 * The approval prompt is the single biggest obstacle to the agent working
 * unattended: every command stops the run and waits for a click, including
 * the ones that cannot possibly do harm. `node --version` and `git status`
 * are not decisions a user needs to make.
 *
 * The line drawn here is deliberately narrow: a command qualifies only if it
 * both (a) appears below and (b) uses a subcommand or flag from the read-only
 * list. `git status` is safe; `git push` is not, and it is the same binary,
 * so the check has to look at the arguments rather than the program.
 *
 * Anything that writes a file, installs a package, runs project code, or
 * touches the network still asks. This is not "trust the agent" — it is
 * "do not ask permission to read a version number".
 */
const READ_ONLY_COMMANDS = new Map<string, Set<string>>([
  // Subcommand-based tools: only these subcommands are read-only.
  ["git", new Set(["status", "log", "diff", "show", "branch", "remote", "ls-files", "rev-parse", "describe", "blame"])],
  ["npm", new Set(["ls", "list", "view", "outdated", "why", "root", "prefix"])],
  ["pnpm", new Set(["ls", "list", "why", "outdated"])],
  ["pip", new Set(["list", "show", "freeze"])],
  ["pip3", new Set(["list", "show", "freeze"])],
  ["go", new Set(["version", "env", "list"])],
  ["cargo", new Set(["--version", "tree"])],
]);

/** Flags that mean "print information and exit", whatever the program. */
const INFO_FLAGS = new Set(["--version", "-v", "--help", "-h", "version"]);

/** Programs whose entire job is to report, never to change anything. */
const ALWAYS_READ_ONLY = new Set(["which", "where"]);

/**
 * Can this command run without asking?
 *
 * Conservative by construction: an unrecognised shape is never safe, so a new
 * command added to the allow-list does not silently become approval-free.
 */
export function isReadOnlyCommand(command: string, args: string[]): boolean {
  const name = normaliseCommand(command);

  /*
   * Anything shell-shaped goes to the prompt, whatever the command.
   *
   * There is no shell, so `which "node;rm -rf /"` cannot do harm — it just
   * fails to find a program with a silly name. But an argument containing
   * shell metacharacters means the model believes there IS a shell, and that
   * belief is worth showing the user rather than quietly executing. Checked
   * first so it applies to every path below, including the ones that would
   * otherwise return true immediately.
   */
  if (args.some((a) => /[>|;&$`\n]/.test(a))) return false;

  if (ALWAYS_READ_ONLY.has(name)) return true;

  // `node --version`, `python3 --version`, and similar.
  if (args.length === 1 && INFO_FLAGS.has(args[0])) return true;
  if (args.length === 0) {
    // A bare interpreter opens an interactive prompt that will hang until the
    // timeout. Not dangerous, but not useful either — let it ask.
    return false;
  }

  const subcommands = READ_ONLY_COMMANDS.get(name);
  if (!subcommands) return false;

  // The first non-flag argument is the subcommand.
  const sub = args.find((a) => !a.startsWith("-")) ?? args[0];
  if (!subcommands.has(sub)) return false;

  /*
   * Even a read-only subcommand can be made to write, or to read elsewhere.
   *
   * Found by attacking this function rather than by reading it:
   *
   *   git --work-tree=/etc status   reports on a directory outside the
   *                                 workspace entirely
   *   git -C /etc status            same, via a different flag
   *   which "node;rm -rf /"         harmless here because there is no shell,
   *                                 but an argument containing shell
   *                                 metacharacters means the model believes
   *                                 there is one, and that belief is worth
   *                                 surfacing to the user rather than
   *                                 silently running
   *
   * The rule is therefore: no argument may redirect, pipe, name an output
   * file, or point the command at a different directory. Anything unusual
   * falls through to the approval prompt, which is the safe default — the
   * cost of being wrong here is a command that runs without being seen.
   */
  const suspicious = /[>|;&$`\n]/;
  const relocates = /^(-C|--work-tree|--git-dir|--prefix|--cwd|--directory)$/;

  for (const [i, a] of args.entries()) {
    if (suspicious.test(a)) return false;
    if (/^--(output|out|file|log-file)=/.test(a)) return false;
    if (relocates.test(a)) return false;
    // The `--flag=value` form of the same thing.
    if (/^--(work-tree|git-dir|prefix|cwd|directory)=/.test(a)) return false;
    // A bare `-C` style flag takes its value as the next argument; both are
    // caught, but this keeps the intent explicit.
    if (i > 0 && relocates.test(args[i - 1])) return false;
  }

  return true;
}

/**
 * Programs the agent BUILT, which the allow-list used to refuse.
 *
 * The reported wall: the agent compiles `injector/x64/Release/nightfall.exe`
 * and then cannot launch the thing it just produced, because the allow-list
 * matches on program NAME and no list can contain a binary that did not exist
 * an hour ago. It reads as a permissions decision about nightfall; it was
 * really "I have never heard of this name".
 *
 * The rule here is about LOCATION instead of name, and it is the same rule the
 * rest of this app already enforces on every file operation: a path that
 * resolves inside the workspace is the agent's own output and may run; a path
 * anywhere else on the machine is not. Nothing outside the workspace becomes
 * runnable, `..` cannot climb out, and a bare name like `nightfall.exe` with
 * no directory is NOT accepted from PATH — it must resolve to a real file
 * inside the workspace, which is precisely the set of things the agent made.
 *
 * Approval is unchanged. A workspace binary is arbitrary native code, so it
 * goes to the same prompt as everything else; this only decides whether the
 * user is allowed to be ASKED.
 */
export function workspaceExecutable(
  command: string,
  workspaceDir: string
): string | null {
  const raw = String(command ?? "").trim();
  if (!raw || raw.includes("\0")) return null;
  if (!workspaceDir || workspaceDir === ".") return null;

  // A bare word is a PATH lookup, not a workspace file. `nightfall.exe` on its
  // own would resolve against the workspace anyway, so it is allowed only when
  // the file really is there — the existence check below is what decides.
  const normalised = raw.replace(/\\/g, "/");

  const root = path.resolve(workspaceDir);
  const target = path.resolve(root, normalised);

  // Containment, the same check every file tool uses: inside the root, and not
  // the root itself.
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;

  try {
    if (!statSync(target).isFile()) return null;
  } catch {
    return null;
  }

  /*
   * On Windows the extension IS the executability bit, so it has to be one of
   * the real ones. Notably absent: .ps1, .cmd and .bat — those are scripts
   * interpreted by a shell, and letting one through would reintroduce the
   * arbitrary-shell-text hole that the SHELLS list exists to close.
   */
  if (process.platform === "win32") {
    return /\.(exe|com)$/i.test(target) ? target : null;
  }

  try {
    // POSIX: the executable bit, for the same reason.
    // eslint-disable-next-line no-bitwise
    return (statSync(target).mode & 0o111) !== 0 ? target : null;
  } catch {
    return null;
  }
}

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
  args: unknown,
  /**
   * Where the agent's own browser profile belongs. Only needed for the
   * browser policy; omitted callers get the check with a workspace-relative
   * default, which is still correct — it only affects the suggested path in
   * the message.
   */
  workspaceDir = "."
): {
  ok: true;
  command: string;
  args: string[];
  /** Set when the policy adjusted the arguments; shown to the user. */
  note?: string;
} | { ok: false; reason: string } {
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

  // A binary the agent built in this workspace runs under its full path.
  const own = workspaceExecutable(command, workspaceDir);

  if (!own && !ALLOWED.has(name)) {
    return {
      ok: false,
      reason:
        `"${name}" is not an allowed command. Allowed: ` +
        `${allowedCommands().join(", ")}. A program you built yourself can ` +
        `be run by its path inside the workspace, e.g. ` +
        `"build/app.exe" — the file has to exist there first.`,
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

  /*
   * The agent's browser must not be the user's browser.
   *
   * Checked here rather than at each call site so every path — run_command,
   * start_process and the runner itself — is covered by one rule. See
   * lib/browser-policy.ts for why this exists: an agent task closed the
   * user's running browser and drove their logged-in profile.
   */
  if (own) {
    // The resolved absolute path, never the model's spelling of it, so a
    // relative path cannot be re-resolved against a different cwd later.
    return { ok: true, command: own, args: clean };
  }

  const policy = checkBrowserPolicy(name, clean, workspaceDir);
  if (policy.action === "refuse") {
    return { ok: false, reason: policy.reason ?? "Refused by browser policy." };
  }
  if (policy.action === "rewrite") {
    return {
      ok: true,
      command: name,
      args: policy.args,
      note: policy.reason,
    };
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

/**
 * The name an interpreter actually has on this platform.
 *
 * A Unix virtualenv's bin/ holds `python`, `python3` and `python3.13`. A
 * Windows venv's Scripts/ holds `python.exe` and `pythonw.exe` — and no
 * `python3.exe` at all. Windows itself is the same: the installer provides
 * `python`, and the bare name `python3` usually hits the Microsoft Store stub
 * that prints an advert and exits non-zero.
 *
 * Models write `python3` because that is the name that works on Linux and
 * macOS, and it is the name in most documentation. On Windows that meant two
 * failures at once: the venv executable was not found, so the command fell
 * back to the system interpreter — silently leaving the workspace virtualenv,
 * which is the isolation the venv exists to provide — and then the system
 * `python3` was a stub, so it failed anyway.
 *
 * Reported from a real run: the model wrote fizzbuzz.py, then called
 * `python3 fizzbuzz.py` to check its own work.
 *
 * Only python3 is remapped. Windows venvs do create pip3.exe, so pip and
 * pip3 both resolve correctly and are left alone.
 */
export function platformCommandName(
  command: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== "win32") return command;
  return command === "python3" ? "python" : command;
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
  signal?: AbortSignal,
  /** Override the default time limit, in ms. Capped at MAX_INSTALL_MS. */
  timeoutMs?: number | null
): Promise<RunResult> {
  const check = validateCommand(command, args, workspaceDirectory(workspaceId));
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
  const localName = platformCommandName(check.command);
  const executable = venvPath
    ? path.join(
        venvPath,
        ...[process.platform === "win32" ? `${localName}.exe` : localName]
      )
    : localName;
  // The venv's own executable when it has one, otherwise the bare name —
  // cross-spawn resolves it, including the .cmd shims on Windows.
  const resolved = venvPath
    ? await fs
        .access(executable)
        .then(() => executable)
        .catch(() => localName)
    : localName;

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

    const limitMs = timeoutFor(check.command, check.args, timeoutMs);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let spawnError: string | undefined;

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
        error: spawnError,
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
      spawnError = err.message;
      stderr += `\nFailed to start ${check.command}: ${err.message}`;
      finish(null);
    });

    child.on("close", (code) => finish(code));
  });
}

/** Formats a result for the model. */
export function formatRunResult(result: RunResult): string {
  const parts: string[] = [];

  // Status FIRST, so the model sees whether the command ran at all before the
  // (often long) output. Distinguishes: could-not-start vs ran-and-failed vs
  // succeeded.
  const cmd = describeCommand(result.command, result.args);
  parts.push(`$ ${cmd}`);

  if (result.error) {
    parts.push(`\nSTATUS: could not run - ${result.error}`);
  } else if (result.timedOut) {
    parts.push(
      `\nSTATUS: timed out and was stopped after the time limit. ` +
        `If this is a server/watcher use start_process; if it waits for ` +
        `input add a non-interactive flag (-y/--yes/--no-input); if it is ` +
        `genuinely slow pass a larger timeout_ms.`
    );
  } else if (result.exitCode === 0) {
    parts.push(`\nSTATUS: ok (exit 0)`);
  } else {
    parts.push(
      `\nSTATUS: failed (exit ${result.exitCode ?? "unknown"}). ` +
        `Read Errors/Output below, fix the actual cause, then re-run. ` +
        `Do not retry the identical command.`
    );
  }

  if (result.stderr.trim()) parts.push(`\nErrors:\n${result.stderr.trim()}`);
  if (result.stdout.trim()) parts.push(`\nOutput:\n${result.stdout.trim()}`);

  if (!result.stdout.trim() && !result.stderr.trim() && !result.timedOut && !result.error) {
    parts.push("\n(no output)");
  }

  if (result.truncated) parts.push("\n(output was long; only the end is shown)");

  return parts.join("\n");
}
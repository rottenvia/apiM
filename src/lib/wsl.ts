/**
 * Running the agent's work inside WSL2 — a private Linux on the user's own
 * Windows PC that they never have to look at.
 *
 * The request, in the user's words: "run app and agent smartly being able to
 * do everything it needs" on their machine, "so I wouldn't see it, even if I
 * were playing," and pointing at a concrete gap — a VM-level obfuscator their
 * own tooling could not recover because there was nowhere to actually RUN the
 * sample and watch it. WSL2 is that somewhere:
 *
 *   - It is a real Linux kernel, built into Windows 10/11 including Home, with
 *     no Docker in the way (the user has had "a lot of problems" with Docker).
 *   - Work inside it never draws on the user's desktop and never takes focus,
 *     so a build, a headless browser, a GUI under Xvfb, or a sample being
 *     traced all run out of sight while the user does something else.
 *   - It sees the workspace through /mnt, so the agent operates on the real
 *     files rather than a copy.
 *
 * This file is the bridge. It is Windows-side code — the app process runs on
 * Windows and shells out to `wsl.exe` — so most of it cannot execute on the
 * Linux box this repo is developed on. What it CAN do anywhere is the pure
 * logic every wrong invocation has come from: translating a Windows path to
 * its /mnt form, parsing `wsl.exe` status output (which is UTF-16 with stray
 * NULs), and assembling the exact argv. Those are unit-tested; the live
 * probes degrade honestly when `wsl.exe` is absent.
 *
 * What this is NOT: a way around command approval. The sandbox wraps an inner
 * command, and that inner command is validated and approved exactly as if it
 * ran on the host. The wrapper only changes WHERE it runs, never WHETHER the
 * user said yes.
 */

import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

/** Distro as `wsl -l -v` reports it. */
export interface WslDistro {
  name: string;
  state: string;
  version: number;
  isDefault: boolean;
}

export interface WslStatus {
  /** wsl.exe answered at all — the feature is installed. */
  installed: boolean;
  /** Distros that can run work. Empty means "installed, but no Linux yet". */
  distros: WslDistro[];
  /** The default distro's name, or null when none is set. */
  defaultDistro: string | null;
  /** Why it is unusable, when it is. Always actionable. */
  reason?: string;
}

/**
 * `wsl.exe` prints UTF-16LE, and Node's spawnSync hands us those bytes as a
 * latin1-ish string full of NULs unless we decode. Rather than guess the
 * encoding at every call site, strip the NULs here: every field we read is
 * ASCII, so dropping the high zero byte of each UTF-16 unit is lossless for
 * our purposes and turns the output into something the parsers below can read.
 */
export function decodeWslOutput(raw: Buffer | string): string {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "binary");
  // A BOM (FF FE) is the reliable tell for UTF-16LE.
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le").replace(/\ufeff/g, "");
  }
  // No BOM but every other byte is NUL → still UTF-16LE in practice.
  let nulEvens = 0;
  const sample = Math.min(buf.length, 64);
  for (let i = 1; i < sample; i += 2) if (buf[i] === 0) nulEvens += 1;
  if (sample > 4 && nulEvens > sample / 4) {
    return buf.toString("utf16le").replace(/\ufeff/g, "");
  }
  return buf.toString("utf8");
}

/**
 * Parse the table from `wsl.exe --list --verbose`.
 *
 * The format, once decoded:
 *
 *     NAME            STATE           VERSION
 *   * Ubuntu          Running         2
 *     Debian          Stopped         2
 *
 * The leading "*" marks the default. Header words are localised on non-English
 * Windows, so we do NOT match them by text — we skip the first non-empty line
 * and read every row positionally, which holds in any locale.
 */
export function parseWslDistros(output: string): WslDistro[] {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.replace(/\u0000/g, "").trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];

  const rows: WslDistro[] = [];
  for (const line of lines.slice(1)) {
    const isDefault = /^\s*\*/.test(line);
    const cols = line.replace(/^\s*\*/, "").trim().split(/\s{1,}/);
    if (cols.length < 3) continue;
    // Version is the last column, state the one before, name is everything
    // before that (a distro name can legally contain a space).
    const version = Number(cols[cols.length - 1]);
    const state = cols[cols.length - 2];
    const name = cols.slice(0, cols.length - 2).join(" ");
    if (!name || !Number.isFinite(version)) continue;
    rows.push({ name, state, version, isDefault });
  }
  return rows;
}

/**
 * Turn a Windows absolute path into the /mnt/<drive> path WSL sees.
 *
 * Computed here rather than by shelling to `wslpath` because it is
 * deterministic, testable, and one fewer process per launch. Handles:
 *   C:\Users\me\ws      → /mnt/c/Users/me/ws
 *   D:/data             → /mnt/d/data
 *   \\wsl$\Ubuntu\home  → left as-is inside the distro (already a Linux view)
 *   /already/posix      → returned unchanged
 * A path already under /mnt or starting with / is assumed to be WSL-side.
 */
export function winPathToWsl(winPath: string): string {
  const p = String(winPath ?? "").trim();
  if (!p) return "";
  // Already a POSIX path (we are being handed a WSL-side path).
  if (p.startsWith("/")) return p;
  // UNC path into a distro — hand it back; it is already the Linux view.
  const unc = /^\\\\wsl(?:\$|\.localhost)\\[^\\]+(\\.*)?$/i.exec(p);
  if (unc) return (unc[1] ?? "").replace(/\\/g, "/") || "/";
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (drive) {
    const rest = drive[2].replace(/\\/g, "/");
    return `/mnt/${drive[1].toLowerCase()}/${rest}`.replace(/\/+$/g, "");
  }
  // A bare relative path — leave the separators Linux-shaped and let --cd
  // resolve it against the sandbox cwd.
  return p.replace(/\\/g, "/");
}

/**
 * Shell-quote a single token for the Linux side of the pipe.
 *
 * We invoke `wsl.exe -- <argv>` which does NOT go through a Windows shell, but
 * when we need to prefix `env VAR=val` or start Xvfb we build a small POSIX
 * command line, and those tokens must survive bash. Single-quote and escape
 * embedded quotes; that is the whole rule.
 */
export function shQuote(token: string): string {
  const s = String(token ?? "");
  if (s === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface WslInvocation {
  /** Always "wsl.exe". */
  command: string;
  args: string[];
}

/**
 * Build the exact `wsl.exe` argv that runs `command args...` inside a distro.
 *
 * Shape:
 *   wsl.exe -d <distro> -u <user> --cd <cwd> --exec env K=V ... <command> <args...>
 *
 * `--exec`, not `--`: after `--` WSL joins the rest into one line and hands it
 * to the Linux login shell, which splits it again, so a script argument with
 * spaces arrives in pieces. `--exec` runs the program directly with each
 * argument intact. Env goes through the Linux `env` helper for the same
 * reason: every K=V is its own argument.
 */
export function buildWslInvocation(opts: {
  distro?: string | null;
  user?: string | null;
  cwdWsl?: string | null;
  env?: Record<string, string>;
  command: string;
  args: string[];
}): WslInvocation {
  const args: string[] = [];
  if (opts.distro) args.push("-d", opts.distro);
  if (opts.user) args.push("-u", opts.user);
  if (opts.cwdWsl) args.push("--cd", opts.cwdWsl);
  args.push("--exec");
  const envPairs = Object.entries(opts.env ?? {}).filter(([, v]) => v != null);
  if (envPairs.length) {
    args.push("env");
    for (const [k, v] of envPairs) args.push(`${k}=${v}`);
  }
  args.push(opts.command, ...opts.args);
  return { command: "wsl.exe", args };
}

/** The sandbox's own distro. Never the user's everyday Linux. */
export const SANDBOX_DISTRO = "apim-sandbox";

/**
 * The official Ubuntu 24.04 WSL image and its published checksum list. The
 * download is verified against SHA256SUMS before anything is imported.
 */
export const ROOTFS_BASE =
  "https://cloud-images.ubuntu.com/wsl/releases/24.04/current";
export const ROOTFS_FILE = "ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz";

/** Find the expected hash for `file` in a SHA256SUMS listing. */
export function expectedSha256(sums: string, file: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && m[2].trim() === file) return m[1].toLowerCase();
  }
  return null;
}

/** `wsl.exe --import` argv for the sandbox distro. */
export function importArgs(
  installDir: string,
  tarball: string,
  version: 1 | 2 = 2
): string[] {
  return ["--import", SANDBOX_DISTRO, installDir, tarball, "--version", String(version)];
}

/**
 * /etc/wsl.conf for the sandbox: the distro does not auto-mount every Windows
 * drive and cannot launch Windows programs. The workspace is mounted on its
 * own, per chat, so the sandbox sees the project it works on and nothing else.
 */
export function sandboxWslConf(): string {
  return [
    "[automount]",
    "enabled = false",
    "mountFsTab = false",
    "",
    "[interop]",
    "enabled = false",
    "appendWindowsPath = false",
    "",
    "[user]",
    "default = root",
    "",
  ].join("\n");
}

/** Packages installed once, at setup. The agent can add more later, approved. */
export const SANDBOX_PACKAGES = [
  "xvfb", "x11-utils", "xdotool", "imagemagick",
  "python3", "python3-pip", "python3-venv",
  "nodejs", "npm",
  "build-essential", "git", "curl", "file", "unzip",
  "gdb", "strace",
];

/**
 * The one-time setup inside the sandbox distro, run as root (the distro's
 * only user), so there is no sudo password to hang on.
 */
export function wslSetupScript(): string {
  return [
    "set -e",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update",
    `apt-get install -y --no-install-recommends ${SANDBOX_PACKAGES.join(" ")}`,
    "mkdir -p /ws",
    'echo "apim-wsl-setup-ok"',
  ].join("\n");
}

/**
 * Where a workspace appears inside the sandbox. One directory per chat, named
 * by its id, so two chats never share files.
 */
export function sandboxMountPoint(workspaceId: string): string {
  return `/ws/${workspaceId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * Bash that mounts one Windows folder (drvfs) at `mountPoint` if it is not
 * mounted yet, then runs the rest of the command there. Every token is quoted.
 */
export function mountAndRunScript(
  winDir: string,
  mountPoint: string,
  inner: string
): string {
  return [
    `mkdir -p ${shQuote(mountPoint)}`,
    `mountpoint -q ${shQuote(mountPoint)} || mount -t drvfs ${shQuote(winDir)} ${shQuote(mountPoint)}`,
    `cd ${shQuote(mountPoint)}`,
    inner,
  ].join(" && ");
}

/** A free X display number, chosen the same way the Linux surface does. */
export function pickDisplay(used: number[] = []): string {
  const taken = new Set(used);
  for (let n = 99; n < 130; n += 1) if (!taken.has(n)) return `:${n}`;
  return ":129";
}

/**
 * Command line that brings up Xvfb on `display` inside the distro, in the
 * background, and returns once. Idempotent: a second call with the same
 * display is harmless because Xvfb refuses a busy display and we ignore that.
 */
export function xvfbLaunchArgs(display: string): string[] {
  // `-nolisten tcp` keeps it a local, in-memory server; 1600x1000x24 matches
  // the host Linux surface so screenshots look the same on both.
  return [display, "-screen", "0", "1600x1000x24", "-nolisten", "tcp"];
}

/** ImageMagick `import` argv that grabs the whole off-screen root into a PNG. */
export function captureArgs(display: string, outPathWsl: string): string[] {
  return ["-display", display, "-window", "root", outPathWsl];
}

// ---------------------------------------------------------------------------
// Live probes. These only mean anything on Windows; elsewhere they report
// "not available" without pretending otherwise.
// ---------------------------------------------------------------------------

/** Is this even a Windows host where wsl.exe could exist? */
export function wslPlatformPossible(): boolean {
  return process.platform === "win32";
}

/**
 * Ask the OS what WSL it has. Never throws — a missing wsl.exe, a disabled
 * feature, or a machine that is not Windows all resolve to installed:false
 * with a reason the UI can show.
 */
export function probeWsl(): WslStatus {
  if (!wslPlatformPossible()) {
    return {
      installed: false,
      distros: [],
      defaultDistro: null,
      reason:
        "The app is not running on Windows, so there is no wsl.exe. The WSL " +
        "sandbox is a Windows-only feature.",
    };
  }
  let probe;
  try {
    probe = spawnSync("wsl.exe", ["--list", "--verbose"], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1 << 20,
    });
  } catch {
    return {
      installed: false,
      distros: [],
      defaultDistro: null,
      reason: "Could not run wsl.exe. Install WSL with: wsl --install",
    };
  }
  if (probe.error || probe.status === null) {
    return {
      installed: false,
      distros: [],
      defaultDistro: null,
      reason:
        "wsl.exe is not available. Install it from an elevated PowerShell " +
        "with: wsl --install (one restart needed).",
    };
  }
  const text = decodeWslOutput(
    (probe.stdout as Buffer) ?? Buffer.from(probe.stdout ?? "")
  );
  const distros = parseWslDistros(text);
  /*
   * `wsl -l -v` exits non-zero when there are no distros at all, which is fine
   * for us (the sandbox imports its own). `wsl --status` tells "installed, no
   * distros" apart from "the feature is not turned on".
   */
  let installed = probe.status === 0 || distros.length > 0;
  if (!installed) {
    try {
      const st = spawnSync("wsl.exe", ["--status"], {
        windowsHide: true,
        timeout: 10_000,
      });
      installed = st.status === 0;
    } catch {
      installed = false;
    }
  }
  if (!installed) {
    return {
      installed: false,
      distros: [],
      defaultDistro: null,
      reason:
        "WSL is not turned on. From an administrator PowerShell run: " +
        "wsl --install --no-distribution   then restart Windows once.",
    };
  }
  const def = distros.find((d) => d.isDefault) ?? distros[0] ?? null;
  return { installed: true, distros, defaultDistro: def?.name ?? null };
}

/**
 * The sandbox runs only in its own distro. The user's other distros are never
 * used: they need a sudo password, auto-mount every drive, and are theirs.
 */
export function chooseDistro(
  status: WslStatus
): { ok: true; distro: string } | { ok: false; reason: string; needsSetup?: boolean } {
  if (!status.installed) {
    return { ok: false, reason: status.reason ?? "WSL is not installed." };
  }
  const own = status.distros.find((d) => d.name === SANDBOX_DISTRO);
  if (!own) {
    return {
      ok: false,
      needsSetup: true,
      reason:
        "The sandbox is not set up yet. Open Settings -> Sandbox (or type " +
        "/sandbox) and click Set up.",
    };
  }
  // WSL 1 is accepted: it is the fallback for a Windows whose virtual-disk
  // drivers are broken (see diagnoseVhdStack), and everything the sandbox
  // uses works on it.
  return { ok: true, distro: own.name };
}

/** One off-screen X display per server process, inside the sandbox distro. */
export interface WslSandbox {
  distro: string;
  display: string;
  xvfb: ChildProcess | null;
}

let sandbox: WslSandbox | null = null;

export function activeWslSandbox(): WslSandbox | null {
  return sandbox;
}

/** Choose the distro and start Xvfb in it (once). */
export function ensureWslSandbox():
  | { ok: true; sandbox: WslSandbox }
  | { ok: false; error: string; needsSetup?: boolean } {
  if (sandbox) return { ok: true, sandbox };
  const chosen = chooseDistro(probeWsl());
  if (!chosen.ok) {
    return { ok: false, error: chosen.reason, needsSetup: chosen.needsSetup };
  }

  const display = pickDisplay();
  let xvfb: ChildProcess | null = null;
  try {
    const inv = buildWslInvocation({
      distro: chosen.distro,
      user: "root",
      command: "Xvfb",
      args: xvfbLaunchArgs(display),
    });
    xvfb = spawn(inv.command, inv.args, {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    });
    xvfb.unref();
  } catch {
    xvfb = null;
  }
  sandbox = { distro: chosen.distro, display, xvfb };
  return { ok: true, sandbox };
}

/** Stop the sandbox's display, if this process started one. */
export function closeWslSandbox(): void {
  if (sandbox) {
    try {
      const inv = buildWslInvocation({
        distro: sandbox.distro,
        user: "root",
        command: "pkill",
        args: ["-f", `Xvfb ${sandbox.display}`],
      });
      spawnSync(inv.command, inv.args, { windowsHide: true, timeout: 5_000 });
    } catch {
      /* it stops with the distro anyway */
    }
    try {
      sandbox.xvfb?.kill();
    } catch {
      /* already gone */
    }
  }
  sandbox = null;
}

/**
 * The `wsl.exe` argv that runs a bash command in the sandbox, inside this
 * chat's workspace (mounted on first use), with DISPLAY on the sandbox's
 * off-screen X server.
 */
export function wrapForSandbox(opts: {
  sandbox: WslSandbox;
  workspaceId: string;
  workspaceWinDir: string;
  script: string;
  extraEnv?: Record<string, string>;
}): WslInvocation {
  const mount = sandboxMountPoint(opts.workspaceId);
  return buildWslInvocation({
    distro: opts.sandbox.distro,
    user: "root",
    env: {
      DISPLAY: opts.sandbox.display,
      HOME: "/root",
      NO_COLOR: "1",
      PYTHONUNBUFFERED: "1",
      DEBIAN_FRONTEND: "noninteractive",
      ...(opts.extraEnv ?? {}),
    },
    command: "bash",
    args: ["-lc", mountAndRunScript(opts.workspaceWinDir, mount, opts.script)],
  });
}

/**
 * Screenshot the sandbox display into the workspace, where view_image can
 * read it. Returns the host path of the PNG.
 */
export function sandboxCaptureInvocation(opts: {
  sandbox: WslSandbox;
  workspaceId: string;
  workspaceWinDir: string;
  outFileName: string;
}): { invocation: WslInvocation; hostPath: string } {
  const capture = ["import", ...captureArgs(opts.sandbox.display, opts.outFileName)]
    .map(shQuote)
    .join(" ");
  return {
    invocation: wrapForSandbox({
      sandbox: opts.sandbox,
      workspaceId: opts.workspaceId,
      workspaceWinDir: opts.workspaceWinDir,
      script: capture,
    }),
    hostPath: path.join(opts.workspaceWinDir, opts.outFileName),
  };
}

// ---------------------------------------------------------------------------
// Where the sandbox disk may live, and what WSL's errors mean.
//
// Reported from the first real setup: `wsl --import` failed with
//   "A virtual disk support provider for the specified file was not found.
//    Error code: Wsl/Service/RegisterDistro/0xc03a0014"
// The disk was being created inside the app's own data folder — wherever the
// project was cloned — and Windows cannot create a WSL virtual disk (.vhdx) in
// a compressed or encrypted folder, inside OneDrive, or on a drive that is not
// NTFS/ReFS. So the disk now lives under %LOCALAPPDATA% by default, and the
// folder is checked (and its compression/encryption cleared) before import.
// ---------------------------------------------------------------------------

/**
 * Where the sandbox keeps its disk and download.
 *
 * APIM_SANDBOX_DIR wins. On Windows the default is %LOCALAPPDATA%\apiM\sandbox:
 * always on the system drive, always NTFS, never synced by OneDrive. Elsewhere
 * (only reachable in tests) it falls back to the app's data folder.
 */
export function sandboxBaseDir(
  env: Record<string, string | undefined>,
  platform: string,
  dataDir: string
): string {
  if (env.APIM_SANDBOX_DIR?.trim()) return env.APIM_SANDBOX_DIR.trim();
  if (platform === "win32" && env.LOCALAPPDATA?.trim()) {
    return path.win32.join(env.LOCALAPPDATA.trim(), "apiM", "sandbox");
  }
  return path.join(dataDir, "sandbox");
}

/**
 * Windows exit codes arrive as unsigned 32-bit numbers, so WSL's -1 shows up
 * as 4294967295. Report the signed value, and the hex for anything that is
 * really an NTSTATUS/HRESULT.
 */
export function formatExitCode(code: number | null): string {
  if (code === null) return "no exit code";
  const signed = code > 0x7fffffff ? code - 0x100000000 : code;
  return Math.abs(signed) > 0xffff
    ? `${signed} (0x${(code >>> 0).toString(16)})`
    : String(signed);
}

/**
 * Turn WSL's error output into what to do about it. Matched on the hex code,
 * which is the same in every Windows language; null when it is not one we know.
 */
export function explainWslError(text: string): string | null {
  const t = String(text ?? "").toLowerCase();
  if (t.includes("0xc03a0014") || t.includes("virtual disk support provider")) {
    return (
      "Windows could not create a virtual disk. Either the folder cannot hold " +
      "one (compressed or encrypted, inside OneDrive, or not NTFS), or Windows' " +
      "own virtual-disk drivers (FsDepends, vhdmp, vdrvroot) are missing or " +
      "disabled. The second also breaks Docker Desktop, Hyper-V and mounting " +
      "ISOs; see docs/restore-fsdepends.md."
    );
  }
  if (t.includes("wsl1_not_supported") || /wsl ?1 is not supported/.test(t)) {
    return (
      "WSL 1 is switched off on this PC. Click 'Turn on WSL 1 support' in " +
      "this panel (it asks Windows for administrator rights), restart " +
      "Windows, then click Set up again."
    );
  }
  if (t.includes("0x80370102")) {
    return (
      "Virtualization is not available to WSL 2. Turn on 'Virtual Machine " +
      "Platform' (Windows Features), and make sure virtualization (Intel VT-x / " +
      "AMD SVM) is enabled in the BIOS, then restart."
    );
  }
  if (t.includes("0x8007019e") || t.includes("0x8000000d")) {
    return (
      "The Windows Subsystem for Linux feature is not enabled. Click 'Turn on " +
      "WSL' in this panel (or run: wsl --install --no-distribution as " +
      "administrator), then restart Windows."
    );
  }
  if (t.includes("0x800701bc") || t.includes("kernel")) {
    return "WSL 2 needs its kernel updated. Run: wsl --update   then click Set up again.";
  }
  if (t.includes("0x80070070") || t.includes("not enough space")) {
    return "The drive is out of space. The sandbox needs about 4 GB free.";
  }
  if (t.includes("0x80070005") || t.includes("access is denied")) {
    return (
      "Windows denied access to the sandbox folder. Pick a folder you own " +
      "with APIM_SANDBOX_DIR, or check antivirus 'controlled folder access'."
    );
  }
  return null;
}

/** What a PowerShell preflight reports about the install folder. */
export interface InstallDirInfo {
  fs: string;
  driveType: string;
  freeGB: number;
  compressed: boolean;
  encrypted: boolean;
}

/**
 * Decide whether a folder can hold the sandbox disk, and what we may fix on
 * our own folder (compression, encryption) versus what the user must change.
 */
export function assessInstallDir(
  dir: string,
  info: InstallDirInfo,
  oneDriveRoots: string[]
): { fixCompression: boolean; fixEncryption: boolean; problems: string[] } {
  const problems: string[] = [];
  const fsName = String(info.fs ?? "").toUpperCase();
  if (fsName && fsName !== "NTFS" && fsName !== "REFS") {
    problems.push(
      `${dir} is on a ${info.fs} drive. A WSL disk needs NTFS (or ReFS); use a ` +
        `folder on your C: drive or set APIM_SANDBOX_DIR.`
    );
  }
  if (/network|cdrom|removable/i.test(info.driveType)) {
    problems.push(
      `${dir} is on a ${info.driveType.toLowerCase()} drive. Use a local fixed drive.`
    );
  }
  const lowered = dir.toLowerCase().replace(/\//g, "\\");
  const synced = oneDriveRoots
    .filter(Boolean)
    .map((r) => r.toLowerCase().replace(/\//g, "\\").replace(/\\+$/, ""))
    .find((r) => lowered === r || lowered.startsWith(r + "\\"));
  if (synced) {
    problems.push(
      `${dir} is inside OneDrive (${synced}). OneDrive cannot hold a WSL disk; ` +
        `set APIM_SANDBOX_DIR to a folder outside it.`
    );
  }
  if (Number.isFinite(info.freeGB) && info.freeGB < 4) {
    problems.push(`Only ${info.freeGB} GB free on that drive; the sandbox needs about 4 GB.`);
  }
  return {
    fixCompression: info.compressed,
    fixEncryption: info.encrypted,
    problems,
  };
}

/**
 * PowerShell that creates the folder and reports its drive and attributes as
 * one line of JSON. ASCII only, for the reason documented in hidden-display.
 */
export function installDirProbeScript(): string {
  return [
    "param([string]$Dir)",
    '$ErrorActionPreference = "Stop"',
    "New-Item -ItemType Directory -Force -Path $Dir | Out-Null",
    "$item = Get-Item -LiteralPath $Dir -Force",
    "$attrs = $item.Attributes",
    "$drive = New-Object System.IO.DriveInfo([System.IO.Path]::GetPathRoot($item.FullName))",
    "[ordered]@{",
    "  fs = $drive.DriveFormat",
    "  driveType = [string]$drive.DriveType",
    "  freeGB = [math]::Round($drive.AvailableFreeSpace / 1GB, 1)",
    "  compressed = [bool]($attrs -band [System.IO.FileAttributes]::Compressed)",
    "  encrypted = [bool]($attrs -band [System.IO.FileAttributes]::Encrypted)",
    "} | ConvertTo-Json -Compress",
    "",
  ].join("\r\n");
}

// ---------------------------------------------------------------------------
// The virtual-disk driver stack.
//
// The folder check above passed on the reporting machine (NTFS, local, not
// compressed) and the import still failed with 0xc03a0014. The other cause of
// that code is Windows itself: VHDX files are created by the vhdmp driver,
// which needs FsDepends (a minifilter) and vdrvroot (the virtual drive
// enumerator); vmcompute must be startable too. A missing or disabled one
// breaks every virtual disk on the machine, which is also why Docker Desktop
// fails there. These are read with sc.exe, which needs no admin rights.
// ---------------------------------------------------------------------------

export const VHD_SERVICES = ["FsDepends", "vhdmp", "vdrvroot", "vmcompute"] as const;
export type VhdService = (typeof VHD_SERVICES)[number];

/** Driver files that must exist under System32\drivers. */
export const VHD_DRIVER_FILES = ["FsDepends.sys", "vhdmp.sys", "vdrvroot.sys"] as const;

const START_NAMES: Record<number, string> = {
  0: "boot",
  1: "system",
  2: "automatic",
  3: "on demand",
  4: "DISABLED",
};

/**
 * Read `sc.exe qc <name>`. Field names and numbers are the same in every
 * Windows language; only the trailing words are translated, so only the
 * numbers are used. 1060 means the service is not registered at all.
 */
export function parseScQc(text: string): { exists: boolean; startType: number | null } {
  const t = String(text ?? "");
  // "FAILED 1060:" in English, "FEHLER 1060:" in German: match the number.
  if (/\s1060:/.test(t)) return { exists: false, startType: null };
  const m = /START_TYPE\s*:\s*(\d+)/.exec(t);
  return { exists: Boolean(m) || /SERVICE_NAME/.test(t), startType: m ? Number(m[1]) : null };
}

/** Read `sc.exe query <name>`: 1 stopped, 4 running. */
export function parseScQuery(text: string): { state: number | null } {
  const m = /STATE\s*:\s*(\d+)/.exec(String(text ?? ""));
  return { state: m ? Number(m[1]) : null };
}

export interface VhdProbe {
  services: Partial<Record<VhdService, { qc: string; query: string }>>;
  /** Whether each driver file exists. */
  files: Partial<Record<(typeof VHD_DRIVER_FILES)[number], boolean>>;
}

export interface VhdFinding {
  component: string;
  problem: string;
  fix: string;
}

/**
 * Turn the raw probe into what is broken and how to fix it. Only real faults
 * are reported: a demand-start driver that is merely stopped is normal.
 */
export function diagnoseVhdStack(probe: VhdProbe): VhdFinding[] {
  const out: VhdFinding[] = [];
  const doc = "docs/restore-fsdepends.md";

  for (const file of VHD_DRIVER_FILES) {
    if (probe.files[file] === false) {
      out.push({
        component: file,
        problem: `the driver file C:\\Windows\\System32\\drivers\\${file} is missing`,
        fix: `no setting can bring it back; copy it from the Windows ISO (${doc}, "If the driver file is missing")`,
      });
    }
  }

  for (const name of VHD_SERVICES) {
    const raw = probe.services[name];
    if (!raw) continue;
    const qc = parseScQc(raw.qc);
    if (!qc.exists) {
      out.push({
        component: name,
        problem: `${name} is not registered with Windows`,
        fix:
          name === "FsDepends"
            ? `recreate its registration step by step: ${doc}, Steps 1-4 (make a restore point first)`
            : name === "vmcompute"
              ? "turn on 'Virtual Machine Platform' in Windows Features, then restart"
              : `its registration is missing; see ${doc}, "If FsDepends loads but VHDX creation still fails"`,
      });
      continue;
    }
    if (qc.startType === 4) {
      const restore = name === "vdrvroot" ? 0 : 3;
      out.push({
        component: name,
        problem: `${name} is DISABLED`,
        fix:
          `as administrator: sc.exe config ${name} start= ${restore === 0 ? "boot" : "demand"}` +
          ` then restart (${START_NAMES[restore]} is the Windows default)`,
      });
    } else if (name === "vdrvroot" && qc.startType !== null && qc.startType !== 0) {
      out.push({
        component: name,
        problem: `vdrvroot starts "${START_NAMES[qc.startType] ?? qc.startType}" instead of at boot`,
        fix: `as administrator: reg add HKLM\\SYSTEM\\CurrentControlSet\\Services\\vdrvroot /v Start /t REG_DWORD /d 0 /f   then restart`,
      });
    }
  }
  return out;
}

/** One paragraph for the log and the error line. */
export function formatVhdFindings(findings: VhdFinding[]): string {
  if (!findings.length) {
    return (
      "The virtual-disk drivers all look registered and enabled, so the fault " +
      "is deeper (often an anti-cheat driver or a damaged VHD stack). Try " +
      "`sc.exe start vhdmp` as administrator and see what it says, and the " +
      "diskpart test in docs/restore-fsdepends.md, Step 4."
    );
  }
  return findings.map((f) => `- ${f.problem}. Fix: ${f.fix}.`).join("\n");
}

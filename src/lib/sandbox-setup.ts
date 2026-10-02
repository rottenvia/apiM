/**
 * One-click setup (and removal) of the WSL sandbox distro.
 *
 * Runs only when the user clicks Set up in the Sandbox panel. The steps, each
 * shown live in the panel's log:
 *
 *   1. Check WSL is turned on (if not, the panel offers to turn it on, which
 *      shows Windows' own administrator prompt).
 *   2. Download the official Ubuntu 24.04 WSL image and verify it against
 *      Ubuntu's published SHA256SUMS. A mismatch stops everything.
 *   3. `wsl --import apim-sandbox` into the app's data folder. The user's own
 *      distros are not touched.
 *   4. Write /etc/wsl.conf: no auto-mounted drives, no launching Windows
 *      programs, root as the only user. Restart the distro so it applies.
 *   5. apt-get install the toolset (Xvfb, xdotool, ImageMagick, Python, Node,
 *      compilers, gdb, strace).
 *
 * Removal is `wsl --unregister apim-sandbox` plus deleting its folder, which
 * throws away everything that was installed inside it.
 *
 * One job at a time, kept in memory; the panel polls getSandboxJob().
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { writePowerShellScript } from "@/lib/hidden-display";
import {
  ROOTFS_BASE,
  ROOTFS_FILE,
  SANDBOX_DISTRO,
  VHD_DRIVER_FILES,
  VHD_SERVICES,
  WSL1_DRIVER_FILES,
  WSL1_SERVICES,
  diagnoseWsl1,
  enableWslElevatedScript,
  enableWslLauncherScript,
  explainDismExit,
  parseDismExit,
  assessInstallDir,
  closeWslSandbox,
  diagnoseVhdStack,
  expectedSha256,
  explainWslError,
  formatExitCode,
  formatVhdFindings,
  importArgs,
  installDirProbeScript,
  sandboxBaseDir,
  type InstallDirInfo,
  type VhdProbe,
  type Wsl1Probe,
  wsl2CannotRunHere,
  probeWsl,
  sandboxWslConf,
  wslSetupScript,
  type WslStatus,
} from "@/lib/wsl";

const DATA_DIR = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.resolve(process.cwd(), "data");

/**
 * Where the sandbox's virtual disk and download live: %LOCALAPPDATA%\apiM\sandbox
 * on Windows (see sandboxBaseDir in lib/wsl for why not the data folder).
 */
export const SANDBOX_DIR = sandboxBaseDir(process.env, process.platform, DATA_DIR);

/** The first release put the disk here; an empty leftover is tidied away. */
const LEGACY_SANDBOX_DIR = path.join(DATA_DIR, "sandbox");

export type SandboxJobKind = "setup" | "remove" | "enable-wsl" | "upgrade";

export interface SandboxJob {
  kind: SandboxJobKind;
  phase: string;
  /** 0..1 while downloading, null otherwise. */
  progress: number | null;
  log: string;
  startedAt: number;
  finishedAt: number | null;
  ok: boolean | null;
  error?: string;
  /** A button the panel should offer next, when the fix is one click. */
  hint?: "enable-wsl1";
}

let job: SandboxJob | null = null;
const MAX_LOG = 40_000;

export function getSandboxJob(): SandboxJob | null {
  return job;
}

function log(line: string): void {
  if (!job) return;
  job.log += line.endsWith("\n") ? line : line + "\n";
  if (job.log.length > MAX_LOG) job.log = job.log.slice(-MAX_LOG);
}

function phase(name: string): void {
  if (!job) return;
  job.phase = name;
  job.progress = null;
  log(`== ${name}`);
}

function finish(ok: boolean, error?: string): void {
  if (!job) return;
  job.ok = ok;
  job.error = error;
  job.finishedAt = Date.now();
  job.phase = ok ? "Done" : "Failed";
  if (error) log(`!! ${error}`);
}

function running(): boolean {
  return Boolean(job && job.finishedAt === null);
}

function begin(kind: SandboxJobKind): { ok: true } | { ok: false; error: string } {
  if (running()) return { ok: false, error: "A sandbox job is already running." };
  job = {
    kind,
    phase: "Starting",
    progress: null,
    log: "",
    startedAt: Date.now(),
    finishedAt: null,
    ok: null,
  };
  return { ok: true };
}

/**
 * Run a program to completion, streaming its output into the job log. The
 * output is also returned, so a failure can be explained from what it said.
 */
function runLogged(
  command: string,
  args: string[],
  options: { input?: string; timeoutMs?: number } = {}
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: [options.input != null ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const onData = (d: Buffer) => {
      // wsl.exe's own messages are UTF-16; Linux programs' output is UTF-8.
      const text = d.toString(d.includes(0) ? "utf16le" : "utf8").replace(/\u0000/g, "");
      if (output.length < 200_000) output += text;
      log(text);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    if (options.input != null) {
      child.stdin?.end(options.input);
    }
    const timer = options.timeoutMs
      ? setTimeout(() => {
          log(`(stopped after ${Math.round(options.timeoutMs! / 1000)}s)`);
          child.kill();
        }, options.timeoutMs)
      : null;
    child.on("error", (err) => {
      output += `could not start ${command}: ${err.message}`;
      log(`could not start ${command}: ${err.message}`);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** Stream a URL to disk while hashing it; reports progress into the job. */
async function download(url: string, dest: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const hash = createHash("sha256");
  let received = 0;
  let lastLogged = 0;
  const out = createWriteStream(dest);
  const body = Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream);
  for await (const chunk of body) {
    const buf = chunk as Buffer;
    hash.update(buf);
    received += buf.length;
    if (!out.write(buf)) await new Promise<void>((r) => out.once("drain", () => r()));
    if (job && total) job.progress = received / total;
    if (received - lastLogged > 50 * 1024 * 1024) {
      lastLogged = received;
      log(`  ${Math.round(received / 1048576)} MB${total ? ` of ${Math.round(total / 1048576)} MB` : ""}`);
    }
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  return hash.digest("hex");
}

/** SHA-256 of a file on disk, or null when it does not exist. */
async function hashFile(file: string): Promise<string | null> {
  try {
    await fs.access(file);
  } catch {
    return null;
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** A failed step, explained in plain words when the error is one we know. */
function failure(step: string, run: { code: number | null; output: string }): Error {
  const known = explainWslError(run.output);
  return new Error(
    known
      ? `${step} failed: ${known}`
      : `${step} failed (exit ${formatExitCode(run.code)}); see the log above.`
  );
}

/**
 * Make sure the folder can hold a WSL disk before 340 MB is spent on it.
 *
 * Compression and encryption on OUR folder are cleared (that only changes how
 * new files in apiM's own folder are stored); anything about the drive itself
 * is reported, because that is the user's call. A preflight that cannot run is
 * logged and skipped rather than blocking setup.
 */
async function preflightInstallDir(dir: string, base: string): Promise<void> {
  const script = path.join(os.tmpdir(), "apim-sandbox-probe.ps1");
  await writePowerShellScript(script, installDirProbeScript());
  const probe = async (): Promise<InstallDirInfo | null> => {
    const run = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Dir", dir],
      { windowsHide: true, timeout: 30_000, encoding: "utf8" }
    );
    const json = /\{[\s\S]*\}/.exec(String(run.stdout ?? ""));
    if (!json) return null;
    try {
      return JSON.parse(json[0]) as InstallDirInfo;
    } catch {
      return null;
    }
  };

  let info = await probe();
  if (!info) {
    log("  (could not inspect the folder; continuing)");
    return;
  }
  log(`  ${dir}: ${info.fs}, ${info.freeGB} GB free`);
  const oneDrive = [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial]
    .filter((v): v is string => Boolean(v));
  let verdict = assessInstallDir(dir, info, oneDrive);

  // Each folder's own "compress/encrypt new files" flag is what a new file
  // inherits, so both folders are cleared by name, then everything inside.
  const quiet = { windowsHide: true, timeout: 60_000 };
  if (verdict.fixCompression) {
    log("  The folder is NTFS-compressed; turning compression off for apiM's folder.");
    for (const d of [base, dir]) spawnSync("compact.exe", ["/u", "/i", "/q", d], quiet);
    spawnSync("compact.exe", ["/u", "/i", "/q", "/s:" + base], quiet);
  }
  if (verdict.fixEncryption) {
    log("  The folder is encrypted (EFS); turning encryption off for apiM's folder.");
    for (const d of [base, dir]) spawnSync("cipher.exe", ["/d", d], quiet);
    spawnSync("cipher.exe", ["/d", "/s:" + base], quiet);
  }
  if (verdict.fixCompression || verdict.fixEncryption) {
    info = (await probe()) ?? info;
    verdict = assessInstallDir(dir, info, oneDrive);
    if (verdict.fixCompression || verdict.fixEncryption) {
      verdict.problems.push(
        `${dir} is still ${verdict.fixCompression ? "compressed" : "encrypted"}. ` +
          `Right-click it -> Properties -> Advanced and untick that option, or ` +
          `set APIM_SANDBOX_DIR to another folder.`
      );
    }
  }
  if (verdict.problems.length) throw new Error(verdict.problems.join(" "));
}

/** Read the virtual-disk drivers' registration with sc.exe (no admin needed). */
function probeVhdStack(): VhdProbe {
  const probe: VhdProbe = { services: {}, files: {} };
  const run = (args: string[]) => {
    try {
      const r = spawnSync("sc.exe", args, { windowsHide: true, timeout: 10_000, encoding: "latin1" });
      return `${r.stdout ?? ""}${r.stderr ?? ""}`;
    } catch {
      return "";
    }
  };
  for (const name of VHD_SERVICES) {
    probe.services[name] = { qc: run(["qc", name]), query: run(["query", name]) };
  }
  const drivers = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "drivers");
  for (const file of VHD_DRIVER_FILES) {
    probe.files[file] = existsSync(path.join(drivers, file));
  }
  return probe;
}

/**
 * Is Windows waiting for a restart to finish installing something? Both keys
 * are readable without admin rights; either one existing means yes.
 */
function rebootPending(): boolean {
  const keys = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired",
  ];
  return keys.some((key) => {
    try {
      return spawnSync("reg.exe", ["query", key], { windowsHide: true, timeout: 10_000 }).status === 0;
    } catch {
      return false;
    }
  });
}

/** Read what WSL 1 needs: its driver files, their registration, a pending restart. */
function probeWsl1(): Wsl1Probe {
  const drivers = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "drivers");
  const probe: Wsl1Probe = { rebootPending: rebootPending(), files: {}, services: {} };
  for (const file of WSL1_DRIVER_FILES) probe.files[file] = existsSync(path.join(drivers, file));
  for (const name of WSL1_SERVICES) {
    try {
      const r = spawnSync("sc.exe", ["qc", name], { windowsHide: true, timeout: 10_000, encoding: "latin1" });
      probe.services[name] = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    } catch {
      /* unknown; diagnoseWsl1 treats a missing entry as "not checked" */
    }
  }
  return probe;
}


export function sandboxStatus(): WslStatus & { setUp: boolean; dir: string } {
  const status = probeWsl();
  return {
    ...status,
    setUp: status.distros.some((d) => d.name === SANDBOX_DISTRO),
    dir: SANDBOX_DIR,
  };
}

/** Start the setup job. Returns immediately; poll getSandboxJob(). */
export function startSandboxSetup(): { ok: true } | { ok: false; error: string } {
  if (process.platform !== "win32") {
    return { ok: false, error: "The WSL sandbox needs the app to run on Windows." };
  }
  const started = begin("setup");
  if (!started.ok) return started;
  void runSetup().catch((err) =>
    finish(false, err instanceof Error ? err.message : String(err))
  );
  return { ok: true };
}

async function runSetup(): Promise<void> {
  phase("Checking WSL");
  if (rebootPending()) {
    log(
      "  Windows is waiting for a restart to finish installing something. If " +
        "you just turned WSL on, restart first (Start -> Power -> Restart)."
    );
  }
  const status = probeWsl();
  if (!status.installed) {
    finish(false, status.reason ?? "WSL is not turned on.");
    return;
  }

  const installDir = path.join(SANDBOX_DIR, "distro");
  const tarball = path.join(SANDBOX_DIR, ROOTFS_FILE);

  if (!status.distros.some((d) => d.name === SANDBOX_DISTRO)) {
    phase("Checking where the sandbox disk will go");
    await fs.mkdir(installDir, { recursive: true });
    await preflightInstallDir(installDir, SANDBOX_DIR);
    await tidyLegacyDir();

    const sumsRes = await fetch(`${ROOTFS_BASE}/SHA256SUMS`);
    if (!sumsRes.ok) throw new Error(`could not fetch SHA256SUMS: HTTP ${sumsRes.status}`);
    const expected = expectedSha256(await sumsRes.text(), ROOTFS_FILE);
    if (!expected) throw new Error(`${ROOTFS_FILE} is not listed in SHA256SUMS`);

    // A verified download from a failed attempt is reused, not fetched again.
    const kept = await hashFile(tarball);
    if (kept === expected) {
      phase("Reusing the Ubuntu image downloaded last time");
      log("  SHA256 matches Ubuntu's published checksum.");
    } else {
      phase("Downloading Ubuntu 24.04 (about 350 MB)");
      const actual = await download(`${ROOTFS_BASE}/${ROOTFS_FILE}`, tarball);
      phase("Verifying download");
      if (actual !== expected) {
        await fs.rm(tarball, { force: true });
        throw new Error(
          `checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…). ` +
            `The file was deleted; nothing was installed.`
        );
      }
      log("  SHA256 matches Ubuntu's published checksum.");
    }

    phase(`Importing as "${SANDBOX_DISTRO}" (WSL 2)`);
    log(`  disk: ${installDir}`);
    const run = await runLogged("wsl.exe", importArgs(installDir, tarball, 2), {
      timeoutMs: 10 * 60_000,
    });
    if (run.code !== 0) {
      // The download is kept on any failure so the next attempt skips it.
      const cause = wsl2CannotRunHere(run.output);
      if (!cause) throw failure("wsl --import", run);

      /*
       * WSL 2 cannot run its VM on this PC. Say why, then fall back to WSL 1,
       * which runs Linux programs directly on Windows: no VM, no virtual
       * disk, no Hyper-V socket. Reported second cause: 0x8007273f, Winsock
       * refusing the AF_HYPERV socket, after the disk drivers were repaired.
       */
      if (cause === "virtual-disk") {
        phase("Windows cannot create virtual disks; checking its drivers");
        log(formatVhdFindings(diagnoseVhdStack(probeVhdStack())));
      } else {
        phase("Windows cannot start the WSL 2 virtual machine");
        log(`  ${explainWslError(run.output) ?? "WSL 2's VM failed to start."}`);
      }
      log("  This is also what breaks Docker Desktop and Hyper-V on this PC.");

      phase(`Importing as "${SANDBOX_DISTRO}" (WSL 1, no virtual machine needed)`);
      await fs.rm(installDir, { recursive: true, force: true });
      await fs.mkdir(installDir, { recursive: true });
      const v1 = await runLogged("wsl.exe", importArgs(installDir, tarball, 1), {
        timeoutMs: 20 * 60_000,
      });
      if (v1.code !== 0) {
        if (!/WSL1_NOT_SUPPORTED|optional component/i.test(v1.output)) {
          throw failure("wsl --import (WSL 1 fallback)", v1);
        }
        // One message, three causes; find out which before suggesting a fix.
        phase("Checking why WSL 1 is unavailable");
        const wsl1 = diagnoseWsl1(probeWsl1());
        if (wsl1.state === "feature-off" && job) job.hint = "enable-wsl1";
        throw new Error(`WSL 1 is not available: ${wsl1.message}`);
      }
      log(
        "  Running on WSL 1. Everything the sandbox uses works on it. Once the " +
          "drivers above are fixed, click Upgrade to WSL 2 in this panel."
      );
    }
    await fs.rm(tarball, { force: true });
  } else {
    log(`  "${SANDBOX_DISTRO}" already exists; reusing it.`);
  }

  phase("Locking down the sandbox (wsl.conf)");
  const conf = await runLogged(
    "wsl.exe",
    ["-d", SANDBOX_DISTRO, "-u", "root", "--exec", "sh", "-c", "cat > /etc/wsl.conf"],
    { input: sandboxWslConf(), timeoutMs: 60_000 }
  );
  if (conf.code !== 0) throw failure("Writing /etc/wsl.conf", conf);
  closeWslSandbox();
  spawnSync("wsl.exe", ["--terminate", SANDBOX_DISTRO], { windowsHide: true, timeout: 30_000 });

  phase("Installing tools (apt-get, a few minutes)");
  const apt = await runLogged(
    "wsl.exe",
    ["-d", SANDBOX_DISTRO, "-u", "root", "--exec", "bash", "-c", wslSetupScript()],
    { timeoutMs: 30 * 60_000 }
  );
  if (apt.code !== 0 || !apt.output.includes("apim-wsl-setup-ok")) {
    throw failure("Installing the tools", apt);
  }

  finish(true);
}

/**
 * The first release created <data>\sandbox\distro and, when the import failed
 * there, left it empty. Remove it only if it is empty: a disk inside means a
 * distro was really registered there, and that is not ours to delete.
 */
async function tidyLegacyDir(): Promise<void> {
  if (path.resolve(LEGACY_SANDBOX_DIR) === path.resolve(SANDBOX_DIR)) return;
  try {
    await fs.rmdir(path.join(LEGACY_SANDBOX_DIR, "distro"));
    await fs.rmdir(LEGACY_SANDBOX_DIR);
  } catch {
    /* not there, or not empty — leave it */
  }
}

/** Unregister the sandbox distro and delete its disk. */
export function startSandboxRemove(): { ok: true } | { ok: false; error: string } {
  if (process.platform !== "win32") {
    return { ok: false, error: "The WSL sandbox needs the app to run on Windows." };
  }
  const started = begin("remove");
  if (!started.ok) return started;
  void (async () => {
    phase(`Removing "${SANDBOX_DISTRO}"`);
    closeWslSandbox();
    const run = await runLogged("wsl.exe", ["--unregister", SANDBOX_DISTRO], {
      timeoutMs: 5 * 60_000,
    });
    await fs.rm(path.join(SANDBOX_DIR, "distro"), { recursive: true, force: true });
    await fs.rm(path.join(SANDBOX_DIR, ROOTFS_FILE), { force: true });
    finish(
      run.code === 0,
      run.code === 0 ? undefined : `wsl --unregister exited ${formatExitCode(run.code)}`
    );
  })().catch((err) => finish(false, err instanceof Error ? err.message : String(err)));
  return { ok: true };
}

/** Move the sandbox from WSL 1 to WSL 2 once virtual disks work again. */
export function startSandboxUpgrade(): { ok: true } | { ok: false; error: string } {
  if (process.platform !== "win32") {
    return { ok: false, error: "The WSL sandbox needs the app to run on Windows." };
  }
  const started = begin("upgrade");
  if (!started.ok) return started;
  void (async () => {
    phase(`Converting "${SANDBOX_DISTRO}" to WSL 2`);
    closeWslSandbox();
    const run = await runLogged("wsl.exe", ["--set-version", SANDBOX_DISTRO, "2"], {
      timeoutMs: 30 * 60_000,
    });
    if (run.code === 0) {
      finish(true);
      return;
    }
    if (wsl2CannotRunHere(run.output) === "virtual-disk") {
      log(formatVhdFindings(diagnoseVhdStack(probeVhdStack())));
    }
    finish(false, failure("Converting to WSL 2", run).message + " The sandbox stays on WSL 1 and keeps working.");
  })().catch((err) => finish(false, err instanceof Error ? err.message : String(err)));
  return { ok: true };
}

/**
 * Turn WSL on. Needs administrator rights, so this asks Windows to show its
 * own elevation prompt; the user decides there. A restart is needed after.
 */
export function startEnableWsl(): { ok: true } | { ok: false; error: string } {
  if (process.platform !== "win32") {
    return { ok: false, error: "WSL only exists on Windows." };
  }
  const started = begin("enable-wsl");
  if (!started.ok) return started;
  void (async () => {
    phase("Asking Windows for administrator rights");
    /*
     * The elevated process cannot hand its output back directly, so it writes
     * DISM's output and exit codes to a log that is read here. Before this the
     * button said "WSL was installed" whatever happened, which is how a
     * declined prompt or a failed DISM looked like success.
     */
    const dir = path.join(os.tmpdir(), "apim-enable-wsl");
    const inner = path.join(dir, "enable.ps1");
    const launcher = path.join(dir, "launch.ps1");
    const logFile = path.join(dir, "result.log");
    await writePowerShellScript(inner, enableWslElevatedScript());
    await writePowerShellScript(launcher, enableWslLauncherScript());
    await fs.rm(logFile, { force: true });

    const run = await runLogged(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "-Inner", inner, "-Log", logFile],
      { timeoutMs: 30 * 60_000 }
    );
    const result = await fs
      .readFile(logFile, "utf8")
      .then((t) => t.replace(/^\ufeff/, "").replace(/\u0000/g, ""))
      .catch(() => "");
    if (result) log(result.trim());

    const declined = run.output.includes("apim-uac-declined") || !result;
    const dism = explainDismExit(declined ? null : parseDismExit(result));
    if (!dism.ok) {
      finish(false, dism.message);
      return;
    }
    const restart = dism.restart || rebootPending();
    log(
      restart
        ? "Restart Windows now (Start -> Power -> Restart), then click Set up."
        : "Done. Click Set up."
    );
    finish(true);
  })().catch((err) => finish(false, err instanceof Error ? err.message : String(err)));
  return { ok: true };
}

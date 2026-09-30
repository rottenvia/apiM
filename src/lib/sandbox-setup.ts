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
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import {
  ROOTFS_BASE,
  ROOTFS_FILE,
  SANDBOX_DISTRO,
  closeWslSandbox,
  expectedSha256,
  importArgs,
  probeWsl,
  sandboxWslConf,
  wslSetupScript,
  type WslStatus,
} from "@/lib/wsl";

const DATA_DIR = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.resolve(process.cwd(), "data");

/** Where the sandbox's virtual disk lives. */
export const SANDBOX_DIR = path.join(DATA_DIR, "sandbox");

export type SandboxJobKind = "setup" | "remove" | "enable-wsl";

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

/** Run a program to completion, streaming its output into the job log. */
function runLogged(
  command: string,
  args: string[],
  options: { input?: string; timeoutMs?: number } = {}
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: [options.input != null ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const onData = (d: Buffer) => {
      // wsl.exe's own messages are UTF-16; Linux programs' output is UTF-8.
      log(d.toString(d.includes(0) ? "utf16le" : "utf8").replace(/\u0000/g, ""));
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
      log(`could not start ${command}: ${err.message}`);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve(code ?? -1);
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
  const status = probeWsl();
  if (!status.installed) {
    finish(false, status.reason ?? "WSL is not turned on.");
    return;
  }

  const installDir = path.join(SANDBOX_DIR, "distro");
  const tarball = path.join(SANDBOX_DIR, ROOTFS_FILE);
  await fs.mkdir(installDir, { recursive: true });

  if (!status.distros.some((d) => d.name === SANDBOX_DISTRO)) {
    phase("Downloading Ubuntu 24.04 (about 350 MB)");
    const sumsRes = await fetch(`${ROOTFS_BASE}/SHA256SUMS`);
    if (!sumsRes.ok) throw new Error(`could not fetch SHA256SUMS: HTTP ${sumsRes.status}`);
    const expected = expectedSha256(await sumsRes.text(), ROOTFS_FILE);
    if (!expected) throw new Error(`${ROOTFS_FILE} is not listed in SHA256SUMS`);

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

    phase(`Importing as "${SANDBOX_DISTRO}"`);
    const code = await runLogged("wsl.exe", importArgs(installDir, tarball), {
      timeoutMs: 10 * 60_000,
    });
    await fs.rm(tarball, { force: true });
    if (code !== 0) throw new Error(`wsl --import failed (exit ${code})`);
  } else {
    log(`  "${SANDBOX_DISTRO}" already exists; reusing it.`);
  }

  phase("Locking down the sandbox (wsl.conf)");
  let code = await runLogged(
    "wsl.exe",
    ["-d", SANDBOX_DISTRO, "-u", "root", "--exec", "sh", "-c", "cat > /etc/wsl.conf"],
    { input: sandboxWslConf(), timeoutMs: 60_000 }
  );
  if (code !== 0) throw new Error(`could not write /etc/wsl.conf (exit ${code})`);
  closeWslSandbox();
  spawnSync("wsl.exe", ["--terminate", SANDBOX_DISTRO], { windowsHide: true, timeout: 30_000 });

  phase("Installing tools (apt-get, a few minutes)");
  code = await runLogged(
    "wsl.exe",
    ["-d", SANDBOX_DISTRO, "-u", "root", "--exec", "bash", "-c", wslSetupScript()],
    { timeoutMs: 30 * 60_000 }
  );
  if (code !== 0 || !job?.log.includes("apim-wsl-setup-ok")) {
    throw new Error(`package install failed (exit ${code}); see the log above`);
  }

  finish(true);
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
    const code = await runLogged("wsl.exe", ["--unregister", SANDBOX_DISTRO], {
      timeoutMs: 5 * 60_000,
    });
    await fs.rm(path.join(SANDBOX_DIR, "distro"), { recursive: true, force: true });
    finish(code === 0, code === 0 ? undefined : `wsl --unregister exited ${code}`);
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
    const code = await runLogged("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Start-Process wsl.exe -ArgumentList '--install','--no-distribution' -Verb RunAs -Wait",
    ]);
    if (code === 0) {
      log("WSL was installed. Restart Windows once, then click Set up.");
      finish(true);
    } else {
      finish(false, "The administrator prompt was declined or failed.");
    }
  })().catch((err) => finish(false, err instanceof Error ? err.message : String(err)));
  return { ok: true };
}

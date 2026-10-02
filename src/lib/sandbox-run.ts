/**
 * Running a command inside the WSL sandbox, foreground or background.
 *
 * This is the counterpart to lib/runner (host commands) and lib/processes
 * (host background processes), for the isolated Linux box instead. The key
 * difference, and why it is a separate path: on the host there is no shell and
 * a strict allow-list, because a mistake runs on the user's real machine.
 * Inside the sandbox a full shell IS the point — it is a throwaway Linux with
 * Windows interop turned off and only this chat's folder mounted, so `bash -lc
 * "…"` there cannot touch anything of the user's. The protection that stays is
 * the one that matters: the user approves each sandbox command, exactly as for
 * run_command.
 *
 * Everything is wrapped by lib/wsl, so the argv, the per-chat mount and the
 * off-screen DISPLAY are built in one tested place.
 */

import { spawn } from "node:child_process";
import {
  activeWslSandbox,
  ensureWslSandbox,
  sandboxCaptureInvocation,
  wrapForSandbox,
  type WslSandbox,
} from "@/lib/wsl";
import { workspaceDirectory } from "@/lib/workspace";
import { adoptProcess, type TrackedProcess } from "@/lib/processes";

export const SANDBOX_RUN_MS = 120_000;
export const SANDBOX_MAX_MS = 20 * 60_000;
const MAX_OUTPUT = 20_000;

export interface SandboxRunResult {
  ok: boolean;
  content: string;
  summary: string;
}

function bringUp():
  | { ok: true; sandbox: WslSandbox }
  | { ok: false; error: string; needsSetup?: boolean } {
  return ensureWslSandbox();
}

/** A sentence the model can act on when the sandbox is not ready. */
/**
 * What to do instead when the Linux sandbox cannot run. Testing a GUI out of
 * the user's sight does not need Linux: start_process with hidden=true puts it
 * on a hidden Windows desktop and screenshot_window captures it there.
 */
export const WINDOWS_FALLBACK =
  "Do not retry the sandbox and do not ask the user to repair Windows. " +
  "Work on Windows directly instead: run code with run_command, start a GUI " +
  "with start_process (hidden=true, so it opens on a hidden desktop the user " +
  "never sees), then capture it with screenshot_window (process_id) and look " +
  "with view_image. Use Windows builds of tools (Python, Node, Lua) there.";

/**
 * WSL failing to start an instance at all, as opposed to the command inside
 * it failing. Reported: Wsl/Service/CreateInstance/0xd0000034 on a PC whose
 * Windows cannot start WSL 1 or WSL 2 - every sandbox_run then failed the
 * same way, and the agent kept retrying it.
 */
export function wslCannotStart(output: string): boolean {
  return /Wsl\/Service\/CreateInstance\/|Wsl\/Service\/CreateVm\/|0xd0000034|HCS_E_/i.test(
    String(output ?? "")
  );
}

function notReady(error: string, needsSetup?: boolean): SandboxRunResult {
  return {
    ok: false,
    content: needsSetup
      ? `The Linux sandbox is not set up on this PC. ${error}\n${WINDOWS_FALLBACK}`
      : `The Linux sandbox is not available on this PC: ${error}\n${WINDOWS_FALLBACK}`,
    summary: "Sandbox not available",
  };
}

/**
 * Run a shell command in the sandbox and wait for it, capturing output.
 *
 * The command has already been approved by the user in the chat route, the
 * same gate run_command goes through.
 */
export async function runSandboxCommand(
  workspaceId: string,
  script: string,
  options: { timeoutMs?: number | null; signal?: AbortSignal } = {}
): Promise<SandboxRunResult> {
  const up = bringUp();
  if (!up.ok) return notReady(up.error, up.needsSetup);

  const inv = wrapForSandbox({
    sandbox: up.sandbox,
    workspaceId,
    workspaceWinDir: workspaceDirectory(workspaceId),
    script,
  });

  const limit = Math.min(
    Math.max(options.timeoutMs ?? SANDBOX_RUN_MS, 1_000),
    SANDBOX_MAX_MS
  );

  return new Promise<SandboxRunResult>((resolve) => {
    const child = spawn(inv.command, inv.args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let timedOut = false;
    let settled = false;
    const add = (d: Buffer) => {
      if (out.length < MAX_OUTPUT) out += d.toString("utf8");
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, limit);

    const onAbort = () => child.kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const done = (result: SandboxRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.on("error", (err) =>
      done({
        ok: false,
        content: `Could not run in the sandbox: ${err.message}`,
        summary: "Sandbox launch failed",
      })
    );

    child.on("close", (code) => {
      const trimmed =
        out.length > MAX_OUTPUT
          ? out.slice(0, MAX_OUTPUT) + "\n…(truncated)"
          : out;
      if (timedOut) {
        done({
          ok: false,
          content:
            `The sandbox command was stopped after ${Math.round(limit / 1000)}s.\n` +
            (trimmed || "(no output)") +
            `\nIf it is a server or watcher, start it in the background instead.`,
          summary: "Sandbox command timed out",
        });
        return;
      }
      const label = up.sandbox.distro;
      if (code !== 0 && wslCannotStart(trimmed)) {
        done({
          ok: false,
          content:
            `The Linux sandbox cannot start on this PC (WSL failed before ` +
            `running anything):\n${trimmed.trim()}\n${WINDOWS_FALLBACK}`,
          summary: "Sandbox cannot start on this PC",
        });
        return;
      }
      done({
        ok: code === 0,
        content:
          `[sandbox ${label}] exit ${code}\n` + (trimmed || "(no output)"),
        summary: code === 0 ? "Sandbox command finished" : `Sandbox exit ${code}`,
      });
    });
  });
}

/**
 * Start a long-running command (a server, a watcher, a GUI) in the sandbox and
 * leave it running, tracked like any other background process so read_process
 * and stop_process work on it.
 */
export async function startSandboxProcess(
  workspaceId: string,
  script: string,
  display: string
): Promise<
  | { ok: true; process: TrackedProcess; diedImmediately: boolean }
  | { ok: false; error: string; needsSetup?: boolean }
> {
  const up = bringUp();
  if (!up.ok) return { ok: false, error: up.error, needsSetup: up.needsSetup };

  const inv = wrapForSandbox({
    sandbox: up.sandbox,
    workspaceId,
    workspaceWinDir: workspaceDirectory(workspaceId),
    script,
  });

  const child = spawn(inv.command, inv.args, {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Adopt it into the same registry the host processes live in, marked hidden
  // so the dock shows "sandbox" and screenshot_window knows where to look.
  const proc = adoptProcess({
    workspaceId,
    command: "sandbox",
    args: [script.slice(0, 60)],
    display: `sandbox: ${script.slice(0, 60)}`,
    child,
    kind: "user",
    hidden: { kind: "xvfb", name: display },
  });

  await new Promise((r) => setTimeout(r, 3_000));
  return { ok: true, process: proc, diedImmediately: proc.exitedAt !== null };
}

/**
 * Screenshot the sandbox's off-screen display into the workspace and return
 * the file name view_image should open.
 */
export async function screenshotSandbox(
  workspaceId: string,
  outFileName = `sandbox-${Date.now()}.png`
): Promise<
  { ok: true; fileName: string; display: string } | { ok: false; error: string; needsSetup?: boolean }
> {
  const sandbox = activeWslSandbox();
  if (!sandbox) {
    return {
      ok: false,
      error:
        "Nothing is running in the sandbox yet. Start something with " +
        "sandbox_run (background:true) first, then screenshot it.",
    };
  }
  const { invocation } = sandboxCaptureInvocation({
    sandbox,
    workspaceId,
    workspaceWinDir: workspaceDirectory(workspaceId),
    outFileName,
  });
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("error", (e) =>
      resolve({ ok: false, error: `capture failed: ${e.message}` })
    );
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, fileName: outFileName, display: sandbox.display });
      else resolve({ ok: false, error: `capture exited ${code}: ${err.slice(0, 300)}` });
    });
  });
}

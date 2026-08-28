/**
 * A place to run a GUI where the user cannot see it, but the agent can.
 *
 * The request behind this file, verbatim: "I want it to start exe but can we
 * do that so that I won't see the started exe and only it will see and take
 * screenshot." That is not the same as hiding a window. A hidden window
 * (SW_HIDE) stops rendering, so PrintWindow gives back a blank rectangle and
 * the screenshot is a lie — the worst outcome this whole area is trying to
 * avoid. Moving the window to -32000 keeps it rendering but leaves it one
 * alt-tab away and steals focus on launch.
 *
 * The correct primitive is a SEPARATE SURFACE the app owns:
 *
 *   Windows — a second desktop object (CreateDesktop). Windows on it are
 *   fully composited and PrintWindow-able, but they are not on the desktop
 *   the user is looking at: no taskbar button, no focus theft, no flashing.
 *   The capture thread switches to that desktop with SetThreadDesktop before
 *   it enumerates, which is the part that makes the window findable at all.
 *
 *   Linux — an Xvfb display. Same idea, older: a real X server rendering into
 *   memory. Anything launched with DISPLAY pointing at it draws normally and
 *   can be grabbed with `import`, and nothing reaches the user's session.
 *
 *   macOS — there is no equivalent that does not need a signed helper or
 *   Screen Recording consent, so this says so instead of pretending.
 *
 * Everything here degrades honestly: if the surface cannot be created, the
 * caller is told why and can decide to launch visibly instead. Nothing here
 * silently falls back to the user's own desktop, because "I thought it was
 * hidden" is a promise you only get to break once.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export type HiddenSurfaceKind = "windows-desktop" | "xvfb";

export interface HiddenSurface {
  kind: HiddenSurfaceKind;
  /** Desktop object name, or the X display like ":97". */
  name: string;
  /** Extra environment a child needs to draw here. */
  env: Record<string, string>;
  /** Human sentence for the tool result. */
  note: string;
}

/** The Xvfb we started, if any, so it can be stopped with the workspace. */
let xvfb: ChildProcess | null = null;
let surface: HiddenSurface | null = null;

/** Fixed name so a reconnecting capture finds the same desktop. */
export const WINDOWS_DESKTOP = "apim_hidden";

function which(command: string): boolean {
  try {
    const probe = spawnSync(process.platform === "win32" ? "where" : "which", [
      command,
    ]);
    return probe.status === 0;
  } catch {
    return false;
  }
}

/**
 * PowerShell that creates the hidden desktop and starts a program on it.
 *
 * CreateProcess is used directly rather than Start-Process because the
 * desktop is chosen through STARTUPINFO.lpDesktop, which .NET's Process class
 * does not expose. The launcher then WAITS on the child, so the tracked
 * process in apiM lives exactly as long as the app does and stopping it stops
 * the real thing rather than an already-exited wrapper.
 */
export function hiddenLaunchScript(): string {
  return String.raw`
param([string]$Exe, [string]$Arguments = "", [string]$Desktop = "apim_hidden", [string]$WorkDir = ".")
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ApimDesk {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateDesktop(string name, IntPtr dev, IntPtr mode, int flags, uint access, IntPtr sa);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr OpenDesktop(string name, int flags, bool inherit, uint access);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta,
    bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
}
"@

# GENERIC_ALL on the desktop; created once and reused on later launches.
$h = [ApimDesk]::OpenDesktop($Desktop, 0, $false, 0x10000000)
if ($h -eq [IntPtr]::Zero) {
  $h = [ApimDesk]::CreateDesktop($Desktop, [IntPtr]::Zero, [IntPtr]::Zero, 0, 0x10000000, [IntPtr]::Zero)
}
if ($h -eq [IntPtr]::Zero) { Write-Error "could not create the hidden desktop"; exit 4 }

$si = New-Object ApimDesk+STARTUPINFO
$si.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($si)
$si.lpDesktop = "WinSta0\" + $Desktop
$pi = New-Object ApimDesk+PROCESS_INFORMATION

$cmd = '"' + $Exe + '"'
if ($Arguments) { $cmd = $cmd + " " + $Arguments }

$ok = [ApimDesk]::CreateProcess($null, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0, [IntPtr]::Zero, $WorkDir, [ref]$si, [ref]$pi)
if (-not $ok) {
  $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($code -eq 740) {
    Write-Error "the program demands administrator rights (error 740). apiM cannot elevate, and popping a UAC dialog on your desktop is exactly what hidden mode is avoiding. Launch it yourself, then screenshot it by pid."
    exit 740
  }
  Write-Error "CreateProcess failed with Win32 error $code"
  exit 5
}

Write-Output ("apim-pid=" + $pi.dwProcessId)
Write-Output ("apim-desktop=" + $Desktop)
$proc = Get-Process -Id $pi.dwProcessId -ErrorAction SilentlyContinue
if ($proc) { $proc.WaitForExit() }
`;
}

/** Is a hidden surface even possible here? Answered without side effects. */
export function hiddenSurfaceAvailability(): {
  possible: boolean;
  kind: HiddenSurfaceKind | null;
  reason: string;
} {
  if (process.platform === "win32") {
    return {
      possible: true,
      kind: "windows-desktop",
      reason: "a second Windows desktop object, invisible to your session",
    };
  }
  if (process.platform === "linux") {
    return which("Xvfb")
      ? {
          possible: true,
          kind: "xvfb",
          reason: "an Xvfb display that renders into memory",
        }
      : {
          possible: false,
          kind: null,
          reason:
            "Xvfb is not installed (apt install xvfb), so there is nowhere " +
            "off-screen to draw",
        };
  }
  return {
    possible: false,
    kind: null,
    reason:
      "macOS has no off-screen desktop an unsigned process may create; the " +
      "app has to run on the visible session",
  };
}

/** Pick an X display number nothing is using. */
async function freeDisplay(): Promise<string> {
  for (let n = 97; n < 120; n++) {
    try {
      await fs.access(`/tmp/.X${n}-lock`);
    } catch {
      return `:${n}`;
    }
  }
  return ":119";
}

/**
 * Create (or reuse) the hidden surface.
 *
 * Idempotent: the Windows desktop is created by the launcher itself, and the
 * Xvfb is started once and kept for the life of the server process.
 */
export async function ensureHiddenSurface(): Promise<
  { ok: true; surface: HiddenSurface } | { ok: false; error: string }
> {
  const availability = hiddenSurfaceAvailability();
  if (!availability.possible) {
    return {
      ok: false,
      error:
        `A hidden launch is not possible here: ${availability.reason}. ` +
        `Start it visibly instead, or ask the user to launch it and give ` +
        `you the pid.`,
    };
  }

  if (surface) return { ok: true, surface };

  if (availability.kind === "windows-desktop") {
    surface = {
      kind: "windows-desktop",
      name: WINDOWS_DESKTOP,
      env: {},
      note:
        `running on the hidden Windows desktop "${WINDOWS_DESKTOP}" — it has ` +
        `no taskbar button and cannot take focus from you`,
    };
    return { ok: true, surface };
  }

  const display = await freeDisplay();
  xvfb = spawn(
    "Xvfb",
    [display, "-screen", "0", "1600x1000x24", "-nolisten", "tcp"],
    { stdio: "ignore", detached: true }
  );

  // Xvfb takes a moment to create its socket; a client that connects too early
  // dies with "cannot open display", which looks like a broken app.
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    try {
      await fs.access(`/tmp/.X11-unix/X${display.slice(1)}`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  if (xvfb.exitCode !== null) {
    xvfb = null;
    return { ok: false, error: "Xvfb exited immediately; no hidden display." };
  }

  surface = {
    kind: "xvfb",
    name: display,
    env: { DISPLAY: display },
    note: `running on the off-screen X display ${display}`,
  };
  return { ok: true, surface };
}

export function activeHiddenSurface(): HiddenSurface | null {
  return surface;
}

/** Stop the off-screen display, if this process started one. */
export function closeHiddenSurface(): void {
  if (xvfb?.pid) {
    try {
      process.kill(-xvfb.pid, "SIGTERM");
    } catch {
      try {
        xvfb.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  xvfb = null;
  surface = null;
}

/** The command line that launches `exe` onto the surface. */
export async function hiddenLaunchCommand(
  exe: string,
  args: string[],
  workDir: string,
  scriptDir: string
): Promise<{ command: string; args: string[]; env: Record<string, string> }> {
  const active = surface;
  if (active?.kind === "windows-desktop") {
    const scriptPath = path.join(scriptDir, ".apim-hidden-launch.ps1");
    await fs.mkdir(scriptDir, { recursive: true });
    await fs.writeFile(scriptPath, hiddenLaunchScript(), "utf8");
    return {
      command: "powershell",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-Exe",
        exe,
        "-Arguments",
        args.join(" "),
        "-Desktop",
        active.name,
        "-WorkDir",
        workDir,
      ],
      env: {},
    };
  }

  // Xvfb: the program runs as itself, only DISPLAY differs.
  return { command: exe, args, env: active?.env ?? {} };
}

/** Pull the real pid out of the launcher's output, when it has printed one. */
export function parseHiddenPid(log: string): number | null {
  const hit = /apim-pid=(\d+)/.exec(log);
  return hit ? Number(hit[1]) : null;
}

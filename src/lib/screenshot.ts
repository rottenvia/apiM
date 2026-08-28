/**
 * Looking at a window the agent just built.
 *
 * The most honest line in the retro: "I designed two UI generations blind…
 * the first eyes on my work were yours." A browser tool exists for web pages,
 * and nothing existed for a native window — so rounded corners, a settings
 * panel, a colour leak and a drag bug were all reasoned about in GDI
 * coordinates in a model's head, and the bugs came back as three-word user
 * reports.
 *
 * This captures a window that is ALREADY RUNNING — one the agent started with
 * start_process, which has already been through command approval — and saves
 * it as a PNG in the workspace, where view_image can look at it. Nothing here
 * launches anything, so it opens no new execution path.
 *
 * Each platform gets a real capture route and an honest failure. "No display"
 * or "no capture backend installed" is reported as exactly that, with the one
 * command that would fix it, rather than as an empty screenshot.
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface CaptureRequest {
  /** Window title, or a distinctive part of it. */
  title?: string | null;
  /** Process id, when the window belongs to a process we started. */
  pid?: number | null;
  /** Absolute path of the PNG to write. */
  outPath: string;
  /** Capture the whole screen instead of one window. */
  fullScreen?: boolean;
  /** How long to allow the capture helper, in ms. */
  timeoutMs?: number;
}

export interface CaptureResult {
  ok: boolean;
  /** Populated on success. */
  bytes?: number;
  width?: number;
  height?: number;
  /** How it was captured, so a surprising image can be explained. */
  method?: string;
  /** Populated on failure — always actionable. */
  error?: string;
}

/**
 * PowerShell that finds a window and PrintWindow()s it into a PNG.
 *
 * PrintWindow rather than a screen grab, because it works when the window is
 * partly covered or behind the editor — the common case for something the
 * agent started in the background. It falls back to a screen-rectangle copy
 * for windows that refuse PrintWindow (some hardware-accelerated surfaces).
 */
export function windowsCaptureScript(): string {
  return String.raw`
param([string]$Title, [int]$ProcId, [string]$OutFile, [switch]$FullScreen)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ApimCap {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
function Save-Bitmap($bmp, $file) { $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png) }

if ($FullScreen) {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  Save-Bitmap $bmp $OutFile
  Write-Output "fullscreen $($bmp.Width)x$($bmp.Height)"
  exit 0
}

$target = $null
if ($ProcId -gt 0) {
  $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0) { $target = $p.MainWindowHandle }
}
if (-not $target -and $Title) {
  $p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$Title*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) { $target = $p.MainWindowHandle }
}
if (-not $target) { Write-Error "no matching window"; exit 2 }

$r = New-Object ApimCap+RECT
[void][ApimCap]::GetWindowRect($target, [ref]$r)
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { Write-Error "window has no size (minimised?)"; exit 3 }

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
$ok = [ApimCap]::PrintWindow($target, $dc, 2)
$g.ReleaseHdc($dc)
if (-not $ok) {
  $g.Dispose()
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
}
Save-Bitmap $bmp $OutFile
Write-Output "window $($bmp.Width)x$($bmp.Height)"
`;
}

/** Width/height straight out of the PNG header, to prove a real image landed. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function run(command: string, args: string[], timeoutMs: number) {
  try {
    return spawnSync(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

function has(command: string): boolean {
  const probe = run(
    process.platform === "win32" ? "where" : "which",
    [command],
    5_000
  );
  return Boolean(probe && probe.status === 0);
}

/** Capture a window (or the screen) to `outPath`. */
export async function captureWindow(
  request: CaptureRequest
): Promise<CaptureResult> {
  const timeoutMs = request.timeoutMs ?? 30_000;
  await fs.mkdir(path.dirname(request.outPath), { recursive: true });
  await fs.rm(request.outPath, { force: true });

  if (!request.title && !request.pid && !request.fullScreen) {
    return {
      ok: false,
      error:
        "Give a window title or the pid of a process you started (or set " +
        "full_screen). Use list_processes to find it.",
    };
  }

  let method = "";

  if (process.platform === "win32") {
    const script = windowsCaptureScript();
    const scriptPath = path.join(
      path.dirname(request.outPath),
      `.apim-capture-${Date.now()}.ps1`
    );
    await fs.writeFile(scriptPath, script, "utf8");
    const out = run(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-Title",
        request.title ?? "",
        "-ProcId",
        String(request.pid ?? 0),
        "-OutFile",
        request.outPath,
        ...(request.fullScreen ? ["-FullScreen"] : []),
      ],
      timeoutMs
    );
    await fs.rm(scriptPath, { force: true });
    method = `PowerShell ${request.fullScreen ? "screen copy" : "PrintWindow"}`;
    if (!out || out.status !== 0) {
      const detail = `${out?.stderr ?? ""}`.trim().split("\n")[0] ?? "";
      return {
        ok: false,
        error:
          `Could not capture the window${detail ? ` — ${detail}` : ""}. ` +
          `Check the process is running and not minimised (list_processes), ` +
          `and that the title matches. A window with no title bar needs its ` +
          `pid rather than a title.`,
      };
    }
  } else if (process.platform === "darwin") {
    if (!has("screencapture")) {
      return { ok: false, error: "screencapture is not available on this Mac." };
    }
    method = "screencapture";
    const out = run(
      "screencapture",
      ["-x", ...(request.fullScreen ? [] : ["-o"]), request.outPath],
      timeoutMs
    );
    if (!out || out.status !== 0) {
      return {
        ok: false,
        error:
          "screencapture failed — macOS requires Screen Recording permission " +
          "for the process running apiM (System Settings → Privacy).",
      };
    }
  } else {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      return {
        ok: false,
        error:
          "There is no graphical display on this machine (DISPLAY and " +
          "WAYLAND_DISPLAY are both unset), so no window can be captured. " +
          "This tool works where the app actually runs — a desktop session.",
      };
    }
    let captured = false;
    if (!request.fullScreen && has("xdotool") && has("import")) {
      const search = run(
        "xdotool",
        ["search", "--name", request.title ?? ""],
        timeoutMs
      );
      const id = (search?.stdout ?? "").trim().split("\n").filter(Boolean).pop();
      if (id) {
        const out = run("import", ["-window", id, request.outPath], timeoutMs);
        captured = Boolean(out && out.status === 0);
        method = "xdotool + import";
      }
    }
    if (!captured && has("import")) {
      const out = run(
        "import",
        ["-window", "root", request.outPath],
        timeoutMs
      );
      captured = Boolean(out && out.status === 0);
      method = "import (whole screen)";
    }
    if (!captured && has("gnome-screenshot")) {
      const out = run(
        "gnome-screenshot",
        [...(request.fullScreen ? [] : ["-w"]), "-f", request.outPath],
        timeoutMs
      );
      captured = Boolean(out && out.status === 0);
      method = "gnome-screenshot";
    }
    if (!captured) {
      return {
        ok: false,
        error:
          "No screen-capture backend found. Install ImageMagick and xdotool " +
          "(apt install imagemagick xdotool) or gnome-screenshot, then try " +
          "again.",
      };
    }
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fs.readFile(request.outPath));
  } catch {
    return {
      ok: false,
      error:
        "The capture helper reported success but wrote no file. Nothing was " +
        "saved, so do not describe the window as if you had seen it.",
    };
  }
  if (bytes.length === 0) {
    return { ok: false, error: "The capture produced an empty file." };
  }

  const size = pngSize(bytes);
  return {
    ok: true,
    bytes: bytes.length,
    width: size?.width,
    height: size?.height,
    method,
  };
}

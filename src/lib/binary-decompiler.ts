/**
 * Optional deep decompilers for executable inspection.
 *
 * Static PE parsing is built in and always available. Restoring source-like
 * code is a different scale of job: ILSpy is the right parser for managed
 * assemblies, while Ghidra's native decompiler ships as a large Java
 * application. This adapter uses either when installed, with bounded CPU,
 * wall time and output, and caches by SHA-256.
 *
 * The target executable is passed as DATA to a known analysis program. It is
 * never launched, loaded as a Node addon, or asked for its version.
 */

import fsSync, { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crossSpawn from "cross-spawn";
import { workspaceDirectory, resolveInside } from "@/lib/workspace";
import type { PeInspection } from "@/lib/binaries";

export interface DeepDecompilationResult {
  attempted: boolean;
  status: "complete" | "partial" | "unavailable" | "failed" | "disabled";
  engine: "ilspy" | "ghidra" | "none";
  outputs: string[];
  cached: boolean;
  summary: string;
  setup?: string;
  logTail?: string;
}

interface RunResult {
  started: boolean;
  code: number | null;
  timedOut: boolean;
  output: string;
  error?: string;
}

const active = new Map<string, Promise<DeepDecompilationResult>>();
const MAX_LOG_CHARS = 2_000_000;
const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

function minimalEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? process.cwd(),
    TEMP: process.env.TEMP ?? os.tmpdir(),
    TMP: process.env.TMP ?? os.tmpdir(),
    NO_COLOR: "1",
  };
  // Java, .NET and Windows process creation need these. API keys and app
  // secrets are intentionally not copied into a third-party decompiler.
  for (const key of [
    "SystemRoot", "SYSTEMROOT", "windir", "COMSPEC", "PATHEXT",
    "ProgramFiles", "ProgramFiles(x86)", "JAVA_HOME", "DOTNET_ROOT",
    "USERPROFILE", "LOCALAPPDATA",
    "APIM_BINARY_MAX_OUTPUT_MB",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env as NodeJS.ProcessEnv;
}

async function killTree(child: ReturnType<typeof crossSpawn>): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = crossSpawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("close", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }
  try {
    // Spawned detached on Unix so the wrapper plus Java/.NET descendants are
    // one process group. Killing only analyzeHeadless would orphan its heavy
    // JVM after the user pressed Stop.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function runCaptured(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal
): Promise<RunResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({
        started: false,
        code: null,
        timedOut: false,
        output: "",
        error: "Executable decompilation was stopped",
      });
      return;
    }
    const timeoutMs = numberEnv(
      "APIM_BINARY_DECOMPILE_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
      30_000,
      MAX_TIMEOUT_MS
    );
    let child: ReturnType<typeof crossSpawn>;
    try {
      child = crossSpawn(command, args, {
        cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        env: minimalEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        started: false,
        code: null,
        timedOut: false,
        output: "",
        error: error instanceof Error ? error.message : "could not start",
      });
      return;
    }

    let output = "";
    let settled = false;
    let started = true;
    const append = (chunk: unknown) => {
      if (output.length >= MAX_LOG_CHARS) return;
      output += String(chunk).slice(0, MAX_LOG_CHARS - output.length);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      void killTree(child).finally(() =>
        finish({
          started,
          code: null,
          timedOut: false,
          output,
          error: "Executable decompilation was stopped",
        })
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      started = false;
      finish({ started: false, code: null, timedOut: false, output, error: error.message });
    });
    child.once("close", (code) => {
      finish({ started, code, timedOut: false, output });
    });

    const timer = setTimeout(() => {
      void killTree(child).finally(() =>
        finish({ started, code: null, timedOut: true, output })
      );
    }, timeoutMs);
  });
}

function cleanName(value: string): string {
  const base = value.replace(/\\/g, "/").split("/").pop() ?? "binary";
  return (
    base
      .replace(/\.[^.]+$/, "")
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 80) || "binary"
  );
}

async function listOutputs(root: string, workspaceRoot: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    if (out.length >= 20_000) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= 20_000) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name !== ".apim-analysis.json") {
        out.push(path.relative(workspaceRoot, full).split(path.sep).join("/"));
      }
    }
  }
  await walk(root);
  return out.sort((a, b) => a.localeCompare(b));
}

function explicitIlSpy(): string {
  return process.env.APIM_ILSPYCMD_PATH?.trim() || "ilspycmd";
}

function ghidraCommand(): string {
  const home = process.env.APIM_GHIDRA_HOME?.trim() || process.env.GHIDRA_HOME?.trim();
  if (home) {
    return path.join(home, "support", process.platform === "win32" ? "analyzeHeadless.bat" : "analyzeHeadless");
  }
  return process.platform === "win32" ? "analyzeHeadless.bat" : "analyzeHeadless";
}

function commandCouldExist(command: string): boolean {
  // Explicit paths can be rejected without spawning. Bare commands are
  // allowed through so cross-spawn can resolve PATH on every platform.
  return !/[\\/]/.test(command) || fsSync.existsSync(command);
}

async function readMarker(file: string, hash: string, engine: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await fs.readFile(file, "utf8")) as {
      hash?: string;
      engine?: string;
      complete?: boolean;
    };
    return marker.hash === hash && marker.engine === engine && marker.complete === true;
  } catch {
    return false;
  }
}

async function writeMarker(file: string, hash: string, engine: string): Promise<void> {
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        hash,
        engine,
        complete: true,
        createdAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

function tail(text: string, chars = 6000): string {
  return text.length <= chars ? text.trim() : `…${text.slice(-chars).trim()}`;
}

async function runIlSpy(
  workspaceId: string,
  target: string,
  inspection: PeInspection,
  force: boolean,
  signal?: AbortSignal
): Promise<DeepDecompilationResult> {
  const workspaceRoot = workspaceDirectory(workspaceId);
  const targetPath = resolveInside(workspaceId, target);
  const relRoot = `analysis/${cleanName(target)}-${inspection.hashes.sha256.slice(0, 12)}`;
  const root = resolveInside(workspaceId, relRoot);
  const output = path.join(root, "ilspy");
  const marker = path.join(output, ".apim-analysis.json");
  if (!force && (await readMarker(marker, inspection.hashes.sha256, "ilspy"))) {
    const outputs = await listOutputs(output, workspaceRoot);
    return {
      attempted: false,
      status: "complete",
      engine: "ilspy",
      outputs,
      cached: true,
      summary: `Reused ${outputs.length} managed source/project file(s) from ${relRoot}/ilspy.`,
    };
  }

  const command = explicitIlSpy();
  if (!commandCouldExist(command)) {
    return {
      attempted: false,
      status: "unavailable",
      engine: "ilspy",
      outputs: [],
      cached: false,
      summary: "The binary is managed .NET, but ILSpy is not installed at the configured path.",
      setup:
        "Install the .NET SDK, run `dotnet tool install --global ilspycmd`, restart apiM, and optionally set APIM_ILSPYCMD_PATH in .env.local if it is not on PATH.",
    };
  }

  if (force) await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  const result = await runCaptured(
    command,
    ["--project", "--outputdir", output, targetPath],
    workspaceRoot,
    signal
  );
  if (!result.started) {
    return {
      attempted: false,
      status: "unavailable",
      engine: "ilspy",
      outputs: [],
      cached: false,
      summary: `ILSpy could not start${result.error ? `: ${result.error}` : "."}`,
      setup:
        "Run `dotnet tool install --global ilspycmd`, make sure the .NET tools directory is on PATH, then restart apiM. APIM_ILSPYCMD_PATH may point directly to ilspycmd.exe.",
    };
  }

  const outputs = await listOutputs(output, workspaceRoot);
  if (result.error === "Executable decompilation was stopped") {
    return {
      attempted: true,
      status: outputs.length ? "partial" : "failed",
      engine: "ilspy",
      outputs,
      cached: false,
      summary: `ILSpy was stopped; ${outputs.length} partial file(s) were kept.`,
      logTail: tail(result.output),
    };
  }
  if (result.code === 0 && outputs.length) {
    await writeMarker(marker, inspection.hashes.sha256, "ilspy");
    return {
      attempted: true,
      status: "complete",
      engine: "ilspy",
      outputs,
      cached: false,
      summary: `Decompiled the managed assembly into ${outputs.length} C#/project file(s) under ${relRoot}/ilspy.`,
      logTail: tail(result.output),
    };
  }
  return {
    attempted: true,
    status: outputs.length ? "partial" : "failed",
    engine: "ilspy",
    outputs,
    cached: false,
    summary: result.timedOut
      ? `ILSpy exceeded the configured time limit; ${outputs.length} partial file(s) were kept.`
      : `ILSpy exited with code ${result.code ?? "unknown"}; ${outputs.length} partial file(s) were kept. The assembly may be obfuscated, mixed-mode, damaged, or not ordinary managed IL.`,
    logTail: tail(result.output),
  };
}

async function runGhidra(
  workspaceId: string,
  target: string,
  inspection: PeInspection,
  force: boolean,
  signal?: AbortSignal
): Promise<DeepDecompilationResult> {
  const workspaceRoot = workspaceDirectory(workspaceId);
  const targetPath = resolveInside(workspaceId, target);
  const relRoot = `analysis/${cleanName(target)}-${inspection.hashes.sha256.slice(0, 12)}`;
  const root = resolveInside(workspaceId, relRoot);
  const output = path.join(root, "ghidra");
  const marker = path.join(output, ".apim-analysis.json");
  if (!force && (await readMarker(marker, inspection.hashes.sha256, "ghidra"))) {
    const outputs = await listOutputs(output, workspaceRoot);
    return {
      attempted: false,
      status: "complete",
      engine: "ghidra",
      outputs,
      cached: true,
      summary: `Reused ${outputs.length} native decompilation file(s) from ${relRoot}/ghidra.`,
    };
  }

  const command = ghidraCommand();
  if (!commandCouldExist(command)) {
    return {
      attempted: false,
      status: "unavailable",
      engine: "ghidra",
      outputs: [],
      cached: false,
      summary: "Native static inspection completed, but Ghidra is not installed at the configured path.",
      setup:
        "Install Ghidra and Java 21, set APIM_GHIDRA_HOME in .env.local to the extracted Ghidra directory (the one containing support\\analyzeHeadless.bat), then restart apiM.",
    };
  }

  if (force) await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  const projectDir = path.join(root, ".ghidra-project");
  await fs.mkdir(projectDir, { recursive: true });
  const scriptDir = path.resolve(process.cwd(), "scripts", "ghidra");
  const maxCpu = numberEnv(
    "APIM_BINARY_MAX_CPU",
    Math.max(1, Math.min(4, (os.availableParallelism?.() ?? os.cpus().length) - 1)),
    1,
    16
  );
  const args = [
    projectDir,
    `apim-${inspection.hashes.sha256.slice(0, 12)}`,
    "-import",
    targetPath,
    "-overwrite",
    "-analysisTimeoutPerFile",
    String(Math.ceil(numberEnv("APIM_BINARY_DECOMPILE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 30_000, MAX_TIMEOUT_MS) / 1000)),
    "-max-cpu",
    String(maxCpu),
    "-deleteProject",
    "-scriptPath",
    scriptDir,
    "-postScript",
    "ApimDecompile.java",
    output,
  ];
  const result = await runCaptured(command, args, workspaceRoot, signal);
  await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {});
  if (!result.started) {
    return {
      attempted: false,
      status: "unavailable",
      engine: "ghidra",
      outputs: [],
      cached: false,
      summary: `Ghidra headless could not start${result.error ? `: ${result.error}` : "."}`,
      setup:
        "Install Ghidra and Java 21, set APIM_GHIDRA_HOME in .env.local, then restart apiM. The configured folder must contain support\\analyzeHeadless.bat.",
    };
  }

  const outputs = await listOutputs(output, workspaceRoot);
  if (result.error === "Executable decompilation was stopped") {
    return {
      attempted: true,
      status: outputs.length ? "partial" : "failed",
      engine: "ghidra",
      outputs,
      cached: false,
      summary: `Ghidra was stopped; ${outputs.length} partial file(s) were kept.`,
      logTail: tail(result.output),
    };
  }
  if (result.code === 0 && outputs.some((x) => /functions\.tsv$/.test(x))) {
    await writeMarker(marker, inspection.hashes.sha256, "ghidra");
    return {
      attempted: true,
      status: "complete",
      engine: "ghidra",
      outputs,
      cached: false,
      summary: `Ghidra analysed and decompiled native code into ${outputs.length} indexed/chunked file(s) under ${relRoot}/ghidra.`,
      logTail: tail(result.output),
    };
  }
  return {
    attempted: true,
    status: outputs.length ? "partial" : "failed",
    engine: "ghidra",
    outputs,
    cached: false,
    summary: result.timedOut
      ? `Ghidra exceeded the configured time limit; ${outputs.length} partial output file(s) were kept. Increase APIM_BINARY_DECOMPILE_TIMEOUT_MS only for binaries that justify it.`
      : `Ghidra exited with code ${result.code ?? "unknown"}; ${outputs.length} partial output file(s) were kept. Packing, anti-analysis, an unsupported CPU, corruption, or exhausted memory can prevent complete recovery.`,
    logTail: tail(result.output),
  };
}

export async function runDeepDecompilation(
  workspaceId: string,
  target: string,
  inspection: PeInspection,
  options: { force?: boolean; signal?: AbortSignal } = {}
): Promise<DeepDecompilationResult> {
  if (!inspection.format.startsWith("PE")) {
    return {
      attempted: false,
      status: "unavailable",
      engine: "none",
      outputs: [],
      cached: false,
      summary: `${inspection.format} is a legacy executable format; the configured modern decompilers cannot reconstruct it. Static strings and hashes are still shown.`,
    };
  }

  const engine = inspection.managed ? "ilspy" : "ghidra";
  const key = `${workspaceId}:${inspection.hashes.sha256}:${engine}:${options.force === true}`;
  const existing = active.get(key);
  if (existing) return existing;

  const work = (inspection.managed
    ? runIlSpy(
        workspaceId,
        target,
        inspection,
        options.force === true,
        options.signal
      )
    : runGhidra(
        workspaceId,
        target,
        inspection,
        options.force === true,
        options.signal
      )
  ).finally(() => active.delete(key));
  active.set(key, work);
  return work;
}

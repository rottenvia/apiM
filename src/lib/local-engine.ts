/**
 * Download and run Qwen 3.8 27B inside this app.
 *
 * Weights stream straight to disk. A llama-server sidecar on loopback
 * does inference. This process never mmap's the GGUF, so Next.js stays
 * a thin chat client.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, readFileSync, rmSync, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  assertAllowedDownloadUrl,
  DEFAULT_LOCAL_API_MODEL,
  DEFAULT_LOCAL_BASE_URL,
  downloadPercent,
  ENGINE_HOST,
  ENGINE_PORT,
  engineHint,
  GGUF_BYTES,
  GGUF_FILE,
  GGUF_URL,
  ggufLooksComplete,
  SIDECAR_IDLE_MS,
  MMPROJ_BYTES,
  MMPROJ_FILE,
  MMPROJ_MIN_BYTES,
  MMPROJ_URL,
  isAllowedDownloadUrl,
  LLAMA_CPP_RELEASE,
  LLAMA_CPP_RELEASE_API,
  pickLlamaAsset,
  pickCudartAsset,
  needsCudart,
  sidecarArgs,
  sidecarLaunchId,
  SIDECAR_CTX,
  defaultSpecState,
  type EngineBuild,
  type EngineDownloadEvent,
  type EngineGpu,
  type EngineGpuState,
  type EngineStatus,
  type SidecarSpecState,
} from "@/lib/local-engine-shared";

export * from "@/lib/local-engine-shared";

const USER_AGENT = "apiM-local-engine";

export function localEngineRoot(): string {
  const base = process.env.APIM_DATA_ROOT
    ? path.resolve(process.env.APIM_DATA_ROOT)
    : path.resolve(process.cwd(), "data");
  return path.join(base, "local-engine");
}

export function ggufPath(): string {
  return path.join(localEngineRoot(), GGUF_FILE);
}

export function mmprojPath(): string {
  return path.join(localEngineRoot(), MMPROJ_FILE);
}

export function engineBinDir(): string {
  return path.join(localEngineRoot(), "bin");
}

export function engineArchivePath(name: string): string {
  return path.join(localEngineRoot(), "cache", name);
}

function serverName(): string {
  return process.platform === "win32" ? "llama-server.exe" : "llama-server";
}

export async function findServerBinary(): Promise<string | null> {
  const dir = engineBinDir();
  const want = serverName();
  async function walk(current: string, depth: number): Promise<string | null> {
    if (depth > 6) return null;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isFile() && entry.name === want) return full;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const hit = await walk(path.join(current, entry.name), depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  return walk(dir, 0);
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return 0;
  }
}

export function detectGpu(): EngineGpu {
  if (process.platform === "darwin") return "metal";
  try {
    const probe = spawnSync("nvidia-smi", ["-L"], {
      timeout: 2_000,
      windowsHide: true,
      encoding: "utf8",
    });
    if (probe.status === 0 && /GPU/i.test(probe.stdout || "")) return "nvidia";
  } catch {
    /* no NVIDIA */
  }
  if (process.platform === "linux") {
    try {
      const dri = spawnSync("sh", ["-c", "test -e /dev/dri/renderD128"], {
        timeout: 1_000,
      });
      if (dri.status === 0) return "vulkan";
    } catch {
      /* no DRM */
    }
  }
  return "none";
}

export async function engineStatus(): Promise<EngineStatus> {
  await maybeUnloadIdle();
  const bytes = await fileSize(ggufPath());
  const projector = await fileSize(mmprojPath());
  const ggufReady = ggufLooksComplete(bytes);
  const mmprojReady = projector >= MMPROJ_MIN_BYTES;
  const server = await findServerBinary();
  const running = await isEngineListening();
  const nCtx = running ? await readSidecarCtx() : null;
  const spec = await readSpecState();
  const flags = {
    ggufReady,
    mmprojReady,
    serverReady: Boolean(server),
    running,
    nCtx,
    ggufBytes: bytes,
  };
  return {
    ...flags,
    ggufBytes: bytes,
    ggufExpected: GGUF_BYTES,
    mmprojBytes: projector,
    mmprojExpected: MMPROJ_BYTES,
    baseUrl: DEFAULT_LOCAL_BASE_URL,
    apiModel: DEFAULT_LOCAL_API_MODEL,
    hint: engineHint(flags),
    spec,
    gpu: await buildGpuState(running),
  };
}

async function buildGpuState(running: boolean): Promise<EngineGpuState> {
  const detected = detectGpu();
  const logTail = await readLogTail(30);
  if (!running) {
    return {
      detected,
      inUse: null,
      backend: null,
      offloaded: null,
      note:
        detected === "none"
          ? "No GPU detected — Qwen would run on the CPU, which is many times slower for a 27B. If this PC has a GPU, check the driver and the backend choice below."
          : "Engine not running — start it and the GPU state appears here.",
      logTail,
    };
  }
  const reading = parseGpuLog(logTail.join("\n"));
  let note: string;
  if (reading.inUse === true) {
    note = `GPU in use — ${reading.offloaded} layers offloaded to ${
      reading.backend ?? "the GPU"
    }.`;
  } else if (reading.inUse === false) {
    const why = reading.failedLine
      ? ` Log line: “${reading.failedLine.trim().slice(0, 160)}”`
      : "";
    note =
      "Running on the CPU, so every reply is many times slower than it should be." +
      why +
      (detected === "nvidia"
        ? " Update the NVIDIA driver, or set the backend to Vulkan below, then Download and Start."
        : " Set a different backend below (Vulkan or CPU), then Download and Start.");
  } else {
    note =
      "GPU state: the engine log has not reported its offload yet — it does so right after start.";
  }
  return {
    detected,
    inUse: reading.inUse,
    backend: reading.backend,
    offloaded: reading.offloaded,
    note,
    logTail,
  };
}

export async function isEngineListening(): Promise<boolean> {
  try {
    const res = await fetch(`http://${ENGINE_HOST}:${ENGINE_PORT}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(800),
    });
    if (res.ok) return true;
  } catch {
    /* try models */
  }
  try {
    const res = await fetch(`http://${ENGINE_HOST}:${ENGINE_PORT}/v1/models`, {
      cache: "no-store",
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function isManagedEngineUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
      return false;
    }
    return u.port === String(ENGINE_PORT);
  } catch {
    return false;
  }
}

async function followAllowed(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 6; hop += 1) {
    assertAllowedDownloadUrl(current);
    const res = await fetch(current, {
      headers,
      redirect: "manual",
      signal,
      cache: "no-store",
    });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const location = res.headers.get("location");
    if (!location) {
      throw new Error("Download redirected without a location.");
    }
    current = new URL(location, current).toString();
  }
  throw new Error("Too many redirects while downloading.");
}

export async function downloadToFile(
  url: string,
  dest: string,
  onProgress: (completed: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!isAllowedDownloadUrl(url)) {
    throw new Error("That download is not on the allow-list.");
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let existing = await fileSize(part);
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (existing > 0) headers.Range = `bytes=${existing}-`;

  const res = await followAllowed(url, headers, signal);
  if (res.status === 200) {
    // Server ignored Range — start over.
    existing = 0;
    await fs.rm(part, { force: true }).catch(() => {});
  } else if (res.status !== 206 && !res.ok) {
    throw new Error(`Download failed (${res.status}).`);
  }

  const declared = Number(res.headers.get("content-length") ?? 0);
  const total =
    res.status === 206 && existing > 0 && declared > 0
      ? existing + declared
      : declared > 0
        ? declared
        : 0;

  if (!res.body) throw new Error("Empty download body.");

  const flags = existing > 0 && res.status === 206 ? "a" : "w";
  const out = createWriteStream(part, { flags });
  let completed = existing;
  const nodeBody = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  nodeBody.on("data", (chunk: Buffer) => {
    completed += chunk.length;
    onProgress(completed, total);
  });
  await pipeline(nodeBody, out);
  await fs.rename(part, dest);
}

async function extractArchive(archive: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const lower = archive.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    const r = spawnSync("tar", ["-xzf", archive, "-C", dest], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (r.status !== 0) {
      throw new Error(r.stderr?.trim() || "Could not unpack the engine archive.");
    }
    return;
  }

  if (process.platform === "win32") {
    const r = spawnSync("tar", ["-xf", archive, "-C", dest], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (r.status === 0) return;
  }

  const unzip = spawnSync("unzip", ["-o", archive, "-d", dest], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (unzip.status === 0) return;

  const py = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    ["-m", "zipfile", "-e", archive, dest],
    { encoding: "utf8", windowsHide: true }
  );
  if (py.status !== 0) {
    throw new Error("Could not unpack the engine zip (need tar, unzip, or Python).");
  }
}

interface GhAsset {
  name: string;
  browser_download_url: string;
}

async function listLlamaAssets(signal?: AbortSignal): Promise<GhAsset[]> {
  const res = await followAllowed(
    LLAMA_CPP_RELEASE_API,
    {
      "User-Agent": USER_AGENT,
      Accept: "application/vnd.github+json",
    },
    signal
  );
  if (!res.ok) {
    throw new Error(`Could not list llama.cpp ${LLAMA_CPP_RELEASE} (${res.status}).`);
  }
  const data = (await res.json()) as { assets?: GhAsset[] };
  return Array.isArray(data.assets) ? data.assets : [];
}

export async function downloadEngine(
  onEvent: (evt: EngineDownloadEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const emit = (evt: EngineDownloadEvent) => onEvent(evt);

  if (!(await fileSize(ggufPath()) >= GGUF_BYTES)) {
    emit({ type: "status", message: "Downloading Qwen 3.8 27B onto this PC…" });
    await downloadToFile(
      GGUF_URL,
      ggufPath(),
      (completed, total) => {
        emit({
          type: "progress",
          label: "Weights",
          completed,
          total: total || GGUF_BYTES,
          percent: downloadPercent(completed, total || GGUF_BYTES),
        });
      },
      signal
    );
  }

  if ((await fileSize(mmprojPath())) < MMPROJ_MIN_BYTES) {
    emit({
      type: "status",
      message: "Downloading the vision projector so Qwen can see images and video…",
    });
    await downloadToFile(
      MMPROJ_URL,
      mmprojPath(),
      (completed, total) => {
        emit({
          type: "progress",
          label: "Vision",
          completed,
          total: total || MMPROJ_BYTES,
          percent: downloadPercent(completed, total || MMPROJ_BYTES),
        });
      },
      signal
    );
  }

  const spec = await readSpecState();
  const assets = await listLlamaAssets(signal);
  const wanted = pickLlamaAsset(assets.map((a) => a.name), {
    platform: process.platform,
    arch: process.arch,
    gpu: detectGpu(),
    build: spec.build,
  });
  const asset = assets.find((a) => a.name === wanted);
  if (!asset) {
    throw new Error(
      `No llama.cpp build for ${process.platform}/${process.arch} in ${LLAMA_CPP_RELEASE}.`
    );
  }

  const installed = await readBuildStamp();
  const hasBinary = Boolean(await findServerBinary());
  // Re-fetch when the build changed (e.g. the user switched CUDA → Vulkan
  // after the GPU refused the other one), not only when nothing is there.
  const needMain = !hasBinary || installed !== asset.name;
  // The Windows CUDA build needs a SECOND archive (the CUDA runtime DLLs)
  // placed next to llama-server, or ggml-cuda fails to load and the engine
  // silently falls back to CPU. Re-fetch it too if it is missing, even when
  // the main build is already installed — earlier installs never fetched it.
  const cudartName = needsCudart(asset.name)
    ? pickCudartAsset(
        assets.map((a) => a.name),
        asset.name
      )
    : null;
  const cudartAsset = cudartName
    ? assets.find((a) => a.name === cudartName)
    : null;
  const needCudart =
    Boolean(cudartAsset) &&
    (needMain || !(await cudartPresent(await findServerBinary())));

  if (needMain) {
    if (installed && installed !== asset.name) {
      emit({
        type: "status",
        message: `Switching engine build (${installed} → ${asset.name})…`,
      });
      rmSync(engineBinDir(), { recursive: true, force: true });
    }
    emit({ type: "status", message: "Downloading the local engine…" });
    const archive = engineArchivePath(asset.name);
    await downloadToFile(
      asset.browser_download_url,
      archive,
      (completed, total) => {
        emit({
          type: "progress",
          label: "Engine",
          completed,
          total,
          percent: downloadPercent(completed, total),
        });
      },
      signal
    );
    emit({ type: "status", message: "Unpacking the engine…" });
    await extractArchive(archive, engineBinDir());
    const server = await findServerBinary();
    if (!server) {
      throw new Error("Unpacked the engine but llama-server was not inside it.");
    }
    if (process.platform !== "win32") {
      await fs.chmod(server, 0o755).catch(() => {});
    }
    await writeBuildStamp(asset.name);
  }

  // CUDA runtime for the Windows CUDA build. ggml-cuda.dll loads these at
  // startup; without them the plugin cannot initialise and the whole build
  // runs on CPU — the "CUDA picked but 99% CPU / ~1% GPU" symptom.
  if (cudartAsset && needCudart) {
    emit({
      type: "status",
      message: "Downloading the CUDA runtime (~390 MB)…",
    });
    const rtArchive = engineArchivePath(cudartAsset.name);
    await downloadToFile(
      cudartAsset.browser_download_url,
      rtArchive,
      (completed, total) => {
        emit({
          type: "progress",
          label: "CUDA",
          completed,
          total,
          percent: downloadPercent(completed, total),
        });
      },
      signal
    );
    emit({ type: "status", message: "Installing the CUDA runtime…" });
    await installCudart(rtArchive, await findServerBinary());
  }

  emit({ type: "done" });
}

/**
 * Are the CUDA runtime DLLs installed next to the server?
 *
 * cublasLt64_*.dll is present in every shipped cudart archive and required by
 * the CUDA backend, so its presence is the reliable signal that the runtime
 * landed; checking only cudart64 missed partial/old extractions.
 */
async function cudartPresent(server: string | null): Promise<boolean> {
  if (!server || process.platform !== "win32") return false;
  const dir = path.dirname(server);
  for (const dll of ["cublasLt64_12.dll", "cublasLt64_13.dll", "cudart64_12.dll"]) {
    try {
      await fs.access(path.join(dir, dll));
      return true;
    } catch {
      /* try the next */
    }
  }
  return false;
}

/**
 * Unpack the cudart archive and copy its runtime DLLs beside llama-server.
 *
 * The archive nests files a directory or two deep, so the DLLs are found by
 * walking the extraction folder rather than assuming a layout.
 */
async function installCudart(
  archive: string,
  server: string | null
): Promise<void> {
  if (!server) return;
  const serverDir = path.dirname(server);
  const staging = path.join(engineBinDir(), "__cudart_tmp");
  await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(staging, { recursive: true });
  try {
    await extractArchive(archive, staging);
    const dlls: string[] = [];
    const collect = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await collect(full, depth + 1);
        } else if (/\.dll$/i.test(e.name)) {
          dlls.push(full);
        }
      }
    };
    await collect(staging, 0);
    for (const dll of dlls) {
      const target = path.join(serverDir, path.basename(dll));
      await fs.copyFile(dll, target).catch(() => {});
    }
    if (!(await cudartPresent(server))) {
      throw new Error(
        "The CUDA runtime extracted but its DLLs were not found in it."
      );
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

let child: ChildProcess | null = null;

function pidFilePath(): string {
  return path.join(localEngineRoot(), "sidecar.pid");
}

function specFilePath(): string {
  return path.join(localEngineRoot(), "spec-opts.json");
}

function launchStampPath(): string {
  return path.join(localEngineRoot(), "sidecar.launch");
}

/** The engine's stderr, so a GPU fallback is visible instead of silent. */
function engineLogPath(): string {
  return path.join(localEngineRoot(), "sidecar.log");
}

/** Which llama.cpp asset the installed binary came from. */
function buildStampPath(): string {
  return path.join(localEngineRoot(), "sidecar.build");
}

async function readBuildStamp(): Promise<string | null> {
  try {
    const s = (await fs.readFile(buildStampPath(), "utf8")).trim();
    return s || null;
  } catch {
    return null;
  }
}

export async function writeBuildStamp(assetName: string): Promise<void> {
  await fs.mkdir(localEngineRoot(), { recursive: true });
  await fs.writeFile(buildStampPath(), assetName, "utf8");
}

/** Last lines of the engine log, oldest first. Bounded so status stays cheap. */
async function readLogTail(lines = 30): Promise<string[]> {
  let text = "";
  try {
    text = await fs.readFile(engineLogPath(), "utf8");
  } catch {
    return [];
  }
  return text
    .replace(/\s+$/, "")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-lines);
}

interface GpuLogReading {
  inUse: boolean | null;
  backend: string | null;
  offloaded: string | null;
  failedLine: string | null;
}

/**
 * What the engine's own log says about the GPU.
 *
 * A 27B on CPU is 10–50x slower than on a GPU and the symptom is "it is
 * hung" — but the sidecar used to pipe stderr to a 400-char error string
 * and throw it away, so a CUDA/Vulkan init failure (old driver, no ICD,
 * not-enough VRAM) was invisible. The log line that proves the fallback is
 * now the status.
 *
 * Heuristics, most specific first. InUse stays null until something in the
 * log proves one way or the other — a young log is "unknown", not "CPU".
 */
export function parseGpuLog(logText: string): GpuLogReading {
  const lines = logText.split("\n");
  const failedLine =
    lines
      .reverse()
      .find((l) =>
        /(no devices found|device\(s?\) found: 0|failed to initialize|init failed|out of memory|cannot allocate|cuda.*(?:error|failed)|vulkan.*(?:error|failed|not available)|no gpu|gl context.*fail)/i.test(
          l
        ) && !/^\s*$/i.test(l)
      ) ?? null;

  // "offloaded 36/36 layers to GPU (CUDA)" — the line that settles it.
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /offloaded (\d+\/\d+) layers to GPU(?:\s*\((\w+)\))?/i.exec(
      lines[i]
    );
    if (m) {
      const total = Number(m[1].split("/")[1] ?? "0");
      const done = Number(m[1].split("/")[0] ?? "0");
      return {
        inUse: done > 0,
        backend: m[2]?.toUpperCase() ?? null,
        offloaded: m[1],
        failedLine: done === 0 ? failedLine : null,
      };
    }
  }

  // No offload line yet, but a backend failure was logged — that is the
  // "GPU 0%, CPU 100%" case, and the log says exactly why.
  if (failedLine) {
    return { inUse: false, backend: null, offloaded: null, failedLine };
  }

  return { inUse: null, backend: null, offloaded: null, failedLine: null };
}

function lastUsedPath(): string {
  return path.join(localEngineRoot(), "last-used");
}

export async function touchSidecarUsed(): Promise<void> {
  try {
    await fs.mkdir(localEngineRoot(), { recursive: true });
    await fs.writeFile(lastUsedPath(), String(Date.now()), "utf8");
  } catch {
    /* status must still work if the data dir is read-only */
  }
}

async function readLastUsed(): Promise<number> {
  try {
    const n = Number((await fs.readFile(lastUsedPath(), "utf8")).trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Drop the 25–30 GB sidecar when nobody has asked Qwen for a while.
 *
 * Switching models used to leave llama-server mapped forever. Settings
 * polls this every few seconds, so an idle machine unloads itself.
 */
export async function maybeUnloadIdle(): Promise<boolean> {
  if (!(await isEngineListening())) return false;
  const last = await readLastUsed();
  // No stamp: do not kill a sidecar that is still booting. Model-switch
  // and the Unload button handle leftovers without a chat timestamp.
  if (last <= 0) return false;
  if (Date.now() - last < SIDECAR_IDLE_MS) return false;
  stopEngine();
  return true;
}

function killPid(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
      });
      return;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  } catch {
    /* already gone */
  }
}

/** Every pid listening on our sidecar port — any address. */
export function pidsOnEnginePort(): number[] {
  const port = ENGINE_PORT;
  const found = new Set<number>();
  if (process.platform === "win32") {
    const r = spawnSync("netstat", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const pin = new RegExp(`:${port}(?!\\d)`);
    for (const line of (r.stdout || "").split(/\r?\n/)) {
      if (!/LISTENING/i.test(line) || !pin.test(line)) continue;
      const m = line.trim().match(/(\d+)\s*$/);
      if (m) found.add(Number(m[1]));
    }
  } else {
    const lsof = spawnSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8" }
    );
    for (const piece of (lsof.stdout || "").trim().split(/\s+/)) {
      const n = Number(piece);
      if (Number.isFinite(n) && n > 0) found.add(n);
    }
    const fuser = spawnSync("fuser", ["-n", "tcp", String(port)], {
      encoding: "utf8",
    });
    for (const piece of `${fuser.stdout || ""} ${fuser.stderr || ""}`.split(
      /\s+/
    )) {
      const n = Number(piece);
      if (Number.isFinite(n) && n > 0) found.add(n);
    }
  }
  return [...found];
}

function killLlamaServerByName(): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/IM", "llama-server.exe", "/T"], {
      windowsHide: true,
    });
    return;
  }
  spawnSync("pkill", ["-9", "-f", "llama-server"], { encoding: "utf8" });
}

export function stopEngine(): boolean {
  const proc = child;
  child = null;
  let killed = false;
  if (proc && proc.pid) {
    killPid(proc.pid);
    killed = true;
  }
  try {
    const raw = readFileSync(pidFilePath(), "utf8");
    const saved = Number(raw.trim());
    if (Number.isFinite(saved) && saved > 0) {
      killPid(saved);
      killed = true;
    }
  } catch {
    /* no pid file */
  }
  for (const pid of pidsOnEnginePort()) {
    killPid(pid);
    killed = true;
  }
  killLlamaServerByName();
  try {
    rmSync(pidFilePath(), { force: true });
  } catch {
    /* ignore */
  }
  return killed;
}

function walkNctx(value: unknown, depth = 0): number | null {
  if (depth > 8 || value == null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = walkNctx(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.n_ctx === "number") return rec.n_ctx;
    for (const item of Object.values(rec)) {
      const hit = walkNctx(item, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function parseSidecarCtx(data: unknown): number | null {
  return walkNctx(data);
}

/** How big a window the running sidecar actually opened. */
export async function readSidecarCtx(): Promise<number | null> {
  for (const path of ["/props", "/slots"]) {
    try {
      const res = await fetch(`http://${ENGINE_HOST}:${ENGINE_PORT}${path}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(1_200),
      });
      if (!res.ok) continue;
      const hit = parseSidecarCtx(await res.json());
      if (hit) return hit;
    } catch {
      /* try the other endpoint */
    }
  }
  return null;
}

async function waitForHealth(ms: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    if (await isEngineListening()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function waitUntilStopped(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await isEngineListening())) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const KNOWN_BUILDS = new Set(["auto", "cuda", "vulkan", "cpu"]);

export async function readSpecState(): Promise<SidecarSpecState> {
  try {
    const raw = await fs.readFile(specFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<SidecarSpecState>;
    const fallback = defaultSpecState();
    const spec: SidecarSpecState = {
      enabled: Array.isArray(parsed.enabled)
        ? parsed.enabled.filter((id): id is string => typeof id === "string")
        : fallback.enabled,
      extra: Array.isArray(parsed.extra)
        ? parsed.extra.filter((id): id is string => typeof id === "string")
        : [],
    };
    if (typeof parsed.build === "string" && KNOWN_BUILDS.has(parsed.build)) {
      spec.build = parsed.build as EngineBuild;
    }
    return spec;
  } catch {
    return defaultSpecState();
  }
}

export async function writeSpecState(spec: SidecarSpecState): Promise<void> {
  await fs.mkdir(localEngineRoot(), { recursive: true });
  await fs.writeFile(specFilePath(), JSON.stringify(spec, null, 2), "utf8");
}

async function writeLaunchStamp(id: string): Promise<void> {
  await fs.mkdir(localEngineRoot(), { recursive: true });
  await fs.writeFile(launchStampPath(), id, "utf8");
}

async function launchMatches(id: string): Promise<boolean> {
  try {
    return (await fs.readFile(launchStampPath(), "utf8")).trim() === id;
  } catch {
    return false;
  }
}

async function spawnSidecar(
  server: string,
  gguf: string,
  mmproj: string | undefined,
  spec: SidecarSpecState
): Promise<{ ok: boolean; error?: string }> {
  stopEngine();
  await waitUntilStopped(10_000);
  if (await isEngineListening()) {
    return {
      ok: false,
      error:
        "An old llama-server is still holding the port. End llama-server in Task Manager and click Restart.",
    };
  }

  // Fresh log per launch: the status panel parses it to say where the
  // compute actually went, so a stale "offloaded" line from an older run
  // would lie.
  await fs.mkdir(localEngineRoot(), { recursive: true });
  await fs.writeFile(engineLogPath(), "", "utf8");

  try {
    child = spawn(server, sidecarArgs(gguf, mmproj, spec), {
      cwd: path.dirname(server),
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      shell: false,
    });
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Could not start the local engine.",
    };
  }

  if (child.pid) {
    await fs.mkdir(localEngineRoot(), { recursive: true });
    await fs.writeFile(pidFilePath(), String(child.pid), "utf8");
  }

  let spawnError = "";
  child.once("error", (err) => {
    spawnError = err.message;
  });
  // Tee stderr to the log file. Everything before only kept the first 400
  // chars for the failure message — the "CUDA init failed, using CPU" line
  // that makes a 27B crawl at 10x slower never survived to the UI.
  const logStream = createWriteStream(engineLogPath(), { flags: "a" });
  logStream.on("error", () => {});
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    if (!text) return;
    logStream.write(text);
    if (spawnError.length < 400) spawnError += text;
  });
  child.on("close", () => {
    try {
      logStream.end();
    } catch {
      /* already closed */
    }
  });
  child.unref();

  let up = await waitForHealth(180_000);

  if (!up && spec.enabled.includes("flash")) {
    // Flash attention can refuse a GPU the other flags were fine on. Retry
    // once without it so "Start" still works, and persist the choice so the
    // user is not surprised by a different launch id later.
    const log = await readLogTail(200).then((l) => l.join("\n"));
    if (/flash/i.test(log)) {
      const fixed: SidecarSpecState = {
        ...spec,
        enabled: spec.enabled.filter((id) => id !== "flash"),
      };
      await writeSpecState(fixed);
      logStream.end();
      stopEngine();
      await waitUntilStopped(10_000);
      if (await isEngineListening()) {
        return {
          ok: false,
          error:
            "An old llama-server is still holding the port. End llama-server in Task Manager and click Restart.",
        };
      }
      await fs.writeFile(engineLogPath(), "", "utf8");
      child = spawn(server, sidecarArgs(gguf, mmproj, fixed), {
        cwd: path.dirname(server),
        detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        shell: false,
      });
      if (child.pid) {
        await fs.writeFile(pidFilePath(), String(child.pid), "utf8");
      }
      const retryStream = createWriteStream(engineLogPath(), { flags: "a" });
      retryStream.on("error", () => {});
      child.stderr?.on("data", (chunk) => {
        const text = String(chunk);
        if (!text) return;
        retryStream.write(text);
        if (spawnError.length < 400) spawnError += text;
      });
      child.on("close", () => {
        try {
          retryStream.end();
        } catch {
          /* already closed */
        }
      });
      child.unref();
      up = await waitForHealth(180_000);
    }
  }

  if (!up) {
    return {
      ok: false,
      error:
        spawnError.trim().slice(0, 400) ||
        "The local engine started but is not answering yet. Give it a moment and try Start again.",
    };
  }

  const ctx = await readSidecarCtx();
  if (ctx !== null && ctx < SIDECAR_CTX) {
    stopEngine();
    await waitUntilStopped(8_000);
    return {
      ok: false,
      error:
        `Qwen came up on a ${ctx.toLocaleString()}-token window, not ${SIDECAR_CTX.toLocaleString()}. ` +
        `An old llama-server is still answering. End llama-server in Task Manager and click Restart.`,
    };
  }
  await writeLaunchStamp(sidecarLaunchId(spec));
  await touchSidecarUsed();
  return { ok: true };
}

export async function startEngine(): Promise<{ ok: boolean; error?: string }> {
  // First run on this machine: let the defaults match the hardware. On a
  // GPU machine flash attention starts on (the preset's own blurb says to
  // leave it off only on CPU). Once the user touches the panel the file
  // exists and their choice is sticky from then on.
  try {
    await fs.access(specFilePath());
  } catch {
    const base = defaultSpecState();
    const first: SidecarSpecState =
      detectGpu() !== "none"
        ? { ...base, enabled: [...new Set([...base.enabled, "flash"])] }
        : base;
    await writeSpecState(first);
  }
  const spec = await readSpecState();
  const wanted = sidecarLaunchId(spec);

  if (await isEngineListening()) {
    const ctx = await readSidecarCtx();
    const same = await launchMatches(wanted);
    if (same && ctx !== null && ctx >= SIDECAR_CTX) {
      await touchSidecarUsed();
      return { ok: true };
    }
    // Too small, unknown, or stale flags: kill the old process for real.
    stopEngine();
    await waitUntilStopped(10_000);
  }

  const gguf = ggufPath();
  if (!ggufLooksComplete(await fileSize(gguf))) {
    return {
      ok: false,
      error:
        "Qwen 3.8 27B is not downloaded yet. Open Settings and click Download.",
    };
  }
  const server = await findServerBinary();
  if (!server) {
    return {
      ok: false,
      error: "The local engine is not installed yet. Click Download in Settings.",
    };
  }

  // An explicit backend choice means a different binary than the one on
  // disk. macOS has one build (Metal is compiled in), so no mismatch there.
  if (spec.build && spec.build !== "auto" && process.platform !== "darwin") {
    const installed = await readBuildStamp();
    if (installed && !installed.includes(spec.build)) {
      return {
        ok: false,
        error:
          `The installed engine is the ${installed} build, but ${spec.build} is ` +
          `selected. Click Download in Settings to fetch the ${spec.build} build.`,
      };
    }
  }

  const projector = mmprojPath();
  const mmproj =
    (await fileSize(projector)) >= MMPROJ_MIN_BYTES ? projector : undefined;
  return spawnSidecar(server, gguf, mmproj, spec);
}

/** Persist spec flags and bounce the sidecar so they take effect. */
export async function applySpecState(
  spec: SidecarSpecState
): Promise<{ ok: boolean; error?: string }> {
  await writeSpecState(spec);
  stopEngine();
  await waitUntilStopped(10_000);
  return startEngine();
}

/** Start the sidecar if this request is aimed at the in-app engine. */
export async function ensureEngineRunning(): Promise<{ ok: boolean; error?: string }> {
  const status = await engineStatus();
  if (!status.ggufReady || !status.serverReady) {
    return {
      ok: false,
      error:
        "Qwen 3.8 27B is not on this PC yet. Open Settings and click Download.",
    };
  }
  return startEngine();
}

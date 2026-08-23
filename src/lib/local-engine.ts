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
  MMPROJ_BYTES,
  MMPROJ_FILE,
  MMPROJ_MIN_BYTES,
  MMPROJ_URL,
  isAllowedDownloadUrl,
  LLAMA_CPP_RELEASE,
  LLAMA_CPP_RELEASE_API,
  pickLlamaAsset,
  sidecarArgs,
  sidecarLaunchId,
  SIDECAR_CTX,
  defaultSpecState,
  type EngineDownloadEvent,
  type EngineGpu,
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
  const bytes = await fileSize(ggufPath());
  const projector = await fileSize(mmprojPath());
  const ggufReady = bytes >= GGUF_BYTES;
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

  if (!(await findServerBinary())) {
    emit({ type: "status", message: "Downloading the local engine…" });
    const assets = await listLlamaAssets(signal);
    const name = pickLlamaAsset(
      assets.map((a) => a.name),
      {
        platform: process.platform,
        arch: process.arch,
        gpu: detectGpu(),
      }
    );
    const asset = assets.find((a) => a.name === name);
    if (!asset) {
      throw new Error(
        `No llama.cpp build for ${process.platform}/${process.arch} in ${LLAMA_CPP_RELEASE}.`
      );
    }
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
  }

  emit({ type: "done" });
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

export async function readSpecState(): Promise<SidecarSpecState> {
  try {
    const raw = await fs.readFile(specFilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<SidecarSpecState>;
    const fallback = defaultSpecState();
    return {
      enabled: Array.isArray(parsed.enabled)
        ? parsed.enabled.filter((id): id is string => typeof id === "string")
        : fallback.enabled,
      extra: Array.isArray(parsed.extra)
        ? parsed.extra.filter((id): id is string => typeof id === "string")
        : [],
    };
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
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    if (text && spawnError.length < 400) spawnError += text;
  });
  child.unref();

  const up = await waitForHealth(180_000);
  if (!up) {
    return {
      ok: false,
      error:
        spawnError.trim() ||
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
  return { ok: true };
}

export async function startEngine(): Promise<{ ok: boolean; error?: string }> {
  const spec = await readSpecState();
  const wanted = sidecarLaunchId(spec);

  if (await isEngineListening()) {
    const ctx = await readSidecarCtx();
    const same = await launchMatches(wanted);
    if (same && ctx !== null && ctx >= SIDECAR_CTX) return { ok: true };
    // Too small, unknown, or stale flags: kill the old process for real.
    stopEngine();
    await waitUntilStopped(10_000);
  }

  const gguf = ggufPath();
  if ((await fileSize(gguf)) < GGUF_BYTES) {
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

/**
 * In-app Qwen runtime — browser-safe bits.
 *
 * The 27B is downloaded into this app and served by a sidecar the app
 * starts. Inference never enters the Next.js process, so the UI stays
 * light. Ollama is not required.
 */

export const ENGINE_PORT = 18765;
export const ENGINE_HOST = "127.0.0.1";
export const DEFAULT_LOCAL_BASE_URL = `http://${ENGINE_HOST}:${ENGINE_PORT}/v1`;
export const DEFAULT_LOCAL_API_MODEL = "qwen-3.8-27b";

export const GGUF_FILE = "Qwen3.8-27B-Q4_K_M.gguf";
/** bartowski Q4_K_M of official Qwen/Qwen3.8-27B. */
export const GGUF_BYTES = 17_772_537_440;
export const GGUF_URL =
  "https://huggingface.co/bartowski/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-Q4_K_M.gguf";

/**
 * Vision projector. The main GGUF is text-only until llama-server is started
 * with `--mmproj`. bartowski ships this next to the weights (~928 MB).
 */
export const MMPROJ_FILE = "mmproj-Qwen3.8-27B-f16.gguf";
export const MMPROJ_URL =
  "https://huggingface.co/bartowski/Qwen3.8-27B-GGUF/resolve/main/mmproj-Qwen3.8-27B-f16.gguf";
/** Hugging Face lists the f16 projector as 928 MB. */
export const MMPROJ_BYTES = 928 * 1024 * 1024;
/** A partial download is not usable — anything under this is treated as missing. */
export const MMPROJ_MIN_BYTES = 100 * 1024 * 1024;

export const LLAMA_CPP_RELEASE = "b10566";
export const LLAMA_CPP_RELEASE_API = `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${LLAMA_CPP_RELEASE}`;

export type EngineGpu = "nvidia" | "metal" | "vulkan" | "none";

export type EngineDownloadEvent =
  | {
      type: "progress";
      label: string;
      completed: number;
      total: number;
      percent: number | null;
    }
  | { type: "status"; message: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface EngineStatus {
  ggufReady: boolean;
  ggufBytes: number;
  ggufExpected: number;
  mmprojReady: boolean;
  mmprojBytes: number;
  mmprojExpected: number;
  serverReady: boolean;
  running: boolean;
  baseUrl: string;
  apiModel: string;
  hint: string;
}

const ALLOWED_HOSTS = new Set([
  "huggingface.co",
  "hf.co",
  "cdn-lfs.huggingface.co",
  "cdn-lfs-us-1.huggingface.co",
  "cas-bridge.xethub.hf.co",
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

/** Only Hugging Face (this GGUF) and official llama.cpp release assets. */
export function isAllowedDownloadUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host) && !host.endsWith(".hf.co")) return false;
  if (host === "github.com" || host === "api.github.com") {
    return url.pathname.includes("/ggml-org/llama.cpp/");
  }
  if (host === "huggingface.co" || host === "hf.co") {
    return (
      url.pathname.includes("/bartowski/Qwen3.8-27B-GGUF/") ||
      url.pathname.includes(`/${GGUF_FILE}`)
    );
  }
  return true;
}

export function assertAllowedDownloadUrl(raw: string): URL {
  if (!isAllowedDownloadUrl(raw)) {
    throw new Error("That download is not on the allow-list.");
  }
  return new URL(raw);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = v >= 10 || i === 0 ? 0 : 1;
  return `${v.toFixed(digits)} ${units[i]}`;
}

export function downloadPercent(completed: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.round((completed / total) * 100));
}

/**
 * Pick a llama.cpp release asset for this machine.
 *
 * GPU builds when we can; a CPU build always exists as the last resort.
 */
export function pickLlamaAsset(
  assets: string[],
  opts: { platform: string; arch: string; gpu: EngineGpu }
): string | null {
  const names = assets.filter((n) => typeof n === "string" && n.length > 0);
  const has = (re: RegExp) => names.find((n) => re.test(n)) ?? null;
  const { platform, arch, gpu } = opts;
  const x64 = arch === "x64" || arch === "x86_64";
  const arm = arch === "arm64" || arch === "aarch64";

  if (platform === "darwin") {
    if (arm) return has(/llama-b\d+-bin-macos-arm64\.tar\.gz$/);
    return has(/llama-b\d+-bin-macos-x64\.tar\.gz$/);
  }

  if (platform === "win32") {
    if (gpu === "nvidia" && x64) {
      return (
        has(/llama-b\d+-bin-win-cuda-12\.4-x64\.zip$/) ??
        has(/llama-b\d+-bin-win-cuda-\d+\.\d+-x64\.zip$/)
      );
    }
    if (x64) {
      return (
        has(/llama-b\d+-bin-win-vulkan-x64\.zip$/) ??
        has(/llama-b\d+-bin-win-cpu-x64\.zip$/)
      );
    }
    if (arm) return has(/llama-b\d+-bin-win-cpu-arm64\.zip$/);
  }

  if (platform === "linux") {
    if (arm) return has(/llama-b\d+-bin-ubuntu-arm64\.tar\.gz$/);
    if (gpu === "vulkan" || gpu === "nvidia") {
      return (
        has(/llama-b\d+-bin-ubuntu-vulkan-x64\.tar\.gz$/) ??
        has(/llama-b\d+-bin-ubuntu-x64\.tar\.gz$/)
      );
    }
    return has(/llama-b\d+-bin-ubuntu-x64\.tar\.gz$/);
  }

  return null;
}

/**
 * Context the in-app sidecar actually opens.
 *
 * The catalog model is 262K, but that KV cache is another ~16 GB on top of
 * the 17 GB weights. 80K is enough for the agent prompt + tools + a long
 * turn, and with q8_0 KV it costs a few GB, not another model.
 */
export const SIDECAR_CTX = 81_920;

/** Output ceiling on the local wire. Input + this must stay under SIDECAR_CTX. */
export const SIDECAR_MAX_OUTPUT = 6_144;

/** Rough token cost of the workspace tool schemas on the wire. */
export const LOCAL_TOOL_RESERVE = 10_000;

/**
 * Bump this when sidecar flags change so a running llama-server is
 * restarted instead of keeping yesterday's args.
 */
export const SIDECAR_LAUNCH = "c81920-q8-mtp2";

/** Args for the sidecar. Host is loopback-only on purpose. */
export function sidecarArgs(
  ggufPath: string,
  mmprojPath?: string | null
): string[] {
  const args = [
    "-m",
    ggufPath,
    "-a",
    DEFAULT_LOCAL_API_MODEL,
    "--host",
    ENGINE_HOST,
    "--port",
    String(ENGINE_PORT),
    "--jinja",
    "--reasoning-format",
    "deepseek",
    "-c",
    String(SIDECAR_CTX),
    "-ngl",
    "99",
    // q8_0 KV is ~half of f16. 80K at f16 would add several GB on a machine
    // that already committed ~17 GB of weights.
    "--cache-type-k",
    "q8_0",
    "--cache-type-v",
    "q8_0",
    // Smaller batches cut the prefill spike on a 73k-token agent prompt.
    "-b",
    "512",
    "-ub",
    "256",
    "--parallel",
    "1",
    // Qwen 3.8 ships an MTP draft head in the same GGUF. Two draft tokens
    // is the safe default: ~1.5x decode, ~0.8 GB extra, same answers.
    // n-max 8 is slower; we do not open that.
    "--spec-type",
    "draft-mtp",
    "--spec-draft-n-max",
    "2",
  ];
  // Without this the 27B is text-only even though the catalog model is a VLM.
  if (mmprojPath) {
    args.push("--mmproj", mmprojPath);
  }
  return args;
}

export function engineHint(s: {
  ggufReady: boolean;
  mmprojReady?: boolean;
  serverReady: boolean;
  running: boolean;
}): string {
  if (s.running && s.ggufReady) {
    return s.mmprojReady === false
      ? "Sidecar is up, but the vision projector is missing — click Download so Qwen can see images and video."
      : "Ready on this PC. The 27B weights are ~17 GB; 25–30 GB committed on a 32 GB machine is expected. This window only sends chat.";
  }
  if (s.ggufReady && s.serverReady) {
    return s.mmprojReady === false
      ? "Weights are on disk. Download the vision projector (~0.9 GB) so Qwen can see images and video, then Start."
      : "Weights are on disk. Start the sidecar to chat — the UI process will not load them.";
  }
  if (s.ggufReady) {
    return "Weights are on disk. The engine binary is still missing — click Download.";
  }
  return "Download Qwen 3.8 27B into this app (~16.5 GB plus a 0.9 GB vision projector). Your PC runs it; nothing is sent to a cloud provider.";
}

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
/**
 * Treat the weights as downloaded once they are this large.
 *
 * Requiring the exact catalog byte count made a finished download look
 * missing (HF can report a slightly different size, and a 99% file is
 * already usable). Below this is a partial .part, not Qwen.
 */
export const GGUF_MIN_BYTES = Math.floor(GGUF_BYTES * 0.98);

/** True when the on-disk GGUF is complete enough to start. */
export function ggufLooksComplete(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes >= GGUF_MIN_BYTES;
}

/** Unload the sidecar after this long with no local chat request. */
export const SIDECAR_IDLE_MS = 10 * 60 * 1000;
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
  /** What the running llama-server actually opened. Null if unknown. */
  nCtx?: number | null;
  spec?: SidecarSpecState;
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
 * Optional llama-server flags the user can toggle or add.
 *
 * Base args (host, ctx, KV) stay fixed. These are the spec/speed knobs
 * people paste from TikTok — MTP is on by default; the rest are opt-in
 * because they can fail on CPU.
 */
export interface SpecPreset {
  id: string;
  label: string;
  blurb: string;
  args: string[];
  /** On unless the user turns it off. */
  on: boolean;
}

export const SPEC_PRESETS: SpecPreset[] = [
  {
    id: "mtp",
    label: "MTP draft · 2 tokens",
    blurb: "Uses the draft head already in the GGUF. Same answers, faster decode. ~0.8 GB extra.",
    args: ["--spec-type", "draft-mtp", "--spec-draft-n-max", "2"],
    on: true,
  },
  {
    id: "flash",
    label: "Flash attention",
    blurb: "Faster attention on NVIDIA / Metal. Leave off on CPU — it can refuse to start.",
    args: ["-fa", "on"],
    on: false,
  },
  {
    id: "shift",
    label: "Context shift",
    blurb: "When the window fills, shift old tokens instead of 400ing.",
    args: ["--context-shift"],
    on: false,
  },
];

export interface SidecarSpecState {
  enabled: string[];
  extra: string[];
}

export function defaultSpecState(): SidecarSpecState {
  return {
    enabled: SPEC_PRESETS.filter((p) => p.on).map((p) => p.id),
    extra: [],
  };
}

/** Split a typed flag line into argv tokens. Rejects shell metacharacters. */
export function parseUserFlags(
  raw: string
): { ok: true; tokens: string[] } | { ok: false; error: string } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { ok: false, error: "Empty flag." };
  if (!parts[0].startsWith("-")) {
    return { ok: false, error: "Start with a flag, e.g. --spec-draft-p-min 0.85" };
  }
  for (const part of parts) {
    if (/[;|&$`\n\r<>\\]/.test(part)) {
      return { ok: false, error: "That flag has a shell character." };
    }
    if (part.startsWith("-")) {
      if (!/^--?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part)) {
        return { ok: false, error: `Not a flag: ${part}` };
      }
    } else if (!/^[A-Za-z0-9_.:%=,+/-]+$/.test(part)) {
      return { ok: false, error: `Not a safe value: ${part}` };
    }
  }
  return { ok: true, tokens: parts };
}

export function sidecarLaunchId(spec: SidecarSpecState = defaultSpecState()): string {
  const enabled = [...spec.enabled].sort().join("+");
  const extra = spec.extra.join(" ");
  return `c${SIDECAR_CTX}-q8-${enabled}-${extra}`;
}

/** Kept so older callers still compile. Prefer sidecarLaunchId. */
export const SIDECAR_LAUNCH = sidecarLaunchId();

/** Args for the sidecar. Host is loopback-only on purpose. */
export function sidecarArgs(
  ggufPath: string,
  mmprojPath?: string | null,
  spec: SidecarSpecState = defaultSpecState()
): string[] {
  const enabled = new Set(spec.enabled);
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
  ];
  for (const preset of SPEC_PRESETS) {
    if (enabled.has(preset.id)) args.push(...preset.args);
  }
  args.push(...spec.extra);
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
  nCtx?: number | null;
  ggufBytes?: number;
}): string {
  if (s.running && s.ggufReady) {
    return s.mmprojReady === false
      ? "Sidecar is up, but the vision projector is missing — click Download so Qwen can see images and video."
      : "Qwen is loaded on this PC (~25–30 GB committed). Unload it when you switch to Ox or DeepSeek so the RAM comes back.";
  }
  if (s.ggufReady && s.serverReady) {
    return s.mmprojReady === false
      ? "Downloaded. Get the vision projector (~0.9 GB) so Qwen can see images, then Start. It is not using RAM until you Start."
      : "Downloaded. Start only when you want to chat with Qwen — Unload frees the 25–30 GB.";
  }
  if (s.ggufReady) {
    return "Weights are on disk. The engine binary is still missing — click Download.";
  }
  if ((s.ggufBytes ?? 0) > 0) {
    return "Partial download on disk — click Download to resume. Qwen is not loaded in RAM yet.";
  }
  return "Download Qwen 3.8 27B into this app (~16.5 GB plus a 0.9 GB vision projector). Your PC runs it; nothing is sent to a cloud provider.";
}

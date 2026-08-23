/**
 * Models the user can pick, and which provider serves each one.
 *
 * Kept free of Node-only APIs so Settings and the composer can import it.
 * Resolution of keys and base URLs lives in `providers.ts`.
 */

export type ProviderId = "deepseek" | "opencode" | "local";

export type ThinkingStyle = "deepseek" | "openai" | "qwen";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  /** Where to mint a key. */
  authUrl: string;
  authLabel: string;
  keyPlaceholder: string;
  /** Shown under the key field. */
  keyBlurb: string;
  thinkingStyle: ThinkingStyle;
}

export interface ModelInfo {
  id: string;
  /** Sent in the Chat Completions `model` field. May differ from `id`. */
  apiModel: string;
  provider: ProviderId;
  label: string;
  shortLabel: string;
  description: string;
  specs: string;
  resumeBlurb: string;
  settingsSubtitle: string;
  /** DeepSeek V4 Pro silently maps requested `low` up to `high`. */
  mapsLowToHigh: boolean;
  /** Cheap enough (or free) to use for search planning / refine / asides. */
  helper: boolean;
  /** Show DeepSeek's Beijing-time peak/off-peak chip. */
  peakHours: boolean;
}

export const DEFAULT_MODEL_ID = "deepseek-v4-pro";

/** Ollama's OpenAI-compatible host. Overridable in Settings. */
export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";

/** Ollama tag for Qwen3.8 27B. vLLM uses `Qwen/Qwen3.8-27B` instead. */
export const DEFAULT_LOCAL_API_MODEL = "qwen3.8:27b";

export const QWEN_38_27B_ID = "qwen-3.8-27b";

export const LOCAL_HOST_PRESETS = [
  {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiModel: "qwen3.8:27b",
  },
  {
    id: "vllm",
    label: "vLLM",
    baseUrl: "http://127.0.0.1:8000/v1",
    apiModel: "Qwen/Qwen3.8-27B",
  },
  {
    id: "llamacpp",
    label: "llama.cpp",
    baseUrl: "http://127.0.0.1:8080/v1",
    apiModel: "Qwen3.8-27B",
  },
] as const;

export const PROVIDER_INFO: Record<ProviderId, ProviderInfo> = {
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    authUrl: "https://platform.deepseek.com",
    authLabel: "platform.deepseek.com",
    keyPlaceholder: "sk-...",
    keyBlurb: "Required for V4 Pro and V4 Flash.",
    thinkingStyle: "deepseek",
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    authUrl: "https://opencode.ai/auth",
    authLabel: "opencode.ai/auth",
    keyPlaceholder: "sk-zen-...",
    keyBlurb:
      "A Zen API key from OpenCode. Required for Ox Alpha — the same OpenAI-compatible Chat Completions API DeepSeek uses.",
    thinkingStyle: "openai",
  },
  local: {
    id: "local",
    name: "Local",
    authUrl: "https://ollama.com/library/qwen3.8",
    authLabel: "your machine",
    keyPlaceholder: "(optional)",
    keyBlurb:
      "Any OpenAI-compatible host on this machine — Ollama, vLLM, or llama.cpp. No cloud key.",
    thinkingStyle: "qwen",
  },
};

/**
 * App-level catalog.
 *
 * `id` is what Settings, localStorage and saved replies store.
 * `apiModel` is what goes on the wire — OpenCode serves Ox Alpha as
 * `x-preview-f-free` (see opencode.ai/docs/zen). Local Qwen's wire id
 * is overridable in Settings because Ollama and vLLM name it differently.
 */
export const MODELS: ModelInfo[] = [
  {
    id: "deepseek-v4-pro",
    apiModel: "deepseek-v4-pro",
    provider: "deepseek",
    label: "DeepSeek V4 Pro",
    shortLabel: "V4 Pro",
    description: "49B parameters. Frontier-level quality for the hardest tasks.",
    specs: "1M context · 384K max output",
    resumeBlurb: "Best at long agent work",
    settingsSubtitle: "49B params • Frontier",
    mapsLowToHigh: true,
    helper: false,
    peakHours: true,
  },
  {
    id: "deepseek-v4-flash",
    apiModel: "deepseek-v4-flash",
    provider: "deepseek",
    label: "DeepSeek V4 Flash",
    shortLabel: "V4 Flash",
    description: "13B parameters. Fast and economical for quick tasks.",
    specs: "1M context · 384K max output",
    resumeBlurb: "About 6x cheaper",
    settingsSubtitle: "13B params • Fast",
    mapsLowToHigh: false,
    helper: true,
    peakHours: true,
  },
  {
    id: "ox-alpha",
    apiModel: "x-preview-f-free",
    provider: "opencode",
    label: "Ox Alpha",
    shortLabel: "Ox Alpha",
    description:
      "Stealth reasoning model on OpenCode Zen. 1M context, multimodal, free during the preview.",
    specs: "1M context · 128K max output · free preview",
    resumeBlurb: "Free on OpenCode Zen",
    settingsSubtitle: "OpenCode · 1M context · free",
    mapsLowToHigh: false,
    helper: true,
    peakHours: false,
  },
  {
    id: QWEN_38_27B_ID,
    apiModel: DEFAULT_LOCAL_API_MODEL,
    provider: "local",
    label: "Qwen 3.8 27B",
    shortLabel: "Qwen 3.8",
    description:
      "Local 27B. Thinking on by default, with reasoning_effort (low / medium / xhigh).",
    specs: "262K context · runs on your GPU · free",
    resumeBlurb: "Local Qwen 3.8 27B",
    settingsSubtitle: "Local · 27B · thinking",
    mapsLowToHigh: false,
    helper: false,
    peakHours: false,
  },
];

export function getModel(id: string | null | undefined): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

export function getProviderInfo(id: ProviderId): ProviderInfo {
  return PROVIDER_INFO[id];
}

export function isKnownModel(id: string | null | undefined): boolean {
  return Boolean(id && MODELS.some((m) => m.id === id));
}

/** True when the selected model has whatever it needs to send. */
export function hasKeyForModel(
  modelId: string | null | undefined,
  keys: {
    deepseekKey?: string;
    opencodeKey?: string;
    /** Local models need a host, not a cloud key. */
    localBaseUrl?: string;
  }
): boolean {
  const provider = getModel(modelId).provider;
  if (provider === "local") {
    // A default host is always assumed. The send fails later if nothing is
    // listening — that is a reachability error, not a missing-key one.
    return true;
  }
  const raw = provider === "opencode" ? keys.opencodeKey : keys.deepseekKey;
  return Boolean(raw && raw.trim());
}

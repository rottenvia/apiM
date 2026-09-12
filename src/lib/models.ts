/**
 * Models the user can pick, and which provider serves each one.
 *
 * Kept free of Node-only APIs so Settings and the composer can import it.
 * Resolution of keys and base URLs lives in `providers.ts`.
 */

import {
  DEFAULT_LOCAL_API_MODEL,
  DEFAULT_LOCAL_BASE_URL,
} from "@/lib/local-engine-shared";
import type { OxHost } from "@/lib/ox-host";

export { DEFAULT_LOCAL_API_MODEL, DEFAULT_LOCAL_BASE_URL };

export type ProviderId = "deepseek" | "opencode" | "openrouter" | "local";

export type ThinkingStyle = "deepseek" | "openai" | "qwen";

/**
 * How this catalog model takes pictures (and whether it can take video).
 *
 *   none   — text only, no helper either
 *   helper — pixels must be described by a separate vision provider first
 *   native — the Chat Completions request can carry image_url / video_url
 */
export type VisionMode = "none" | "native" | "helper";

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
  /**
   * How screenshots reach this model.
   *
   * DeepSeek's hosted Chat Completions API is text-only, so images go
   * through a vision helper. Ox Alpha and Qwen 3.8 27B are native VLMs.
   */
  vision: VisionMode;
  /** Native video input (MP4). Independent of `vision`. */
  video: boolean;
  /**
   * Ox Alpha only: no per-call tool ceilings. The model can read a whole
   * file, a whole page, and as many paths as it asks for in one call.
   * (GLM 5.3 Flash is the same model Ox Alpha previewed, so it keeps the
   * open limits.)
   */
  openToolLimits: boolean;
  /**
   * Ceiling on generated tokens for ONE round, in tokens.
   *
   * Keyed off the model, not the provider. The old rule was
   * `provider === "opencode" ? 128k : 64k`, which quietly gave GLM 5.3
   * Flash — a 128K-output model — half its window on OpenRouter. That is
   * invisible on prose and fatal on a batch tool call: `edit_files` across
   * twenty files is one enormous JSON argument blob, and a blob cut in
   * half is unparseable, so the whole batch lands as nothing.
   */
  maxOutputTokens: number;
  /**
   * OpenCode-provider models only: pin the model to one host, ignoring the
   * Ox Alpha host button. `x-preview-f-free` follows the button; the free
   * DeepSeek lane exists only on Zen.
   */
  fixedHost?: OxHost;
}

/**
 * Output ceilings, per round.
 *
 * A run is bounded by the round cap and the (optional) spending limit, never
 * by these: a forty-round task generates forty replies, each up to this many
 * tokens, and a short reply costs nothing extra.
 *
 * The paid number exists to bound the worst case on a metered model. A free
 * model has no bill to bound, so it gets its documented window — cutting it
 * short only breaks long files and large batch tool calls.
 */
export const PAID_MAX_OUTPUT_TOKENS = 65_536;
export const FREE_MAX_OUTPUT_TOKENS = 131_072;
/**
 * GLM 5.3 Flash documents 128K max output, and its whole point is long agent
 * work: batch edits across many files are single tool calls whose arguments
 * are tens of thousands of tokens of JSON. It is metered, but cheap, and the
 * spending limit still caps a round through `maxTokensFor`.
 */
export const GLM_MAX_OUTPUT_TOKENS = 131_072;

export const DEFAULT_MODEL_ID = "deepseek-v4-pro";

export const QWEN_38_27B_ID = "qwen-3.8-27b";

export const NEMOTRON_3_ULTRA_ID = "nemotron-3-ultra";

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
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    authUrl: "https://openrouter.ai/settings/keys",
    authLabel: "openrouter.ai/settings/keys",
    keyPlaceholder: "sk-or-v1-...",
    keyBlurb:
      "An OpenRouter API key. Required for GLM 5.3 Flash — and for Ox Alpha when its host is set to OpenRouter.",
    thinkingStyle: "openai",
  },
  local: {
    id: "local",
    name: "On this PC",
    authUrl: "https://huggingface.co/Qwen/Qwen3.8-27B",
    authLabel: "your machine",
    keyPlaceholder: "(optional)",
    keyBlurb:
      "Download Qwen in Settings. A sidecar on this PC runs it; the app stays a thin client. No cloud key.",
    thinkingStyle: "qwen",
  },
};

/**
 * App-level catalog.
 *
 * `id` is what Settings, localStorage and saved replies store.
 * `apiModel` is what goes on the wire — OpenCode serves Ox Alpha as
 * `x-preview-f-free` (see opencode.ai/docs/zen). Local Qwen defaults to
 * the in-app sidecar; a custom host can still override the wire id.
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
    vision: "helper",
    video: false,
    openToolLimits: false,
    maxOutputTokens: PAID_MAX_OUTPUT_TOKENS,
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
    vision: "helper",
    video: false,
    openToolLimits: false,
    maxOutputTokens: PAID_MAX_OUTPUT_TOKENS,
  },
  {
    id: "deepseek-v4-flash-free",
    apiModel: "deepseek-v4-flash-free",
    provider: "opencode",
    fixedHost: "zen",
    label: "DeepSeek V4 Flash Free",
    shortLabel: "V4 Flash Free",
    description:
      "Free preview of DeepSeek V4 Flash on OpenCode Zen. No balance needed — but the quota is low, it is a limited-time offer, and it can end without notice.",
    specs: "1M context · 384K max output · free preview",
    resumeBlurb: "Free on Zen",
    settingsSubtitle: "OpenCode Zen · free preview",
    mapsLowToHigh: false,
    helper: true,
    peakHours: false,
    vision: "helper",
    video: false,
    openToolLimits: false,
    maxOutputTokens: FREE_MAX_OUTPUT_TOKENS,
  },
  {
    id: "ox-alpha",
    apiModel: "x-preview-f-free",
    provider: "opencode",
    label: "Ox Alpha",
    shortLabel: "Ox Alpha",
    description:
      "Stealth reasoning model. 1M context, native image and video. Served by OpenCode Zen or OpenRouter — pick the host in Settings.",
    specs: "1M context · 128K max output · image + video · open tools · free preview",
    resumeBlurb: "Free on Zen or OpenRouter",
    settingsSubtitle: "Zen or OpenRouter · 1M context · free",
    mapsLowToHigh: false,
    helper: true,
    peakHours: false,
    vision: "native",
    video: true,
    openToolLimits: true,
    maxOutputTokens: FREE_MAX_OUTPUT_TOKENS,
  },
  {
    id: "glm-5.3-flash",
    apiModel: "z-ai/glm-5.3-flash",
    provider: "openrouter",
    label: "GLM 5.3 Flash",
    shortLabel: "GLM 5.3 Flash",
    description:
      "Z.ai's agent model — the model that ran as the Ox Alpha stealth preview, now official on OpenRouter. 1M context, native images and video, built for long agent tasks. 50% launch discount through Sep 9.",
    specs: "1M context · 128K max output · image + video · open tools",
    resumeBlurb: "Ox Alpha, now official",
    settingsSubtitle: "OpenRouter · 1M context · fast",
    mapsLowToHigh: false,
    helper: false,
    peakHours: false,
    vision: "native",
    video: true,
    openToolLimits: true,
    maxOutputTokens: GLM_MAX_OUTPUT_TOKENS,
  },
  {
    id: NEMOTRON_3_ULTRA_ID,
    apiModel: "nvidia/nemotron-3-ultra-550b-a55b:free",
    provider: "openrouter",
    label: "Nemotron 3 Ultra",
    shortLabel: "Nemotron 3",
    description:
      "NVIDIA's open frontier model — 550B MoE with 55B active, built for reasoning and agent orchestration. Runs on OpenRouter's free lane; the wire is text-only, so screenshots go through the free local OCR helper. The paid lane can be added as a custom model: nvidia/nemotron-3-ultra-550b-a55b.",
    specs: "1M context · 65K max output · OpenRouter free lane",
    resumeBlurb: "NVIDIA's open frontier MoE",
    settingsSubtitle: "OpenRouter · 1M context · free",
    mapsLowToHigh: false,
    helper: false,
    peakHours: false,
    vision: "helper",
    video: false,
    openToolLimits: false,
    maxOutputTokens: 65_536,
  },
  {
    id: QWEN_38_27B_ID,
    apiModel: DEFAULT_LOCAL_API_MODEL,
    provider: "local",
    label: "Qwen 3.8 27B",
    shortLabel: "Qwen 3.8",
    description:
      "Download in Settings. Your PC runs the 27B in a sidecar so this app stays light. Native vision — images and video, no cloud helper.",
    specs: "80K window on this PC · ~17 GB weights · native VLM · free",
    resumeBlurb: "Qwen 3.8 27B on this PC",
    settingsSubtitle: "On this PC · 27B · thinking",
    mapsLowToHigh: false,
    helper: false,
    peakHours: false,
    vision: "native",
    video: true,
    openToolLimits: false,
    maxOutputTokens: PAID_MAX_OUTPUT_TOKENS,
  },
];

/**
 * Custom models — any wire id on OpenRouter or OpenCode Zen, added by the
 * user in Settings → Model.
 *
 * The built-in catalog above is curated; this registry is not. A def is
 * just a provider and a wire id (plus optional label and capability
 * flags), and it becomes a full ModelInfo with conservative defaults:
 * text on the wire (screenshots reach it through the free local OCR
 * helper, exactly like DeepSeek), metered-style 65K output ceiling,
 * closed tool limits. The defs live in the browser's localStorage and
 * travel with each chat request, so both sides resolve the same ids:
 *
 *   browser  — registerCustomModels() from the settings state
 *   server   — registerCustomModels() from the request body, before
 *              resolveChatTarget() runs
 *
 * Catalog ids are `custom:<provider>:<wire id>` so a custom entry can
 * never collide with a built-in one, and the wire id stays visible in it.
 */
export type CustomModelProvider = "openrouter" | "opencode";

export interface CustomModelDef {
  provider: CustomModelProvider;
  /** Value of the Chat Completions `model` field, e.g. `nvidia/...`. */
  apiModel: string;
  /** Optional display name; derived from the wire id when omitted. */
  label?: string;
  /** Per-round output ceiling. Defaults to the paid-model ceiling. */
  maxOutputTokens?: number;
  /** Native image input. Off by default — pixels go through the OCR helper. */
  vision?: boolean;
  /** Native video input. Off by default. */
  video?: boolean;
}

export const MAX_CUSTOM_MODELS = 24;

const CUSTOM_ID_PREFIX = "custom:";

export function customModelId(
  provider: CustomModelProvider,
  apiModel: string
): string {
  return `${CUSTOM_ID_PREFIX}${provider}:${apiModel}`;
}

/** `nvidia/nemotron-3-ultra-550b-a55b:free` → `Nemotron 3 Ultra 550b`. */
function labelFromWireId(apiModel: string): string {
  const tail = apiModel.split("/").pop() ?? apiModel;
  const cleaned = tail.replace(/:free$/i, "");
  const words = cleaned.split(/[-_.]+/).filter(Boolean);
  const pretty = words
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
  return pretty.trim() || apiModel;
}

export function toCustomModel(def: CustomModelDef): ModelInfo {
  const label = def.label?.trim() || labelFromWireId(def.apiModel);
  const providerName =
    def.provider === "openrouter" ? "OpenRouter" : "OpenCode Zen";
  const maxOutput =
    typeof def.maxOutputTokens === "number" && def.maxOutputTokens > 0
      ? Math.min(def.maxOutputTokens, FREE_MAX_OUTPUT_TOKENS)
      : PAID_MAX_OUTPUT_TOKENS;
  return {
    id: customModelId(def.provider, def.apiModel),
    apiModel: def.apiModel,
    provider: def.provider,
    // A custom OpenCode model lives on Zen only — the Ox host button is
    // about Ox Alpha's two front doors, not about arbitrary Zen models.
    ...(def.provider === "opencode" ? { fixedHost: "zen" as const } : {}),
    label,
    shortLabel: label.length > 18 ? `${label.slice(0, 17)}…` : label,
    description: `Custom model on ${providerName} — wire id ${def.apiModel}. Added by you in Settings.`,
    specs: `${Math.round(maxOutput / 1024)}K max output${def.vision ? " · image" : ""}${def.video ? " + video" : ""} · added by you`,
    resumeBlurb: `${label} (${providerName})`,
    settingsSubtitle: `${providerName} · custom`,
    mapsLowToHigh: false,
    helper: false,
    peakHours: false,
    // The wire is assumed text-only: screenshots are described by the free
    // local OCR helper (DeepSeek's path) unless the user ticked native.
    // Silently dropping attached pixels is the failure this avoids.
    vision: def.vision ? "native" : "helper",
    video: def.video === true,
    openToolLimits: false,
    maxOutputTokens: maxOutput,
  };
}

/**
 * Accept an unknown payload (localStorage, request body) and return only
 * the well-formed defs. A hand-edited or corrupted blob must never throw
 * during settings hydration or break a chat request.
 */
export function parseCustomModelDefs(raw: unknown): CustomModelDef[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const defs: CustomModelDef[] = [];
  for (const item of raw) {
    if (defs.length >= MAX_CUSTOM_MODELS) break;
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const provider =
      rec.provider === "openrouter" || rec.provider === "opencode"
        ? (rec.provider as CustomModelProvider)
        : null;
    const apiModel =
      typeof rec.apiModel === "string" ? rec.apiModel.trim() : "";
    if (!provider || !apiModel || apiModel.length > 200) continue;
    const id = customModelId(provider, apiModel);
    if (seen.has(id)) continue;
    seen.add(id);
    defs.push({
      provider,
      apiModel,
      label: typeof rec.label === "string" ? rec.label.slice(0, 60) : undefined,
      maxOutputTokens:
        typeof rec.maxOutputTokens === "number" &&
        Number.isFinite(rec.maxOutputTokens)
          ? rec.maxOutputTokens
          : undefined,
      vision: rec.vision === true,
      video: rec.video === true,
    });
  }
  return defs;
}

/** The live registry, consulted after the built-in catalog. */
const customModelRegistry: ModelInfo[] = [];

/** Replace the registry. Called on hydration (client) and per request (server). */
export function registerCustomModels(raw: unknown): void {
  const defs = parseCustomModelDefs(raw);
  customModelRegistry.length = 0;
  for (const def of defs) customModelRegistry.push(toCustomModel(def));
}

/** Built-in catalog plus whatever the user added. */
export function allModels(): ModelInfo[] {
  return customModelRegistry.length
    ? [...MODELS, ...customModelRegistry]
    : MODELS;
}

/** Screenshots can reach this model — either natively or via the helper. */
export function modelSeesImages(id: string | null | undefined): boolean {
  const mode = getModel(id).vision;
  return mode === "native" || mode === "helper";
}

/** Blind model: pixels must be described by a separate vision provider. */
export function modelNeedsVisionHelper(id: string | null | undefined): boolean {
  return getModel(id).vision === "helper";
}

/** Native video input (MP4). DeepSeek cannot; Ox, GLM and Qwen can. */
export function modelSeesVideo(id: string | null | undefined): boolean {
  return getModel(id).video;
}

export function modelVision(id: string | null | undefined): VisionMode {
  return getModel(id).vision;
}

/**
 * Per-round output ceiling for this model. Local Qwen is the exception the
 * caller handles: the sidecar's window, not the catalog, decides there.
 */
export function maxOutputTokensFor(id: string | null | undefined): number {
  return getModel(id).maxOutputTokens;
}

export function getModel(id: string | null | undefined): ModelInfo {
  return (
    MODELS.find((m) => m.id === id) ??
    customModelRegistry.find((m) => m.id === id) ??
    MODELS[0]
  );
}

export function getProviderInfo(id: ProviderId): ProviderInfo {
  return PROVIDER_INFO[id];
}

export function isKnownModel(id: string | null | undefined): boolean {
  return Boolean(
    id &&
      (MODELS.some((m) => m.id === id) ||
        customModelRegistry.some((m) => m.id === id))
  );
}

/** True when the selected model has whatever it needs to send. */
export function hasKeyForModel(
  modelId: string | null | undefined,
  keys: {
    deepseekKey?: string;
    opencodeKey?: string;
    openrouterKey?: string;
    /** Which Ox Alpha front door is selected. */
    oxHost?: string;
    /** Local models need a host, not a cloud key. */
    localBaseUrl?: string;
  }
): boolean {
  const model = getModel(modelId);
  const provider = model.provider;
  if (provider === "local") {
    // A default host is always assumed. The send fails later if nothing is
    // listening — that is a reachability error, not a missing-key one.
    return true;
  }
  if (provider === "openrouter") {
    return Boolean(keys.openrouterKey && keys.openrouterKey.trim());
  }
  if (provider === "opencode") {
    // A fixedHost model lives on one front door no matter what the Ox
    // button says; everything else follows the button.
    const host =
      model.fixedHost ?? (keys.oxHost === "openrouter" ? "openrouter" : "zen");
    const raw = host === "openrouter" ? keys.openrouterKey : keys.opencodeKey;
    return Boolean(raw && raw.trim());
  }
  return Boolean(keys.deepseekKey && keys.deepseekKey.trim());
}

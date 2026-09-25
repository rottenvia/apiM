/**
 * Models the user can pick, and which provider serves each one.
 *
 * Kept free of Node-only APIs so Settings and the composer can import it.
 * Resolution of keys and base URLs lives in `providers.ts`.
 *
 * Custom OpenRouter models (added in Settings → Model) are NOT in this file:
 * they live in the browser's localStorage, ride each chat request, and are
 * merged with this catalog by `resolveModelInfo`. Anything that must work
 * for customs (resolution, pricing, vision) takes the merged info — never
 * `getModel` alone.
 */

import {
  DEFAULT_LOCAL_API_MODEL,
  DEFAULT_LOCAL_BASE_URL,
} from "@/lib/local-engine-shared";

export { DEFAULT_LOCAL_API_MODEL, DEFAULT_LOCAL_BASE_URL };

export type ProviderId = "deepseek" | "openrouter" | "local";

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
   * through a vision helper. GLM 5.3 Flash and Qwen 3.8 27B are native VLMs.
   */
  vision: VisionMode;
  /** Native video input (MP4). Independent of `vision`. */
  video: boolean;
  /**
   * No per-call tool ceilings: the model can read a whole file, a whole
   * page, and as many paths as it asks for in one call.
   *
   * No catalog model opts in — uncapped reads fed 401k-char results into
   * the transcript and re-bloated every later round. Custom OpenRouter
   * models may still enable it in Settings, with the warning shown there.
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
}

/**
 * A user-added OpenRouter model.
 *
 * Stored in the browser (Settings → Model), sent with every chat request,
 * and merged with the catalog on the server. Validation lives in
 * `sanitizeCustomModelDef` — the server never trusts these fields raw.
 */
export interface CustomModelDef {
  /** `custom:<slug>`, e.g. `custom:anthropic/claude-opus-4-6`. Stable. */
  id: string;
  /** Display name, e.g. `Claude Opus 4.6`. */
  label: string;
  /** OpenRouter slug for the wire, e.g. `anthropic/claude-opus-4-6`. */
  apiModel: string;
  description?: string;
  /** Native VLMs get image_url parts; anything else gets helper descriptions. */
  vision: VisionMode;
  /** Native MP4 input. Off unless the model is known to take video. */
  video: boolean;
  /** Per-round output ceiling, in tokens. */
  maxOutputTokens: number;
  /** Context window, in tokens. Display only (from Verify, or typed). */
  contextLength?: number;
  /** USD per 1M tokens. Absent means cost is unknown, not free. */
  inputPrice?: number;
  outputPrice?: number;
  /** Opt into uncapped per-call tool reads. Off by default — see ModelInfo. */
  openLimits?: boolean;
}

export const CUSTOM_ID_PREFIX = "custom:";

/** True for ids shaped like `custom:<openrouter-slug>`. */
export function isCustomModelId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(CUSTOM_ID_PREFIX);
}

/** OpenRouter slugs look like `vendor/model-name` with an optional `:free`-style suffix. */
// Length is guarded at the call site; this guards shape. The optional
// `:variant` suffix is OpenRouter routing (`:free`, `:nitro`, `:floor`) —
// Verify accepts it, so this must too, or free models verify and then
// refuse to add.
const SLUG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?(?::[A-Za-z0-9-]+)?$/;

/**
 * Validate a custom model definition from the client or localStorage.
 *
 * Returns null when the definition is unusable (no wire id). Everything
 * else is clamped to sane ranges so a hostile or stale payload cannot
 * produce a 65M-token ceiling or a negative price.
 */
export function sanitizeCustomModelDef(
  input: unknown
): CustomModelDef | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const apiModel =
    typeof raw.apiModel === "string" ? raw.apiModel.trim() : "";
  if (!apiModel || apiModel.length > 128 || !SLUG_PATTERN.test(apiModel)) {
    return null;
  }
  const label =
    typeof raw.label === "string" && raw.label.trim()
      ? raw.label.trim().slice(0, 60)
      : apiModel;
  const vision =
    raw.vision === "native" || raw.vision === "none" ? raw.vision : "helper";
  const maxOutput =
    typeof raw.maxOutputTokens === "number" &&
    Number.isFinite(raw.maxOutputTokens)
      ? Math.max(1_000, Math.min(1_000_000, Math.floor(raw.maxOutputTokens)))
      : PAID_MAX_OUTPUT_TOKENS;
  const contextLength =
    typeof raw.contextLength === "number" &&
    Number.isFinite(raw.contextLength) &&
    raw.contextLength > 0
      ? Math.min(100_000_000, Math.floor(raw.contextLength))
      : undefined;
  const price = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10_000
      ? v
      : undefined;
  const description =
    typeof raw.description === "string" && raw.description.trim()
      ? raw.description.trim().slice(0, 300)
      : undefined;
  return {
    id: `${CUSTOM_ID_PREFIX}${apiModel}`,
    label,
    apiModel,
    ...(description ? { description } : {}),
    vision,
    video: raw.video === true,
    maxOutputTokens: maxOutput,
    ...(contextLength ? { contextLength } : {}),
    ...(price(raw.inputPrice) !== undefined
      ? { inputPrice: price(raw.inputPrice) as number }
      : {}),
    ...(price(raw.outputPrice) !== undefined
      ? { outputPrice: price(raw.outputPrice) as number }
      : {}),
    ...(raw.openLimits === true ? { openLimits: true } : {}),
  };
}

/** Human context/pricing line for a custom model, e.g. `200K ctx · $3/$15 per 1M`. */
export function customSpecs(def: CustomModelDef): string {
  const bits: string[] = [];
  if (def.contextLength) {
    const ctx = def.contextLength;
    bits.push(
      ctx >= 1_000_000
        ? `${+(ctx / 1_000_000).toFixed(2)}M ctx`
        : `${Math.round(ctx / 1000)}K ctx`
    );
  }
  if (def.inputPrice !== undefined || def.outputPrice !== undefined) {
    const fmt = (v: number | undefined) =>
      v === undefined ? "?" : v === 0 ? "$0" : `$${v}`;
    bits.push(`${fmt(def.inputPrice)}/${fmt(def.outputPrice)} per 1M`);
  }
  bits.push("custom");
  return bits.join(" · ");
}

/** A custom definition as the rest of the app expects a model to look. */
export function customToModelInfo(def: CustomModelDef): ModelInfo {
  return {
    id: def.id,
    apiModel: def.apiModel,
    provider: "openrouter",
    label: def.label,
    shortLabel: def.label.length > 22 ? `${def.label.slice(0, 21)}…` : def.label,
    description:
      def.description ??
      `Custom OpenRouter model (${def.apiModel}). Pricing and vision come from Settings — Verify fills them in.`,
    specs: customSpecs(def),
    resumeBlurb: "Custom OpenRouter",
    settingsSubtitle: `OpenRouter · ${def.apiModel}`,
    mapsLowToHigh: false,
    // Customs are main models, never side-call helpers: the helper must be
    // a known-cheap lane (Flash on DeepSeek, Nemotron-free on OpenRouter), and a
    // custom's price is user-typed rather than verified.
    helper: false,
    peakHours: false,
    vision: def.vision,
    video: def.video,
    openToolLimits: def.openLimits === true,
    maxOutputTokens: def.maxOutputTokens,
  };
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
/**
 * DeepSeek V4.1 Flash via OpenRouter (Morph endpoint, 943K documented max).
 * Same generous window as GLM: it is the other cheap agent lane, and long
 * tool-call arguments need the room. The spending limit still caps a round
 * through `maxTokensFor`.
 */
export const OR_AGENT_MAX_OUTPUT_TOKENS = 131_072;

export const DEFAULT_MODEL_ID = "glm-5.3-flash";

export const QWEN_38_27B_ID = "qwen-3.8-27b";

/** The free OpenRouter lane customs and GLM fall back to for side calls. */
export const FREE_OPENROUTER_MODEL_ID = "nvidia-nemotron-3-ultra-free";

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
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    authUrl: "https://openrouter.ai/settings/keys",
    authLabel: "openrouter.ai/settings/keys",
    keyPlaceholder: "sk-or-v1-...",
    keyBlurb:
      "One key covers every OpenRouter model: GLM 5.3 Flash, DeepSeek V4.1 Flash, Nemotron 3 Ultra (free), and anything custom you add.",
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
 * `apiModel` is what goes on the wire.
 */
export const MODELS: ModelInfo[] = [
  {
    id: "glm-5.3-flash",
    apiModel: "z-ai/glm-5.3-flash",
    provider: "openrouter",
    label: "GLM 5.3 Flash",
    shortLabel: "GLM 5.3 Flash",
    description:
      "Z.ai's agent model. 1M context, native images and video, built for long agent tasks. This app's default.",
    specs: "1M context · 128K max output · image + video",
    resumeBlurb: "Fast agent default",
    settingsSubtitle: "OpenRouter · 1M context · fast",
    mapsLowToHigh: false,
    helper: false,
    peakHours: false,
    vision: "native",
    video: true,
    // Capped: uncapped 401k reads re-fed fat fresh results into the
    // transcript on the default model — the exact fat-wire disease.
    openToolLimits: false,
    maxOutputTokens: GLM_MAX_OUTPUT_TOKENS,
  },
  {
    id: "deepseek-v4.1-flash",
    apiModel: "deepseek/deepseek-v4.1-flash",
    provider: "openrouter",
    label: "DeepSeek V4.1 Flash",
    shortLabel: "V4.1 Flash",
    description:
      "DeepSeek's sparse-MoE agent model via OpenRouter's cheapest tools-capable endpoint (Morph). 1M context, native images, tools + reasoning.",
    specs: "1M context · 131K max output · images",
    resumeBlurb: "Cheap DeepSeek agent lane",
    settingsSubtitle: "OpenRouter · Morph endpoint",
    mapsLowToHigh: false,
    helper: false,
    peakHours: false,
    vision: "native",
    video: false,
    // Capped like every catalog model.
    openToolLimits: false,
    maxOutputTokens: OR_AGENT_MAX_OUTPUT_TOKENS,
  },
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
    id: FREE_OPENROUTER_MODEL_ID,
    apiModel: "nvidia/nemotron-3-ultra-550b-a55b:free",
    provider: "openrouter",
    label: "Nemotron 3 Ultra Free",
    shortLabel: "Nemotron Free",
    description:
      "NVIDIA's 550B-MoE flagship on OpenRouter's free tier. The smartest $0 lane for coding, reasoning and agent work. Free — but it is a shared pool, so evenings can be slow.",
    specs: "1M context · free · tools + reasoning",
    resumeBlurb: "Free on OpenRouter",
    settingsSubtitle: "OpenRouter · free",
    mapsLowToHigh: false,
    helper: true,
    peakHours: false,
    vision: "helper",
    video: false,
    openToolLimits: false,
    maxOutputTokens: FREE_MAX_OUTPUT_TOKENS,
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

/** Screenshots can reach this model — either natively or via the helper. */
export function modelSeesImages(id: string | null | undefined): boolean {
  const mode = getModel(id).vision;
  return mode === "native" || mode === "helper";
}

/** Blind model: pixels must be described by a separate vision provider. */
export function modelNeedsVisionHelper(id: string | null | undefined): boolean {
  return getModel(id).vision === "helper";
}

/** Native video input (MP4). DeepSeek cannot; GLM and Qwen can. */
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
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

/**
 * Catalog first, then the user's customs, then the default.
 *
 * Server paths that accept custom models must use this (or the already
 * resolved `target.model`), never `getModel` — `getModel` cannot see
 * customs and silently returns GLM for them.
 */
export function resolveModelInfo(
  id: string | null | undefined,
  customs?: CustomModelDef[] | null
): ModelInfo {
  const catalog = MODELS.find((m) => m.id === id);
  if (catalog) return catalog;
  if (customs && id) {
    const def = customs.find((c) => c.id === id);
    if (def) return customToModelInfo(def);
  }
  return MODELS[0];
}

export function getProviderInfo(id: ProviderId): ProviderInfo {
  return PROVIDER_INFO[id];
}

export function isKnownModel(id: string | null | undefined): boolean {
  return Boolean(id && MODELS.some((m) => m.id === id));
}

export function isKnownModelOrCustom(
  id: string | null | undefined,
  customs?: CustomModelDef[] | null
): boolean {
  if (!id) return false;
  if (MODELS.some((m) => m.id === id)) return true;
  return Boolean(customs?.some((c) => c.id === id));
}

/** True when the selected model has whatever it needs to send. */
export function hasKeyForModel(
  modelId: string | null | undefined,
  keys: {
    deepseekKey?: string;
    openrouterKey?: string;
    /** Local models need a host, not a cloud key. */
    localBaseUrl?: string;
  },
  customs?: CustomModelDef[] | null
): boolean {
  const model = resolveModelInfo(modelId, customs);
  const provider = model.provider;
  if (provider === "local") {
    // A default host is always assumed. The send fails later if nothing is
    // listening — that is a reachability error, not a missing-key one.
    return true;
  }
  if (provider === "openrouter") {
    return Boolean(keys.openrouterKey && keys.openrouterKey.trim());
  }
  return Boolean(keys.deepseekKey && keys.deepseekKey.trim());
}

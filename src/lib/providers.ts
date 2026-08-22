/**
 * Resolve which LLM endpoint a request should hit.
 *
 * DeepSeek used to be the only provider. Ox Alpha is served by OpenCode Zen
 * at the same Chat Completions shape (`/chat/completions`), so the rest of
 * the agent loop stays identical — only the URL, key and on-the-wire model
 * id change.
 */

import {
  DEFAULT_MODEL_ID,
  MODELS,
  getModel,
  getProviderInfo,
  type ModelInfo,
  type ProviderId,
  type ThinkingStyle,
} from "@/lib/models";

export {
  DEFAULT_MODEL_ID,
  MODELS,
  getModel,
  getProviderInfo,
  type ModelInfo,
  type ProviderId,
  type ThinkingStyle,
};

export interface ChatCredentials {
  deepseekApiKey?: string | null;
  opencodeApiKey?: string | null;
}

export interface ResolvedTarget {
  model: ModelInfo;
  providerId: ProviderId;
  providerName: string;
  thinkingStyle: ThinkingStyle;
  apiKey: string;
  baseUrl: string;
  /** Value of the Chat Completions `model` field. */
  apiModel: string;
}

export interface ResolveFailure {
  ok: false;
  error: string;
}

export interface ResolveSuccess {
  ok: true;
  target: ResolvedTarget;
}

const DEFAULT_BASE: Record<ProviderId, string> = {
  deepseek: "https://api.deepseek.com",
  opencode: "https://opencode.ai/zen/v1",
};

/** Strip a trailing slash so `${base}/chat/completions` never doubles. */
function cleanBase(url: string): string {
  return url.replace(/\/+$/, "");
}

export function providerBaseUrl(id: ProviderId): string {
  if (id === "deepseek") {
    return cleanBase(process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE.deepseek);
  }
  return cleanBase(process.env.OPENCODE_BASE_URL ?? DEFAULT_BASE.opencode);
}

export function keyForProvider(
  id: ProviderId,
  creds: ChatCredentials
): string {
  const raw =
    id === "opencode" ? creds.opencodeApiKey : creds.deepseekApiKey;
  return typeof raw === "string" ? raw.trim() : "";
}

export function hasKeyForModel(
  modelId: string | null | undefined,
  creds: ChatCredentials
): boolean {
  return Boolean(keyForProvider(getModel(modelId).provider, creds));
}

export function resolveChatTarget(
  modelId: string | null | undefined,
  creds: ChatCredentials
): ResolveSuccess | ResolveFailure {
  const model = getModel(modelId);
  const apiKey = keyForProvider(model.provider, creds);
  const info = getProviderInfo(model.provider);

  if (!apiKey) {
    return {
      ok: false,
      error:
        model.provider === "opencode"
          ? "An OpenCode API key is required for Ox Alpha. Add one in Settings (opencode.ai/auth)."
          : "A DeepSeek API key is required for this model. Add one in Settings.",
    };
  }

  return {
    ok: true,
    target: {
      model,
      providerId: model.provider,
      providerName: info.name,
      thinkingStyle: info.thinkingStyle,
      apiKey,
      baseUrl: providerBaseUrl(model.provider),
      apiModel: model.apiModel,
    },
  };
}

/**
 * A cheap (or free) model for search planning, refine and asides.
 *
 * Prefers DeepSeek Flash when that key is present so existing DeepSeek-only
 * setups keep the same cost profile. Falls back to Ox Alpha when the user
 * only connected OpenCode.
 */
export function resolveHelperTarget(
  creds: ChatCredentials
): ResolvedTarget | null {
  const flash = MODELS.find((m) => m.id === "deepseek-v4-flash");
  if (flash && keyForProvider("deepseek", creds)) {
    return {
      model: flash,
      providerId: "deepseek",
      providerName: getProviderInfo("deepseek").name,
      thinkingStyle: "deepseek",
      apiKey: keyForProvider("deepseek", creds),
      baseUrl: providerBaseUrl("deepseek"),
      apiModel: flash.apiModel,
    };
  }

  const ox = MODELS.find((m) => m.id === "ox-alpha");
  if (ox && keyForProvider("opencode", creds)) {
    return {
      model: ox,
      providerId: "opencode",
      providerName: getProviderInfo("opencode").name,
      thinkingStyle: "openai",
      apiKey: keyForProvider("opencode", creds),
      baseUrl: providerBaseUrl("opencode"),
      apiModel: ox.apiModel,
    };
  }

  return null;
}

const VALID_EFFORTS = new Set(["low", "high", "max"]);

/**
 * Provider-specific thinking fields.
 *
 * DeepSeek's REST API takes a top-level `thinking: { type }` plus
 * `reasoning_effort`. OpenCode Zen is OpenAI-compatible and does not
 * document DeepSeek's `thinking` object — sending it can 400, so Ox Alpha
 * only gets `reasoning_effort` when thinking is on.
 */
export function applyThinking(
  body: Record<string, unknown>,
  style: ThinkingStyle,
  thinkingEnabled: boolean,
  effort: string
): void {
  const level = VALID_EFFORTS.has(effort) ? effort : "high";

  if (style === "deepseek") {
    body.thinking = { type: thinkingEnabled ? "enabled" : "disabled" };
    if (thinkingEnabled) body.reasoning_effort = level;
    return;
  }

  if (thinkingEnabled) body.reasoning_effort = level;
}

/** User-facing error for a failed Chat Completions call. */
export function providerHttpError(
  status: number,
  providerName: string,
  detail: string
): string {
  if (status === 401) {
    return `Your ${providerName} API key was rejected. Check it in Settings.`;
  }
  if (status === 402) {
    return `Your ${providerName} account has insufficient balance. Everything done so far is saved — add credit and press Continue on the reply above.`;
  }
  if (status === 429) {
    return `Rate limited by ${providerName}. Please wait a moment and try again.`;
  }
  return `${providerName} API error (${status})${detail ? `: ${detail}` : ""}`;
}

export function providerUnreachable(providerName: string, attempts: number): string {
  return `Couldn't reach the ${providerName} API after ${attempts} attempt(s). Check the network connection and try again.`;
}

export function providerTimedOut(providerName: string, attempts: number): string {
  return `The ${providerName} API took too long to respond, after ${attempts} attempt(s).`;
}

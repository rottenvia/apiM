/**
 * Resolve which LLM endpoint a request should hit.
 *
 * Three front doors, one Chat Completions shape: DeepSeek's own API, the
 * OpenRouter gateway (GLM 5.3 Flash, the free Nemotron lane, and any
 * custom model the user added), and a local OpenAI-compatible host for the
 * on-device Qwen sidecar. The rest of the agent loop stays identical — only
 * the URL, key and on-the-wire model id change.
 */

import {
  DEFAULT_LOCAL_API_MODEL,
  DEFAULT_LOCAL_BASE_URL,
  DEFAULT_MODEL_ID,
  FREE_OPENROUTER_MODEL_ID,
  MODELS,
  getModel,
  getProviderInfo,
  resolveModelInfo,
  type CustomModelDef,
  type ModelInfo,
  type ProviderId,
  type ThinkingStyle,
} from "@/lib/models";

export {
  DEFAULT_LOCAL_API_MODEL,
  DEFAULT_LOCAL_BASE_URL,
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
  /** OpenRouter key — serves GLM, the free Nemotron lane, and customs. */
  openrouterApiKey?: string | null;
  /** OpenAI-compatible host, e.g. http://127.0.0.1:18765/v1 */
  localBaseUrl?: string | null;
  /** Optional. The in-app sidecar ignores it; some custom hosts require one. */
  localApiKey?: string | null;
  /** Overrides the catalog wire id. */
  localApiModel?: string | null;
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
  openrouter: "https://openrouter.ai/api/v1",
  local: DEFAULT_LOCAL_BASE_URL,
};

/**
 * Per-attempt hang cap for HTTP headers on the shared pool.
 *
 * 20s was killing real replies: workspace is always on, so the POST
 * body is huge and the upload alone can eat the budget. 45s still fails
 * a silent 503 quickly; Stop aborts the wait either way.
 */
export const OPENROUTER_ATTEMPT_TIMEOUT_MS = 45_000;

/**
 * After a 200, how long we wait for the first token / tool / finish.
 *
 * Test never exercises this. A 200 with an empty or stalled SSE body is
 * how "green key check, chat never loads, no error" actually happens.
 * Prefill on a workspace prompt needs more than 15s.
 */
export const OPENROUTER_FIRST_TOKEN_MS = 45_000;

/** Strip a trailing slash so `${base}/chat/completions` never doubles. */
function cleanBase(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Accept the ways people paste a local host.
 *
 * `http://127.0.0.1:18765`, `.../v1`, and even `.../v1/chat/completions`
 * should all land on `.../v1` so the chat route can append
 * `/chat/completions`.
 */
export function normalizeOpenAiBase(url: string): string {
  let u = url.trim();
  if (!u) return DEFAULT_LOCAL_BASE_URL;
  u = cleanBase(u);
  u = u.replace(/\/chat\/completions$/i, "");
  u = cleanBase(u);
  if (!/\/v\d+$/i.test(u)) u += "/v1";
  return u;
}

export function providerBaseUrl(id: ProviderId): string {
  if (id === "deepseek") {
    return cleanBase(process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE.deepseek);
  }
  if (id === "local") {
    return normalizeOpenAiBase(
      process.env.LOCAL_BASE_URL ?? DEFAULT_BASE.local
    );
  }
  return cleanBase(process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE.openrouter);
}

export function keyForProvider(
  id: ProviderId,
  creds: ChatCredentials
): string {
  if (id === "local") {
    const raw = creds.localApiKey;
    // The sidecar accepts any bearer token. An empty one still has to be a
    // string so the Authorization header is well-formed.
    return typeof raw === "string" && raw.trim() ? raw.trim() : "local";
  }
  if (id === "openrouter") {
    const raw = creds.openrouterApiKey;
    return typeof raw === "string" ? raw.trim() : "";
  }
  const raw = creds.deepseekApiKey;
  return typeof raw === "string" ? raw.trim() : "";
}

export function hasKeyForModel(
  modelId: string | null | undefined,
  creds: ChatCredentials,
  customs?: CustomModelDef[] | null
): boolean {
  const provider = resolveModelInfo(modelId, customs).provider;
  if (provider === "local") return true;
  return Boolean(keyForProvider(provider, creds));
}

export function resolveChatTarget(
  modelId: string | null | undefined,
  creds: ChatCredentials,
  customs?: CustomModelDef[] | null
): ResolveSuccess | ResolveFailure {
  const model = resolveModelInfo(modelId, customs);

  if (model.provider === "openrouter") {
    const apiKey = keyForProvider("openrouter", creds);
    if (!apiKey) {
      return {
        ok: false,
        error:
          `An OpenRouter API key is required for ${model.label}. ` +
          `Add one in Settings (openrouter.ai/settings/keys).`,
      };
    }
    return {
      ok: true,
      target: {
        model,
        providerId: "openrouter",
        providerName: getProviderInfo("openrouter").name,
        thinkingStyle: "openai",
        apiKey,
        baseUrl: providerBaseUrl("openrouter"),
        apiModel: model.apiModel,
      },
    };
  }

  const apiKey = keyForProvider(model.provider, creds);
  const info = getProviderInfo(model.provider);

  if (model.provider !== "local" && !apiKey) {
    return {
      ok: false,
      error: "A DeepSeek API key is required for this model. Add one in Settings.",
    };
  }

  const baseUrl =
    model.provider === "local"
      ? normalizeOpenAiBase(creds.localBaseUrl || providerBaseUrl("local"))
      : providerBaseUrl(model.provider);

  const apiModel =
    model.provider === "local" && creds.localApiModel?.trim()
      ? creds.localApiModel.trim()
      : model.apiModel;

  return {
    ok: true,
    target: {
      model,
      providerId: model.provider,
      providerName: info.name,
      thinkingStyle: info.thinkingStyle,
      apiKey,
      baseUrl,
      apiModel,
    },
  };
}

/**
 * A cheap (or free) model for search planning, refine and asides.
 *
 * DeepSeek Flash when a DeepSeek key exists — the key already paying for
 * the reply keeps the side calls cheap. Otherwise the free Nemotron lane on
 * OpenRouter when that key exists. Local 27B is deliberately not a helper —
 * it is the main model, not a planner — and customs are never helpers: a
 * side call must ride a known-cheap lane, not a user-typed price.
 *
 * The caller drops the helper when it equals the main model (a Flash
 * conversation judges on Flash already; a Nemotron-free conversation judges on
 * itself).
 */
export function resolveHelperTarget(
  creds: ChatCredentials,
  customs?: CustomModelDef[] | null
): ResolvedTarget | null {
  void customs;
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

  const free = MODELS.find((m) => m.id === FREE_OPENROUTER_MODEL_ID);
  if (free) {
    const apiKey = keyForProvider("openrouter", creds);
    if (apiKey) {
      return {
        model: free,
        providerId: "openrouter",
        providerName: getProviderInfo("openrouter").name,
        thinkingStyle: "openai",
        apiKey,
        baseUrl: providerBaseUrl("openrouter"),
        apiModel: free.apiModel,
      };
    }
  }

  return null;
}

/** Headers for a Chat Completions POST. OpenRouter asks for a referer. */
export function completionHeaders(target: ResolvedTarget): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${target.apiKey}`,
  };
  if (target.providerId === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/eggyeg/apiM";
    headers["X-Title"] = "apiM";
  }
  return headers;
}

/** How long one hung attempt may sit before we treat it as a miss. */
export function attemptTimeoutMs(
  target: ResolvedTarget,
  inputChars = 0
): number {
  if (target.providerId !== "openrouter") return 280_000;
  // Workspace prompts are large. Give the upload a second per 8k chars
  // on top of the base hang cap, but never sit past 90s on a dead host.
  const extra = Math.ceil(Math.max(0, inputChars) / 8_000) * 1_000;
  return Math.min(90_000, OPENROUTER_ATTEMPT_TIMEOUT_MS + extra);
}

const VALID_EFFORTS = new Set(["low", "high", "max"]);

/** Map our High/Max slider onto Qwen3.8's low / medium / xhigh. */
export function qwenReasoningEffort(effort: string): "low" | "medium" | "xhigh" {
  if (effort === "low") return "low";
  if (effort === "max") return "xhigh";
  return "medium";
}

/**
 * Provider-specific thinking fields.
 *
 * DeepSeek's REST API takes a top-level `thinking: { type }` plus
 * `reasoning_effort`. OpenRouter is OpenAI-compatible and does not
 * document DeepSeek's `thinking` object — sending it can 400, so
 * OpenRouter models only get `reasoning_effort` when thinking is on.
 *
 * Qwen 3.8 27B (in-app sidecar) thinks by default.
 * Official fields: `chat_template_kwargs.enable_thinking` and
 * `reasoning_effort` of `xhigh` | `medium` | `low`. `preserve_thinking`
 * keeps prior-round thoughts in the transcript. The sidecar is started
 * with `--reasoning-format deepseek` so think tokens stay out of content.
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

  if (style === "qwen") {
    if (thinkingEnabled) {
      const qwen = qwenReasoningEffort(level);
      body.chat_template_kwargs = {
        enable_thinking: true,
        preserve_thinking: true,
        reasoning_effort: qwen,
      };
      body.reasoning_effort = qwen;
      // Some OpenAI shims read this; unknown fields are ignored.
      body.think = true;
    } else {
      body.chat_template_kwargs = { enable_thinking: false };
      body.think = false;
    }
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
    return `Your ${providerName} account has insufficient balance. Everything done so far is saved — add credit and press Continue on the reply above. If your balance is not actually low, an old media attachment was still riding in the request body — the pre-flight estimate prices the whole body as text tokens and refuses a round whose real cost is small.`;
  }
  if (status === 429) {
    if (providerName === "OpenRouter") {
      return (
        `OpenRouter is out of free capacity right now (429). ` +
        `This is their shared pool, not your key — mornings are quieter, ` +
        `evenings and US work hours get slammed. Wait a bit and try again.`
      );
    }
    return `Rate limited by ${providerName}. Please wait a moment and try again.`;
  }
  if (status === 502 || status === 503 || status === 504) {
    const trimmed = detail.replace(/\s+/g, " ").trim();
    const noisy =
      !trimmed ||
      /^(retrying|inference is temporarily unavailable|bad gateway|gateway time-?out)[.!]?$/i.test(
        trimmed
      );
    return (
      `${providerName} is temporarily unavailable (${status}). ` +
      `This is their servers, not your API key.` +
      (noisy ? "" : ` ${trimmed}`) +
      ` Wait a minute and try again.`
    );
  }
  if (/exceeds the available context size/i.test(detail)) {
    return (
      `${providerName} ran out of context (${detail}). ` +
      `The sidecar must be on an 80K window. Open Settings → On this PC → Restart ` +
      `so the old 16K llama-server is killed.`
    );
  }
  return `${providerName} API error (${status})${detail ? `: ${detail}` : ""}`;
}

export function providerUnreachable(providerName: string, attempts: number): string {
  if (providerName === "On this PC" || providerName === "Local") {
    return `Couldn't reach Qwen on this PC after ${attempts} attempt(s). Open Settings and Download or Start it. The 27B runs in a sidecar — this app never loads the weights.`;
  }
  return `Couldn't reach the ${providerName} API after ${attempts} attempt(s). Check the network connection and try again.`;
}

export function providerTimedOut(providerName: string, attempts: number): string {
  return `The ${providerName} API took too long to respond, after ${attempts} attempt(s).`;
}

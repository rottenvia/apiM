/**
 * Resolve which LLM endpoint a request should hit.
 *
 * DeepSeek used to be the only provider. Ox Alpha is served by OpenCode Zen
 * at the same Chat Completions shape (`/chat/completions`), so the rest of
 * the agent loop stays identical — only the URL, key and on-the-wire model
 * id change. Local Qwen 3.8 27B is the same loop again, pointed at the
 * in-app sidecar on this machine (or a custom OpenAI-compatible host).
 */

import {
  DEFAULT_LOCAL_API_MODEL,
  DEFAULT_LOCAL_BASE_URL,
  DEFAULT_MODEL_ID,
  MODELS,
  getModel,
  getProviderInfo,
  type ModelInfo,
  type ProviderId,
  type ThinkingStyle,
} from "@/lib/models";
import {
  OX_ATTEMPT_TIMEOUT_MS,
  OX_HOSTS,
  isOxProvider,
  oxHostInfo,
  parseOxHost,
  type OxHost,
} from "@/lib/ox-host";

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
  opencodeApiKey?: string | null;
  /** OpenRouter key — used when Ox Alpha's host is set to OpenRouter. */
  openrouterApiKey?: string | null;
  /** Which Ox Alpha front door to hit. Defaults to OpenCode Zen. */
  oxHost?: OxHost | string | null;
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
  /** Set when this target is Ox Alpha, so the route can pick headers/timeout. */
  oxHost?: OxHost;
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
  local: DEFAULT_LOCAL_BASE_URL,
};

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

export function providerBaseUrl(id: ProviderId, host?: OxHost): string {
  if (id === "deepseek") {
    return cleanBase(process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE.deepseek);
  }
  if (id === "local") {
    return normalizeOpenAiBase(
      process.env.LOCAL_BASE_URL ?? DEFAULT_BASE.local
    );
  }
  if (host === "openrouter") {
    return cleanBase(process.env.OPENROUTER_BASE_URL ?? OX_HOSTS.openrouter.baseUrl);
  }
  return cleanBase(process.env.OPENCODE_BASE_URL ?? DEFAULT_BASE.opencode);
}

export function keyForOx(creds: ChatCredentials): string {
  const host = parseOxHost(creds.oxHost);
  const raw =
    host === "openrouter" ? creds.openrouterApiKey : creds.opencodeApiKey;
  return typeof raw === "string" ? raw.trim() : "";
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
  if (id === "opencode") return keyForOx(creds);
  const raw = creds.deepseekApiKey;
  return typeof raw === "string" ? raw.trim() : "";
}

export function hasKeyForModel(
  modelId: string | null | undefined,
  creds: ChatCredentials
): boolean {
  const provider = getModel(modelId).provider;
  if (provider === "local") return true;
  return Boolean(keyForProvider(provider, creds));
}

export function resolveChatTarget(
  modelId: string | null | undefined,
  creds: ChatCredentials
): ResolveSuccess | ResolveFailure {
  const model = getModel(modelId);

  if (model.provider === "opencode") {
    const host = parseOxHost(creds.oxHost);
    const gate = oxHostInfo(host);
    const apiKey = keyForOx(creds);
    if (!apiKey) {
      return {
        ok: false,
        error:
          host === "openrouter"
            ? "An OpenRouter API key is required for Ox Alpha. Add one in Settings, or switch the Ox host back to OpenCode Zen."
            : "An OpenCode Zen API key is required for Ox Alpha. Add one in Settings (opencode.ai/auth), or switch the Ox host to OpenRouter.",
      };
    }
    return {
      ok: true,
      target: {
        model,
        providerId: "opencode",
        providerName: gate.label,
        thinkingStyle: "openai",
        apiKey,
        baseUrl: providerBaseUrl("opencode", host),
        apiModel: gate.apiModel,
        oxHost: host,
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
 * Prefers DeepSeek Flash when that key is present so existing DeepSeek-only
 * setups keep the same cost profile. Falls back to Ox Alpha when the user
 * only connected OpenCode. Local 27B is deliberately not a helper — it is
 * the main model, not a planner.
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
  if (ox) {
    // Only the host the user picked. Do not silently hop Zen ↔ OpenRouter —
    // they set that button on purpose when one of them is down for ten minutes.
    const host = parseOxHost(creds.oxHost);
    const raw =
      host === "openrouter" ? creds.openrouterApiKey : creds.opencodeApiKey;
    const apiKey = typeof raw === "string" ? raw.trim() : "";
    if (apiKey) {
      const gate = oxHostInfo(host);
      return {
        model: ox,
        providerId: "opencode",
        providerName: gate.label,
        thinkingStyle: "openai",
        apiKey,
        baseUrl: providerBaseUrl("opencode", host),
        apiModel: gate.apiModel,
        oxHost: host,
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
  if (target.oxHost === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/eggyeg/apiM";
    headers["X-Title"] = "apiM";
  }
  return headers;
}

/** How long one hung attempt may sit before we treat it as a miss. */
export function attemptTimeoutMs(target: ResolvedTarget): number {
  return isOxProvider(target.providerId) ? OX_ATTEMPT_TIMEOUT_MS : 280_000;
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
 * `reasoning_effort`. OpenCode Zen is OpenAI-compatible and does not
 * document DeepSeek's `thinking` object — sending it can 400, so Ox Alpha
 * only gets `reasoning_effort` when thinking is on.
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
    return `Your ${providerName} account has insufficient balance. Everything done so far is saved — add credit and press Continue on the reply above.`;
  }
  if (status === 429) {
    return `Rate limited by ${providerName}. Please wait a moment and try again.`;
  }
  if (status === 502 || status === 503 || status === 504) {
    // OpenCode Zen often replies 503 with body {"error":{"message":"retrying"}}
    // or "Inference is temporarily unavailable". Echoing that produced a
    // bubble that said we were retrying after retries had already finished.
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
      ` Wait a minute and try again.` +
      (providerName === "OpenCode Zen" || providerName === "OpenRouter"
        ? ` Or switch the Ox host in Settings.`
        : "")
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

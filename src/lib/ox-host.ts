/**
 * Ox Alpha is one catalog model with two Chat Completions front doors.
 *
 * Do not add a second Ox entry to MODELS. Plugin pinning, open tool
 * limits, vision, retry policy and pricing all key off `ox-alpha` /
 * `provider: "opencode"`. Only the URL, bearer token and wire id change.
 */

export type OxHost = "zen" | "openrouter";

export interface OxHostInfo {
  id: OxHost;
  label: string;
  shortLabel: string;
  authUrl: string;
  authLabel: string;
  keyPlaceholder: string;
  baseUrl: string;
  /** Value of the Chat Completions `model` field. */
  apiModel: string;
  /** Substring that must appear in GET /models when the host is healthy. */
  listedAs: string;
}

export const DEFAULT_OX_HOST: OxHost = "zen";

/**
 * Per-attempt hang cap for HTTP headers.
 *
 * 20s was killing real Ox replies: workspace is always on, so the POST
 * body is huge and the upload alone can eat the budget. 45s still fails
 * a silent 503 quickly; Stop aborts the wait either way.
 */
export const OX_ATTEMPT_TIMEOUT_MS = 45_000;

/**
 * After a 200, how long we wait for the first token / tool / finish.
 *
 * Test (GET /models) never exercises this. A 200 with an empty or stalled
 * SSE body is how "both hosts Test green, chat never loads, no error"
 * actually happens. Prefill on a workspace prompt needs more than 15s.
 */
export const OX_FIRST_TOKEN_MS = 45_000;

export const OX_HOSTS: Record<OxHost, OxHostInfo> = {
  zen: {
    id: "zen",
    label: "OpenCode Zen",
    shortLabel: "Zen",
    authUrl: "https://opencode.ai/auth",
    authLabel: "opencode.ai/auth",
    keyPlaceholder: "sk-zen-...",
    baseUrl: "https://opencode.ai/zen/v1",
    apiModel: "x-preview-f-free",
    listedAs: "x-preview-f-free",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    shortLabel: "OpenRouter",
    authUrl: "https://openrouter.ai/settings/keys",
    authLabel: "openrouter.ai/settings/keys",
    keyPlaceholder: "sk-or-v1-...",
    baseUrl: "https://openrouter.ai/api/v1",
    apiModel: "stealth/ox-alpha",
    listedAs: "stealth/ox-alpha",
  },
};

export function isOxHost(value: unknown): value is OxHost {
  return value === "zen" || value === "openrouter";
}

export function parseOxHost(value: unknown): OxHost {
  return isOxHost(value) ? value : DEFAULT_OX_HOST;
}

/** Catalog provider id for Ox, on either host. */
export function isOxProvider(id: string | null | undefined): boolean {
  return id === "opencode";
}

export function oxHostInfo(host: unknown): OxHostInfo {
  return OX_HOSTS[parseOxHost(host)];
}

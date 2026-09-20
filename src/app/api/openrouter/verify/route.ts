/**
 * Verify an OpenRouter model id before it joins the custom list.
 *
 * The user types `qwen/qwen3-max` (or pastes it from openrouter.ai); this
 * checks the id exists and brings back everything the app needs to treat
 * it as a first-class model: context window, per-1M pricing, and whether
 * it takes tools, images and reasoning. Nothing is stored here — the
 * client keeps the list, and /api/chat re-sanitizes it per request.
 *
 * Two lookups: the per-model endpoint is cheap and exact, but it cannot
 * address `:free` / `:nitro` variants (the suffix is a routing hint, not
 * part of the catalog id), so a miss falls back to scanning the full
 * list for the literal id. Either way the response carries the canonical
 * OpenRouter id the chat route will put on the wire.
 */

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

const MODELS_URL = "https://openrouter.ai/api/v1/models";

interface VerifyBody {
  slug?: string;
  apiKey?: string;
}

interface OpenRouterModel {
  id?: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  supported_parameters?: string[];
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
}

const SLUG_RE = /^[a-z0-9][a-z0-9._/-]*[a-z0-9](?::[a-z0-9-]+)?$/i;

function slugVariants(raw: string): { wire: string; catalog: string } | null {
  const wire = raw.trim();
  if (!wire || wire.length > 160 || !SLUG_RE.test(wire)) return null;
  // `:free` / `:nitro` / `:floor` route the request but are not catalog ids.
  const catalog = wire.includes(":") ? wire.split(":")[0] : wire;
  return { wire, catalog };
}

/** OpenRouter prices per token as strings; the app prices per 1M as numbers. */
function toPerMillion(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const perToken = Number(value);
  if (!Number.isFinite(perToken) || perToken < 0) return undefined;
  return perToken * 1_000_000;
}

function shape(entry: OpenRouterModel, wireId: string): Record<string, unknown> {
  const params = Array.isArray(entry.supported_parameters)
    ? entry.supported_parameters
    : [];
  const inputs = entry.architecture?.input_modalities ?? [];
  const prompt = toPerMillion(entry.pricing?.prompt);
  const completion = toPerMillion(entry.pricing?.completion);
  return {
    id: wireId,
    name: typeof entry.name === "string" && entry.name ? entry.name : wireId,
    contextLength:
      typeof entry.context_length === "number" && entry.context_length > 0
        ? Math.floor(entry.context_length)
        : undefined,
    inputPrice: prompt,
    outputPrice: completion,
    supportsTools: params.length === 0 ? true : params.includes("tools"),
    supportsVision:
      inputs.includes("image") || inputs.includes("video"),
    supportsThinking:
      params.includes("reasoning") || params.includes("include_reasoning"),
  };
}

export async function POST(req: NextRequest) {
  let body: VerifyBody;
  try {
    body = (await req.json()) as VerifyBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
  }

  const ids = slugVariants(body.slug ?? "");
  if (!ids) {
    return NextResponse.json(
      {
        error:
          "That is not an OpenRouter model id. It looks like `author/model-name`, " +
          "optionally with `:free` on the end — copy it from the model's openrouter.ai page.",
      },
      { status: 400 }
    );
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  // 1. Cheap exact lookup. The catalog id has no variant suffix.
  try {
    const res = await fetch(
      `${MODELS_URL}/${ids.catalog}`,
      { headers, signal: AbortSignal.timeout(15_000) }
    );
    if (res.ok) {
      const parsed = (await res.json()) as { data?: OpenRouterModel };
      if (parsed?.data?.id) {
        return NextResponse.json({
          ok: true,
          model: shape(parsed.data, ids.wire),
        });
      }
    } else if (res.status === 401 && apiKey) {
      return NextResponse.json(
        { error: "That OpenRouter API key was rejected. Check it in Settings → Keys." },
        { status: 401 }
      );
    }
    // Any other miss falls through to the list scan below.
  } catch {
    // Network blip on the cheap path — the list scan gets its own chance.
  }

  // 2. Full-list scan for the literal id (covers `:free` variants and ids
  // the per-model endpoint will not address).
  try {
    const res = await fetch(MODELS_URL, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      if (res.status === 401 && apiKey) {
        return NextResponse.json(
          { error: "That OpenRouter API key was rejected. Check it in Settings → Keys." },
          { status: 401 }
        );
      }
      return NextResponse.json(
        { error: `OpenRouter returned ${res.status}. Try again in a moment.` },
        { status: 502 }
      );
    }
    const parsed = (await res.json()) as { data?: OpenRouterModel[] };
    const list = Array.isArray(parsed?.data) ? parsed.data : [];
    const match =
      list.find((m) => m.id === ids.wire) ??
      list.find((m) => m.id === ids.catalog);
    if (!match?.id) {
      return NextResponse.json(
        {
          error:
            `No OpenRouter model matches "${ids.wire}". ` +
            `Open the model on openrouter.ai and copy its id exactly.`,
        },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true, model: shape(match, ids.wire) });
  } catch {
    return NextResponse.json(
      { error: "Could not reach OpenRouter. Check the connection and try again." },
      { status: 502 }
    );
  }
}

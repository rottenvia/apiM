import { NextRequest, NextResponse } from "next/server";
import { oxHostInfo, parseOxHost, type OxHost } from "@/lib/ox-host";

/**
 * Probe the selected Ox front door without spending a chat turn.
 *
 * GET /models is enough: 401 is a bad key, 503 is their outage, and a
 * 200 whose body names the wire id means this host can serve Ox Alpha.
 */

export async function POST(req: NextRequest) {
  let body: { host?: unknown; apiKey?: unknown };
  try {
    body = (await req.json()) as { host?: unknown; apiKey?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const host = parseOxHost(body.host);
  const info = oxHostInfo(host);
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) {
    return NextResponse.json(
      {
        ok: false,
        host,
        error: `Paste a ${info.label} API key first.`,
      },
      { status: 400 }
    );
  }

  const started = Date.now();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (host === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/eggyeg/apiM";
    headers["X-Title"] = "apiM";
  }

  try {
    const res = await fetch(`${info.baseUrl}/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    const ms = Date.now() - started;
    const text = await res.text().catch(() => "");

    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({
        ok: false,
        host,
        status: res.status,
        ms,
        error: `${info.label} rejected this key. Check it at ${info.authLabel}.`,
      });
    }

    if (res.status === 402) {
      return NextResponse.json({
        ok: false,
        host,
        status: res.status,
        ms,
        error: `${info.label} says this account has no credit left.`,
      });
    }

    if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
      return NextResponse.json({
        ok: false,
        host,
        status: res.status,
        ms,
        error: `${info.label} is temporarily unavailable (${res.status}). This is their servers, not your key. Try the other Ox host.`,
      });
    }

    if (!res.ok) {
      return NextResponse.json({
        ok: false,
        host,
        status: res.status,
        ms,
        error: `${info.label} returned HTTP ${res.status}.`,
      });
    }

    const listed = text.includes(info.listedAs);
    return NextResponse.json({
      ok: true,
      host,
      status: res.status,
      ms,
      listed,
      model: info.apiModel,
      detail: listed
        ? `${info.label} is up and lists ${info.apiModel}.`
        : `${info.label} accepted the key (${ms}ms) but did not list ${info.apiModel}. The host is reachable — try a short chat.`,
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return NextResponse.json({
      ok: false,
      host,
      error: timedOut
        ? `${info.label} did not answer in 8s. Their API is hanging — switch host or try again later.`
        : `Couldn't reach ${info.label}. Check the network and try again.`,
    });
  }
}

export type { OxHost };

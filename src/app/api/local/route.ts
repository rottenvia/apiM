/**
 * In-app Qwen download / start.
 *
 * Streams weights to disk and starts a loopback sidecar. The Next.js
 * process never loads the GGUF.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  downloadEngine,
  engineStatus,
  ensureEngineRunning,
  applySpecState,
  startEngine,
  stopEngine,
} from "@/lib/local-engine";
import {
  defaultSpecState,
  parseUserFlags,
  type SidecarSpecState,
} from "@/lib/local-engine-shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 1800;

export async function GET() {
  return NextResponse.json(await engineStatus());
}

export async function POST(req: NextRequest) {
  let body: { action?: unknown };
  try {
    body = (await req.json()) as { action?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";

  if (action === "status") {
    return NextResponse.json(await engineStatus());
  }

  if (action === "stop") {
    stopEngine();
    return NextResponse.json(await engineStatus());
  }

  if (action === "restart") {
    stopEngine();
    const started = await startEngine();
    return NextResponse.json({
      ok: started.ok,
      error: started.error,
      status: await engineStatus(),
    });
  }

  if (action === "set-opts") {
    const raw = body as {
      enabled?: unknown;
      extra?: unknown;
      addFlag?: unknown;
    };
    const current = (await engineStatus()).spec ?? defaultSpecState();
    let extra = Array.isArray(raw.extra)
      ? raw.extra.filter((t): t is string => typeof t === "string")
      : current.extra;
    if (typeof raw.addFlag === "string" && raw.addFlag.trim()) {
      const parsed = parseUserFlags(raw.addFlag);
      if (!parsed.ok) {
        return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
      }
      extra = [...extra, ...parsed.tokens];
    }
    const next: SidecarSpecState = {
      enabled: Array.isArray(raw.enabled)
        ? raw.enabled.filter((t): t is string => typeof t === "string")
        : current.enabled,
      extra,
    };
    const applied = await applySpecState(next);
    return NextResponse.json({
      ok: applied.ok,
      error: applied.error,
      status: await engineStatus(),
    });
  }

  if (action === "start") {
    const started = await startEngine();
    const status = await engineStatus();
    return NextResponse.json({
      ok: started.ok,
      error: started.error,
      status,
    });
  }

  if (action === "ensure") {
    const ready = await ensureEngineRunning();
    const status = await engineStatus();
    return NextResponse.json({
      ok: ready.ok,
      error: ready.error,
      status,
    });
  }

  if (action === "download") {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (payload: unknown) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
          );
        };
        try {
          await downloadEngine(send, req.signal);
          const status = await engineStatus();
          send({ type: "status", message: "Starting the sidecar…" });
          const started = await startEngine();
          if (!started.ok) {
            send({
              type: "error",
              message: started.error ?? "Downloaded, but the sidecar did not start.",
            });
          }
          send({ type: "done", status: await engineStatus() });
          void status;
        } catch (err) {
          send({
            type: "error",
            message:
              err instanceof Error && err.name === "AbortError"
                ? "Download cancelled."
                : err instanceof Error
                  ? err.message
                  : "Download failed.",
          });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

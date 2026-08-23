import { NextRequest, NextResponse } from "next/server";
import {
  describeImageWithFallback,
  DEFAULT_VISION_MODEL,
} from "@/lib/vision";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Describe an image so a text-only model can reason about it.
 *
 * OpenAI vision when a key is sent and still has credit. Otherwise free
 * local OCR — no key, no funds. The key is never forwarded to a third
 * party from the browser.
 */
export async function POST(req: NextRequest) {
  let body: {
    dataUrl?: string;
    apiKey?: string;
    model?: string;
    hint?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { dataUrl, apiKey, model, hint } = body;

  if (!dataUrl?.startsWith("data:image/")) {
    return NextResponse.json(
      { error: "A base64 image data URL is required" },
      { status: 400 }
    );
  }

  const result = await describeImageWithFallback(
    dataUrl,
    apiKey,
    model || DEFAULT_VISION_MODEL,
    hint
  );

  if (result.error && !result.description) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  return NextResponse.json({
    description: result.description,
    source: result.source ?? "ocr",
  });
}

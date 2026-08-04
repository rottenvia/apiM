import { NextRequest, NextResponse } from "next/server";
import { describeImage, DEFAULT_VISION_MODEL } from "@/lib/vision";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Describe an image so a text-only model can reason about it.
 *
 * Runs server-side so the vision key is never exposed to a third-party origin
 * from the browser, and so the request isn't blocked by CORS.
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
  if (!apiKey) {
    return NextResponse.json(
      { error: "Add a vision API key in Settings to send screenshots" },
      { status: 400 }
    );
  }

  const result = await describeImage(
    dataUrl,
    apiKey,
    model || DEFAULT_VISION_MODEL,
    hint
  );

  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  return NextResponse.json({ description: result.description });
}

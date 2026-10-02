import { NextRequest, NextResponse } from "next/server";
import { readImageBytes, WorkspaceError } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * The raw bytes of one image in a workspace, for showing it in the chat.
 *
 * Images only (png/jpg/webp/gif/bmp, never SVG), through the same checked
 * path resolution the tools use, so this cannot serve a page or a file from
 * outside the workspace. The /api guard in proxy.ts covers access.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const rel = req.nextUrl.searchParams.get("path") ?? "";
  try {
    const image = await readImageBytes(id, rel);
    return new NextResponse(new Uint8Array(image.buffer), {
      headers: {
        "Content-Type": image.mime,
        "Content-Length": String(image.bytes),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    if (error instanceof WorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error("Workspace image request failed:", error);
    return NextResponse.json({ error: "Image request failed" }, { status: 500 });
  }
}

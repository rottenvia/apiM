import { NextRequest, NextResponse } from "next/server";
import { ingestUpload } from "@/lib/ingest";
import { WorkspaceError } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Describe an uploaded workspace file (or folder) for the model.
 *
 * Returns what goes into the message — the whole text when it is small,
 * its structure and a pointer to the right tool when it is not — and a
 * short label for the attachment chip. See lib/ingest.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { path?: unknown; extract?: unknown };
    const rel = typeof body.path === "string" ? body.path.replace(/\\/g, "/").trim() : "";
    if (!rel) return NextResponse.json({ error: "path is required" }, { status: 400 });
    // extract:true unpacks an archive first (zip, rar, 7z, tar…) — lib/extract.
    return NextResponse.json(
      await ingestUpload(id, rel, { extract: body.extract === true, signal: req.signal })
    );
  } catch (error) {
    if (error instanceof WorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const code = (error as { code?: string })?.code;
    if (code === "ENOENT") return NextResponse.json({ error: "No such file" }, { status: 404 });
    console.error("Describe failed:", error);
    return NextResponse.json(
      { error: `Couldn't describe the file: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}

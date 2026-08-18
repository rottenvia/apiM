import { NextRequest, NextResponse } from "next/server";
import { writeFile, WorkspaceError, MAX_FILE_BYTES } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * Save a text attachment into the chat workspace.
 *
 * Uploaded JSON/text files used to be inlined into the first user message
 * only: the model saw them once and had no path to re-read them on later
 * rounds, so `read_file('data.json')` failed. They are now written under
 * uploads/<name>, exactly like binaries/archives, so the model can open
 * them with the normal file tools. One request per file keeps this simple
 * and makes a failure visible (the UI can fall back to inlining).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    let body: { path?: unknown; content?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (typeof body.path !== "string" || !body.path.trim()) {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }
    if (typeof body.content !== "string") {
      return NextResponse.json(
        { error: "content must be a string" },
        { status: 400 }
      );
    }

    // Reject anything absurdly large before it hits the disk writer.
    const byteLength = Buffer.byteLength(body.content, "utf8");
    if (byteLength > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: `File is too large (${Math.round(byteLength / 1024)}KB)` },
        { status: 413 }
      );
    }

    const written = await writeFile(id, body.path.trim(), body.content);
    return NextResponse.json({ path: written.path, bytes: written.bytes });
  } catch (error) {
    if (error instanceof WorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Write failed:", error);
    return NextResponse.json({ error: "Write failed" }, { status: 500 });
  }
}

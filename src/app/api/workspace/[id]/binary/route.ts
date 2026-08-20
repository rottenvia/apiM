import { NextRequest, NextResponse } from "next/server";
import { assertPeUpload, MAX_BINARY_ANALYSIS_BYTES } from "@/lib/binaries";
import { writeFileBytes, WorkspaceError } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * Preserve an attached executable as exact bytes in its chat workspace.
 *
 * Text attachments can be decoded in the browser and sent inline. Doing that
 * to an EXE corrupts it and base64-inlining tens of megabytes into a chat is
 * worse. Multipart keeps the bytes exact and puts them where inspect_binary
 * can read them. The target is stored, never launched.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const form = await req.formData();
    const file = form.get("file");
    const target = form.get("path");

    if (!(file instanceof File) || typeof target !== "string" || !target.trim()) {
      return NextResponse.json(
        { error: "file and path are required" },
        { status: 400 }
      );
    }
    if (file.size > MAX_BINARY_ANALYSIS_BYTES) {
      return NextResponse.json(
        {
          error:
            `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)}MB; ` +
            `executable uploads are capped at ${MAX_BINARY_ANALYSIS_BYTES / 1024 / 1024}MB.`,
        },
        { status: 413 }
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    assertPeUpload(bytes, file.name);
    const written = await writeFileBytes(id, target, Buffer.from(bytes));
    return NextResponse.json({
      path: written.path,
      bytes: written.bytes,
      executableWasRun: false,
    });
  } catch (error) {
    if (error instanceof WorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Surface the real cause (e.g. a reverse-proxy body cap, EACCES, disk
    // full) instead of a generic 500, so "Binary upload failed" is debuggable.
    const detail = error instanceof Error ? error.message : String(error);
    console.error("Binary upload failed:", error);
    return NextResponse.json(
      { error: `Binary upload failed: ${detail}` },
      { status: 500 }
    );
  }
}

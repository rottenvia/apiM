import { NextRequest, NextResponse } from "next/server";
import { writeFileBytes, WorkspaceError, MAX_FILE_BYTES } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * Save an attached file's exact bytes into the chat workspace.
 *
 * Unlike /binary, this does NOT require a PE/MZ header — it is the generic
 * path for large binaries (.bin/.dat/.o/...) that would be too big to inline
 * as a hex dump in the message. The bytes are stored and never executed; the
 * model reads ranges with read_file, which returns a hex+ASCII dump.
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

    if (
      !(file instanceof File) ||
      typeof target !== "string" ||
      !target.trim()
    ) {
      return NextResponse.json(
        { error: "file and path are required" },
        { status: 400 }
      );
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        {
          error: `${file.name} is ${(file.size / 1024 / 1024).toFixed(
            1
          )}MB; the per-file limit is ${MAX_FILE_BYTES / 1024 / 1024}MB.`,
        },
        { status: 413 }
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const written = await writeFileBytes(id, target, Buffer.from(bytes));
    return NextResponse.json({
      path: written.path,
      bytes: written.bytes,
    });
  } catch (error) {
    if (error instanceof WorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("File upload failed:", error);
    return NextResponse.json({ error: "File upload failed" }, { status: 500 });
  }
}

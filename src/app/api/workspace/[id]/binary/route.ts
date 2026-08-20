import { NextRequest, NextResponse } from "next/server";
import { assertPeUpload, MAX_BINARY_ANALYSIS_BYTES } from "@/lib/binaries";
import { writeFileBytes, WorkspaceError } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * Preserve an attached executable as exact bytes in its chat workspace.
 *
 * Text attachments can be decoded in the browser and sent inline. Doing that
 * to an EXE corrupts it and base64-inlining tens of megabytes into a chat is
 * worse. Large binaries are uploaded as a raw octet-stream (the destination
 * path is passed in the X-Binary-Path header) to avoid Next.js' multipart
 * parser failing on large bodies; the legacy multipart path is still accepted.
 * The target is stored, never launched.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const contentType = req.headers.get("content-type") ?? "";

    let filename: string;
    let target: string;
    let bytes: Uint8Array;

    if (contentType.includes("multipart/form-data")) {
      // Legacy/compat path. formData() can fail on very large bodies in some
      // runtimes; the UI uses the octet-stream path below for big files.
      const form = await req.formData();
      const file = form.get("file");
      const pathValue = form.get("path");
      if (!(file instanceof File) || typeof pathValue !== "string" || !pathValue.trim()) {
        return NextResponse.json(
          { error: "file and path are required" },
          { status: 400 }
        );
      }
      filename = file.name;
      target = pathValue;
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
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      // Raw bytes. Content-Length is used to reject oversize uploads early.
      target = decodeURIComponent(
        req.headers.get("x-binary-path") ?? ""
      ).trim();
      filename = target.split(/[\\/]/).pop() ?? "binary";
      if (!target) {
        return NextResponse.json(
          { error: "X-Binary-Path header is required" },
          { status: 400 }
        );
      }
      const declared = Number(req.headers.get("content-length") ?? "0");
      if (declared > MAX_BINARY_ANALYSIS_BYTES) {
        return NextResponse.json(
          {
            error:
              `${filename} is ${(declared / 1024 / 1024).toFixed(1)}MB; ` +
              `executable uploads are capped at ${MAX_BINARY_ANALYSIS_BYTES / 1024 / 1024}MB.`,
          },
          { status: 413 }
        );
      }
      const buf = Buffer.from(await req.arrayBuffer());
      if (buf.byteLength > MAX_BINARY_ANALYSIS_BYTES) {
        return NextResponse.json(
          {
            error:
              `${filename} is ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB; ` +
              `executable uploads are capped at ${MAX_BINARY_ANALYSIS_BYTES / 1024 / 1024}MB.`,
          },
          { status: 413 }
        );
      }
      bytes = buf;
    }

    assertPeUpload(bytes, filename);
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

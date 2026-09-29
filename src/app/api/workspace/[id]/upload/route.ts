import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { assertBinaryUpload } from "@/lib/binaries";
import { freeName, streamToWorkspace, UploadTooLarge } from "@/lib/upload-stream";
import { WorkspaceError } from "@/lib/workspace";
import { isPeFilename } from "@/lib/binary-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const fetchCache = "force-no-store";

/** Matches next.config's proxyClientMaxBodySize: the body can't be larger anyway. */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

/**
 * Save any dropped file into the workspace as exact bytes.
 *
 * The composer posts the raw file (application/octet-stream) with its
 * intended workspace path in X-Upload-Path. The file is never decoded,
 * truncated or executed here — describing it is a separate step (/describe),
 * so an upload that succeeds is never lost to a description that fails.
 * `?unique=1` picks a free name instead of overwriting an earlier upload.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    let target = decodeURIComponent(
      req.headers.get("x-upload-path") ?? req.headers.get("x-binary-path") ?? ""
    )
      .replace(/\\/g, "/")
      .trim();
    if (!target) {
      return NextResponse.json({ error: "X-Upload-Path header is required" }, { status: 400 });
    }
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `The file is ${(declared / 1024 / 1024).toFixed(0)}MB — uploads are capped at ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.` },
        { status: 413 }
      );
    }
    if (!req.body) return NextResponse.json({ error: "empty request body" }, { status: 400 });
    if (req.nextUrl.searchParams.get("unique") === "1") target = await freeName(id, target);

    const name = target.split("/").pop() ?? target;
    const saved = await streamToWorkspace(
      req.body as ReadableStream<Uint8Array>,
      id,
      target,
      MAX_UPLOAD_BYTES,
      // A ".dll" without an MZ header is corrupt or spoofed — same rule as before.
      isPeFilename(name) ? async (tmp) => assertBinaryUpload(await readFile(tmp), name) : undefined
    );
    return NextResponse.json({ ...saved, executableWasRun: false });
  } catch (error) {
    if (error instanceof UploadTooLarge) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof WorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Upload failed:", error);
    return NextResponse.json(
      { error: `Upload failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}

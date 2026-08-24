import { NextRequest, NextResponse } from "next/server";
import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertBinaryUpload, MAX_BINARY_ANALYSIS_BYTES } from "@/lib/binaries";
import {
  workspaceDirectory,
  resolveInside,
  ensureRoot,
  WorkspaceError,
} from "@/lib/workspace";

export const dynamic = "force-dynamic";
// Run in the Node.js runtime so we can stream the body straight to disk with
// the fs stream API. (The edge runtime has no node:fs.)
export const runtime = "nodejs";
// Do not let the framework buffer the whole request in memory / cap it at its
// default body size. We stream and enforce the size limit ourselves.
export const fetchCache = "force-no-store";

/**
 * Preserve an attached executable as exact bytes in its chat workspace.
 *
 * Large binaries (a 37MB client.dll) are uploaded as a raw octet-stream: the
 * destination path is in the X-Binary-Path header and the body is streamed
 * directly to a temp file, then moved into the workspace. This avoids both
 * multipart parsing failures and any in-memory body cap that truncated large
 * uploads. A legacy multipart/form-data path is kept for compatibility. The
 * target is stored, never launched.
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
    let bytes: number;

    if (contentType.includes("multipart/form-data")) {
      // Legacy path. formData() can fail on very large bodies; the UI uses
      // the octet-stream path below for big files.
      const form = await req.formData();
      const file = form.get("file");
      const pathValue = form.get("path");
      if (
        !(file instanceof File) ||
        typeof pathValue !== "string" ||
        !pathValue.trim()
      ) {
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
      const buf = Buffer.from(await file.arrayBuffer());
      assertBinaryUpload(buf, filename);
      await ensureRoot(id);
      const dest = resolveInside(id, target);
      await mkdir(path.dirname(dest), { recursive: true });
      // writeFile is fine here: multipart bodies are already bounded.
      const { writeFile } = await import("node:fs/promises");
      await writeFile(dest, buf);
      bytes = buf.byteLength;
    } else {
      // Raw octet-stream, streamed to disk.
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
      if (!req.body) {
        return NextResponse.json(
          { error: "empty request body" },
          { status: 400 }
        );
      }

      await ensureRoot(id);
      const dest = resolveInside(id, target);
      await mkdir(path.dirname(dest), { recursive: true });

      // Stream to a temp file in the workspace dir (same volume so the final
      // rename is atomic), enforcing the cap on bytes actually received.
      const tmpDir = workspaceDirectory(id);
      const tmpName = `.upload-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
      const tmpPath = path.join(tmpDir, tmpName);

      let received = 0;
      let truncated = false;
      const writer = createWriteStream(tmpPath);
      // Drain the web ReadableStream into the file manually. Using node's
      // pipeline() fights the type system (web vs node streams) and still
      // buffers; a reader loop streams chunk-by-chunk with a hard cap.
      const reader = (req.body as ReadableStream<Uint8Array>).getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          received += value.byteLength;
          if (received > MAX_BINARY_ANALYSIS_BYTES) {
            truncated = true;
            break;
          }
          await new Promise<void>((resolve, reject) =>
            writer.write(value, (err) => (err ? reject(err) : resolve()))
          );
        }
      } finally {
        reader.releaseLock();
        await new Promise<void>((resolve) => writer.end(resolve));
      }

      if (truncated || received > MAX_BINARY_ANALYSIS_BYTES) {
        await unlink(tmpPath).catch(() => {});
        return NextResponse.json(
          {
            error:
              `${filename} exceeds the ${MAX_BINARY_ANALYSIS_BYTES / 1024 / 1024}MB cap ` +
              `(received ${received} bytes).`,
          },
          { status: 413 }
        );
      }

      // Validate the PE header before promoting the temp file.
      const { readFile } = await import("node:fs/promises");
      const tmpBuf = await readFile(tmpPath);
      try {
        assertBinaryUpload(tmpBuf, filename);
      } catch (peErr) {
        await unlink(tmpPath).catch(() => {});
        if (peErr instanceof WorkspaceError) {
          return NextResponse.json({ error: peErr.message }, { status: 400 });
        }
        throw peErr;
      }
      await rename(tmpPath, dest);
      bytes = tmpBuf.byteLength;
    }

    return NextResponse.json({
      path: target,
      bytes,
      executableWasRun: false,
    });
  } catch (error) {
    if (error instanceof WorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.error("Binary upload failed:", error);
    return NextResponse.json(
      { error: `Binary upload failed: ${detail}` },
      { status: 500 }
    );
  }
}

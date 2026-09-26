import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { listFiles, workspaceDirectory, resolveInside } from "@/lib/workspace";
import { createZip, type ZipEntry } from "@/lib/zip";

export const dynamic = "force-dynamic";

/** Filename-safe version of the folder name, for the download. */
function archiveName(workspaceId: string): string {
  const folder = path.basename(workspaceDirectory(workspaceId));
  const clean = folder.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${clean || "workspace"}.zip`;
}

/** GET returns every file in the workspace as a single archive. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const files = await listFiles(id);

    if (files.length === 0) {
      return NextResponse.json(
        { error: "This workspace is empty" },
        { status: 404 }
      );
    }

    const entries: ZipEntry[] = [];
    for (const file of files) {
      try {
        // Read as bytes, not text: images and other binaries would be
        // corrupted by a UTF-8 decode round trip.
        const content = await fs.readFile(resolveInside(id, file.path));
        entries.push({
          path: file.path,
          content,
          modified: new Date(file.modifiedAt),
        });
      } catch {
        // Skip anything that vanished or can't be read rather than failing
        // the whole download for one file.
      }
    }

    if (entries.length === 0) {
      return NextResponse.json(
        { error: "Nothing in this workspace could be read" },
        { status: 404 }
      );
    }

    const zip = await createZip(entries);

    /*
     * The in-app button asks with ?via=fetch and gets the bytes WITHOUT
     * download headers.
     *
     * Download managers (IDM) watch the browser's network responses — fetch
     * included — and grab anything that says "attachment" or looks like an
     * archive: the browser's own copy is cancelled (a 0 KB file) and IDM
     * re-requests the URL on its own. A plain text response is never
     * claimed; the page turns the bytes back into a .zip locally.
     */
    if (req.nextUrl.searchParams.get("via") === "fetch") {
      return new NextResponse(new Uint8Array(zip), {
        headers: {
          "Content-Type": "text/plain; charset=x-user-defined",
          "Content-Length": String(zip.length),
          "X-Archive-Name": archiveName(id),
          "Cache-Control": "no-store",
        },
      });
    }

    return new NextResponse(new Uint8Array(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${archiveName(id)}"`,
        "Content-Length": String(zip.length),
        // The contents change as the model works, so a cached copy would be
        // wrong almost immediately.
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Workspace download failed:", error);
    return NextResponse.json(
      { error: "Could not build the archive" },
      { status: 500 }
    );
  }
}

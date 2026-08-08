import { NextRequest, NextResponse } from "next/server";
import { writeFile, WorkspaceError } from "@/lib/workspace";

/**
 * Write an unpacked archive into the workspace in one request.
 *
 * The alternative is one PUT per file, which for a real project means several
 * hundred round trips and a workspace that fills in visibly over several
 * seconds. Doing it in a single call also means the whole archive either
 * lands or does not, rather than half of it appearing and the rest failing.
 */

/** Matches the archive reader's own cap, so this cannot be used to bypass it. */
const MAX_FILES = 800;

interface Incoming {
  dir?: unknown;
  files?: unknown;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: Incoming;
  try {
    body = (await req.json()) as Incoming;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const dir = typeof body.dir === "string" ? body.dir.trim() : "";
  if (!dir) {
    return NextResponse.json({ error: "dir is required" }, { status: 400 });
  }

  if (!Array.isArray(body.files)) {
    return NextResponse.json({ error: "files must be a list" }, { status: 400 });
  }
  if (body.files.length > MAX_FILES) {
    return NextResponse.json(
      { error: `Too many files (${body.files.length}), limit is ${MAX_FILES}` },
      { status: 400 }
    );
  }

  let written = 0;
  const failed: { path: string; reason: string }[] = [];

  for (const entry of body.files) {
    const file = entry as { path?: unknown; content?: unknown };
    if (typeof file.path !== "string" || typeof file.content !== "string") {
      failed.push({ path: String(file.path ?? "?"), reason: "malformed entry" });
      continue;
    }

    // Paths are joined here rather than trusted from the client, and
    // writeFile validates the result — an archive can contain "../" entries,
    // and a zip-slip would otherwise write outside the workspace.
    const target = `${dir}/${file.path}`;

    try {
      await writeFile(id, target, file.content);
      written += 1;
    } catch (error) {
      failed.push({
        path: target,
        reason:
          error instanceof WorkspaceError ? error.message : "could not be written",
      });
    }
  }

  return NextResponse.json({ dir, written, failed });
}

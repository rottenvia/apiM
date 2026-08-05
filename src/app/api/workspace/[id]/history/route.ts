import { NextRequest, NextResponse } from "next/server";
import {
  previousVersion,
  readFile,
  writeFile,
  WorkspaceError,
} from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * The version a file had before the last write, and restoring it.
 *
 * Without this a model overwriting a file is unrecoverable — you see the
 * result and have no way to know what it replaced.
 */

function fail(error: unknown) {
  if (error instanceof WorkspaceError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  console.error("Workspace history request failed:", error);
  return NextResponse.json({ error: "Request failed" }, { status: 500 });
}

/** GET ?path=… returns the previous and current contents, for a diff. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const filePath = req.nextUrl.searchParams.get("path");

  if (!filePath) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  try {
    const previous = await previousVersion(id, filePath);

    // The file may have been deleted, in which case there is still a previous
    // version worth showing and restoring.
    let current: string | null = null;
    try {
      current = (await readFile(id, filePath)).content;
    } catch {
      current = null;
    }

    return NextResponse.json({
      path: filePath,
      previous,
      current,
      hasHistory: previous !== null,
    });
  } catch (error) {
    return fail(error);
  }
}

/** POST restores the previous version, making the undo itself undoable. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: { path?: string };
  try {
    body = (await req.json()) as { path?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  try {
    const previous = await previousVersion(id, body.path);
    if (previous === null) {
      return NextResponse.json(
        { error: "No previous version of that file" },
        { status: 404 }
      );
    }

    // Goes through writeFile, so the current contents become the new history
    // entry — meaning the undo can itself be undone.
    await writeFile(id, body.path, previous);

    return NextResponse.json({ path: body.path, restored: true });
  } catch (error) {
    return fail(error);
  }
}

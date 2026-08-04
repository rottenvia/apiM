import { NextRequest, NextResponse } from "next/server";
import {
  listFiles,
  readFile,
  writeFile,
  deleteFile,
  workspaceDirectory,
  WorkspaceError,
} from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * Workspace file access for the UI.
 *
 * The same functions the model's tools call, so the file list can never drift
 * from what the model actually sees.
 */

function fail(error: unknown) {
  // WorkspaceError is always a rejected path or a missing file — safe to show.
  if (error instanceof WorkspaceError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  console.error("Workspace request failed:", error);
  return NextResponse.json({ error: "Workspace request failed" }, { status: 500 });
}

/** GET ?path=… reads one file; without it, lists the whole workspace. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const filePath = req.nextUrl.searchParams.get("path");

  try {
    if (filePath) {
      return NextResponse.json(await readFile(id, filePath));
    }
    const files = await listFiles(id);
    return NextResponse.json({
      files,
      directory: workspaceDirectory(id),
    });
  } catch (error) {
    return fail(error);
  }
}

/** PUT saves an edit made in the UI. */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: { path?: string; content?: string };
  try {
    body = (await req.json()) as { path?: string; content?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.path || typeof body.content !== "string") {
    return NextResponse.json(
      { error: "path and content are required" },
      { status: 400 }
    );
  }

  try {
    return NextResponse.json(await writeFile(id, body.path, body.content));
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const filePath = req.nextUrl.searchParams.get("path");

  if (!filePath) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  try {
    return NextResponse.json(await deleteFile(id, filePath));
  } catch (error) {
    return fail(error);
  }
}

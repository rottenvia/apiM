import { NextRequest, NextResponse } from "next/server";
import { copyWorkspace, WorkspaceError } from "@/lib/workspace";

/**
 * Bring another chat's files into this one.
 *
 * Starting a new chat is usually deliberate — a clean slate — but the files
 * from the last one often still matter. This copies them without carrying
 * the conversation across.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = (await req.json()) as { from?: unknown };

    if (typeof body.from !== "string" || !body.from.trim()) {
      return NextResponse.json(
        { error: "Pick a chat to copy from." },
        { status: 400 }
      );
    }

    const result = await copyWorkspace(body.from, id);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof WorkspaceError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Workspace import failed:", error);
    return NextResponse.json({ error: "Failed to import" }, { status: 500 });
  }
}

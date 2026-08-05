import { NextRequest, NextResponse } from "next/server";
import {
  deleteConversation,
  getConversation,
  updateConversation,
  DuplicateTitleError,
} from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const conv = await getConversation(id);
    if (!conv) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(conv);
  } catch (error) {
    console.error("Error reading conversation:", error);
    return NextResponse.json({ error: "Failed to read" }, { status: 500 });
  }
}

/** Rename and archive/unarchive. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = (await req.json()) as { title?: string; archived?: boolean };
    const conv = await updateConversation(id, body);
    if (!conv) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const { messages: _messages, ...summary } = conv;
    void _messages;
    return NextResponse.json(summary);
  } catch (error) {
    // 409 Conflict, not 500: the request was fine, the name is taken. The UI
    // shows this message directly, so it has to read as an explanation.
    if (error instanceof DuplicateTitleError) {
      return NextResponse.json(
        {
          error: `A chat named "${error.title}" already exists. Pick a different name.`,
          code: "duplicate_title",
        },
        { status: 409 }
      );
    }
    console.error("Error updating conversation:", error);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const ok = await deleteConversation(id);
    return NextResponse.json({ ok });
  } catch (error) {
    console.error("Error deleting conversation:", error);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}

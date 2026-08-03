import { NextRequest, NextResponse } from "next/server";
import {
  deleteConversation,
  getConversation,
  updateConversation,
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

import { NextRequest, NextResponse } from "next/server";
import { getConversation } from "@/lib/store";

/**
 * The reasoning for one message, fetched only when someone opens it.
 *
 * The conversation endpoint used to include every message's chain of thought.
 * On a long chat that was about half the payload, and it is collapsed by
 * default — so the common case was downloading and parsing hundreds of
 * kilobytes of text that nobody read.
 *
 * Splitting it out costs one small request on the rare occasion the panel is
 * expanded, against a large one on every single open.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  try {
    const { id, messageId } = await params;
    const conv = await getConversation(id);
    if (!conv) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const message = conv.messages.find((m) => m.id === messageId);
    if (!message) {
      return NextResponse.json({ error: "No such message" }, { status: 404 });
    }

    return NextResponse.json({ reasoning: message.reasoningContent ?? "" });
  } catch (error) {
    console.error("Error reading reasoning:", error);
    return NextResponse.json({ error: "Failed to read" }, { status: 500 });
  }
}

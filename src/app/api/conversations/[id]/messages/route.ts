import { NextRequest, NextResponse } from "next/server";
import { deleteTurn } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Delete one user/assistant exchange so both sides forget it.
 *
 * The chat route reloads history from disk. Removing the bubbles in the
 * browser is not enough — the next reply would still see the turn.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const query = new URL(req.url).searchParams;
    const messageId = query.get("message")?.trim() ?? "";
    if (!messageId) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }
    const fallbackLastPair = query.get("last") === "1";
    const result = await deleteTurn(id, messageId, { fallbackLastPair });
    if (!result) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ removed: result.removed });
  } catch (error) {
    console.error("Error deleting turn:", error);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}

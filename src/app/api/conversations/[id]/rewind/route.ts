import { NextRequest, NextResponse } from "next/server";
import { rewindChat } from "@/lib/rewind";

export const dynamic = "force-dynamic";

/**
 * Rewind to a message — the chat and, optionally, the workspace files.
 *
 * POST { messageId | replyId (+ ordinal, content), restoreFiles, dryRun?,
 * workspaceId? }. The question and everything after it are removed from the
 * stored chat; with `restoreFiles` the files go back to the restore point
 * taken when that question's reply started, and the id of a snapshot of
 * the files as they were before the rewind comes back as
 * `safetySnapshotId`, so the rewind can be undone. `dryRun` reports what
 * would happen and changes nothing. 409 while a reply is running here.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!/^[\w-]{1,128}$/.test(id)) {
    return NextResponse.json({ error: "Invalid conversation id" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : undefined;
  const messageId = str(body.messageId);
  const replyId = str(body.replyId);
  if (!messageId && !replyId) {
    return NextResponse.json(
      { error: "messageId is required" },
      { status: 400 }
    );
  }
  const workspaceId = str(body.workspaceId);
  if (workspaceId && !/^[\w-]{1,128}$/.test(workspaceId)) {
    return NextResponse.json({ error: "Invalid workspace id" }, { status: 400 });
  }

  try {
    const outcome = await rewindChat(id, {
      messageId,
      replyId,
      ordinal: typeof body.ordinal === "number" ? body.ordinal : undefined,
      content: typeof body.content === "string" ? body.content : undefined,
      restoreFiles: body.restoreFiles === true,
      dryRun: body.dryRun === true,
      workspaceId,
    });
    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    }
    return NextResponse.json(outcome);
  } catch (error) {
    console.error("Rewind failed:", error);
    return NextResponse.json({ error: "Rewinding failed." }, { status: 500 });
  }
}

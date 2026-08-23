import { NextRequest, NextResponse } from "next/server";
import { stopRun, stopConversation, activeRuns } from "@/lib/runs";

/**
 * Stop a reply on purpose.
 *
 * Stopping used to be implicit: the browser aborted its own request and the
 * server noticed. That worked, but it could not tell the difference between
 * "the user pressed Stop" and "the tab was closed" — so closing a tab killed
 * a run that was still writing files.
 *
 * Now the two are separate. The work watches a signal only this endpoint can
 * abort, and a lost connection means nobody is watching rather than stop.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { messageId?: unknown; conversationId?: unknown };
  try {
    body = (await req.json()) as {
      messageId?: unknown;
      conversationId?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const messageId =
    typeof body.messageId === "string" ? body.messageId : "";
  const conversationId =
    typeof body.conversationId === "string" ? body.conversationId : "";
  if (!messageId && !conversationId) {
    return NextResponse.json(
      { error: "messageId or conversationId is required" },
      { status: 400 }
    );
  }

  // Conversation-wide first: Stop is pressed before `meta` names the
  // message, and auto-resume can replace the run under a new id.
  const byConv = conversationId ? stopConversation(conversationId) : 0;
  const byMsg = messageId ? stopRun(messageId) : false;

  // Reported honestly: a Stop that silently did nothing is worse than being
  // told the reply had already finished.
  return NextResponse.json({
    stopped: byMsg || byConv > 0,
    stoppedRuns: byConv + (byMsg ? 1 : 0),
  });
}

/** Which replies are still being generated, so a reopened tab can rejoin. */
export async function GET(req: NextRequest) {
  const conversationId = req.nextUrl.searchParams.get("conversationId") ?? "";
  if (!conversationId) {
    return NextResponse.json({ running: [] });
  }
  return NextResponse.json({ running: activeRuns(conversationId) });
}

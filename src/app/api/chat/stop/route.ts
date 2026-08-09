import { NextRequest, NextResponse } from "next/server";
import { stopRun, activeRuns } from "@/lib/runs";

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
  let body: { messageId?: unknown };
  try {
    body = (await req.json()) as { messageId?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const messageId =
    typeof body.messageId === "string" ? body.messageId : "";
  if (!messageId) {
    return NextResponse.json({ error: "messageId is required" }, { status: 400 });
  }

  // Reported honestly: a Stop that silently did nothing is worse than being
  // told the reply had already finished.
  return NextResponse.json({ stopped: stopRun(messageId) });
}

/** Which replies are still being generated, so a reopened tab can rejoin. */
export async function GET(req: NextRequest) {
  const conversationId = req.nextUrl.searchParams.get("conversationId") ?? "";
  if (!conversationId) {
    return NextResponse.json({ running: [] });
  }
  return NextResponse.json({ running: activeRuns(conversationId) });
}

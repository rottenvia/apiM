import { NextRequest, NextResponse } from "next/server";
import {
  listProcesses,
  stopProcess,
  stopAll,
  getProcess,
  isRunning,
} from "@/lib/processes";

export const dynamic = "force-dynamic";

/**
 * Background processes for a workspace, so the user can see and stop what the
 * model started without going through the chat.
 */

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  return NextResponse.json({
    processes: listProcesses(id).map((p) => ({
      id: p.id,
      display: p.display,
      running: isRunning(p),
      startedAt: p.startedAt,
      exitCode: p.exitCode,
      stoppedByUser: p.stoppedByUser,
      // The tail only: the full log can be tens of thousands of characters,
      // and the panel shows a preview rather than the whole thing.
      logTail: p.log.slice(-2000),
    })),
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const target = req.nextUrl.searchParams.get("process");

  if (!target || target === "all") {
    return NextResponse.json({ stopped: stopAll(id) });
  }

  const proc = getProcess(target);
  // Scoped to the workspace so one chat cannot stop another's process.
  if (!proc || proc.workspaceId !== id) {
    return NextResponse.json({ error: "No such process" }, { status: 404 });
  }

  stopProcess(target);
  return NextResponse.json({ stopped: 1 });
}

import { NextRequest, NextResponse } from "next/server";
import {
  listProcesses,
  stopProcess,
  stopAll,
  getProcess,
  isRunning,
  listLeftoverDecompilers,
  stopLeftoverDecompilers,
  stopLeftoverById,
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

  const tracked = listProcesses(id).map((p) => ({
    id: p.id,
    display: p.display,
    running: isRunning(p),
    startedAt: p.startedAt,
    exitCode: p.exitCode,
    stoppedByUser: p.stoppedByUser,
    leftover: p.kind === "decompiler",
    // The tail only: the full log can be tens of thousands of characters,
    // and the panel shows a preview rather than the whole thing.
    logTail: p.log.slice(-2000),
  }));
  const seen = new Set(tracked.map((p) => p.id));
  const leftovers = listLeftoverDecompilers()
    .filter((item) => !seen.has(item.id))
    .map((item) => ({
      id: item.id,
      display: item.display,
      running: true,
      startedAt: Date.now(),
      exitCode: null,
      stoppedByUser: false,
      leftover: true,
      logTail: item.command.slice(-2000),
    }));

  return NextResponse.json({
    processes: [...tracked, ...leftovers],
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const target = req.nextUrl.searchParams.get("process");

  if (target === "leftover" || target === "ghidra") {
    return NextResponse.json({ stopped: stopLeftoverDecompilers() });
  }

  if (!target || target === "all") {
    return NextResponse.json({
      stopped: stopAll(id) + stopLeftoverDecompilers(),
    });
  }

  if (target.startsWith("orphan-")) {
    const ok = stopLeftoverById(target);
    return ok
      ? NextResponse.json({ stopped: 1 })
      : NextResponse.json({ error: "No such process" }, { status: 404 });
  }

  const proc = getProcess(target);
  // User processes stay workspace-scoped. Decompiler leftovers can be
  // killed from any chat — after a refresh the user is often on a new one.
  if (!proc || (proc.workspaceId !== id && proc.kind !== "decompiler")) {
    return NextResponse.json({ error: "No such process" }, { status: 404 });
  }

  stopProcess(target);
  return NextResponse.json({ stopped: 1 });
}

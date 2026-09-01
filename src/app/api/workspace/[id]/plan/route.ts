import { NextRequest, NextResponse } from "next/server";
import { readPlan, writePlan, reopenBlockedSteps } from "@/lib/plan";

export const dynamic = "force-dynamic";

/**
 * User control over the agent's saved plan.
 *
 * The plan persists on disk between messages so progress survives a Stop —
 * but that same persistence means a step the agent marked "blocked" (often a
 * refusal dressed up as an obstacle) comes back pre-stuck on every later
 * message. The user must always be able to clear it:
 *
 *   DELETE /api/workspace/:id/plan          wipe the plan entirely
 *   POST   /api/workspace/:id/plan/unblock  reopen blocked steps, keep the rest
 *
 * Both are simple file operations against the same plan store the agent's
 * tools use, so the next reply can never resurrect a state the user deleted.
 */

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await writePlan(id, null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Failed to clear plan:", error);
    return NextResponse.json(
      { error: "Failed to clear plan" },
      { status: 500 }
    );
  }
}

/**
 * Reopen blocked steps without throwing the rest of the plan away.
 *
 * Done steps keep their verified evidence; blocked ones go back to todo with
 * the blocker text removed. This is the "unstick" action: the user wants the
 * agent to try again, not to forget what was already finished.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const action =
      req.nextUrl.searchParams.get("action") ??
      ((await req.json().catch(() => ({}))) as { action?: string }).action;

    if (action === "clear") {
      await writePlan(id, null);
      return NextResponse.json({ ok: true, cleared: true });
    }

    const saved = await readPlan(id);
    if (!saved) {
      return NextResponse.json({ ok: true, plan: null });
    }
    const reopened = reopenBlockedSteps(saved);
    await writePlan(id, reopened);
    return NextResponse.json({ ok: true, plan: reopened });
  } catch (error) {
    console.error("Failed to unblock plan:", error);
    return NextResponse.json(
      { error: "Failed to update plan" },
      { status: 500 }
    );
  }
}

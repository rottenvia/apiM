import { NextRequest, NextResponse } from "next/server";
import { decide } from "@/lib/approvals";

export const dynamic = "force-dynamic";

/**
 * Records the user's Run / Skip decision.
 *
 * Arrives on a separate request from the chat stream that is waiting for it,
 * which is why approvals are held in a shared map rather than a closure.
 */
export async function POST(req: NextRequest) {
  let body: { id?: string; approved?: boolean; remember?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.id !== "string" || !body.id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const ok = decide(
    body.id,
    body.approved
      ? { approved: true, remember: body.remember === true }
      : { approved: false, reason: "The user declined to run this command." }
  );

  if (!ok) {
    // Already answered, timed out, or the reply was stopped.
    return NextResponse.json(
      { error: "That approval is no longer waiting" },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { answerQuestion } from "@/lib/approvals";

export const dynamic = "force-dynamic";

/**
 * Delivers the user's answer to a question the model asked.
 *
 * Arrives on a separate request from the chat stream waiting for it, which is
 * why pending questions live in a shared map rather than a closure.
 */
export async function POST(req: NextRequest) {
  let body: { id?: string; answer?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.id !== "string" || !body.id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  if (!answer) {
    return NextResponse.json({ error: "answer is required" }, { status: 400 });
  }

  if (!answerQuestion(body.id, answer.slice(0, 2000))) {
    // Already answered, timed out, or the reply was stopped.
    return NextResponse.json(
      { error: "That question is no longer waiting" },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true });
}

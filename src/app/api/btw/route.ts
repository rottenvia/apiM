import { NextRequest, NextResponse } from "next/server";
import { appendBtwNote } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A note to the RUNNING task — the user's mid-run steering channel.
 *
 * While a reply is in flight, "btw it's a dead DLL, don't touch it" is NOT a
 * side question (the old design answered asides in a separate, tool-less
 * context that the running task never saw). It is information the running
 * task needs, at the next thinking step.
 *
 * So this route does the smallest possible thing: it queues the note on the
 * conversation. The agent loop drains the queue at the next round boundary
 * and turns each note into a real user message —
 *
 *   [While I was working, the user added: it's a dead DLL, don't touch it]
 *
 * — which the model reads as live steering at its next step, while nothing
 * that was running (a tool call, a decompile, a stream) is interrupted. The
 * note is also persisted as an ordinary user message, so it keeps steering
 * every later turn of the conversation, not just the round it landed in.
 *
 * No model call happens here: the note costs the next round a few dozen
 * tokens and nothing else.
 */

/** A note is a course correction, not a second conversation. */
const MAX_NOTE_CHARS = 2000;

interface Incoming {
  conversationId?: unknown;
  note?: unknown;
}

export async function POST(req: NextRequest) {
  let body: Incoming;
  try {
    body = (await req.json()) as Incoming;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const conversationId =
    typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  const note = typeof body.note === "string" ? body.note.trim() : "";

  if (!conversationId) {
    return NextResponse.json(
      { error: "conversationId is required" },
      { status: 400 }
    );
  }
  if (!note) {
    return NextResponse.json({ error: "A note is required" }, { status: 400 });
  }
  if (note.length > MAX_NOTE_CHARS) {
    return NextResponse.json(
      {
        error: `The note limit is ${MAX_NOTE_CHARS} characters — a note is a course correction, not a document.`,
      },
      { status: 400 }
    );
  }

  try {
    await appendBtwNote(conversationId, note);
  } catch (e) {
    console.error("Failed to queue btw note:", e);
    return NextResponse.json(
      { error: "Could not save the note for this conversation" },
      { status: 404 }
    );
  }

  return NextResponse.json({ queued: true });
}

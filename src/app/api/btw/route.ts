import { NextRequest, NextResponse } from "next/server";
import { appendBtwNote } from "@/lib/store";
import type { StoredAttachment } from "@/lib/multimodal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A note to the RUNNING task — the user's mid-run steering channel.
 *
 * While a reply is in flight, "btw it's a dead DLL, don't touch it" is NOT a
 * side question. It is information the running task needs, at the next
 * thinking step — optionally with a dropped screenshot or binary attached,
 * exactly like a normal message would carry them.
 *
 * So this route does the smallest possible thing: it queues the note (text +
 * attachments) on the conversation. The agent loop drains the queue at the
 * next round boundary and turns each note into a real user message —
 *
 *   [While I was working, the user added: it's a dead DLL, don't touch it]
 *
 * — which the model reads as live steering at its next step, while nothing
 * that was running (a tool call, a decompile, a stream) is interrupted. The
 * note is also persisted as an ordinary user message, so it keeps steering
 * every later turn of the conversation, not just the round it landed in.
 *
 * No model call happens here: the note costs the next round a few dozen
 * tokens (plus the attachment bytes the composer already inlined) and
 * nothing else.
 */

/** A note is a course correction, not a second conversation. */
const MAX_NOTE_CHARS = 2000;
/** File blocks are already capped client-side (800k chars each); this bounds
 *  the total in case ten of them arrive at once. */
const MAX_WIRE_CHARS = 4_000_000;
/** Same composer cap as a normal message. */
const MAX_ATTACHMENTS = 10;

interface Incoming {
  conversationId?: unknown;
  note?: unknown;
  /** Model-facing text: note plus inlined file blocks (composer output). */
  wireText?: unknown;
  attachments?: unknown;
}

const ATTACHMENT_KINDS = new Set(["text", "image", "video"]);

/** Trust the same shape the composer already sends for a normal message,
 *  but never let a malformed body queue a note that breaks the drain. */
function parseAttachments(raw: unknown): StoredAttachment[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error("attachments must be an array");
  if (raw.length > MAX_ATTACHMENTS) {
    throw new Error(`A note carries at most ${MAX_ATTACHMENTS} attachments`);
  }
  const out: StoredAttachment[] = [];
  for (const a of raw) {
    if (typeof a !== "object" || a === null) continue;
    const att = a as Record<string, unknown>;
    if (typeof att.name !== "string" || !att.name.trim()) continue;
    if (typeof att.kind !== "string" || !ATTACHMENT_KINDS.has(att.kind)) {
      continue;
    }
    out.push({
      name: att.name.trim(),
      kind: att.kind as StoredAttachment["kind"],
      ...(typeof att.dataUrl === "string" ? { dataUrl: att.dataUrl } : {}),
      ...(typeof att.description === "string"
        ? { description: att.description }
        : {}),
      ...(att.descriptionSource === "vision" || att.descriptionSource === "ocr"
        ? { descriptionSource: att.descriptionSource }
        : {}),
    });
  }
  return out;
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
  const wireText =
    typeof body.wireText === "string" ? body.wireText : "";

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
  if (wireText.length > MAX_WIRE_CHARS) {
    return NextResponse.json(
      {
        error: `The attached content is too large (${MAX_WIRE_CHARS.toLocaleString()} characters max).`,
      },
      { status: 400 }
    );
  }

  let attachments: StoredAttachment[] | undefined;
  try {
    attachments = parseAttachments(body.attachments);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Invalid attachments" },
      { status: 400 }
    );
  }

  try {
    await appendBtwNote(conversationId, {
      text: note,
      wireText: wireText || note,
      attachments,
    });
  } catch (e) {
    console.error("Failed to queue btw note:", e);
    return NextResponse.json(
      { error: "Could not save the note for this conversation" },
      { status: 404 }
    );
  }

  return NextResponse.json({ queued: true });
}

import { NextRequest, NextResponse } from "next/server";
import {
  deleteConversation,
  getConversation,
  updateConversation,
  DuplicateTitleError,
} from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const conv = await getConversation(id);
    if (!conv) return NextResponse.json({ error: "Not found" }, { status: 404 });

    /*
     * The saved resume transcript never leaves the server.
     *
     * It holds every tool result from the interrupted reply — the full text
     * of every file that was read — so on a real project it dwarfs the rest
     * of the conversation. The browser only needs to know whether resuming is
     * possible, so it gets a boolean and the payload stays small.
     */
    const messages = conv.messages.map((m) => {
      const { resumeState, ...rest } = m;
      /*
       * Resumable if there is anything worth carrying forward.
       *
       * Not just an exact saved transcript. A reply from before that existed
       * still holds its reasoning, its partial text and the full arguments of
       * every tool call it made, which is enough to reconstruct a usable
       * transcript — see lib/rebuild-resume. Requiring resumeState here made
       * every older chat look unresumable when it was not.
       */
      const canResume =
        Boolean(resumeState?.messages?.length) ||
        (m.role === "assistant" &&
          (Boolean(m.toolEvents?.length) ||
            Boolean(m.reasoningContent?.trim()) ||
            Boolean(m.content?.trim())));
      /*
       * Reasoning is sent as a length, not as text.
       *
       * It is collapsed by default and most of it is never expanded, yet on a
       * long chat it was half the payload — 0.46MB of 0.93MB on a 120-message
       * conversation. Every open of that chat downloaded and parsed it so the
       * user could not read it.
       *
       * The panel now fetches the text when it is opened, from the endpoint
       * below. The length is kept so the UI still knows whether to show the
       * panel at all, without a round trip to find out.
       */
      const { reasoningContent, ...withoutReasoning } = rest;
      return {
        ...withoutReasoning,
        reasoningLength: reasoningContent?.length ?? 0,
        canResume,
      };
    });

    return NextResponse.json({ ...conv, messages });
  } catch (error) {
    console.error("Error reading conversation:", error);
    return NextResponse.json({ error: "Failed to read" }, { status: 500 });
  }
}

/** Rename and archive/unarchive. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = (await req.json()) as { title?: string; archived?: boolean };
    const conv = await updateConversation(id, body);
    if (!conv) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const { messages: _messages, ...summary } = conv;
    void _messages;
    return NextResponse.json(summary);
  } catch (error) {
    // 409 Conflict, not 500: the request was fine, the name is taken. The UI
    // shows this message directly, so it has to read as an explanation.
    if (error instanceof DuplicateTitleError) {
      return NextResponse.json(
        {
          error: `A chat named "${error.title}" already exists. Pick a different name.`,
          code: "duplicate_title",
        },
        { status: 409 }
      );
    }
    console.error("Error updating conversation:", error);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const ok = await deleteConversation(id);
    return NextResponse.json({ ok });
  } catch (error) {
    console.error("Error deleting conversation:", error);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}

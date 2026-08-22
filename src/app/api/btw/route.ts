import { NextRequest, NextResponse } from "next/server";
import { buildWorkspaceContext } from "@/lib/workspace-context";

/**
 * A quick question that must not disturb the running task.
 *
 * The main chat route is one conversation with one transcript. Sending a
 * second message into it while a reply streams would put the question into
 * `conversationHistory`, which the agent's *next round* then reads — so the
 * long task you did not want to interrupt starts answering your aside. That
 * is the failure this route exists to make impossible.
 *
 * Isolation here is structural rather than careful:
 *
 *   - nothing this returns is ever written to the conversation
 *   - it receives the workspace tree and the last question for context, never
 *     the in-flight reply, its reasoning, or its tool results
 *   - it is sent with no `tools` at all, so it cannot write a file or run a
 *     command while the main task is mid-edit — two writers on one workspace
 *     is a corruption bug, not a feature
 *
 * Flash with thinking disabled, because this is a question asked in passing.
 * Pro with reasoning would cost more than the main task's next round and take
 * longer than the question is worth.
 */

import { resolveHelperTarget } from "@/lib/providers";

/** Long enough for a real answer, short enough that it stays an aside. */
const MAX_OUTPUT_TOKENS = 1200;

const SYSTEM_PROMPT =
  "You are answering a quick aside while a longer task runs in the " +
  "background. Be direct and brief — a few sentences, or a short list. " +
  "You cannot run commands or edit files right now, so do not offer to; if " +
  "the answer needs that, say so in one line and suggest asking once the " +
  "current task finishes. You may be shown the project's file listing for " +
  "context. Never pretend to have read a file you were not given.";

interface Incoming {
  question?: unknown;
  deepseekApiKey?: unknown;
  opencodeApiKey?: unknown;
  workspaceId?: unknown;
  /** The user's last real message, purely as context for pronouns. */
  lastUserMessage?: unknown;
}

export async function POST(req: NextRequest) {
  let body: Incoming;
  try {
    body = (await req.json()) as Incoming;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const question =
    typeof body.question === "string" ? body.question.trim() : "";
  const helper = resolveHelperTarget({
    deepseekApiKey:
      typeof body.deepseekApiKey === "string" ? body.deepseekApiKey : "",
    opencodeApiKey:
      typeof body.opencodeApiKey === "string" ? body.opencodeApiKey : "",
  });

  if (!question) {
    return NextResponse.json({ error: "A question is required" }, { status: 400 });
  }
  if (!helper) {
    return NextResponse.json(
      { error: "Add a DeepSeek or OpenCode API key in Settings first" },
      { status: 400 }
    );
  }

  // The file tree only. Enough to answer "where does X live?" without
  // touching anything the running task is working on.
  let workspaceBlock = "";
  if (typeof body.workspaceId === "string" && body.workspaceId) {
    try {
      workspaceBlock = await buildWorkspaceContext(body.workspaceId);
    } catch {
      // Context is a nicety here, not a requirement.
    }
  }

  const context =
    typeof body.lastUserMessage === "string" && body.lastUserMessage.trim()
      ? `\n\nFor context, the user's last message in the main conversation was:\n"${body.lastUserMessage.trim().slice(0, 500)}"\n\nThey are now asking something separate.`
      : "";

  try {
    const res = await fetch(`${helper.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${helper.apiKey}`,
      },
      // Its own signal. Dismissing the aside must not touch the main task,
      // and stopping the main task must not kill the aside.
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(60_000)]),
      body: JSON.stringify({
        model: helper.apiModel,
        ...(helper.thinkingStyle === "openai"
          ? {}
          : { thinking: { type: "disabled" } }),
        max_tokens: MAX_OUTPUT_TOKENS,
        // Deliberately no `tools`. See the note at the top of the file.
        messages: [
          { role: "system", content: SYSTEM_PROMPT + workspaceBlock + context },
          { role: "user", content: question.slice(0, 4000) },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      let message = `${helper.providerName} returned ${res.status}`;
      try {
        const parsed = JSON.parse(detail);
        message = parsed?.error?.message ?? message;
      } catch {
        /* keep the status-based message */
      }
      return NextResponse.json(
        {
          error:
            res.status === 402
              ? `Insufficient ${helper.providerName} balance for the side question.`
              : message,
        },
        { status: 502 }
      );
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const answer = data.choices?.[0]?.message?.content?.trim() ?? "";
    if (!answer) {
      return NextResponse.json(
        { error: "No answer came back. Try asking again." },
        { status: 502 }
      );
    }

    return NextResponse.json({
      answer,
      usage: data.usage ?? null,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      // The user dismissed it. Not an error worth reporting.
      return NextResponse.json({ answer: "", cancelled: true });
    }
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return NextResponse.json(
      {
        error: timedOut
          ? "The side question timed out."
          : "Couldn't reach DeepSeek for the side question.",
      },
      { status: 502 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { saveHistorySummary } from "@/lib/store";
import { loadReplayableHistory } from "@/lib/chat-history";
import {
  COMPACT_TEXT_MAX_CHARS,
  compactChunks,
  compactSystemPrompt,
  historyChars,
  runHistorySummary,
  shapeHistory,
  type StoredHistorySummary,
} from "@/lib/history-summary";
import { activeRuns } from "@/lib/runs";
import {
  applyThinking,
  completionHeaders,
  openrouterProviderFor,
  openrouterReasoningMandatory,
  resolveChatTarget,
} from "@/lib/providers";
import { sanitizeCustomModelDef, type CustomModelDef } from "@/lib/models";
import { estimateCost } from "@/lib/pricing";
import { getDeepSeekPeriod } from "@/lib/deepseek-hours";

export const dynamic = "force-dynamic";

/**
 * /compact — fold the whole conversation into its summary.
 *
 * The automatic summary only ever covers turns that have already left the
 * verbatim window; the newest eight always ride in full. This is the user
 * saying "all of it": every turn up to now is rolled into the summary with
 * the chat's own model, and the next request carries the summary plus
 * whatever is said after it. The transcript on screen is untouched — only
 * what the model is sent changes.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // A running reply is reading this history round by round; compacting under
  // it would change what it is working from mid-task.
  if (activeRuns(id).length > 0) {
    return NextResponse.json(
      { error: "A reply is still running in this chat. Stop it or wait for it to finish, then compact." },
      { status: 409 }
    );
  }

  const history = await loadReplayableHistory(id).catch(() => null);
  if (!history) {
    return NextResponse.json({ error: "This chat has not been saved yet." }, { status: 404 });
  }
  const { messages, stored } = history;
  const shape = shapeHistory(messages, stored);
  const uncovered =
    stored && messages.some((m) => m.id === stored.upToId)
      ? messages.slice(messages.findIndex((m) => m.id === stored.upToId) + 1)
      : messages;
  if (uncovered.length === 0) {
    return NextResponse.json(
      { error: "Nothing new to compact — the conversation is already summarised." },
      { status: 400 }
    );
  }
  if (!stored && messages.length < 2) {
    return NextResponse.json(
      { error: "Nothing to compact yet — send a message first." },
      { status: 400 }
    );
  }

  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const creds = {
    deepseekApiKey: str(body.deepseekApiKey),
    openrouterApiKey: str(body.openrouterApiKey),
    localBaseUrl: str(body.localBaseUrl),
    localApiKey: str(body.localApiKey),
    localApiModel: str(body.localApiModel),
  };
  const customs: CustomModelDef[] = [];
  if (Array.isArray(body.customModels)) {
    for (const entry of body.customModels) {
      const clean = sanitizeCustomModelDef(entry);
      if (clean) customs.push(clean);
    }
  }
  const resolved = resolveChatTarget(str(body.model) ?? "", creds, customs);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }
  const target = resolved.target;
  const instructions = str(body.instructions)?.slice(0, 500);

  // Thinking off: this is extraction, and a think would cost more than the
  // summary. Mandatory-reasoning pins get minimal effort instead of a 400.
  const extraBody: Record<string, unknown> = {};
  if (target.providerId === "openrouter") {
    const pinned = openrouterProviderFor(target.model.id);
    if (pinned) extraBody.provider = pinned;
  }
  applyThinking(
    extraBody,
    target.thinkingStyle,
    false,
    "none",
    target.providerId === "openrouter"
      ? { reasoningMandatory: openrouterReasoningMandatory(target.model.id) }
      : undefined
  );

  const { chunks, skipped } = compactChunks(uncovered);
  let digestDropped = 0;
  let text = stored?.text ?? null;
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const chunk of chunks) {
    const fresh = await runHistorySummary(
      text,
      chunk,
      {
        apiKey: target.apiKey,
        baseUrl: target.baseUrl,
        model: target.apiModel,
        thinkingStyle: target.thinkingStyle,
      },
      req.signal,
      {
        system: compactSystemPrompt(instructions),
        maxTokens: 4000,
        maxChars: COMPACT_TEXT_MAX_CHARS,
        extraBody,
        headers: completionHeaders(target),
      }
    );
    if (!fresh) {
      return NextResponse.json(
        {
          error:
            text === (stored?.text ?? null)
              ? `${target.providerName} did not return a summary. Nothing was changed — try again.`
              : `${target.providerName} stopped partway through. Nothing was changed — try again.`,
        },
        { status: 502 }
      );
    }
    text = fresh.text;
    digestDropped += fresh.droppedTurns;
    if (fresh.usage) {
      usage.prompt_tokens += fresh.usage.prompt_tokens;
      usage.completion_tokens += fresh.usage.completion_tokens;
      usage.total_tokens +=
        fresh.usage.prompt_tokens + fresh.usage.completion_tokens;
    }
  }

  const last = messages[messages.length - 1];
  const next: StoredHistorySummary = {
    text: text ?? "",
    upToId: last.id,
    droppedTurns: (stored?.droppedTurns ?? 0) + skipped + digestDropped,
    updatedAt: new Date().toISOString(),
    manual: true,
    coveredTurns: messages.length,
  };
  const saved = await saveHistorySummary(id, stored?.upToId ?? null, next);
  if (!saved) {
    return NextResponse.json(
      { error: "The chat changed while it was being compacted. Try again." },
      { status: 409 }
    );
  }

  const beforeChars = historyChars(shape.verbatim, stored);
  const afterChars = historyChars([], next);
  return NextResponse.json({
    summary: next,
    beforeChars,
    afterChars,
    usage,
    costUsd: estimateCost(
      usage,
      target.model.id,
      getDeepSeekPeriod().period,
      customs
    ),
    model: target.model.id,
  });
}

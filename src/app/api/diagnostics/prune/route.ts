import { NextRequest, NextResponse } from "next/server";
import { getConversation } from "@/lib/store";
import { pruneTranscript, transcriptChars } from "@/lib/prune";
import { compactTranscript } from "@/lib/compact";
import { loadScopedConversationHistory } from "@/lib/chat-history";
import type { TranscriptMessage } from "@/lib/transcript";

export const dynamic = "force-dynamic";

/**
 * Show what pruning/compaction would do to a conversation WITHOUT spending
 * any model tokens. Visit:
 *   /api/diagnostics/prune?conversationId=<id>
 *
 * Reports raw transcript size vs the size actually sent upstream after
 * pruning and compaction, so you can verify the token-bloat fix is working
 * on an existing (long) chat before sending another message.
 */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("conversationId") ?? "";
  if (!id) {
    return NextResponse.json(
      { error: "conversationId is required" },
      { status: 400 }
    );
  }

  const conv = await getConversation(id);
  if (!conv) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Reconstruct roughly what the chat route builds from stored history.
  const history = await loadScopedConversationHistory(id, { dropLastUser: false });
  const messages: TranscriptMessage[] = history.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
  }));

  const rawChars = transcriptChars(messages);
  const pruned = pruneTranscript(messages);
  const compacted = compactTranscript(pruned.messages);
  const sentChars = transcriptChars(compacted.messages);

  // Count how many tool results are still whole vs collapsed in the sent
  // transcript — the direct indicator of whether giant decompiles are being
  // re-billed.
  let wholeToolResults = 0;
  let collapsedToolResults = 0;
  for (const m of compacted.messages) {
    if (m.role !== "tool") continue;
    if (typeof m.content === "string" && m.content.startsWith("[earlier")) {
      collapsedToolResults += 1;
    } else {
      wholeToolResults += 1;
    }
  }

  return NextResponse.json({
    conversationId: id,
    messageCount: messages.length,
    pruning: {
      thresholdChars: 24_000,
      keepVerbatim: 8,
      minCollapseChars: 1_500,
    },
    raw: {
      chars: rawChars,
      approxTokens: Math.round(rawChars / 3.6),
    },
    afterPrune: {
      chars: transcriptChars(pruned.messages),
      approxTokens: Math.round(transcriptChars(pruned.messages) / 3.6),
      collapsedResults: pruned.stats.collapsed,
      charsSaved: pruned.stats.charsSaved,
    },
    afterCompact: {
      chars: sentChars,
      approxTokens: Math.round(sentChars / 3.6),
      roundsCompacted: compacted.stats.rounds,
    },
    sentToModel: {
      wholeToolResults,
      collapsedToolResults,
    },
    saving: {
      chars: rawChars - sentChars,
      percent: rawChars > 0 ? Math.round((1 - sentChars / rawChars) * 100) : 0,
    },
  });
}

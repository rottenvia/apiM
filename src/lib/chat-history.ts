import { getConversation } from "@/lib/store";

export interface ScopedChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Maximum total characters of recent history to replay.
 *
 * Capping only by message COUNT was the bug: a "new chat" that reused an
 * existing conversation could replay the last 20 messages, and a handful of
 * large ones (hex dumps, long outputs, embedded files) added up to millions
 * of tokens. We keep at most 20 messages AND stop once their combined size
 * crosses this budget, always including the most recent exchange. Roughly
 * 60k tokens — well under a tenth of the window and enough for continuity.
 */
export const MAX_HISTORY_CHARS = 240_000;

/**
 * Load only the transcript owned by one conversation id.
 *
 * Browser-supplied history is deliberately not accepted as an argument. That
 * API shape is the isolation property: a stale client can pick an id or send
 * text, but cannot pair Chat B's id with Chat A's transcript.
 */
export async function loadScopedConversationHistory(
  conversationId: string,
  options: { dropLastUser?: boolean } = {}
): Promise<ScopedChatMessage[]> {
  const stored = await getConversation(conversationId);
  const eligible = (stored?.messages ?? []).filter(
    (entry) =>
      (entry.role === "user" || entry.role === "assistant") &&
      Boolean(entry.content?.trim()) &&
      !entry.incomplete
  );

  // Take the most recent messages, newest last, but stop once the running
  // total exceeds the character budget. Always keep at least the final
  // user/assistant pair so the model knows what it is continuing.
  const picked: typeof eligible = [];
  let size = 0;
  for (let i = eligible.length - 1; i >= 0; i--) {
    const len = eligible[i].content?.length ?? 0;
    if (picked.length > 0 && size + len > MAX_HISTORY_CHARS) break;
    picked.unshift(eligible[i]);
    size += len;
    if (picked.length >= 20) break;
  }

  const history = picked.map((entry) => ({
    role: entry.role as "user" | "assistant",
    content: entry.content,
  }));
  if (options.dropLastUser && history.at(-1)?.role === "user") history.pop();
  return history;
}

import { getConversation } from "@/lib/store";
import type { StoredAttachment } from "@/lib/multimodal";

export interface ScopedChatMessage {
  role: "user" | "assistant";
  content: string;
  attachments?: StoredAttachment[] | null;
}

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
  const history = (stored?.messages ?? [])
    .filter(
      (entry) =>
        (entry.role === "user" || entry.role === "assistant") &&
        // A screenshot-only turn stores empty typed text — keep it so the
        // pixels (or helper description) can be replayed.
        (Boolean(entry.content?.trim()) ||
          Boolean(entry.attachments?.length)) &&
        !entry.incomplete
    )
    .slice(-20)
    .map((entry) => ({
      role: entry.role as "user" | "assistant",
      content: entry.content,
      attachments: entry.attachments ?? null,
    }));
  if (options.dropLastUser && history.at(-1)?.role === "user") history.pop();
  return history;
}

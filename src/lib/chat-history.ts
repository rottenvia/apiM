import { getConversation } from "@/lib/store";
import type { StoredMessage } from "@/lib/store";
import type { StoredAttachment } from "@/lib/multimodal";
import {
  shapeHistory,
  type HistoryShape,
  type ScopedHistoryMessage,
} from "@/lib/history-summary";

export interface ScopedChatMessage {
  role: "user" | "assistant";
  content: string;
  attachments?: StoredAttachment[] | null;
  /** Mid-run steering note (see StoredMessage.note); replayed with its label. */
  note?: boolean;
}

/**
 * Turns worth replaying: finished user/assistant turns with text or media.
 * Shared by the last-20 loader and the summary splitter so the two can
 * never disagree about what counts as history.
 */
function replayable(entry: StoredMessage): boolean {
  return (
    (entry.role === "user" || entry.role === "assistant") &&
    // A screenshot-only turn stores empty typed text — keep it so the
    // pixels (or helper description) can be replayed.
    (Boolean(entry.content?.trim()) || Boolean(entry.attachments?.length)) &&
    !entry.incomplete
  );
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
    .filter(replayable)
    .slice(-20)
    .map((entry) => ({
      role: entry.role as "user" | "assistant",
      content: entry.content,
      attachments: entry.attachments ?? null,
      // Without this a steering note would replay on the next run as plain
      // history — the model would lose the "the user said this mid-task"
      // framing that is the whole point of the label.
      ...(entry.note === true ? { note: true } : {}),
    }));
  if (options.dropLastUser && history.at(-1)?.role === "user") history.pop();
  return history;
}

/**
 * Full replayable history plus its summary split, for request building.
 *
 * Unlike loadScopedConversationHistory this is uncapped: the splitter needs
 * everything to find the backlog boundary, and the verbatim window is
 * decided by shapeHistory (newest turns plus uncovered backlog, max 20),
 * not by a blind slice. One read serves both the window and the stored
 * summary, so the route never fetches the conversation twice.
 */
export async function loadHistoryForRequest(
  conversationId: string,
  options: { dropLastUser?: boolean } = {}
): Promise<HistoryShape> {
  const stored = await getConversation(conversationId);
  const messages: ScopedHistoryMessage[] = (stored?.messages ?? [])
    .filter(replayable)
    .map((entry) => ({
      id: entry.id,
      role: entry.role as "user" | "assistant",
      content: entry.content,
      attachments: entry.attachments ?? null,
      ...(entry.note === true ? { note: true } : {}),
    }));
  if (options.dropLastUser && messages.at(-1)?.role === "user") messages.pop();
  return shapeHistory(messages, stored?.historySummary ?? null);
}

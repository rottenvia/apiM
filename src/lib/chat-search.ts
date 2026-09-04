/**
 * Matching rules for in-conversation search.
 *
 * Two modes:
 *
 * - Whole word (default): the query must line up with a complete word, so
 *   "calc" does not match "calculator" but "calculator" does. This keeps
 *   results tight and predictable, which is what makes a find-in-page useful
 *   rather than noisy.
 * - Partial: plain substring matching, so "calc" does match "calculator".
 *   Available as a toggle for when you only remember part of a word.
 */

export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the matcher.
 *
 * `\b` is not used for the word-boundary case because it behaves badly when
 * the query starts or ends with punctuation (searching "c++" would never
 * match). Lookarounds against an explicit word-character class handle those
 * correctly.
 */
export function buildSearchRegex(
  query: string,
  wholeWord: boolean
): RegExp | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const escaped = escapeRegex(trimmed);
  const pattern = wholeWord
    ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`
    : escaped;

  try {
    return new RegExp(pattern, "giu");
  } catch {
    // Extremely long or pathological input — fall back to substring.
    try {
      return new RegExp(escaped, "gi");
    } catch {
      return null;
    }
  }
}

/** Number of matches in a single string. */
export function countMatches(
  text: string,
  query: string,
  wholeWord: boolean
): number {
  const regex = buildSearchRegex(query, wholeWord);
  if (!regex || !text) return 0;

  let count = 0;
  // Guard against zero-length matches looping forever.
  let guard = 0;
  while (regex.exec(text) !== null && guard < 100_000) {
    count += 1;
    guard += 1;
    if (regex.lastIndex === 0) break;
  }
  return count;
}

/**
 * Whether the text contains at least one match.
 *
 * The find bar used to pass the query to every bubble, so a chat of 70
 * messages re-parsed the markdown of all 70 on every keystroke — most of
 * them contained no match at all. Callers use this to skip those bubbles
 * entirely: the first match ends the scan, so even a megabyte of text costs
 * one regex search rather than the full highlight pass.
 */
export function messageHasMatch(
  text: string,
  query: string,
  wholeWord: boolean
): boolean {
  if (!query.trim() || !text) return false;
  const regex = buildSearchRegex(query, wholeWord);
  if (!regex) return false;
  regex.lastIndex = 0;
  return regex.test(text);
}

export interface MessageLike {
  id: string;
  content: string;
  reasoningContent?: string | null;
}

export interface SearchIndexEntry {
  messageId: string;
  /** Index of the message within the conversation. */
  messageIndex: number;
  /** Global index of this message's first match. */
  offset: number;
  count: number;
}

export interface ChatSearchIndex {
  total: number;
  entries: SearchIndexEntry[];
  /** Index of the earliest matching message, or -1. */
  firstMatchIndex: number;
}

/**
 * Count matches across a conversation and record where each message's matches
 * begin in the global sequence, so "5 of 23" and next/previous navigation can
 * address a specific occurrence.
 *
 * Only visible reply text is searched — reasoning is collapsed by default, so
 * counting it would produce matches the user cannot see.
 */
export function buildChatSearchIndex(
  messages: MessageLike[],
  query: string,
  wholeWord: boolean
): ChatSearchIndex {
  const entries: SearchIndexEntry[] = [];
  let total = 0;
  let firstMatchIndex = -1;

  if (!query.trim()) return { total: 0, entries, firstMatchIndex };

  messages.forEach((message, messageIndex) => {
    const count = countMatches(message.content ?? "", query, wholeWord);
    if (count === 0) return;
    if (firstMatchIndex === -1) firstMatchIndex = messageIndex;
    entries.push({
      messageId: message.id,
      messageIndex,
      offset: total,
      count,
    });
    total += count;
  });

  return { total, entries, firstMatchIndex };
}

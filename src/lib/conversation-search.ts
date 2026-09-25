/**
 * Recall on demand: searching the stored transcript of one conversation.
 *
 * The history summary keeps meaning but drops verbatim text — exact
 * commands, paths, errors, and pasted snippets do not survive compression.
 * Rather than paying to keep everything in context "in case", the model
 * gets this: a way to pull exact earlier wording back when it actually
 * needs it. "What did I paste?", "what did we decide?", "that error from
 * yesterday" — all answerable without replaying the turns every request.
 *
 * Strictly single-conversation. The caller scopes by id (the route passes
 * the current chat); this module never lists or opens another chat, so a
 * search cannot leak Chat A's transcript into Chat B.
 */

import { buildSearchRegex } from "@/lib/chat-search";

/** Chars of context on each side of the first match in an excerpt. */
const EXCERPT_RADIUS = 140;

/** Hits returned per call unless asked for fewer. */
export const CONVERSATION_SEARCH_DEFAULT_LIMIT = 5;

/** Hard ceiling — a search is a pointer, not a replay. */
const CONVERSATION_SEARCH_MAX_LIMIT = 10;

export interface SearchableTurn {
  id: string;
  role: string;
  content: string;
  attachments?: {
    name: string;
    description?: string;
  }[] | null;
}

export interface ConversationSearchHit {
  /** 1-based position of the turn in the conversation. */
  turnIndex: number;
  messageId: string;
  role: string;
  /** First match with surrounding context. */
  excerpt: string;
  matchesInTurn: number;
}

export interface ConversationSearchOutcome {
  query: string;
  turnsSearched: number;
  totalMatches: number;
  hits: ConversationSearchHit[];
  /** True when more turns matched than `limit` returned. */
  truncated: boolean;
}

function excerptAround(text: string, at: number, matchLength: number): string {
  const from = Math.max(0, at - EXCERPT_RADIUS);
  const to = Math.min(text.length, at + matchLength + EXCERPT_RADIUS);
  const head = from > 0 ? "…" : "";
  const tail = to < text.length ? "…" : "";
  return `${head}${text.slice(from, to)}${tail}`;
}

function firstMatch(
  text: string,
  query: string,
  wholeWord: boolean
): { at: number; length: number; count: number } | null {
  const regex = buildSearchRegex(query, wholeWord);
  if (!regex || !text) return null;
  regex.lastIndex = 0;
  const first = regex.exec(text);
  if (!first) return null;
  let count = 1;
  let guard = 0;
  while (regex.exec(text) !== null && guard < 100_000) {
    count += 1;
    guard += 1;
    if (regex.lastIndex === 0) break;
  }
  return { at: first.index, length: first[0].length, count };
}

/**
 * Search one conversation's turns, oldest first.
 *
 * Content is searched first; a turn whose text does not match falls back
 * to its attachment names and helper descriptions, so "the screenshot of
 * the red error" still resolves after the pixels left context.
 */
export function searchStoredMessages(
  turns: SearchableTurn[],
  rawQuery: string,
  options: { wholeWord?: boolean; limit?: number } = {}
): ConversationSearchOutcome {
  const query = rawQuery.trim();
  const empty: ConversationSearchOutcome = {
    query,
    turnsSearched: turns.length,
    totalMatches: 0,
    hits: [],
    truncated: false,
  };
  if (!query) return empty;

  const wholeWord = options.wholeWord !== false;
  const limit = Math.min(
    Math.max(Math.floor(options.limit ?? CONVERSATION_SEARCH_DEFAULT_LIMIT), 1),
    CONVERSATION_SEARCH_MAX_LIMIT
  );

  const hits: ConversationSearchHit[] = [];
  let totalMatches = 0;
  let matchedTurns = 0;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const contentMatch = firstMatch(turn.content ?? "", query, wholeWord);
    let excerpt: string | null = null;
    let count = 0;

    if (contentMatch) {
      excerpt = excerptAround(turn.content, contentMatch.at, contentMatch.length);
      count = contentMatch.count;
    } else {
      const shared = (turn.attachments ?? [])
        .map((a) =>
          a.description ? `${a.name}: ${a.description}` : a.name
        )
        .join("\n");
      const mediaMatch = firstMatch(shared, query, wholeWord);
      if (mediaMatch) {
        excerpt = `Shared: ${excerptAround(shared, mediaMatch.at, mediaMatch.length)}`;
        count = mediaMatch.count;
      }
    }

    if (excerpt === null) continue;
    matchedTurns += 1;
    totalMatches += count;
    if (hits.length < limit) {
      hits.push({
        turnIndex: i + 1,
        messageId: turn.id,
        role: turn.role,
        excerpt,
        matchesInTurn: count,
      });
    }
  }

  return {
    query,
    turnsSearched: turns.length,
    totalMatches,
    hits,
    truncated: matchedTurns > hits.length,
  };
}

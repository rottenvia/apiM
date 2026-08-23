/**
 * Fit an agent transcript into the in-app Qwen window.
 *
 * DeepSeek/Ox have a 1M context, so prune/compact stay lazy on purpose.
 * The sidecar opens 80K. A workspace turn with tools, the file tree and
 * a few rounds of history is already tens of thousands of tokens — the
 * 16K default was a guaranteed 400.
 *
 * Stored transcript is left alone. Only the copy on the wire is reduced.
 */

import {
  LOCAL_TOOL_RESERVE,
  SIDECAR_CTX,
  SIDECAR_MAX_OUTPUT,
} from "@/lib/local-engine-shared";
import { compactTranscript } from "@/lib/compact";
import { pruneTranscript, toolCallsAreBalanced } from "@/lib/prune";
import { foldSystemMessagesToFront } from "@/lib/transcript";
import type { TranscriptMessage } from "@/lib/transcript";

/** Start collapsing old tool results almost immediately on Qwen. */
export const QWEN_PRUNE = {
  keepVerbatim: 3,
  minChars: 600,
  thresholdChars: 8_000,
} as const;

/** Fold finished rounds far earlier than the DeepSeek 500k-token valve. */
export const QWEN_COMPACT = {
  keepRecentRounds: 2,
  thresholdChars: 24_000,
  step: 2,
} as const;

/**
 * Conservative token estimate. llama.cpp counted 73k on a turn our
 * 3.6-chars heuristic would have called ~60k, so we bias high.
 */
export function estimateMessageTokens(messages: TranscriptMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && typeof part === "object" && "type" in part) {
          const p = part as { type: string; text?: string };
          if (p.type === "text" && typeof p.text === "string") {
            chars += p.text.length;
          } else if (p.type === "image_url") {
            chars += 4_500;
          } else if (p.type === "video_url") {
            chars += 24_000;
          }
        }
      }
    }
    if (m.role === "assistant") {
      chars += m.reasoning_content?.length ?? 0;
      for (const call of m.tool_calls ?? []) {
        chars += call.function.arguments.length + call.function.name.length + 24;
      }
    }
  }
  return Math.ceil(chars / 3);
}

/** Tokens left for messages after output and (optional) tool schemas. */
export function localMessageBudget(hasTools: boolean): number {
  return (
    SIDECAR_CTX -
    SIDECAR_MAX_OUTPUT -
    (hasTools ? LOCAL_TOOL_RESERVE : 256) -
    256
  );
}

function lastUserIndex(messages: TranscriptMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

/**
 * Drop the oldest expendable round. Tool calls leave with their replies
 * so the transcript stays a valid API request.
 */
function dropOldestExpendable(
  messages: TranscriptMessage[]
): TranscriptMessage[] | null {
  const lastUser = lastUserIndex(messages);
  if (lastUser < 0) return null;

  for (let i = 0; i < lastUser; i++) {
    const m = messages[i];
    if (m.role === "system" && i === 0) continue;

    if (m.role === "assistant" && m.tool_calls?.length) {
      const ids = new Set(m.tool_calls.map((c) => c.id));
      return messages.filter((x, idx) => {
        if (idx === i) return false;
        if (x.role === "tool" && ids.has(x.tool_call_id)) return false;
        return true;
      });
    }

    if (m.role === "assistant" || m.role === "system") {
      return messages.filter((_, idx) => idx !== i);
    }

    if (m.role === "user" && i !== lastUser) {
      return messages.filter((_, idx) => idx !== i);
    }

    if (m.role === "tool") {
      return messages.filter((_, idx) => idx !== i);
    }
  }
  return null;
}

function clipLeadingSystem(
  messages: TranscriptMessage[],
  keepChars: number
): TranscriptMessage[] {
  const first = messages[0];
  if (!first || first.role !== "system" || first.content.length <= keepChars) {
    return messages;
  }
  const clipped: TranscriptMessage = {
    role: "system",
    content:
      first.content.slice(0, keepChars) +
      "\n\n[clipped to fit the local context window]",
  };
  return [clipped, ...messages.slice(1)];
}

export interface FitLocalResult {
  messages: TranscriptMessage[];
  trimmed: boolean;
  tokens: number;
}

/**
 * Fold, prune, compact and (if needed) drop old rounds until the wire
 * copy fits `budgetTokens`. Input is never mutated.
 */
export function fitForLocalContext(
  messages: TranscriptMessage[],
  budgetTokens: number
): FitLocalResult {
  const pruned = pruneTranscript(messages, QWEN_PRUNE);
  const compacted = compactTranscript(pruned.messages, QWEN_COMPACT);
  let out = foldSystemMessagesToFront(compacted.messages);
  let trimmed =
    pruned.stats.collapsed > 0 ||
    compacted.stats.rounds > 0 ||
    out !== messages;

  let guard = 0;
  while (estimateMessageTokens(out) > budgetTokens && guard < 80) {
    guard += 1;
    const next = dropOldestExpendable(out);
    if (!next || next.length >= out.length) break;
    out = next;
    trimmed = true;
  }

  if (estimateMessageTokens(out) > budgetTokens && out[0]?.role === "system") {
    const other = estimateMessageTokens(out.slice(1));
    const keepChars = Math.max(4_000, (budgetTokens - other - 64) * 3);
    const clipped = clipLeadingSystem(out, keepChars);
    if (clipped !== out) {
      out = clipped;
      trimmed = true;
    }
  }

  if (!toolCallsAreBalanced(out)) {
    return {
      messages: foldSystemMessagesToFront(compacted.messages),
      trimmed,
      tokens: estimateMessageTokens(foldSystemMessagesToFront(compacted.messages)),
    };
  }

  return { messages: out, trimmed, tokens: estimateMessageTokens(out) };
}

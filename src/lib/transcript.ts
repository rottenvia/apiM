/**
 * The API transcript — the exact message list sent to DeepSeek.
 *
 * This is deliberately separate from the messages shown in the UI. The two
 * diverge in ways that matter:
 *
 *   - A single displayed reply can span several API turns (think, call a
 *     tool, read the result, call another, then answer).
 *   - `reasoning_content` must be replayed verbatim on every subsequent
 *     request once `tools` is in play, or DeepSeek returns 400.
 *   - Tool results are `role: "tool"` messages the user never sees.
 *
 * Conflating them is why tool calling could not work before: history was
 * rebuilt as bare {role, content}, discarding reasoning and tool calls
 * entirely.
 */

import type { UserContent } from "@/lib/multimodal";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-encoded object, exactly as the model emitted it. */
    arguments: string;
  };
}

export type TranscriptMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: UserContent }
  | {
      role: "assistant";
      content: string | null;
      /**
       * Chain of thought. Required verbatim in later requests when the turn
       * involved a tool call — omitting it is a 400 from the API.
       */
      reasoning_content?: string | null;
      tool_calls?: ToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/**
 * Strip fields DeepSeek rejects and drop empty ones.
 *
 * An assistant turn with `content: null` is valid when it only called tools,
 * but sending `tool_calls: []` or a stray `undefined` is not.
 */
export function serializeForApi(
  messages: TranscriptMessage[]
): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "assistant") {
      const out: Record<string, unknown> = {
        role: "assistant",
        content: m.content ?? "",
      };
      // Only replay reasoning for turns that actually called a tool. The API
      // ignores it otherwise, and sending it everywhere wastes tokens.
      if (m.tool_calls?.length) {
        out.tool_calls = m.tool_calls;
        if (m.reasoning_content) out.reasoning_content = m.reasoning_content;
        // A tool-calling turn legitimately has no prose.
        out.content = m.content ?? null;
      }
      return out;
    }

    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.tool_call_id,
        content: m.content,
      };
    }

    return { role: m.role, content: m.content };
  });
}

/**
 * Assemble streamed tool-call deltas.
 *
 * Arguments arrive as fragments across many chunks and must be concatenated
 * before the JSON can be parsed. Acting on a partial fragment would run a tool
 * with truncated arguments, so nothing is executed until the stream ends.
 */
export class ToolCallAccumulator {
  private calls = new Map<number, ToolCall>();

  add(delta: {
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }): void {
    const index = delta.index ?? 0;
    const existing = this.calls.get(index);

    if (!existing) {
      this.calls.set(index, {
        id: delta.id ?? "",
        type: "function",
        function: {
          name: delta.function?.name ?? "",
          arguments: delta.function?.arguments ?? "",
        },
      });
      return;
    }

    // Later chunks fill in whichever pieces were missing.
    if (delta.id) existing.id = delta.id;
    if (delta.function?.name) existing.function.name = delta.function.name;
    if (delta.function?.arguments) {
      existing.function.arguments += delta.function.arguments;
    }
  }

  /** Completed calls in the order the model emitted them. */
  result(): ToolCall[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call)
      .filter((c) => c.function.name);
  }

  get size(): number {
    return this.calls.size;
  }

  reset(): void {
    this.calls.clear();
  }
}

/** Parse tool arguments defensively — a malformed blob must not throw. */
export function parseToolArguments(
  raw: string
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "Arguments must be a JSON object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid JSON",
    };
  }
}

/**
 * Rebuild an API transcript from stored messages.
 *
 * Stored turns keep their reasoning and tool calls, so reopening a
 * conversation and continuing it replays a valid transcript rather than a
 * lossy {role, content} summary.
 */
export interface StoredTurn {
  role: "user" | "assistant";
  content: string;
  reasoningContent?: string | null;
  toolCalls?: ToolCall[] | null;
  toolResults?: { tool_call_id: string; content: string }[] | null;
}

export function rebuildTranscript(
  turns: StoredTurn[],
  limit = 20
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];

  for (const turn of turns.slice(-limit)) {
    if (turn.role === "user") {
      if (turn.content.trim()) out.push({ role: "user", content: turn.content });
      continue;
    }

    const hasCalls = Boolean(turn.toolCalls?.length);
    // Skip empty assistant turns that did nothing — a blank reply makes the
    // model continue it instead of answering the next question.
    if (!turn.content.trim() && !hasCalls) continue;

    out.push({
      role: "assistant",
      content: turn.content || null,
      reasoning_content: hasCalls ? turn.reasoningContent : undefined,
      tool_calls: turn.toolCalls ?? undefined,
    });

    for (const result of turn.toolResults ?? []) {
      out.push({
        role: "tool",
        tool_call_id: result.tool_call_id,
        content: result.content,
      });
    }
  }

  return out;
}

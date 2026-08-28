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

/**
 * How a mid-run steering note is labeled on the wire.
 *
 * The model needs to know, from the message alone, that the user said this
 * *while the task was running* — not that it started a new task. The label
 * is what makes "hmm, the user just told me not to touch that DLL" happen at
 * the next thinking step instead of the note being read as fresh instructions
 * that restart the plan.
 */
export const MID_RUN_NOTE_LABEL = "While I was working, the user added:";

export type TranscriptMessage =
  | { role: "system"; content: string }
  /**
   * `note` marks a steering note the user added while a reply was already
   * running ("btw …"). It serializes with the mid-run label so the model
   * reads it as live steering, not a new task.
   */
  | { role: "user"; content: UserContent; note?: boolean }
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
 * Qwen's chat template (llama-server --jinja) only accepts a system
 * message at index 0. A later one raises:
 *   "System message must be at the beginning."
 *
 * The agent loop appends the file tree, plan and plugin block as extra
 * system messages so DeepSeek can cache the prefix. Those stay in the
 * stored transcript. On the wire for Qwen they are folded into the first
 * system message, in order, so nothing is dropped.
 */
export function foldSystemMessagesToFront(
  messages: TranscriptMessage[]
): TranscriptMessage[] {
  const systems: string[] = [];
  const rest: TranscriptMessage[] = [];
  let laterSystem = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "system") {
      if (i > 0) laterSystem = true;
      if (m.content) systems.push(m.content);
      continue;
    }
    rest.push(m);
  }
  if (!laterSystem) return messages;
  if (systems.length === 0) return rest;
  return [{ role: "system", content: systems.join("\n\n") }, ...rest];
}

/**
 * Strip fields DeepSeek rejects and drop empty ones.
 *
 * An assistant turn with `content: null` is valid when it only called tools,
 * but sending `tool_calls: []` or a stray `undefined` is not.
 *
 * `includeReasoning` exists for hosts that are NOT DeepSeek. `reasoning_content`
 * is a DeepSeek wire field: DeepSeek 400s when a tool-calling turn omits it,
 * but OpenCode Zen validates its Chat Completions schema strictly and the
 * Ox Alpha catalog says the field is not required there
 * (`requiresReasoningContentOnAssistantMessages: No`) — replaying it is what
 * turns a 20-round agent run into a 400 "[1210] Invalid API parameter" on
 * every subsequent round and every resume. Stripping it for those hosts also
 * stops resending ~9k tokens of chain-of-thought per round on a free pool.
 */
export function serializeForApi(
  messages: TranscriptMessage[],
  options: { includeReasoning?: boolean } = {}
): Record<string, unknown>[] {
  const { includeReasoning = true } = options;
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
        if (includeReasoning && m.reasoning_content)
          out.reasoning_content = m.reasoning_content;
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

    /*
     * Mid-run steering note: label it on the wire, every time.
     *
     * The label is added here (not stored on the message) so every provider
     * — and every resume, which re-serializes the saved transcript — sees
     * the identical framing. With attachments the content is a part array
     * (text + image_url): the FIRST text part takes the label, so the
     * framing reads before the pixels without any part being lost.
     */
    if (m.role === "user" && m.note) {
      if (typeof m.content === "string") {
        return {
          role: "user",
          content: `[${MID_RUN_NOTE_LABEL} ${m.content}]`,
        };
      }
      const parts = m.content.map((p) => ({ ...p }));
      const firstTextIdx = parts.findIndex((p) => p.type === "text");
      const firstText = firstTextIdx === -1 ? null : parts[firstTextIdx];
      if (!firstText || firstText.type !== "text") {
        parts.unshift({ type: "text", text: MID_RUN_NOTE_LABEL });
      } else {
        parts[firstTextIdx] = {
          type: "text",
          text: `[${MID_RUN_NOTE_LABEL} ${firstText.text}]`,
        };
      }
      return { role: "user", content: parts };
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
  /**
   * Every call seen this round, in the order the model started them.
   *
   * An array rather than a Map keyed by index, because `index` cannot be
   * trusted as an identity. Well-behaved providers number parallel calls
   * 0,1,2… and stream their argument fragments interleaved. Others — GLM
   * 5.3 Flash through OpenRouter among them — emit calls one after another
   * and restart the numbering, or omit `index` entirely, so a round with
   * eight `edit_file` calls arrived as eight deltas all claiming slot 0.
   *
   * Keyed only by index, those eight were concatenated into ONE call whose
   * arguments were eight JSON objects glued together: unparseable, so the
   * whole round was reported as "invalid tool arguments" and nothing was
   * edited. That is the "it can't batch edit a lot of files" bug, and it
   * gets worse the more files the model tries to do at once.
   */
  private open = new Map<number, ToolCall>();
  private order: ToolCall[] = [];

  add(delta: {
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }): void {
    const index = delta.index ?? 0;
    const existing = this.open.get(index);

    if (existing && this.startsNewCall(existing, delta)) {
      // The slot is being reused for a different call. Retire what is there
      // — it stays in `order`, complete — and begin a fresh one rather than
      // appending this delta to it.
      this.open.delete(index);
    }

    const current = this.open.get(index);
    if (!current) {
      const call: ToolCall = {
        id: delta.id ?? "",
        type: "function",
        function: {
          name: delta.function?.name ?? "",
          arguments: delta.function?.arguments ?? "",
        },
      };
      this.open.set(index, call);
      this.order.push(call);
      return;
    }

    // Later chunks fill in whichever pieces were missing.
    if (delta.id) current.id = delta.id;
    if (delta.function?.name) {
      /*
       * Names arrive whole, but some providers repeat the name on every
       * fragment and others send it once. Appending would produce
       * "edit_fileedit_file"; overwriting an identical name is harmless.
       */
      current.function.name = delta.function.name;
    }
    if (delta.function?.arguments) {
      current.function.arguments += delta.function.arguments;
    }
  }

  /**
   * Is this delta a new call landing on an occupied slot?
   *
   * Only two signals are trusted, and both are unambiguous: a different
   * non-empty id, or a different function name once arguments have already
   * started. Anything looser would split a single call whose provider
   * merely repeats metadata on each fragment.
   */
  private startsNewCall(
    existing: ToolCall,
    delta: { id?: string; function?: { name?: string } }
  ): boolean {
    if (delta.id && existing.id && delta.id !== existing.id) return true;
    return Boolean(
      delta.function?.name &&
        existing.function.name &&
        delta.function.name !== existing.function.name &&
        existing.function.arguments.length > 0
    );
  }

  /**
   * Completed calls in the order the model emitted them.
   *
   * Insertion order, not index order: with a provider that reuses index 0
   * for every call, index order says nothing, while the order they were
   * started in is exactly the order the model asked for.
   */
  result(): ToolCall[] {
    return this.order.filter((c) => c.function.name);
  }

  get size(): number {
    return this.order.length;
  }

  reset(): void {
    this.open.clear();
    this.order = [];
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
 * Tools whose arguments are a list of jobs, and the key that holds it.
 *
 * These are the calls that get physically large: twenty edits or a dozen
 * whole files is tens of thousands of tokens of JSON in ONE argument blob.
 * They are also the calls a model is told to prefer, so "the batch was too
 * big to finish streaming" cannot be allowed to mean "nothing happened".
 */
export const BATCH_TOOL_ITEMS: Record<string, string> = {
  read_files: "paths",
  write_files: "files",
  edit_files: "edits",
};

/**
 * What a complete item looks like for each batch tool.
 *
 * Used to throw away the half-written job at the end of a cut-off call. An
 * edit with a path and no replacement text is not a smaller edit, it is a
 * broken one, and applying it would corrupt a file the model believes it
 * fixed. `read_files` takes plain strings, so it has no key list.
 */
export const BATCH_TOOL_REQUIRED: Record<string, string[]> = {
  write_files: ["path", "content"],
  edit_files: ["path", "old_text", "new_text"],
};

/**
 * Recover the complete items from a tool call that was cut off mid-JSON.
 *
 * When a round hits the output ceiling in the middle of a batch call, the
 * arguments are valid JSON right up to the point the budget ran out. The old
 * behaviour threw all of it away and asked the model to send the batch again
 * — which, being the same batch, was cut off in the same place. A model that
 * tries to edit thirty files then makes no progress at all, forever.
 *
 * This closes the open brackets, drops the half-written item at the end, and
 * hands back what was complete so those edits can actually land. Returns null
 * when nothing usable can be recovered.
 */
export function salvageToolArguments(
  raw: string,
  toolName?: string
): { value: Record<string, unknown> } | null {
  const repaired = repairPartialJson(raw);
  if (!repaired) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(repaired);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const value = parsed as Record<string, unknown>;

  /*
   * Drop a trailing item that is only half there.
   *
   * The cut always lands on a value boundary, so the last object in a list
   * can be missing the keys its siblings have — an edit with a path and no
   * new_text. Applying that would be worse than not applying it.
   */
  const required = toolName ? BATCH_TOOL_REQUIRED[toolName] : undefined;

  for (const key of Object.keys(value)) {
    const list = value[key];
    if (!Array.isArray(list) || list.length === 0) continue;

    value[key] = list.filter((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        // A bare string (a read_files path) is either whole or was never
        // closed, and an unclosed one never survives the repair.
        return true;
      }
      const keys = Object.keys(item as Record<string, unknown>);
      if (required) {
        return required.every((k) => typeof (item as Record<string, unknown>)[k] === "string");
      }
      /*
       * No declared shape: fall back to the siblings. The items of a batch
       * are uniform, so an item with fewer keys than the rest is the one the
       * stream stopped in the middle of.
       */
      const shape = new Set<string>();
      for (const other of list) {
        if (other !== item && other && typeof other === "object" && !Array.isArray(other)) {
          for (const k of Object.keys(other)) shape.add(k);
        }
      }
      if (shape.size === 0) return keys.length > 0;
      return keys.length >= shape.size;
    });
  }

  return { value };
}

/** How many jobs a salvaged batch call still carries. */
export function batchItemCount(
  name: string,
  args: Record<string, unknown>
): number {
  const key = BATCH_TOOL_ITEMS[name];
  if (!key) return 0;
  const list = args[key];
  return Array.isArray(list) ? list.length : 0;
}

/**
 * Close the containers a truncated JSON document left open.
 *
 * Walks once, remembering for every depth the offset just after the last
 * COMPLETED value at that depth. Then it tries those cut points from the
 * deepest outwards: the deepest one keeps the most work, and anything that
 * does not parse falls back to a shallower, safer cut.
 */
function repairPartialJson(raw: string): string | null {
  const text = raw.trimEnd();
  if (!text.startsWith("{")) return null;

  const stack: string[] = [];
  // safe[depth] = offset just after the last completed value at that depth.
  const safe: number[] = [];
  // Which containers are open at each recorded cut point.
  const openAt: string[][] = [];
  let inString = false;
  let escaped = false;

  const mark = (offset: number) => {
    const depth = stack.length;
    if (depth === 0) return;
    safe[depth] = offset;
    openAt[depth] = [...stack];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{" || c === "[") {
      stack.push(c);
      mark(i + 1);
      continue;
    }
    if (c === "}" || c === "]") {
      stack.pop();
      mark(i + 1);
      continue;
    }
    if (c === ",") {
      // Cut BEFORE the comma: everything up to here is a whole value.
      mark(i);
    }
  }

  // Nothing was left open — this is not a truncation, it is a bad document.
  if (stack.length === 0) return null;

  for (let depth = safe.length - 1; depth >= 1; depth--) {
    const cut = safe[depth];
    if (cut === undefined) continue;
    const open = openAt[depth] ?? [];
    let candidate = text.slice(0, cut).trimEnd();
    // An empty container, or one whose only item was the truncated one.
    if (/[[{,]$/.test(candidate)) candidate = candidate.replace(/,$/, "");
    for (let k = open.length - 1; k >= 0; k--) {
      candidate += open[k] === "{" ? "}" : "]";
    }
    try {
      const value = JSON.parse(candidate);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return candidate;
      }
    } catch {
      // Try a shallower cut.
    }
  }

  return null;
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

/**
 * Where the bytes of one Chat Completions request live.
 *
 * The retry banner shows the whole body as "612k chars in", which answers
 * "how big" but not "why" — and "why" is the actionable half. A 600k body
 * made of plugins wants different treatment than one made of screenshots
 * or one made of replayed reasoning. This walks the serialised messages
 * and attributes every character to a bucket, largest first.
 *
 * Sizes are raw string lengths, not JSON-escaped lengths, so the buckets
 * sum to slightly less than the body. Close enough for attribution: the
 * banner's total stays the honest `bodyJson.length`.
 */

import { PLUGIN_DIRECTIVES_MARKER } from "@/lib/plugins";
import { PLAN_MARKER } from "@/lib/plan";
import { HISTORY_SUMMARY_MARKER } from "@/lib/history-summary";
import { GOAL_PIN_MARKER } from "@/lib/goal-pin";

export interface RequestSizePart {
  label: string;
  chars: number;
}

function add(parts: Map<string, number>, label: string, chars: number): void {
  if (chars <= 0) return;
  parts.set(label, (parts.get(label) ?? 0) + chars);
}

/**
 * Bucket the serialised messages of one request.
 *
 * `messages` is the post-`serializeForApi` shape (plain JSON), `toolsChars`
 * the stringified tool schemas. Returns non-empty buckets, largest first.
 */
export function breakdownRequestMessages(
  messages: unknown,
  toolsChars: number
): RequestSizePart[] {
  const parts = new Map<string, number>();
  add(parts, "tool schemas", toolsChars);

  if (!Array.isArray(messages)) return sorted(parts);

  // The last user turn is the live question; every earlier user turn is
  // history. Media counts separately either way.
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown } | null;
    if (m && typeof m === "object" && m.role === "user") {
      lastUser = i;
      break;
    }
  }

  messages.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") return;
    const m = entry as {
      role?: unknown;
      content?: unknown;
      reasoning_content?: unknown;
      tool_calls?: unknown;
    };
    if (m.role === "system") {
      if (typeof m.content !== "string") return;
      const text = m.content;
      if (text.includes(PLUGIN_DIRECTIVES_MARKER)) add(parts, "plugins", text.length);
      else if (text.startsWith("Current workspace contents"))
        add(parts, "file tree", text.length);
      else if (text.startsWith("Workspace changes since"))
        add(parts, "tree updates", text.length);
      else if (text.startsWith(PLAN_MARKER)) add(parts, "plan", text.length);
      else if (text.startsWith(HISTORY_SUMMARY_MARKER))
        add(parts, "summary", text.length);
      else if (text.startsWith(GOAL_PIN_MARKER))
        add(parts, "goal", text.length);
      else add(parts, "instructions", text.length);
      return;
    }
    if (m.role === "user") {
      const bucket = i === lastUser ? "your message" : "history";
      addUserContent(parts, m.content, bucket);
      return;
    }
    if (m.role === "assistant") {
      if (typeof m.content === "string") add(parts, "history", m.content.length);
      if (typeof m.reasoning_content === "string")
        add(parts, "reasoning", m.reasoning_content.length);
      if (Array.isArray(m.tool_calls)) {
        for (const call of m.tool_calls) {
          const fn = (call as { function?: { name?: unknown; arguments?: unknown } })
            ?.function;
          if (typeof fn?.arguments === "string")
            add(parts, "tool calls", fn.arguments.length);
          if (typeof fn?.name === "string") add(parts, "tool calls", fn.name.length);
        }
      }
      return;
    }
    if (m.role === "tool") {
      if (typeof m.content === "string")
        add(parts, "tool results", m.content.length);
    }
  });

  return sorted(parts);
}

function addUserContent(
  parts: Map<string, number>,
  content: unknown,
  textBucket: string
): void {
  if (typeof content === "string") {
    add(parts, textBucket, content.length);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as {
      type?: unknown;
      text?: unknown;
      image_url?: { url?: unknown };
      video_url?: { url?: unknown };
    };
    if (p.type === "text" && typeof p.text === "string") {
      add(parts, textBucket, p.text.length);
    } else if (p.type === "image_url" && typeof p.image_url?.url === "string") {
      add(parts, "media", p.image_url.url.length);
    } else if (p.type === "video_url" && typeof p.video_url?.url === "string") {
      add(parts, "media", p.video_url.url.length);
    }
  }
}

function sorted(parts: Map<string, number>): RequestSizePart[] {
  return [...parts.entries()]
    .map(([label, chars]) => ({ label, chars }))
    .sort((a, b) => b.chars - a.chars);
}

/**
 * One line per history turn, oldest first: role, size, and the opening words.
 *
 * The `history` bucket answers "how much" but a 479k history is still a
 * mystery until you see WHICH turns hold it — one 400k user paste reads
 * very differently from twenty chatty replies. Logged beside the breakdown
 * when history dominates, so the terminal names the fat turns directly.
 */
export function describeHistoryTurns(
  messages: unknown,
  limit = 8
): string[] {
  if (!Array.isArray(messages)) return [];
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown } | null;
    if (m && typeof m === "object" && m.role === "user") {
      lastUser = i;
      break;
    }
  }
  const rows: { role: string; chars: number; head: string }[] = [];
  messages.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") return;
    const m = entry as { role?: unknown; content?: unknown };
    const isHistoryUser = m.role === "user" && i !== lastUser;
    const isHistoryAssistant =
      m.role === "assistant" && typeof m.content === "string";
    if (!isHistoryUser && !isHistoryAssistant) return;
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter(
                (p): p is { type: string; text: string } =>
                  Boolean(p) &&
                  typeof p === "object" &&
                  (p as { type?: unknown }).type === "text" &&
                  typeof (p as { text?: unknown }).text === "string"
              )
              .map((p) => p.text)
              .join("\n")
          : "";
    if (!text) return;
    const head =
      text.replace(/\s+/g, " ").trim().slice(0, 60) || "(no text)";
    rows.push({
      role: m.role === "user" ? "user" : "asst",
      chars: text.length,
      head,
    });
  });
  rows.sort((a, b) => b.chars - a.chars);
  const k = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(0)}k` : `${n}`;
  return rows
    .slice(0, limit)
    .map((r) => `${r.role} ${k(r.chars)} "${r.head}${r.head.length >= 60 ? "…" : ""}"`);
}

/** `612k chars (plugins 310k · history 120k)` — the server log line. */
export function formatBreakdown(
  totalChars: number,
  parts: RequestSizePart[],
  shown = 4
): string {
  const k = (n: number) =>
    n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1000
        ? `${(n / 1000).toFixed(0)}k`
        : `${n}`;
  const head = parts
    .slice(0, shown)
    .map((p) => `${p.label} ${k(p.chars)}`)
    .join(" · ");
  return `${k(totalChars)} chars${head ? ` (${head})` : ""}`;
}

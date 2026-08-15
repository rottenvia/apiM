/**
 * Normalize plain-text reasoning from OpenAI-compatible streaming deltas.
 *
 * DeepSeek's documented field is `reasoning_content`, but compatible gateways
 * and model revisions also use `reasoning`, `thinking`, or camelCase. The UI
 * previously treated every alternate shape as "no reasoning returned" even
 * when the text was present in the same chunk. Only explicit reasoning fields
 * are accepted here — ordinary answer `content` is never relabelled as thought.
 */
export interface ReasoningDelta {
  text: string;
  field: string;
}

const FIELDS = [
  "reasoning_content",
  "reasoning",
  "thinking",
  "reasoningContent",
] as const;

export function extractReasoningDelta(
  delta: Record<string, unknown> | null | undefined
): ReasoningDelta | null {
  if (!delta) return null;

  for (const field of FIELDS) {
    const text = plainText(delta[field]);
    if (text) return { text, field };
  }
  return null;
}

function plainText(value: unknown): string {
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const item = part as Record<string, unknown>;
        const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
        // Do not pull ordinary output_text/content blocks into reasoning.
        if (type && !/reason|think/.test(type)) return "";
        return typeof item.text === "string"
          ? item.text
          : typeof item.content === "string"
            ? item.content
            : "";
      })
      .join("");
  }

  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    if (typeof item.text === "string") return item.text;
    if (typeof item.content === "string") return item.content;
  }

  return "";
}

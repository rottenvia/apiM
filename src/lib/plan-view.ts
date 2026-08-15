/**
 * Turn a model-supplied plan step into text a person can read.
 *
 * The tool schema asks for strings, but models sometimes send richer objects
 * such as { title, description }. Calling String(object) produces the literal
 * "[object Object]", which is what reached every row in Screenshot_168.
 * Accept the useful structured shapes at the boundary and reject everything
 * else instead of leaking JavaScript coercion into the UI and saved plan.
 */
export function normalisePlanStepText(value: unknown): string {
  if (typeof value === "string") {
    const text = value.trim();
    // Already-corrupted plans from older builds stored the coercion result,
    // so the original title cannot be recovered. Never keep displaying the
    // JavaScript placeholder; the UI will show "Untitled step" instead.
    return /^\[object Object\]$/i.test(text) ? "" : text;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";

  const item = value as Record<string, unknown>;
  const field = (...names: string[]): string => {
    for (const name of names) {
      const candidate = item[name];
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
    return "";
  };

  const title = field("title", "name", "label", "step");
  const description = field("description", "details", "detail", "text", "task");

  if (title && description && normalise(title) !== normalise(description)) {
    return `${title} — ${description}`;
  }
  return title || description;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

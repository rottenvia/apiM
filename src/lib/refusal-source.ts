/**
 * Who stopped a reply.
 *
 * apiM adds no content rules of its own: it sends what the user typed to the
 * provider and shows what comes back. When a model refuses, or a provider's
 * own content filter blocks a request, the user (or their client) only sees
 * that something said no. Without a name on it, the app gets the blame.
 * These helpers tell the two real sources apart so the UI can say which one
 * it was.
 *
 * Client-safe: no Node imports, so MessageBubble can use it.
 */

/**
 * Provider-side content filters, as their errors read.
 *
 * DeepSeek answers 400 "Content Exists Risk". Zhipu (GLM) answers code 1301
 * with "contentFilter" or a Chinese/English "unsafe or sensitive content"
 * message. OpenRouter forwards moderation as 403 "requires moderation" or
 * "flagged". The generic ones cover the rest without matching ordinary
 * errors that merely mention content (a 413 "content too large" stays out).
 */
const PROVIDER_FILTER = [
  /content exists risk/i,
  /\bcontentFilter\b/,
  /\b1301\b[\s\S]{0,200}(?:sensitive|unsafe)/i,
  /(?:unsafe|sensitive) content/i,
  /不安全或敏感/,
  /data_inspection_failed/i,
  /\bcontent[\s_-]?(?:filter|moderation|management policy)\b/i,
  /requires? moderation|flagged by (?:the )?moderation|moderation (?:flagged|block)/i,
  /\bsafety (?:system|filter)\b/i,
  /\b(?:prohibited|inappropriate) content\b/i,
];

/** Is this upstream error a provider's content filter, not a fault? */
export function isProviderContentBlock(detail: string): boolean {
  return PROVIDER_FILTER.some((re) => re.test(detail));
}

/** The error text for a request a provider's own filter blocked. */
export function providerContentBlockMessage(providerName: string, detail: string): string {
  const trimmed = readableDetail(detail).replace(/\s+/g, " ").trim().slice(0, 200);
  return (
    `${providerName} blocked this request with its own content filter` +
    (trimmed ? ` ("${trimmed}")` : "") +
    `. This check runs on ${providerName}'s servers; apiM does not filter or change ` +
    `what you send. Rephrase it, or switch to another model and press Try again.`
  );
}

/** The provider's own message out of a JSON error body, else the text as given. */
function readableDetail(detail: string): string {
  try {
    const body = JSON.parse(detail) as { error?: { message?: unknown } | string; message?: unknown };
    const inner = typeof body.error === "object" ? body.error?.message : body.error;
    const message = inner ?? body.message;
    if (typeof message === "string" && message.trim()) return message;
  } catch {
    // Not JSON: already a plain message.
  }
  return detail;
}

/**
 * Declines as they open a reply: "I'm sorry, but I can't help with that",
 * "I can't assist with", "I won't write", "against my guidelines".
 *
 * First-person and about the request, so "I can't reproduce the bug" or
 * "the build can't find the symbol" are not refusals.
 */
const REPLY_REFUSAL = [
  /\bI\s+(?:cannot|can'?t|won'?t|will\s+not|am\s+not\s+able\s+to|am\s+unable\s+to|'m\s+unable\s+to)\s+(?:help(?!\s+(?:noticing|but|thinking|wondering))|assist|comply|provide|create|write|generate|fulfill|fulfil|support|engage)\b/i,
  /\b(?:I'?m\s+)?sorry,?\s+but\s+I\s+(?:cannot|can'?t|won'?t)\b/i,
  /\bI\s+(?:must|have\s+to)\s+decline\b/i,
  /\b(?:against|violates?)\s+(?:my|the|our)\s+(?:content\s+|safety\s+|usage\s+)?(?:policy|policies|guidelines?|principles?)\b/i,
  /\bnot\s+(?:able|allowed|permitted)\s+to\s+(?:help|assist|provide|create|write|generate)\s+(?:with\s+)?(?:that|this)\b/i,
];

/** Longest reply still read as a refusal. A long answer that hedges once is an answer. */
const MAX_REFUSAL_CHARS = 1500;

/** Only the opening is checked: a refusal says so up front. */
const OPENING_CHARS = 600;

/** Does this finished reply read as the model declining the request? */
export function looksLikeModelRefusal(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t || t.length > MAX_REFUSAL_CHARS) return false;
  const opening = t.slice(0, OPENING_CHARS);
  return REPLY_REFUSAL.some((re) => re.test(opening));
}

/** A model id as people read it: the catalog label, else the id's own name. */
export function modelDisplayName(
  id: string | null | undefined,
  catalog: readonly { id: string; label: string }[]
): string {
  if (!id) return "the model";
  const known = catalog.find((m) => m.id === id);
  if (known) return known.label;
  // custom:vendor/model-name:free → model-name
  const slug = id.replace(/^custom:/, "").split("/").pop() ?? id;
  return slug.replace(/:.*$/, "");
}

export type RefusalSource = "content_filter" | "model" | null;

/**
 * Why a finished assistant reply should carry a "this was not apiM" note.
 *
 * `content_filter` when the provider ended the stream with that finish
 * reason; `model` when the reply text itself is a refusal; null otherwise.
 */
export function refusalSource(reply: {
  content?: string | null;
  ending?: { finish: string | null } | null;
}): RefusalSource {
  if (reply.ending?.finish && /^content[_-]filter$/i.test(reply.ending.finish)) {
    return "content_filter";
  }
  return looksLikeModelRefusal(reply.content) ? "model" : null;
}

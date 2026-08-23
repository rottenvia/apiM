/**
 * When the user types "resume" / "continue", which last reply can we
 * actually continue?
 *
 * Auto-detection of inner-limit stops is conservative on purpose — a false
 * continue on a finished answer wastes a round. The cost of a MISS is that
 * the Resume button never appears. Typing the word still has to restore
 * that same reply (same thinking panel, no new message), which is why this
 * is a little wider than `incomplete`.
 *
 * Deliberately not "any assistant bubble": after a finished Q&A, "continue"
 * is a real next question.
 */
export function replyCanContinue(m?: {
  role?: string;
  isStreaming?: boolean;
  isError?: boolean;
  incomplete?: boolean;
  toolEvents?: unknown[] | null;
  plan?: { steps?: { state: string }[] } | null;
  reasoningContent?: string | null;
  reasoningLength?: number;
  content?: string | null;
} | null): boolean {
  if (!m || m.role !== "assistant" || m.isStreaming || m.isError) return false;
  if (m.incomplete) return true;
  if (m.toolEvents && m.toolEvents.length > 0) return true;
  if (m.plan?.steps?.some((s) => s.state === "todo" || s.state === "doing")) {
    return true;
  }
  const thinking =
    (m.reasoningLength ?? 0) || (m.reasoningContent?.trim().length ?? 0);
  // Thinking-only abort that the detector missed: a long thought and
  // almost no answer. A finished chat reply has a real closing sentence.
  if (thinking >= 200 && (m.content?.trim().length ?? 0) < 80) return true;
  return false;
}

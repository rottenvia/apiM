/**
 * Per-model user content: text, or OpenAI-compat image/video parts.
 *
 * DeepSeek's hosted Chat Completions API is text-only, so screenshots are
 * described by a vision helper and inlined as `<image>` blocks. Ox Alpha and
 * Qwen 3.8 27B take pixels (and MP4) on the wire — calling `/api/vision` for
 * those models is the bug that made "extracted text" appear on a native VLM.
 */

import type { VisionMode } from "@/lib/models";

export type { VisionMode };

export type AttachmentKind = "text" | "image" | "video";

/** Shape stored on a chat message and sent with /api/chat. */
export interface StoredAttachment {
  name: string;
  kind: AttachmentKind;
  /** Images and video: data URL so native models can replay the pixels. */
  dataUrl?: string;
  /** Images only, helper path: what vision or OCR extracted. */
  description?: string;
  descriptionSource?: "vision" | "ocr";
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } };

export type UserContent = string | ContentPart[];

const IMAGE_BLOCK = /<image\s/i;

/** True when this user turn has something the model can read. */
export function userHasContent(content: UserContent | null | undefined): boolean {
  if (content == null) return false;
  if (typeof content === "string") return Boolean(content.trim());
  return content.some((part) => {
    if (part.type === "text") return Boolean(part.text.trim());
    if (part.type === "image_url") return Boolean(part.image_url.url);
    return Boolean(part.video_url.url);
  });
}

/** Flatten to plain text for titles, search planning, and logs. */
export function userContentText(content: UserContent | null | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * Build the `content` field for one user turn.
 *
 * Native VLMs get text plus image_url / video_url parts. Helper / text-only
 * models get a string: either the already-inlined `<image>` blocks from the
 * composer, or a reconstruction from stored helper descriptions on replay.
 *
 * `options.mediaWindow` replays only the media kinds it allows and replaces
 * the rest with a one-line text reference. Used for history turns: re-sending
 * the full base64 of every past attachment on every request is what bloats
 * the body past the size the gateway's zstd pipeline can take (a 32MB clip
 * is a ~43MB body on every round), and it re-bills image tokens on a shared
 * free pool. The model's earlier turns already reflect what it saw, so old
 * pixels cost more than they are worth.
 */
export function buildUserContent(
  text: string,
  attachments: StoredAttachment[] | null | undefined,
  vision: VisionMode,
  options?: {
    mediaWindow?: { images?: boolean; videos?: boolean };
  }
): UserContent {
  const body = typeof text === "string" ? text : "";
  const media = (attachments ?? []).filter(
    (a) => (a.kind === "image" || a.kind === "video") && Boolean(a.dataUrl)
  );

  if (vision === "native" && media.length > 0) {
    const window = options?.mediaWindow;
    const parts: ContentPart[] = [];
    const dropped: string[] = [];
    const trimmed = body.trim();
    if (trimmed) parts.push({ type: "text", text: trimmed });
    for (const a of media) {
      const keep =
        !window ||
        (a.kind === "video"
          ? window.videos !== false
          : window.images !== false);
      if (!keep) {
        dropped.push(`${a.name} (${a.kind})`);
        continue;
      }
      if (a.kind === "video") {
        parts.push({ type: "video_url", video_url: { url: a.dataUrl as string } });
      } else {
        parts.push({ type: "image_url", image_url: { url: a.dataUrl as string } });
      }
    }
    if (dropped.length > 0) {
      parts.push({
        type: "text",
        text: `[Earlier attachment${dropped.length > 1 ? "s" : ""}: ${dropped.join(", ")} — kept in the conversation, not re-sent in later turns]`,
      });
    }
    return parts.length > 0 ? parts : body;
  }

  // History replay on a helper model: the stored `content` is what the user
  // typed, so rebuild the description blocks the composer would have inlined.
  if (
    vision === "helper" &&
    !IMAGE_BLOCK.test(body) &&
    media.some((a) => a.kind === "image" && a.description)
  ) {
    const blocks = media
      .filter((a) => a.kind === "image")
      .map((a) =>
        a.description
          ? `<image name="${a.name}">\n${a.description}\n</image>`
          : `<image name="${a.name}">\n[the image could not be read]\n</image>`
      );
    const trimmed = body.trim();
    return trimmed ? `${blocks.join("\n\n")}\n\n${trimmed}` : blocks.join("\n\n");
  }

  return body;
}

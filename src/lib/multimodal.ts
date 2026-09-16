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
  /**
   * Videos only: still frames sampled at attach time. Present (and dataUrl
   * absent) means the video rides as a strip of image parts; dataUrl
   * present means it rides as one native video_url part. Never both.
   */
  frames?: { dataUrl: string; t: number }[];
  /** Videos only: source duration and uniform frame spacing, in seconds. */
  durationSec?: number;
  frameIntervalSec?: number;
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

/**
 * Replace media payloads with one-line references — for the wire copy.
 *
 * A clip's first ride does the work: the provider ingests its frames on the
 * request that carries it, and the model's perception of those frames lives
 * in the turns it produced afterwards. Replaying the same ~54M characters of
 * base64 on every later round re-ships megabytes the model cannot re-ingest,
 * and OpenRouter's pre-flight estimate prices that body as plain text
 * tokens — 402ing balances below an estimate the round does not actually
 * carry.
 *
 * The doors this closes — the current turn is built without the media
 * window, so its media parts persist in the run transcript, and
 * `resumeState` snapshots that transcript with the payload still inside it.
 * `pruneTranscript` collapses tool results and `compactTranscript` folds
 * reasoning rounds; neither touches media, so a resumed run re-shipped the
 * payload on every round until it was interrupted again. THREE encodings can
 * carry those pixels, so all three are guarded here:
 *
 * 1. a native `video_url` part;
 * 2. a frames-mode group — the `[Video "…" — N still frames]` cadence header
 *    followed by its image_url parts (the video-only guard was blind to
 *    these, and a frames-mode clip therefore re-rode every resumed round);
 * 3. inline `data:image|video;base64` blobs embedded in STRING content by
 *    older transcript shapes — a string sails past any part-based guard.
 *
 * `keepLastUserVideo` is true only for the opening request of a fresh send —
 * the round that introduces the media still needs the pixels. Returns a new
 * array; stored transcripts keep their originals.
 */

/** Inline base64 media of 100KB+ inside string content — legacy carriers. */
const INLINE_MEDIA_BLOB =
  /data:(?:image|video)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{100000,}/g;

/** The cadence header that introduces a frames-mode still group. */
const FRAME_GROUP_PREFIX = /^\[Video "/;

const RIDE_ALONG_REFERENCE =
  "[video omitted — it already rode once; re-attach the clip or flip the chip to frames to look again]";

const RIDE_ALONG_IMAGE_REFERENCE =
  "[earlier attachment(s) omitted — they already rode once; re-attach the image to look again]";

export function stripRideAlongVideos<
  M extends { role: string; content: unknown }
>(messages: M[], keepLastUserVideo: boolean): M[] {
  let lastUser = -1;
  if (keepLastUserVideo) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") {
        lastUser = i;
        break;
      }
    }
  }
  return messages.map((msg, i) => {
    if (msg.role !== "user" || i === lastUser) return msg;

    // Legacy shape: base64 embedded directly in the text of the turn.
    if (typeof msg.content === "string") {
      if (!msg.content.includes(";base64,")) return msg;
      const stripped = msg.content.replace(
        INLINE_MEDIA_BLOB,
        "[media omitted — it already rode once; re-attach the file to look again]"
      );
      return stripped === msg.content
        ? msg
        : ({ ...msg, content: stripped } as M);
    }

    if (!Array.isArray(msg.content)) return msg;
    const parts = msg.content as ContentPart[];
    const hasNative = parts.some((part) => part.type === "video_url");
    const hasFrameGroup = parts.some(
      (part) =>
        part.type === "text" &&
        typeof part.text === "string" &&
        FRAME_GROUP_PREFIX.test(part.text)
    );
    // A plain screenshot rides as an ordinary image_url part — no video
    // shapes at all. It still re-ships on every mid-run round unless guarded,
    // and one 600KB screenshot is ~800k chars of base64: the "small request,
    // 900k chars in" body.
    const hasPlainImage = parts.some((part) => part.type === "image_url");
    if (!hasNative && !hasFrameGroup && !hasPlainImage) return msg;
    const out: ContentPart[] = [];
    for (let p = 0; p < parts.length; p += 1) {
      const part = parts[p];
      if (part.type === "video_url") {
        out.push({ type: "text", text: RIDE_ALONG_REFERENCE });
        continue;
      }
      if (
        part.type === "text" &&
        typeof part.text === "string" &&
        FRAME_GROUP_PREFIX.test(part.text)
      ) {
        out.push({ type: "text", text: RIDE_ALONG_REFERENCE });
        // Swallow the still frames that belong to this cadence header.
        while (p + 1 < parts.length && parts[p + 1].type === "image_url") {
          p += 1;
        }
        continue;
      }
      if (part.type === "image_url") {
        // A plain screenshot outside any frame group. Its pixels rode on the
        // opening round; later rounds get the reference, not the payload.
        out.push({ type: "text", text: RIDE_ALONG_IMAGE_REFERENCE });
        continue;
      }
      out.push(part);
    }
    return { ...msg, content: out } as M;
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
    (a) =>
      (a.kind === "image" && Boolean(a.dataUrl)) ||
      (a.kind === "video" &&
        (Boolean(a.dataUrl) || (a.frames?.length ?? 0) > 0))
  );

  if (vision === "native" && media.length > 0) {
    const window = options?.mediaWindow;
    const parts: ContentPart[] = [];
    const dropped: string[] = [];
    const trimmed = body.trim();
    if (trimmed) parts.push({ type: "text", text: trimmed });
    for (const a of media) {
      // A frames-mode video is images on the wire but a video in spirit:
      // it windows (and stops re-billing) exactly like a native video.
      const asFrames =
        a.kind === "video" && !a.dataUrl && (a.frames?.length ?? 0) > 0;
      const keep =
        !window ||
        (a.kind === "video"
          ? window.videos !== false
          : window.images !== false);
      if (!keep) {
        dropped.push(
          asFrames ? `${a.name} (video as frames)` : `${a.name} (${a.kind})`
        );
        continue;
      }
      if (asFrames) {
        const n = a.frames!.length;
        const iv = (a.frameIntervalSec ?? 0).toFixed(2).replace(/\.?0+$/, "");
        const cadence =
          n === 1
            ? "a single still at 0.0s"
            : `${n} still frames sampled evenly across the clip, one every ` +
              `${iv}s starting at 0.0s, in order — frame k of ${n} sits at ` +
              `about (k-1)×${iv}s`;
        parts.push({
          type: "text",
          text:
            `[Video "${a.name}" (${(a.durationSec ?? 0).toFixed(1)}s) attached as ` +
            `${cadence}. Motion between frames is not visible; reason across ` +
            `the sequence for anything time-based.]`,
        });
        for (const f of a.frames!) {
          parts.push({ type: "image_url", image_url: { url: f.dataUrl } });
        }
      } else if (a.kind === "video") {
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

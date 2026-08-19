/**
 * Image understanding for a text-only model.
 *
 * DeepSeek's V4 API accepts text only — there is no documented image input on
 * the hosted Chat Completions endpoint. So images are described by a vision
 * model first, and only that description reaches DeepSeek.
 *
 * A vision model is used rather than plain OCR because a screenshot is rarely
 * just characters: layout, which control is highlighted, and what looks wrong
 * all matter, and OCR discards every one of them.
 */

export const VISION_BASE_URL =
  process.env.VISION_BASE_URL ?? "https://api.openai.com/v1";

/** Cheap, fast, and good enough for screenshots. */
export const DEFAULT_VISION_MODEL = "gpt-4o-mini";

function endpointEnd(u: string): string {
  return u.replace(/\/+$/, "");
}

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/bmp",
]);

export function isImageFile(file: { type: string; name: string }): boolean {
  if (IMAGE_MIME_TYPES.has(file.type)) return true;
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
}

const SYSTEM_PROMPT = `You convert images into text for a text-only assistant that cannot see them.

Describe the image completely enough that someone reading only your description could answer questions about it.

- Transcribe ALL visible text exactly, preserving code indentation and line breaks.
- For code or terminal output, reproduce it verbatim inside a fenced code block with the right language.
- For errors, give the full message, file paths and line numbers exactly.
- For a UI, describe the layout, what is where, and anything that looks broken, misaligned or cut off.
- For charts or diagrams, state the structure, labels and the values or relationships shown.
- Note anything visually wrong even if not asked.

Be factual. Never guess at text that is unreadable — say it is unclear instead.
Do not add commentary, opinions or a preamble. Output only the description.`;

export interface VisionResult {
  description?: string;
  error?: string;
}

/**
 * Send one image to the vision model and return its textual description.
 *
 * `dataUrl` must be a base64 data URL, which is how the browser hands us a
 * pasted or dropped file without any upload step.
 */
export async function describeImage(
  dataUrl: string,
  apiKey: string,
  model: string = DEFAULT_VISION_MODEL,
  userHint?: string,
  baseUrl?: string
): Promise<VisionResult> {
  if (!apiKey) return { error: "No vision API key configured" };

  const endpointBase = (baseUrl && baseUrl.trim()) || VISION_BASE_URL;

  try {
    const response = await fetch(`${endpointBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: userHint
                  ? `Describe this image. The user asks: "${userHint}"`
                  : "Describe this image.",
              },
              // "high" detail costs more but is what makes small UI text and
              // stack traces legible, which is the whole point here.
              { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
            ],
          },
        ],
        max_tokens: 4096,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      let detail = "";
      try {
        detail = (JSON.parse(body)?.error?.message as string) ?? "";
      } catch {
        detail = body.slice(0, 160);
      }

      if (response.status === 401) {
        return { error: "Vision API key was rejected. Check it in Settings." };
      }
      if (response.status === 429) {
        return { error: "Vision API rate limit reached. Try again shortly." };
      }
      return {
        error: `Vision API error (${response.status})${detail ? `: ${detail}` : ""}`,
      };
    }

    const data = await response.json();
    const description = data?.choices?.[0]?.message?.content;
    if (typeof description !== "string" || !description.trim()) {
      return { error: "The vision model returned an empty description" };
    }

    return { description: description.trim() };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      error: timedOut
        ? "The vision model took too long to respond"
        : "Couldn't reach the vision API",
    };
  }
}

/** Wrap a description so the model knows it came from an image, not the user. */
export function formatImageBlock(name: string, description: string): string {
  return `<image name="${name}">\n${description}\n</image>`;
}

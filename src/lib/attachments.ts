/**
 * Text file attachments for the composer.
 *
 * Files are read in the browser and inlined into the message, so nothing is
 * uploaded anywhere and no server-side storage is involved.
 */

import {
  formatArchive,
  isArchive,
  readArchive,
  unsupportedArchiveNote,
} from "@/lib/archive";

export interface Attachment {
  id: string;
  name: string;
  /** Archives only: how many files came out of it, shown on the chip. */
  fileCount?: number;
  /** Size of the original file in bytes. */
  size: number;
  content: string;
  /** True when the file was longer than MAX_CHARS and had to be cut. */
  truncated: boolean;
  kind: "text" | "image";
  /** Images only: base64 data URL used for the thumbnail and the API call. */
  dataUrl?: string;
  /** Images only: description produced by the vision model. */
  description?: string;
  /** Images only: extraction still running. */
  analyzing?: boolean;
  /** Images only: extraction failed, with the reason. */
  visionError?: string;
}

/** Per-file cap. Large files would otherwise blow past the context window. */
export const MAX_CHARS = 200_000;
/** Reject anything over this outright rather than reading it into memory. */
export const MAX_BYTES = 5 * 1024 * 1024;
/**
 * Archives get a larger cap.
 *
 * They are compressed and hold a whole project, so the single-file limit
 * would refuse ordinary repositories. What actually bounds the cost is
 * MAX_TOTAL_CHARS on the extracted text, not the size of the container.
 */
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES = 10;
/** Images are capped separately — they are sent to the vision model whole. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Extensions treated as text. Anything else is rejected, because binary
 * content inlined into a prompt is just noise that costs tokens.
 */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "rst", "log", "csv", "tsv",
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "xml", "html", "htm", "css", "scss", "sass", "less",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts",
  "py", "rb", "go", "rs", "java", "kt", "kts", "c", "h", "cpp", "hpp", "cc",
  "cs", "swift", "php", "pl", "lua", "r", "scala", "clj", "ex", "exs", "erl",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "sql", "graphql", "gql", "proto", "dockerfile", "makefile", "gitignore",
  "vue", "svelte", "astro", "tf", "hcl", "gradle", "properties", "diff", "patch",
]);

/** Files with no extension that are still plain text. */
const TEXT_FILENAMES = new Set([
  "dockerfile", "makefile", "readme", "license", "changelog",
  ".gitignore", ".env", ".npmrc", ".editorconfig", ".prettierrc", ".eslintrc",
]);

export function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  return at === -1 ? "" : name.slice(at + 1).toLowerCase();
}

export function isTextFile(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  if (
    file.type === "application/json" ||
    file.type === "application/xml" ||
    file.type === "application/javascript" ||
    file.type === "application/x-sh"
  ) {
    return true;
  }

  const lower = file.name.toLowerCase();
  if (TEXT_FILENAMES.has(lower)) return true;

  const ext = extensionOf(lower);
  // A file with no extension and no MIME type is ambiguous; allow it and let
  // the binary-content check below decide.
  if (!ext) return file.type === "";
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Heuristic binary check. A NUL byte in the first chunk means this isn't text,
 * regardless of what the extension claimed.
 */
export function looksBinary(sample: string): boolean {
  const head = sample.slice(0, 8000);
  if (head.includes("\u0000")) return true;

  let control = 0;
  for (let i = 0; i < head.length; i += 1) {
    const code = head.charCodeAt(i);
    // Anything outside printable ASCII, tab, newline, carriage return.
    if (code < 9 || (code > 13 && code < 32)) control += 1;
  }
  return head.length > 0 && control / head.length > 0.1;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ReadResult {
  attachment?: Attachment;
  error?: string;
}

/** Read an image as a data URL so it can be previewed and sent for analysis. */
export async function readImageFile(file: File): Promise<ReadResult> {
  if (file.size > MAX_IMAGE_BYTES) {
    return {
      error: `${file.name} is ${formatBytes(file.size)} — the image limit is ${formatBytes(MAX_IMAGE_BYTES)}`,
    };
  }

  const dataUrl = await new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });

  if (!dataUrl) return { error: `Couldn't read ${file.name}` };

  return {
    attachment: {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      size: file.size,
      content: "",
      truncated: false,
      kind: "image",
      dataUrl,
      analyzing: true,
    },
  };
}

export async function readTextFile(file: File): Promise<ReadResult> {
  const cap = isArchive(file.name) ? MAX_ARCHIVE_BYTES : MAX_BYTES;
  if (file.size > cap) {
    return {
      error: `${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(cap)}`,
    };
  }

  // Archives are unpacked rather than rejected. Attaching a project used to
  // mean selecting its files one at a time, which is tedious for five and
  // impossible for fifty — so people pasted two and described the rest.
  const unsupported = unsupportedArchiveNote(file.name);
  if (unsupported) return { error: unsupported };

  if (isArchive(file.name)) {
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const result = await readArchive(file.name, data);
      if (result.entries.length === 0) {
        return { error: `${file.name} had no readable text files in it` };
      }
      return {
        attachment: {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          size: file.size,
          content: formatArchive(file.name, result),
          truncated: result.hitLimit || result.entries.some((e) => e.truncated),
          kind: "text",
          fileCount: result.entries.length,
        },
      };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? `Couldn't open ${file.name}: ${error.message}`
            : `Couldn't open ${file.name}`,
      };
    }
  }

  if (!isTextFile(file)) {
    return { error: `${file.name} doesn't look like a text file` };
  }

  let raw: string;
  try {
    raw = await file.text();
  } catch {
    return { error: `Couldn't read ${file.name}` };
  }

  if (looksBinary(raw)) {
    return { error: `${file.name} appears to be binary, not text` };
  }

  const truncated = raw.length > MAX_CHARS;
  return {
    attachment: {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      size: file.size,
      content: truncated ? raw.slice(0, MAX_CHARS) : raw,
      truncated,
      kind: "text",
    },
  };
}

/**
 * Inline attachments ahead of the user's own text.
 *
 * Fenced with the file's language hint so the model reads them as files, and
 * so the app's own code-block rendering picks them up.
 */
export function buildMessageWithAttachments(
  text: string,
  attachments: Attachment[]
): string {
  if (attachments.length === 0) return text;

  const blocks = attachments.map((a) => {
    // Images arrive as a description from the vision model, since DeepSeek's
    // API is text-only and cannot accept pixels.
    if (a.kind === "image") {
      if (a.description) {
        return `<image name="${a.name}">\n${a.description}\n</image>`;
      }
      return `<image name="${a.name}">\n[the image could not be read]\n</image>`;
    }

    const ext = extensionOf(a.name);
    const fence = ext && ext.length <= 12 ? ext : "";
    const note = a.truncated
      ? `\n[truncated — showing the first ${MAX_CHARS.toLocaleString()} characters of ${formatBytes(a.size)}]`
      : "";
    return `Attached file: ${a.name}${note}\n\`\`\`${fence}\n${a.content}\n\`\`\``;
  });

  return text.trim()
    ? `${blocks.join("\n\n")}\n\n${text.trim()}`
    : blocks.join("\n\n");
}

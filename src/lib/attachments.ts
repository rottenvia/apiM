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
import { documentKind, readDocument } from "@/lib/documents";

/**
 * What a file is doing while it is being read.
 *
 * Archives and documents take long enough to notice — unpacking a project or
 * pulling text out of a spreadsheet is real work — and until now nothing
 * appeared until it was finished, so a large zip looked like a dropped file
 * that had been ignored.
 */
export type AttachStage =
  | "reading"
  | "unpacking"
  | "extracting"
  | "analyzing";

export const STAGE_LABELS: Record<AttachStage, string> = {
  reading: "Reading",
  unpacking: "Unpacking",
  extracting: "Extracting text",
  analyzing: "Looking at image",
};

export interface Attachment {
  id: string;
  name: string;
  /** Set while the file is still being read; cleared when it lands. */
  stage?: AttachStage;
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
 * Heuristic binary check over raw bytes.
 *
 * Works on the bytes rather than a decoded string, so it can run on the first
 * few KB of a file without decoding the rest. A NUL byte is the cheapest
 * reliable signal; beyond that, a high proportion of control characters means
 * this is not text whatever the extension claimed.
 */
export function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  return at === -1 ? "" : name.slice(at + 1).toLowerCase();
}

/** How much of a file to inspect before deciding whether it is text. */
export const SNIFF_BYTES = 8_000;

/**
 * Formats that are definitely not text, with a reason.
 *
 * The reader accepts anything that decodes as text rather than checking
 * against a list of known extensions — a list can only ever be incomplete,
 * and being told a .vdf "doesn't look like a text file" when it plainly is
 * one is the kind of refusal that makes an app feel stupid.
 *
 * The inverse still needs handling: a .png would be sniffed, found binary,
 * and reported as "looks like a binary file", which is true but unhelpful.
 * Naming the common ones gives a better message and, where something could
 * be supported later, says so.
 */
const BINARY_FORMATS: Record<string, string> = {
  pdf: "PDFs need a parser this app doesn't have yet — copy the text out, or say the word and I'll add one.",
  doc: "The old .doc format isn't readable. Save as .docx and it will work.",
  xls: "The old .xls format isn't readable. Save as .xlsx or .csv and it will work.",
  exe: "an executable",
  dll: "a library",
  so: "a library",
  dylib: "a library",
  bin: "a binary",
  dat: "a binary data file",
  db: "a database file",
  sqlite: "a database file",
  mp3: "audio", wav: "audio", flac: "audio", ogg: "audio",
  mp4: "video", avi: "video", mov: "video", mkv: "video", webm: "video",
  ttf: "a font", otf: "a font", woff: "a font", woff2: "a font",
  pyc: "compiled Python", class: "compiled Java", o: "an object file",
};

export function binaryFormatNote(name: string): string | null {
  const ext = extensionOf(name);
  const note = BINARY_FORMATS[ext];
  if (!note) return null;
  // Entries that are a full sentence explain themselves; the short ones are
  // a noun phrase and need wrapping.
  return note.endsWith(".")
    ? note
    : `${name} is ${note}, so there's no text to read.`;
}

export function bytesLookBinary(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;

  const head = bytes.subarray(0, Math.min(bytes.length, 8000));
  if (head.includes(0)) return true;

  let control = 0;
  for (let i = 0; i < head.length; i += 1) {
    const b = head[i];
    // Outside printable ASCII, tab, newline, carriage return. Bytes above
    // 0x7f are left alone: they are ordinary in UTF-8 text.
    if (b < 9 || (b > 13 && b < 32)) control += 1;
  }
  return control / head.length > 0.1;
}

/** Kept for the string case, which the archive reader still uses. */
export function looksBinary(sample: string): boolean {
  const head = sample.slice(0, 8000);
  if (head.includes("\u0000")) return true;

  let control = 0;
  for (let i = 0; i < head.length; i += 1) {
    const code = head.charCodeAt(i);
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

/** Reports progress while a file is read, so the chip can say what is happening. */
export type ProgressFn = (stage: AttachStage) => void;

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

export async function readTextFile(
  file: File,
  onProgress?: ProgressFn
): Promise<ReadResult> {
  const cap =
    isArchive(file.name) || documentKind(file.name)
      ? MAX_ARCHIVE_BYTES
      : MAX_BYTES;
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
      onProgress?.("unpacking");
      const data = new Uint8Array(await file.arrayBuffer());
      // Yield once so the "Unpacking" state paints before the main thread is
      // busy inflating; otherwise the label only appears after the work.
      await new Promise((r) => setTimeout(r, 0));
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

  // Office documents are ZIP archives of XML, so their text can be pulled
  // out with the reader that already exists. Handled before the binary
  // refusal below, since as files they are binary — the point is that the
  // words inside them are not.
  const kind = documentKind(file.name);
  if (kind) {
    try {
      onProgress?.("extracting");
      const data = new Uint8Array(await file.arrayBuffer());
      await new Promise((r) => setTimeout(r, 0));
      const doc = await readDocument(kind, data);
      return {
        attachment: {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          size: file.size,
          content: doc.text,
          truncated: doc.truncated,
          kind: "text",
          fileCount: doc.sections > 1 ? doc.sections : undefined,
        },
      };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? `Couldn't read ${file.name}: ${error.message}`
            : `Couldn't read ${file.name}`,
      };
    }
  }

  // Known binary formats are refused up front, so a .png or a .pdf gets a
  // useful message rather than being sniffed and reported as "binary".
  const refusal = binaryFormatNote(file.name);
  if (refusal) return { error: refusal };

  // Decide from the first few KB rather than the whole file.
  //
  // This used to call file.text(), which decodes everything into a string
  // before anything is inspected — so a 5MB log became a 5MB string, had
  // 8000 characters checked, then had 200k kept and the rest discarded. On
  // the main thread, that decode is the freeze. Worse, it happened even for
  // files that were then rejected as binary.
  onProgress?.("reading");

  let head: Uint8Array;
  try {
    head = new Uint8Array(
      await file.slice(0, SNIFF_BYTES).arrayBuffer()
    );
  } catch {
    return { error: `Couldn't read ${file.name}` };
  }

  if (bytesLookBinary(head)) {
    return {
      error: `${file.name} looks like a binary file, so there's nothing to read`,
    };
  }

  // Read only as much as will be kept. UTF-8 is at most 4 bytes per
  // character, so this cannot cut short of MAX_CHARS; slicing on a byte
  // boundary can split a multi-byte character, which the decoder replaces
  // rather than throwing on.
  const wanted = MAX_CHARS * 4;
  const needsTruncating = file.size > wanted;

  let raw: string;
  try {
    const part = needsTruncating ? file.slice(0, wanted) : file;
    raw = await part.text();
  } catch {
    return { error: `Couldn't read ${file.name}` };
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

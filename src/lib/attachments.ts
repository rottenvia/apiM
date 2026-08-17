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
  readFolderTree,
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
  | "saving"
  | "unpacking"
  | "extracting"
  | "analyzing";

export const STAGE_LABELS: Record<AttachStage, string> = {
  reading: "Reading",
  saving: "Saving binary",
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
  /**
   * Archives only: the unpacked files, so they can be written to the
   * workspace rather than inlined into a message and lost with it.
   */
  entries?: { path: string; content: string }[];
  /**
   * Archive/folder PE files carried only until multipart upload finishes.
   * Cleared before the attachment enters a chat message, so raw executable
   * bytes are never base64/JSON-inlined into model context.
   */
  binaryEntries?: { path: string; data: Uint8Array; bytes: number }[];
  /** Executable members already saved as raw workspace files. */
  binaryPaths?: string[];
  /** Archives only: where they were written, once they have been. */
  unpackedTo?: string;
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

/**
 * Per-file cap.
 *
 * Raised to match the model's 1M token window; the old 200k was sized for a
 * 128k one and cut ordinary files for no reason. 800k characters is about
 * 222k tokens, so even two large attachments still leave most of the window
 * for the conversation.
 */
export const MAX_CHARS = 800_000;
/**
 * Reject anything over this outright rather than reading it into memory.
 *
 * Only the first MAX_CHARS worth is ever kept, so this is not a limit on
 * useful content — it exists so a 2GB file is refused instantly instead of
 * being streamed through. Comfortably above the 3.2MB that MAX_CHARS can
 * consume, so it never becomes the binding constraint.
 */
export const MAX_BYTES = 64 * 1024 * 1024;
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
// Formats that should NOT be turned into a hex dump.
//
//  - Windows PE files are saved as raw bytes and opened with inspect_binary
//    (the composer recognises them before this point), so decoding them here
//    would only waste tokens.
//  - PDF / old Office have dedicated converters elsewhere.
//  - Audio/video/fonts are not useful as byte dumps.
// Anything else that is binary — .bin, .dat, .o, .pyc, generic blobs, or a
// file with no extension that sniffs binary — falls through readTextFile and
// is attached as a hex+ASCII dump.
const BINARY_FORMATS: Record<string, string> = {
  pdf: "PDFs need a parser this app doesn't have yet — copy the text out, or say the word and I'll add one.",
  doc: "The old .doc format isn't readable. Save as .docx and it will work.",
  xls: "The old .xls format isn't readable. Save as .xlsx or .csv and it will work.",
  exe: "Windows executables must be saved as raw bytes and opened with inspect_binary, not decoded as text.",
  dll: "Windows libraries must be saved as raw bytes and opened with inspect_binary, not decoded as text.",
  sys: "Windows drivers must be saved as raw bytes and opened with inspect_binary, not decoded as text.",
  ocx: "Windows OCX libraries must be saved as raw bytes and opened with inspect_binary, not decoded as text.",
  scr: "Windows screen-saver executables must be saved as raw bytes and opened with inspect_binary, not decoded as text.",
  cpl: "Windows Control Panel libraries must be saved as raw bytes and opened with inspect_binary, not decoded as text.",
  drv: "Windows driver libraries must be saved as raw bytes and opened with inspect_binary, not decoded as text.",
  efi: "EFI executables must be saved as raw bytes and opened with inspect_binary, not decoded as text.",
  mp3: "audio", wav: "audio", flac: "audio", ogg: "audio",
  mp4: "video", avi: "video", mov: "video", mkv: "video", webm: "video",
  ttf: "a font", otf: "a font", woff: "a font", woff2: "a font",
};

/**
 * Render binary data as a hex + ASCII dump (the classic `xxd` layout).
 *
 * The composer runs in the browser, so this is a client-side twin of the
 * workspace hexDump. It lets the user attach a .bin/.dat/.o (or any file
 * that sniffs as binary and isn't a saved PE) and have every byte shown to
 * the model instead of being refused with "no text to read". Output is
 * capped at `maxChars` (default MAX_CHARS) like any other attachment.
 */
export function hexDump(
  bytes: Uint8Array,
  maxChars = MAX_CHARS
): { content: string; truncated: boolean } {
  const bytesPerLine = 16;
  const lines: string[] = [];
  lines.push("Offset(h)  00 01 02 03 04 05 06 07  08 09 0A 0B 0C 0D 0E 0F   ASCII");
  lines.push("--------------------------------------------------------------------");
  let truncated = false;
  let running = lines.join("\n").length + 1;
  for (let off = 0; off < bytes.length; off += bytesPerLine) {
    const slice = bytes.subarray(off, Math.min(off + bytesPerLine, bytes.length));
    const hex = Array.from(slice)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    const hexPadded = hex.padEnd(47, " ").replace(/^(\S{23}) /, "$1  ");
    const ascii = Array.from(slice)
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
      .join("");
    const line = `${off.toString(16).padStart(8, "0")}  ${hexPadded}  ${ascii}`;
    if (running + line.length + 1 > maxChars) {
      truncated = true;
      lines.push(
        `... truncated at offset 0x${off.toString(16)} (${off} of ${bytes.length} bytes)`
      );
      break;
    }
    lines.push(line);
    running += line.length + 1;
  }
  return { content: lines.join("\n"), truncated };
}

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

/**
 * Does this look like UTF-16 text rather than a binary blob?
 *
 * Windows writes UTF-16 far more often than anything else does: PowerShell's
 * `>` redirection, `Export-CSV`, Notepad's "Unicode" option and a good number
 * of application logs all produce it. Every other byte is then a zero, so the
 * `includes(0)` check below calls it binary and the file is refused with
 * "looks like a binary file, so there's nothing to read".
 *
 * Reported: a .log file that could not be attached. This is the reason.
 *
 * Detected by the byte-order mark, or by the giveaway pattern of ASCII text
 * in one of the two byte positions with zeros in the other. Deliberately
 * narrow — it must not start accepting actual binaries.
 */
export function looksUtf16(bytes: Uint8Array): "le" | "be" | null {
  if (bytes.length < 4) return null;

  // A byte-order mark is unambiguous.
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "be";

  // No BOM: look at how the zeros fall. In UTF-16LE ASCII text every odd
  // byte is zero; in UTF-16BE every even one is.
  const n = Math.min(bytes.length, 2000) & ~1;
  if (n < 8) return null;

  let zeroOdd = 0;
  let zeroEven = 0;
  let printableEven = 0;
  let printableOdd = 0;
  for (let i = 0; i < n; i += 2) {
    const even = bytes[i];
    const odd = bytes[i + 1];
    if (odd === 0) zeroOdd += 1;
    if (even === 0) zeroEven += 1;
    if (even >= 9 && even < 127) printableEven += 1;
    if (odd >= 9 && odd < 127) printableOdd += 1;
  }
  const pairs = n / 2;
  // Nearly every high byte zero AND nearly every low byte ordinary text.
  if (zeroOdd / pairs > 0.9 && printableEven / pairs > 0.9) return "le";
  if (zeroEven / pairs > 0.9 && printableOdd / pairs > 0.9) return "be";
  return null;
}

export function bytesLookBinary(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;

  // UTF-16 is text, even though half its bytes are zeros.
  if (looksUtf16(bytes)) return false;

  const head = bytes.subarray(0, Math.min(bytes.length, 8000));
  if (head.includes(0)) return true;

  let control = 0;
  for (let i = 0; i < head.length; i += 1) {
    const b = head[i];
    /*
     * ESC is text when it starts a colour code.
     *
     * A densely coloured log — "\x1b[32mINFO\x1b[0m up" — is 11.8% ESC bytes,
     * just over the 10% threshold, so it was rejected as binary. That is a
     * console log saved to a file, which is one of the most likely things
     * anyone attaches. Measured, not guessed: the ratio is in the test.
     *
     * Only ESC immediately followed by '[' is forgiven, which is the CSI
     * sequence every colouring library emits. A lone ESC still counts.
     */
    if (b === 0x1b && head[i + 1] === 0x5b) continue;
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

/**
 * Read a folder picked through the directory input.
 *
 * Produces exactly the shape an archive produces, so the caller unpacks it
 * into the workspace and shows a manifest without caring which it was. A
 * folder and a .zip of that folder are the same request.
 */
export async function readFolder(
  name: string,
  files: File[]
): Promise<ReadResult> {
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_ARCHIVE_BYTES) {
    return {
      error: `${name} is ${formatBytes(total)} — the limit is ${formatBytes(MAX_ARCHIVE_BYTES)}`,
    };
  }

  try {
    const result = await readFolderTree(files);
    if (result.entries.length === 0 && !(result.binaries?.length)) {
      return { error: `${name} had no readable text or supported Windows executables in it` };
    }
    return {
      attachment: {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        size: total,
        content: formatArchive(name, result),
        truncated: result.hitLimit || result.entries.some((e) => e.truncated),
        kind: "text",
        fileCount: result.entries.length + (result.binaries?.length ?? 0),
        entries: result.entries.map((e) => ({
          path: e.path,
          content: e.content,
        })),
        binaryEntries: result.binaries,
      },
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? `Couldn't read ${name}: ${error.message}`
          : `Couldn't read ${name}`,
    };
  }
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
      if (result.entries.length === 0 && !(result.binaries?.length)) {
        return {
          error: `${file.name} had no readable text or supported Windows executables in it`,
        };
      }
      return {
        attachment: {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          size: file.size,
          // Replaced by a manifest once the files are on disk; kept as the
          // full inline form as a fallback for when writing is not possible.
          content: formatArchive(file.name, result),
          truncated: result.hitLimit || result.entries.some((e) => e.truncated),
          kind: "text",
          fileCount: result.entries.length + (result.binaries?.length ?? 0),
          entries: result.entries.map((e) => ({
            path: e.path,
            content: e.content,
          })),
          binaryEntries: result.binaries,
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

  // Known binary formats that have a better path elsewhere are refused up
  // front (PE -> inspect_binary; PDF/old Office -> a converter; media/fonts
  // -> not useful as text). Anything else that is binary — .bin/.dat/.o and
  // files with no extension that merely sniff binary — is attached as a
  // hex+ASCII dump so the model can still inspect every byte instead of
  // being told "there's nothing to read".
  const refusal = binaryFormatNote(file.name);
  if (refusal) return { error: refusal };

  // Decide from the first few KB rather than the whole file.
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
    // Read up to a few MB for the dump; the dump itself is capped at
    // MAX_CHARS by hexDump, so this only bounds the byte read.
    onProgress?.("reading");
    const wanted = Math.min(file.size, MAX_CHARS * 4);
    const buf = new Uint8Array(await file.slice(0, wanted).arrayBuffer());
    const { content, truncated } = hexDump(buf, MAX_CHARS);
    return {
      attachment: {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        size: file.size,
        content: `Binary file ${file.name} (${file.size} bytes). Hex dump:\n\n${content}`,
        truncated: truncated || file.size > wanted,
        kind: "text",
      },
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
    /*
     * Decode with the encoding the bytes actually are.
     *
     * `Blob.text()` always assumes UTF-8. Handed a UTF-16 file it returns a
     * string with a NUL between every character, which then reads as
     * gibberish to the model — worse than a refusal, because it looks like
     * it worked. Windows produces UTF-16 routinely, which is how a .log file
     * ended up unattachable.
     */
    const encoding = looksUtf16(head);
    if (encoding) {
      const buf = await part.arrayBuffer();
      raw = new TextDecoder(encoding === "le" ? "utf-16le" : "utf-16be", {
        fatal: false,
      })
        .decode(buf)
        // Strip a leading byte-order mark so the first line is not prefixed
        // with an invisible character.
        .replace(/^\uFEFF/, "");
    } else {
      raw = await part.text();
    }
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

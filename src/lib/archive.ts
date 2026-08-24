/**
 * Reading archives that were dropped on the composer.
 *
 * Attaching a project meant selecting its files one at a time, which is
 * tedious for five files and impossible for fifty — so in practice people
 * pasted a couple of files and described the rest. An archive is how a
 * project is actually shaped, and unpacking it in the browser means the whole
 * thing arrives at once with its directory structure intact.
 *
 * ZIP, TAR and TAR.GZ are handled here with no dependencies: deflate and gzip
 * are both in the platform's DecompressionStream, and TAR is uncompressed
 * fixed-width headers. RAR and 7z are deliberately not supported — see
 * `unsupportedArchiveNote` for why, and for what to tell the user instead.
 */

import { looksUtf16 } from "./attachments";
import {
  isPeFilename,
  MAX_PE_UPLOAD_BYTES,
} from "./binary-types";

/** Entries that are never worth reading out of an archive. */
const SKIP_DIRS = [
  "node_modules/",
  ".git/",
  ".next/",
  "dist/",
  "build/",
  "__pycache__/",
  ".venv/",
  "venv/",
  "target/",
  ".idea/",
  ".vscode/",
  "__MACOSX/",
];

/** Binary payloads that would only arrive as mojibake. */
// Name-based pre-filter only. Everything not listed still goes through
// decodeText, and non-text files are KEPT as exact binary bytes under the
// same caps as executables — so only media, fonts and nested archives stay
// excluded here (a zip of 200 PNGs must not consume the binary-entry caps).
// Code and data binaries (.so, .dylib, .o, .a, .bin, .dat, .pyc, .class)
// deliberately fall through: they are exactly what inspect_binary is for.
const SKIP_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "svg",
  "pdf", "zip", "gz", "tar", "rar", "7z", "exe", "dll",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "wav", "avi", "mov", "webm",
  "db", "sqlite",
]);

export interface ArchiveEntry {
  path: string;
  content: string;
  bytes: number;
  /** Cut short because the file alone was larger than the per-file cap. */
  truncated: boolean;
}

export interface ArchiveBinaryEntry {
  path: string;
  data: Uint8Array;
  bytes: number;
}

export interface ArchiveResult {
  entries: ArchiveEntry[];
  /** Binary files (PE, ELF, Mach-O, raw data) preserved as exact bytes for inspect_binary, never decoded. */
  binaries?: ArchiveBinaryEntry[];
  /** Files deliberately left out, with a one-line reason each. */
  skipped: { path: string; reason: string }[];
  /** True when the archive held more files than the cap allows. */
  hitLimit: boolean;
}

/**
 * Caps, sized against the model actually in use.
 *
 * These were originally chosen for a ~128k token window and left alone when
 * the model moved to 1M. The result was files being cut at around 1,500 lines
 * while 89% of the context sat unused — the truncation was protecting against
 * a limit that no longer existed.
 *
 * At roughly 3.6 characters per token, 1.5M characters is about 417k tokens,
 * which leaves plenty of room for the conversation and the reply, and costs
 * about $0.18 per round at DeepSeek pro rates. A cap still exists because an
 * unbounded archive would eventually exceed the window and fail the request
 * outright, which is worse than a note saying something was trimmed.
 */
export const MAX_ENTRIES = 800;
/** Per file. Comfortably past any hand-written source file. */
export const MAX_ENTRY_CHARS = 300_000;
/** Across the whole archive. */
export const MAX_TOTAL_CHARS = 1_500_000;
/** Keep folder/archive executable sets bounded independently from text. */
export const MAX_BINARY_ENTRIES = 128;
export const MAX_TOTAL_BINARY_BYTES = 512 * 1024 * 1024;

/**
 * A folder name for an unpacked archive.
 *
 * Derived from the archive's own name so the workspace reads as a list of
 * what was uploaded, and stripped of anything that could change the path —
 * an archive is user-supplied and "../" in a folder name would escape the
 * uploads directory.
 */
export function archiveFolderName(name: string): string {
  const base = name
    .replace(/\.(tar\.gz|tgz|tar|zip)$/i, "")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 60);
  return base || "archive";
}

export function isArchive(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".zip") ||
    lower.endsWith(".tar") ||
    lower.endsWith(".tar.gz") ||
    lower.endsWith(".tgz")
  );
}

/** Formats we cannot open, and what to do instead. */
export function unsupportedArchiveNote(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".rar")) {
    return "RAR is a proprietary format with no open decoder, so it can't be opened here. Re-save it as a .zip and it will work.";
  }
  if (lower.endsWith(".7z")) {
    return "7z uses LZMA, which browsers have no built-in support for. Re-save it as a .zip and it will work.";
  }
  return null;
}

function shouldSkip(path: string): string | null {
  if (path.endsWith("/")) return null; // directory entry, silently ignored
  if (SKIP_DIRS.some((d) => path.includes(d))) return "dependency or build output";

  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base.startsWith("._")) return "macOS resource fork";

  // A cheap pre-filter only. Anything not listed still goes through
  // decodeText: text is kept as text, and binary is kept as exact bytes —
  // so an unfamiliar format is included rather than refused for being
  // unknown.
  const dot = base.lastIndexOf(".");
  const ext = dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return "binary file";

  return null;
}

/**
 * The path a File carries when it came from a folder picker.
 *
 * `webkitRelativePath` is "myproject/src/index.ts" for a file chosen through
 * a directory input, and "" for an ordinary one — which is how a folder pick
 * is told apart from a multi-file pick.
 */
export function folderPathOf(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string })
    .webkitRelativePath;
  return typeof rel === "string" ? rel : "";
}

/**
 * Read a picked folder the same way an archive is read.
 *
 * Same skip rules, same caps, same shape of result — so everything
 * downstream (unpacking into the workspace, the manifest, the chip) works
 * without knowing where the files came from. A folder and a zip of that
 * folder should behave identically, because to the user they are the same
 * request.
 */
export async function readFolderTree(
  files: File[]
): Promise<ArchiveResult> {
  const entries: ArchiveEntry[] = [];
  const binaries: ArchiveBinaryEntry[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let totalChars = 0;
  let totalBinaryBytes = 0;
  let hitLimit = false;

  // Stable order, so the manifest reads like a directory listing rather than
  // whatever order the OS handed them over in.
  const sorted = [...files].sort((a, b) =>
    folderPathOf(a).localeCompare(folderPathOf(b))
  );

  for (const file of sorted) {
    // Strip the top-level folder name: paths are relative to it, exactly as
    // they are inside an archive.
    const full = folderPathOf(file) || file.name;
    const path = full.split("/").slice(1).join("/") || file.name;

    if (isPeFilename(full)) {
      if (
        file.size > MAX_PE_UPLOAD_BYTES ||
        binaries.length >= MAX_BINARY_ENTRIES ||
        totalBinaryBytes + file.size > MAX_TOTAL_BINARY_BYTES
      ) {
        hitLimit = true;
        skipped.push({ path, reason: "executable binary limit exceeded" });
        continue;
      }
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        if (data.length < 64 || data[0] !== 0x4d || data[1] !== 0x5a) {
          skipped.push({ path, reason: "executable extension but no MZ header" });
          continue;
        }
        binaries.push({ path, data, bytes: data.length });
        totalBinaryBytes += data.length;
      } catch {
        skipped.push({ path, reason: "could not read executable bytes" });
      }
      continue;
    }

    const reason = shouldSkip(full);
    if (reason) {
      skipped.push({ path, reason });
      continue;
    }

    // The text cap applies to text only — it is evaluated after the sniff
    // below, so a binary found in a capped folder is still preserved (PE
    // files above get the same treatment by being handled first).
    const atTextCap =
      entries.length >= MAX_ENTRIES || totalChars >= MAX_TOTAL_CHARS;

    let bytes: Uint8Array;
    try {
      // Only as much as could be kept: a 2GB file in a folder must not be
      // decoded in full just to throw most of it away.
      const slice = file.slice(0, MAX_ENTRY_CHARS * 4);
      bytes = new Uint8Array(await slice.arrayBuffer());
    } catch {
      skipped.push({ path, reason: "could not be read" });
      continue;
    }

    const text = decodeText(bytes);
    if (text === null) {
      /*
       * Binary file: keep it as exact bytes under the same caps as
       * executables. `bytes` here is only the sniff head, so a file larger
       * than the head must be read in full first — but never past the cap,
       * which is what bounds the read itself.
       */
      if (
        file.size > MAX_PE_UPLOAD_BYTES ||
        binaries.length >= MAX_BINARY_ENTRIES ||
        totalBinaryBytes + file.size > MAX_TOTAL_BINARY_BYTES
      ) {
        hitLimit = true;
        skipped.push({ path, reason: "binary limit exceeded" });
        continue;
      }
      let full = bytes;
      if (file.size > bytes.length) {
        try {
          full = new Uint8Array(await file.arrayBuffer());
        } catch {
          skipped.push({ path, reason: "could not read binary bytes" });
          continue;
        }
      }
      binaries.push({ path, data: full, bytes: full.length });
      totalBinaryBytes += full.length;
      continue;
    }

    if (atTextCap) {
      hitLimit = true;
      continue;
    }

    const truncated = text.length > MAX_ENTRY_CHARS || file.size > bytes.length;
    const content = truncated ? text.slice(0, MAX_ENTRY_CHARS) : text;
    entries.push({ path, content, bytes: file.size, truncated });
    totalChars += content.length;
  }

  return { entries, binaries, skipped, hitLimit };
}

/** Decode as UTF-8 or UTF-16, refusing anything that is clearly not text. */
function decodeText(bytes: Uint8Array): string | null {
  /*
   * UTF-16 first, because it fails the NUL test below.
   *
   * Windows writes UTF-16 routinely — PowerShell redirection, Notepad's
   * "Unicode" option, plenty of application logs — and every other byte is
   * then zero. Treating that as binary is how a zipped folder of Windows
   * logs came back with every file "skipped: binary file".
   */
  const utf16 = looksUtf16(bytes);
  if (utf16) {
    try {
      return new TextDecoder(utf16 === "le" ? "utf-16le" : "utf-16be", {
        fatal: false,
      })
        .decode(bytes)
        .replace(/^\uFEFF/, "");
    } catch {
      return null;
    }
  }

  // A NUL byte in the first chunk is the cheapest reliable binary signal.
  const probe = bytes.subarray(0, Math.min(bytes.length, 8000));
  if (probe.includes(0)) return null;

  /*
   * Control-byte ratio — kept in lockstep with bytesLookBinary in
   * attachments.ts so a file is "binary" the same way whether it is dropped
   * loose or arrives inside an archive. Without it, a 2MB file of 0x07
   * bytes sailed through as "text" and inlined two megabytes of garbage,
   * while the identical loose file was refused. Tab, LF, CR and form feed
   * are exempt (real text uses them); ESC counts only when it does not
   * start a colour-code sequence, so dense ANSI logs stay text.
   */
  let control = 0;
  for (let i = 0; i < probe.length; i++) {
    const b = probe[i];
    if (b === 0x1b && probe[i + 1] === 0x5b) continue;
    if (b < 9 || (b > 13 && b < 32)) control += 1;
  }
  if (probe.length > 0 && control / probe.length > 0.1) return null;

  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([data as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function gunzip(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([data as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Read a ZIP from its central directory.
 *
 * The central directory at the end of the file is authoritative — walking
 * local headers from the front breaks on archives written by streaming
 * writers, which leave sizes as zero and put them in a trailing descriptor.
 */
/**
 * Every member of a ZIP, as raw bytes.
 *
 * Split out from readZip because Office documents are ZIPs with a known
 * internal layout — DOCX is word/document.xml, XLSX is a set of sheet parts —
 * so they need the same central-directory walk without the text filtering
 * that a user-supplied archive gets.
 */
export async function zipMembers(
  buf: Uint8Array,
  wanted?: (path: string) => boolean
): Promise<Map<string, Uint8Array>> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Map<string, Uint8Array>();

  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("Not a valid .zip file");

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  for (let n = 0; n < count; n++) {
    if (offset + 46 > buf.length) break;
    if (view.getUint32(offset, true) !== 0x02014b50) break;

    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);

    const name = new TextDecoder().decode(
      buf.subarray(offset + 46, offset + 46 + nameLen)
    );
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;
    if (wanted && !wanted(name)) continue;
    if (localOffset + 30 > buf.length) continue;

    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    let bytes: Uint8Array | null;
    if (method === 0) bytes = raw;
    else if (method === 8) bytes = await inflateRaw(raw);
    else continue;

    if (bytes) out.set(name, bytes);
  }

  return out;
}

async function readZip(buf: Uint8Array): Promise<ArchiveResult> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const entries: ArchiveEntry[] = [];
  const binaries: ArchiveBinaryEntry[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let totalBinaryBytes = 0;
  let hitLimit = false;

  // End-of-central-directory record: scan back for its signature, since a
  // trailing comment means it is not always at a fixed offset.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("Not a valid .zip file");

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  let totalChars = 0;

  for (let n = 0; n < count; n++) {
    if (offset + 46 > buf.length) break;
    if (view.getUint32(offset, true) !== 0x02014b50) break;

    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);

    const name = new TextDecoder().decode(
      buf.subarray(offset + 46, offset + 46 + nameLen)
    );
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;

    const isProgram = isPeFilename(name);
    const reason = shouldSkip(name);
    if (reason && !isProgram) {
      skipped.push({ path: name, reason });
      continue;
    }

    if (isProgram) {
      if (
        uncompressedSize > MAX_PE_UPLOAD_BYTES ||
        binaries.length >= MAX_BINARY_ENTRIES ||
        totalBinaryBytes + uncompressedSize > MAX_TOTAL_BINARY_BYTES
      ) {
        hitLimit = true;
        skipped.push({ path: name, reason: "executable binary limit exceeded" });
        continue;
      }
    }
    // The text cap applies to text only (evaluated after the sniff below), so
    // a non-PE binary in a text-capped archive is still preserved.
    const atTextCap =
      entries.length >= MAX_ENTRIES || totalChars >= MAX_TOTAL_CHARS;

    // The local header repeats the name and extra fields, and its extra
    // length can differ from the central one — so it has to be read again.
    if (localOffset + 30 > buf.length) continue;
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    let bytes: Uint8Array | null;
    if (method === 0) bytes = raw;
    else if (method === 8) bytes = await inflateRaw(raw);
    else {
      skipped.push({ path: name, reason: "unsupported compression" });
      continue;
    }
    if (!bytes) {
      skipped.push({ path: name, reason: "could not be decompressed" });
      continue;
    }

    if (isProgram) {
      if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
        skipped.push({ path: name, reason: "executable extension but no MZ header" });
      } else {
        // Copy out of the archive buffer. Stored entries may otherwise retain
        // the entire ZIP through a small subarray view.
        const data = new Uint8Array(bytes);
        binaries.push({ path: name, data, bytes: data.length });
        totalBinaryBytes += data.length;
      }
      continue;
    }

    const text = decodeText(bytes);
    if (text === null) {
      /*
       * Non-text file: keep it as exact bytes, exactly like an executable.
       *
       * Skipping here was the "the zip worked but my .so / .bin / core file
       * vanished" case — a zip of a Linux project lost every ELF and the
       * model was left with the source that referenced files it could not
       * see. The same caps that bound executables bound everything else.
       */
      if (
        bytes.length > MAX_PE_UPLOAD_BYTES ||
        binaries.length >= MAX_BINARY_ENTRIES ||
        totalBinaryBytes + bytes.length > MAX_TOTAL_BINARY_BYTES
      ) {
        hitLimit = true;
        skipped.push({ path: name, reason: "binary limit exceeded" });
      } else {
        // Copy out of the archive buffer. Stored entries may otherwise retain
        // the entire ZIP through a small subarray view.
        const data = new Uint8Array(bytes);
        binaries.push({ path: name, data, bytes: data.length });
        totalBinaryBytes += data.length;
      }
      continue;
    }

    if (atTextCap) {
      hitLimit = true;
      continue;
    }

    const truncated = text.length > MAX_ENTRY_CHARS;
    const content = truncated ? text.slice(0, MAX_ENTRY_CHARS) : text;
    totalChars += content.length;
    entries.push({ path: name, content, bytes: bytes.length, truncated });
  }

  return { entries, binaries, skipped, hitLimit };
}

/**
 * Read a TAR.
 *
 * 512-byte header blocks, each followed by the file rounded up to 512. No
 * index and no compression, so it is a straight walk from the front.
 */
function readTar(buf: Uint8Array): ArchiveResult {
  const entries: ArchiveEntry[] = [];
  const binaries: ArchiveBinaryEntry[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let hitLimit = false;
  let totalChars = 0;
  let totalBinaryBytes = 0;
  let offset = 0;

  const str = (start: number, len: number) =>
    new TextDecoder()
      .decode(buf.subarray(start, start + len))
      .replace(/\0.*$/, "")
      .trim();

  while (offset + 512 <= buf.length) {
    const name = str(offset, 100);
    // Two zero blocks mark the end; one empty name is enough to stop.
    if (!name) break;

    const sizeField = str(offset + 124, 12);
    const size = parseInt(sizeField, 8) || 0;
    const typeFlag = String.fromCharCode(buf[offset + 156]);
    // A prefix field carries long paths in the ustar format.
    const prefix = str(offset + 345, 155);
    const full = prefix ? `${prefix}/${name}` : name;

    const dataStart = offset + 512;
    offset = dataStart + Math.ceil(size / 512) * 512;

    // "0" and "\0" are regular files; everything else is a link or directory.
    if (typeFlag !== "0" && typeFlag !== "\0" && typeFlag !== "") continue;
    if (full.endsWith("/")) continue;

    const isProgram = isPeFilename(full);
    const reason = shouldSkip(full);
    if (reason && !isProgram) {
      skipped.push({ path: full, reason });
      continue;
    }
    if (isProgram) {
      if (
        size > MAX_PE_UPLOAD_BYTES ||
        binaries.length >= MAX_BINARY_ENTRIES ||
        totalBinaryBytes + size > MAX_TOTAL_BINARY_BYTES
      ) {
        hitLimit = true;
        skipped.push({ path: full, reason: "executable binary limit exceeded" });
        continue;
      }
      const bytes = buf.subarray(dataStart, dataStart + size);
      if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
        skipped.push({ path: full, reason: "executable extension but no MZ header" });
      } else {
        const data = new Uint8Array(bytes);
        binaries.push({ path: full, data, bytes: data.length });
        totalBinaryBytes += data.length;
      }
      continue;
    }
    // The text cap applies to text only (evaluated after the sniff below), so
    // a non-PE binary in a text-capped archive is still preserved.
    const atTextCap =
      entries.length >= MAX_ENTRIES || totalChars >= MAX_TOTAL_CHARS;

    const bytes = buf.subarray(dataStart, dataStart + size);
    const text = decodeText(bytes);
    if (text === null) {
      // Keep non-text files as exact bytes, same caps as executables.
      if (
        size > MAX_PE_UPLOAD_BYTES ||
        binaries.length >= MAX_BINARY_ENTRIES ||
        totalBinaryBytes + size > MAX_TOTAL_BINARY_BYTES
      ) {
        hitLimit = true;
        skipped.push({ path: full, reason: "binary limit exceeded" });
      } else {
        const data = new Uint8Array(bytes);
        binaries.push({ path: full, data, bytes: data.length });
        totalBinaryBytes += data.length;
      }
      continue;
    }

    if (atTextCap) {
      hitLimit = true;
      continue;
    }

    const truncated = text.length > MAX_ENTRY_CHARS;
    const content = truncated ? text.slice(0, MAX_ENTRY_CHARS) : text;
    totalChars += content.length;
    entries.push({ path: full, content, bytes: size, truncated });
  }

  return { entries, binaries, skipped, hitLimit };
}

/** Unpack an archive into its readable text files. */
export async function readArchive(
  name: string,
  data: Uint8Array
): Promise<ArchiveResult> {
  const lower = name.toLowerCase();

  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    const plain = await gunzip(data);
    if (!plain) throw new Error("Could not decompress this .tar.gz");
    return readTar(plain);
  }
  if (lower.endsWith(".tar")) return readTar(data);
  return readZip(data);
}

/**
 * Render an unpacked archive for the model.
 *
 * A manifest first, so it can see the shape of the project before reading
 * any of it, then each file fenced with its path. Skipped files are counted
 * rather than listed — forty "binary file" lines would push out the code.
 */
/**
 * Render an archive that has been written to the workspace.
 *
 * Only the manifest, because the files themselves are on disk now. Inlining
 * them as well would send everything twice — once here and again whenever
 * the model reads one — and would put a whole project into a single message
 * that is discarded when the turn ends.
 */
export function formatArchiveManifest(
  name: string,
  dir: string,
  result: ArchiveResult
): string {
  const { entries, skipped, hitLimit } = result;
  const binaries = result.binaries ?? [];

  const tree = [
    ...entries.map(
      (e) => `  ${dir}/${e.path}${e.truncated ? "  (truncated)" : ""}`
    ),
    ...binaries.map((e) => `  ${dir}/${e.path}  (binary bytes)`),
  ].join("\n");

  const notes: string[] = [];
  if (skipped.length > 0) {
    notes.push(`${skipped.length} skipped (dependencies or unsupported binaries)`);
  }
  if (hitLimit) notes.push("an extraction limit was reached");
  const count = entries.length + binaries.length;

  return [
    `${name} was unpacked into the workspace at ${dir}/ — ${count} file(s)${
      notes.length ? `, ${notes.join(", ")}` : ""
    }.`,
    "",
    tree,
    "",
    "These are real files on disk. Read text with read_file, search source with search_files, and use inspect_binary on an EXE/DLL — do not ask for the archive to be re-sent.",
  ].join("\n");
}

export function formatArchive(name: string, result: ArchiveResult): string {
  const { entries, skipped, hitLimit } = result;
  const binaries = result.binaries ?? [];

  if (entries.length === 0 && binaries.length === 0) {
    return `[${name} contained no readable text or binary files]`;
  }

  const tree = [
    ...entries.map((e) => `  ${e.path}${e.truncated ? "  (truncated)" : ""}`),
    ...binaries.map((e) => `  ${e.path}  (binary bytes; saving to workspace)`),
  ].join("\n");

  const notes: string[] = [];
  if (skipped.length > 0) {
    notes.push(`${skipped.length} file(s) skipped (dependencies or unsupported binaries)`);
  }
  if (hitLimit) notes.push("an extraction limit was reached");

  const body = entries
    .map((e) => `--- ${e.path} ---\n${e.content}`)
    .join("\n\n");
  const count = entries.length + binaries.length;

  return [
    `Contents of ${name} (${count} file(s))`,
    notes.length ? `Note: ${notes.join("; ")}` : "",
    binaries.length
      ? `${binaries.length} executable/library file(s) will be stored as exact bytes for inspect_binary; they are not executed.`
      : "",
    "",
    tree,
    "",
    body,
  ]
    .filter(Boolean)
    .join("\n");
}

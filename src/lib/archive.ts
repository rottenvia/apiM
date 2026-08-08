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
const SKIP_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "svg",
  "pdf", "zip", "gz", "tar", "rar", "7z", "exe", "dll", "so", "dylib",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "wav", "avi", "mov", "webm",
  "pyc", "class", "o", "a", "bin", "dat", "db", "sqlite",
]);

export interface ArchiveEntry {
  path: string;
  content: string;
  bytes: number;
  /** Cut short because the file alone was larger than the per-file cap. */
  truncated: boolean;
}

export interface ArchiveResult {
  entries: ArchiveEntry[];
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
  // decodeText, which drops it if it turns out to be binary — so an
  // unfamiliar text format is read rather than refused for being unknown.
  const dot = base.lastIndexOf(".");
  const ext = dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return "binary file";

  return null;
}

/** Decode as UTF-8, refusing anything that is clearly not text. */
function decodeText(bytes: Uint8Array): string | null {
  // A NUL byte in the first chunk is the cheapest reliable binary signal.
  const probe = bytes.subarray(0, Math.min(bytes.length, 8000));
  if (probe.includes(0)) return null;

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
  const skipped: { path: string; reason: string }[] = [];
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
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);

    const name = new TextDecoder().decode(
      buf.subarray(offset + 46, offset + 46 + nameLen)
    );
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;

    const reason = shouldSkip(name);
    if (reason) {
      skipped.push({ path: name, reason });
      continue;
    }

    if (entries.length >= MAX_ENTRIES || totalChars >= MAX_TOTAL_CHARS) {
      hitLimit = true;
      continue;
    }

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

    const text = decodeText(bytes);
    if (text === null) {
      skipped.push({ path: name, reason: "binary file" });
      continue;
    }

    const truncated = text.length > MAX_ENTRY_CHARS;
    const content = truncated ? text.slice(0, MAX_ENTRY_CHARS) : text;
    totalChars += content.length;
    entries.push({ path: name, content, bytes: bytes.length, truncated });
  }

  return { entries, skipped, hitLimit };
}

/**
 * Read a TAR.
 *
 * 512-byte header blocks, each followed by the file rounded up to 512. No
 * index and no compression, so it is a straight walk from the front.
 */
function readTar(buf: Uint8Array): ArchiveResult {
  const entries: ArchiveEntry[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let hitLimit = false;
  let totalChars = 0;
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

    const reason = shouldSkip(full);
    if (reason) {
      skipped.push({ path: full, reason });
      continue;
    }
    if (entries.length >= MAX_ENTRIES || totalChars >= MAX_TOTAL_CHARS) {
      hitLimit = true;
      continue;
    }

    const bytes = buf.subarray(dataStart, dataStart + size);
    const text = decodeText(bytes);
    if (text === null) {
      skipped.push({ path: full, reason: "binary file" });
      continue;
    }

    const truncated = text.length > MAX_ENTRY_CHARS;
    const content = truncated ? text.slice(0, MAX_ENTRY_CHARS) : text;
    totalChars += content.length;
    entries.push({ path: full, content, bytes: size, truncated });
  }

  return { entries, skipped, hitLimit };
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

  const tree = entries
    .map((e) => `  ${dir}/${e.path}${e.truncated ? "  (truncated)" : ""}`)
    .join("\n");

  const notes: string[] = [];
  if (skipped.length > 0) {
    notes.push(`${skipped.length} skipped (binaries, dependencies)`);
  }
  if (hitLimit) notes.push(`only the first ${entries.length} were unpacked`);

  return [
    `${name} was unpacked into the workspace at ${dir}/ — ${entries.length} file(s)${
      notes.length ? `, ${notes.join(", ")}` : ""
    }.`,
    "",
    tree,
    "",
    "These are real files on disk. Read the ones you need with read_file, or search across them with search_files — do not ask for the archive to be re-sent.",
  ].join("\n");
}

export function formatArchive(name: string, result: ArchiveResult): string {
  const { entries, skipped, hitLimit } = result;

  if (entries.length === 0) {
    return `[${name} contained no readable text files]`;
  }

  const tree = entries
    .map((e) => `  ${e.path}${e.truncated ? "  (truncated)" : ""}`)
    .join("\n");

  const notes: string[] = [];
  if (skipped.length > 0) {
    notes.push(`${skipped.length} file(s) skipped (binaries, dependencies)`);
  }
  if (hitLimit) {
    notes.push(`only the first ${entries.length} files are included`);
  }

  const body = entries
    .map((e) => `--- ${e.path} ---\n${e.content}`)
    .join("\n\n");

  return [
    `Contents of ${name} (${entries.length} file(s))`,
    notes.length ? `Note: ${notes.join("; ")}` : "",
    "",
    tree,
    "",
    body,
  ]
    .filter(Boolean)
    .join("\n");
}

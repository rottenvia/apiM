/**
 * What the model is told about a file the user dropped in.
 *
 * Files used to be read in the browser and pasted into the message: text
 * cut at 800k characters (the rest of a 35MB JSON simply did not exist),
 * archives unpacked with only their text kept, RAR and 7z refused. Now the
 * file is saved to the workspace as exact bytes first, and this describes
 * it the way a person would before opening it: a small file is shown whole;
 * a big one gets its shape — a JSON's structure with counts, a CSV's
 * columns and rows, a log's head and tail, a document's opening text, an
 * archive's tree — with the path and the tool that reads the rest. The
 * agent then works on the real file instead of on a truncated copy.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveInside, listFiles } from "@/lib/workspace";
import { describeData, loadData, formatFor, mainCollection, MAX_DATA_BYTES } from "@/lib/data-query";
import { documentKind, readDocument } from "@/lib/documents";
import { detectBinaryFormat } from "@/lib/binaries";

/** Text up to this many characters is shown whole (≈28k tokens). */
export const INLINE_CHARS = 100_000;
/** A document's text shown in the message before pointing at read_document. */
const DOC_PREVIEW_CHARS = 20_000;
const HEAD_LINES = 80;
const TAIL_LINES = 30;
const PREVIEW_LINE_CHARS = 400;

export type UploadKind = "text" | "data" | "document" | "image" | "binary" | "archive" | "folder";

export interface UploadDescription {
  path: string;
  bytes: number;
  kind: UploadKind;
  /** The whole content is in `text`. */
  inline: boolean;
  /** What goes into the message for the model. */
  text: string;
  /** Short line for the chip, e.g. "JSON · 150,000 items". */
  label: string;
  fileCount?: number;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---------------------------------------------------------------- sniffing

const IMAGE_MAGIC: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47], "PNG"],
  [[0xff, 0xd8, 0xff], "JPEG"],
  [[0x47, 0x49, 0x46, 0x38], "GIF"],
  [[0x42, 0x4d], "BMP"],
];

function startsWith(head: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => head[i] === b);
}

export function imageKind(head: Uint8Array): string | null {
  for (const [magic, name] of IMAGE_MAGIC) if (startsWith(head, magic)) return name;
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && String.fromCharCode(...head.slice(8, 12)) === "WEBP") return "WebP";
  return null;
}

/** Executable formats inspect_binary takes apart — the same detector it uses. */
export function executableKind(head: Uint8Array, name: string): string | null {
  if (head[0] === 0x4d && head[1] === 0x5a) return "Windows PE";
  const { format } = detectBinaryFormat(head, name);
  return format === "unknown binary" ? null : format;
}

/** Same rule as the browser's sniff: a NUL, or ~10% control bytes. */
export function looksBinary(head: Uint8Array): boolean {
  if (utf16(head)) return false;
  const n = Math.min(head.length, 8192);
  if (n === 0) return false;
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const b = head[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32 && b !== 27)) odd++;
  }
  return odd / n > 0.1;
}

function utf16(head: Uint8Array): "le" | "be" | null {
  if (head[0] === 0xff && head[1] === 0xfe) return "le";
  if (head[0] === 0xfe && head[1] === 0xff) return "be";
  return null;
}

function decode(buf: Buffer): string {
  const enc = utf16(buf);
  if (enc) return new TextDecoder(enc === "le" ? "utf-16le" : "utf-16be").decode(buf).replace(/^﻿/, "");
  return buf.toString("utf8").replace(/^﻿/, "");
}

function fence(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return ext && ext.length <= 12 && /^[a-z0-9+#-]+$/.test(ext) ? ext : "";
}

function clipLine(line: string): string {
  return line.length > PREVIEW_LINE_CHARS ? `${line.slice(0, PREVIEW_LINE_CHARS)}…[+${line.length - PREVIEW_LINE_CHARS} chars]` : line;
}

// ---------------------------------------------------------------- describe

async function describeText(rel: string, abs: string, bytes: number): Promise<UploadDescription> {
  // Big data files: parse for structure instead of loading text we won't show.
  const head = (await readHead(abs, 4096)).toString("utf8");
  const format = formatFor(rel, head);
  if (format && bytes > INLINE_CHARS && bytes <= MAX_DATA_BYTES) {
    try {
      const data = await loadData(abs, rel);
      const main = mainCollection(data.value);
      const noun = format === "csv" || format === "tsv" ? "rows" : main?.key ?? "items";
      const label =
        `${format.toUpperCase()} · ${formatSize(bytes)}` +
        (main ? ` · ${main.length.toLocaleString()} ${noun}` : "");
      // Examples written against this file's own shape, not a generic one.
      const examples = main
        ? [
            `${main.path}[0:5]`,
            `${main.path}[-1]`,
            ...(main.sampleField ? [`${main.path}[?(@.${main.sampleField} == …)]`, `${main.path}[*].${main.sampleField}`] : []),
          ]
        : ["$", "$..<key>"];
      return {
        path: rel,
        bytes,
        kind: "data",
        inline: false,
        label,
        text:
          `Attached file: ${rel} (${formatSize(bytes)}) — saved in the workspace; too large to show whole, so here is its structure.\n` +
          `${describeData(data)}\n\n` +
          `Read it with query_data path="${rel}" — JSONPath queries such as ${examples.join(", ")}; ` +
          `count:true, fields, and save_as to write a subset to a file. ` +
          `For heavy processing, run a script against the file.`,
      };
    } catch {
      // Not parseable as data — describe it as text below.
    }
  }

  const buf = await fs.readFile(abs);
  const text = decode(buf);
  const lines = text.split("\n");
  if (text.length <= INLINE_CHARS) {
    return {
      path: rel,
      bytes,
      kind: "text",
      inline: true,
      label: `${lines.length.toLocaleString()} lines`,
      text: `Attached file: ${rel} (saved in the workspace)\n\`\`\`${fence(rel)}\n${text}\n\`\`\``,
    };
  }
  const headLines = lines.slice(0, HEAD_LINES).map(clipLine);
  const tailLines = lines.length > HEAD_LINES + TAIL_LINES ? lines.slice(-TAIL_LINES).map(clipLine) : [];
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  return {
    path: rel,
    bytes,
    kind: "text",
    inline: false,
    label: `${formatSize(bytes)} · ${lines.length.toLocaleString()} lines`,
    text:
      `Attached file: ${rel} (${formatSize(bytes)}, ${lines.length.toLocaleString()} lines, ${text.length.toLocaleString()} characters) — saved in the workspace; too large to show whole.\n` +
      `First ${headLines.length} lines:\n\`\`\`${fence(rel)}\n${headLines.join("\n")}\n\`\`\`\n` +
      (tailLines.length ? `Last ${tailLines.length} lines:\n\`\`\`${fence(rel)}\n${tailLines.join("\n")}\n\`\`\`\n` : "") +
      (longest > 100_000
        ? `Some lines are extremely long (up to ${longest.toLocaleString()} characters) — read_file cannot page through those; use search_files or a script.\n`
        : "") +
      `Read more with read_file path="${rel}" start_line=… end_line=…, find things with search_files, or process it with a script.`,
  };
}

async function readHead(abs: string, n: number): Promise<Buffer> {
  const fh = await fs.open(abs, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Describe one uploaded workspace file. Archives are handled by the caller
 * (they are extracted first); everything else is described here.
 */
export async function describeUpload(workspaceId: string, rel: string): Promise<UploadDescription> {
  const abs = resolveInside(workspaceId, rel);
  const st = await fs.stat(abs);
  if (st.isDirectory()) return describeFolder(workspaceId, rel);
  const bytes = st.size;
  const head = await readHead(abs, 8192);
  const name = path.basename(rel);

  const doc = documentKind(name);
  if (doc) {
    try {
      const out = await readDocument(doc, new Uint8Array(await fs.readFile(abs)));
      const whole = out.text.length <= DOC_PREVIEW_CHARS && !out.truncated;
      return {
        path: rel,
        bytes,
        kind: "document",
        inline: whole,
        label: `${doc.toUpperCase()} · ${formatSize(bytes)}${out.sections > 1 ? ` · ${out.sections} sections` : ""}`,
        text:
          `Attached document: ${rel} (${formatSize(bytes)}) — saved in the workspace.\n` +
          (whole
            ? `${out.text}`
            : `First ${DOC_PREVIEW_CHARS.toLocaleString()} characters of its text:\n${out.text.slice(0, DOC_PREVIEW_CHARS)}\n…\nRead the rest with read_document path="${rel}".`),
      };
    } catch (e) {
      return {
        path: rel,
        bytes,
        kind: "document",
        inline: false,
        label: `${doc.toUpperCase()} · ${formatSize(bytes)}`,
        text: `Attached document: ${rel} (${formatSize(bytes)}) — saved in the workspace, but its text could not be extracted here (${e instanceof Error ? e.message : "unreadable"}). Try read_document path="${rel}".`,
      };
    }
  }

  const image = imageKind(head);
  if (image) {
    return {
      path: rel,
      bytes,
      kind: "image",
      inline: false,
      label: `${image} · ${formatSize(bytes)}`,
      text: `Attached image: ${rel} (${image}, ${formatSize(bytes)}) — saved in the workspace; view_image path="${rel}" looks at it.`,
    };
  }

  const exe = executableKind(head, name);
  if (exe || looksBinary(head)) {
    return {
      path: rel,
      bytes,
      kind: "binary",
      inline: false,
      label: `${exe ?? "binary"} · ${formatSize(bytes)}`,
      text:
        `Attached ${exe ?? "binary file"}: ${rel} (${formatSize(bytes)}) — saved as exact bytes; it was not executed. ` +
        `Use inspect_binary path="${rel}": start with analyses:["summary"] or ["strings"], then decompile only the functions you need (focus_terms). Do not dump the whole binary.`,
    };
  }

  return describeText(rel, abs, bytes);
}

// ---------------------------------------------------------------- folders

const NOTABLE = /(?:^|\/)(?:README[^/]*|LICENSE[^/]*|package\.json|pyproject\.toml|requirements[^/]*\.txt|setup\.py|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.sln|[^/]+\.csproj|CMakeLists\.txt|Makefile|Dockerfile|docker-compose\.ya?ml|AGENTS\.md|CLAUDE\.md|main\.[a-z]+|index\.[a-z]+|app\.[a-z]+)$/i;

/** A folder the user dropped (or an archive once extracted): its map. */
export async function describeFolder(workspaceId: string, rel: string): Promise<UploadDescription> {
  const files = await listFiles(workspaceId, rel);
  const bytes = files.reduce((n, f) => n + f.size, 0);
  const prefix = rel.replace(/\/+$/, "") + "/";
  const relOf = (p: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);

  const byExt = new Map<string, { n: number; bytes: number }>();
  for (const f of files) {
    const ext = path.extname(f.path).toLowerCase() || "(none)";
    const e = byExt.get(ext) ?? { n: 0, bytes: 0 };
    e.n++;
    e.bytes += f.size;
    byExt.set(ext, e);
  }
  const histogram = [...byExt.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 12)
    .map(([ext, e]) => `${ext} ×${e.n}`)
    .join(", ");

  // Directory tree, folded: top two levels in full, deeper levels counted.
  const dirs = new Map<string, { files: number; bytes: number }>();
  for (const f of files) {
    const parts = relOf(f.path).split("/");
    for (let d = 1; d < parts.length; d++) {
      const dir = parts.slice(0, d).join("/");
      const e = dirs.get(dir) ?? { files: 0, bytes: 0 };
      e.files++;
      e.bytes += f.size;
      dirs.set(dir, e);
    }
  }
  const treeLines: string[] = [];
  const MAX_TREE = 120;
  const topFiles = files.filter((f) => !relOf(f.path).includes("/"));
  for (const [dir, e] of [...dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (dir.split("/").length > 2) continue;
    if (treeLines.length >= MAX_TREE) break;
    const depth = dir.split("/").length - 1;
    treeLines.push(`${"  ".repeat(depth)}${dir.split("/").pop()}/  (${e.files} files, ${formatSize(e.bytes)})`);
  }
  for (const f of topFiles.slice(0, Math.max(0, MAX_TREE - treeLines.length))) {
    treeLines.push(`${relOf(f.path)}  (${formatSize(f.size)})`);
  }
  if (dirs.size + topFiles.length > treeLines.length) treeLines.push("…");

  const notable = files.filter((f) => NOTABLE.test(relOf(f.path)) && relOf(f.path).split("/").length <= 3).slice(0, 20);
  const executables = files.filter((f) => /\.(?:exe|dll|sys|so|dylib|jar|apk|class|wasm|pyc)$/i.test(f.path)).slice(0, 20);
  const archives = files.filter((f) => /\.(?:zip|rar|7z|tar|tgz|gz|bz2|xz)$/i.test(f.path)).slice(0, 20);

  return {
    path: rel,
    bytes,
    kind: "folder",
    inline: false,
    fileCount: files.length,
    label: `${files.length.toLocaleString()} files · ${formatSize(bytes)}`,
    text:
      `Attached folder: ${rel}/ — ${files.length.toLocaleString()} files, ${formatSize(bytes)}, saved in the workspace with its structure.\n` +
      `Types: ${histogram}\n` +
      `Tree:\n${treeLines.join("\n")}\n` +
      (notable.length ? `Notable files:\n${notable.map((f) => `  ${f.path}`).join("\n")}\n` : "") +
      (executables.length ? `Binaries (inspect_binary; never executed):\n${executables.map((f) => `  ${f.path}`).join("\n")}\n` : "") +
      (archives.length ? `Archives inside (extract_archive to unpack):\n${archives.map((f) => `  ${f.path}`).join("\n")}\n` : "") +
      `Explore it with list_files path="${rel}", search_files, read_files and find_references — or delegate a survey of it.`,
  };
}

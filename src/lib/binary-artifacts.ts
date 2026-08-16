/**
 * Persistent static-analysis artifacts for inspect_binary.
 *
 * The chat response stays bounded; exhaustive data goes into the workspace so
 * the agent can search/read only the parts relevant to the question. All work
 * is streaming/chunked and cached by the executable SHA-256.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { binaryAnalysisRoot } from "@/lib/binary-types";
import { resolveInside, workspaceDirectory } from "@/lib/workspace";
import type { PeInspection } from "@/lib/binaries";

export interface StringsDumpResult {
  count: number;
  ascii: number;
  utf16: number;
  outputs: string[];
  truncated: boolean;
}

export interface EntropyMapResult {
  windowBytes: number;
  windows: number;
  min: number;
  max: number;
  average: number;
  outputs: string[];
}

export interface CarvedBlob {
  index: number;
  kind:
    | "PE"
    | "Lua bytecode"
    | "Lua source"
    | "ZIP"
    | "PNG"
    | "PDF"
    | "opaque high-entropy section"
    | "opaque overlay";
  offset: number;
  bytes: number;
  path: string;
  strings: string[];
  note: string;
}

export interface StaticArtifactLayers {
  summary: boolean;
  strings: boolean;
  entropy: boolean;
  carve: boolean;
}

export interface StaticBinaryArtifacts {
  root: string;
  outputs: string[];
  strings: StringsDumpResult;
  entropy: EntropyMapResult;
  carved: CarvedBlob[];
  layers: StaticArtifactLayers;
  cached: boolean;
  summary: string;
}

interface StaticArtifactCache {
  schema: number;
  hash: string;
  summaryOutput?: string;
  strings?: StringsDumpResult;
  entropy?: EntropyMapResult;
  carved?: CarvedBlob[];
}

const STATIC_SCHEMA = 5;
// search_files reads up to 512KB per file. Stay below that so exhaustive
// artifacts are genuinely searchable instead of merely present on disk.
const STRINGS_CHUNK_BYTES = 350_000;
const MAX_CARVED_BLOBS = 64;
const MAX_CARVED_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_CARVED_SINGLE_BYTES = 64 * 1024 * 1024;

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, Math.trunc(parsed)))
    : fallback;
}

function relative(workspaceRoot: string, full: string): string {
  return path.relative(workspaceRoot, full).split(path.sep).join("/");
}

function safe(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 90) || "blob"
  );
}

function stopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Binary artifact generation stopped", "AbortError");
}

class ChunkWriter {
  private readonly dir: string;
  private readonly stem: string;
  private readonly extension: string;
  private readonly maxBytes: number;
  private part = 0;
  private buffered: string[] = [];
  private bufferedBytes = 0;
  private totalBytes = 0;
  readonly files: string[] = [];
  truncated = false;

  constructor(dir: string, stem: string, extension: string, maxBytes: number) {
    this.dir = dir;
    this.stem = stem;
    this.extension = extension;
    this.maxBytes = maxBytes;
  }

  async write(line: string): Promise<boolean> {
    if (this.truncated) return false;
    const bytes = Buffer.byteLength(line, "utf8");
    if (this.totalBytes + this.bufferedBytes + bytes > this.maxBytes) {
      this.truncated = true;
      await this.flush();
      return false;
    }
    if (this.bufferedBytes > 0 && this.bufferedBytes + bytes > STRINGS_CHUNK_BYTES) {
      await this.flush();
    }
    this.buffered.push(line);
    this.bufferedBytes += bytes;
    return true;
  }

  async flush(): Promise<void> {
    if (!this.buffered.length) return;
    this.part++;
    const name = `${this.stem}-${String(this.part).padStart(4, "0")}.${this.extension}`;
    const full = path.join(this.dir, name);
    await fs.writeFile(full, this.buffered.join(""), "utf8");
    this.files.push(full);
    this.totalBytes += this.bufferedBytes;
    this.buffered = [];
    this.bufferedBytes = 0;
  }

  async finish(): Promise<void> {
    await this.flush();
  }
}

function printableAscii(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e;
}

function cleanString(value: string): string {
  // JSON keeps tabs/newlines and unpaired code units from breaking TSV rows.
  return JSON.stringify(value);
}

/** Exhaustive ASCII + both UTF-16LE alignments, written incrementally. */
async function dumpStrings(
  bytes: Uint8Array,
  dir: string,
  stem: string,
  workspaceRoot: string,
  signal?: AbortSignal,
  maxOutputBytes?: number
): Promise<StringsDumpResult> {
  await fs.mkdir(dir, { recursive: true });
  const max = maxOutputBytes ??
    numberEnv(
      "APIM_BINARY_MAX_STATIC_OUTPUT_MB",
      512,
      16,
      2_048
    ) * 1024 * 1024;
  const perEncodingMax = Math.max(8 * 1024 * 1024, Math.floor(max / 2));
  const asciiWriter = new ChunkWriter(
    dir,
    `${stem}-ascii`,
    "tsv",
    perEncodingMax
  );
  const utfWriter = new ChunkWriter(
    dir,
    `${stem}-utf16le`,
    "tsv",
    perEncodingMax
  );
  await asciiWriter.write("offset\tencoding\tlength\tvalue\n");
  await utfWriter.write("offset\tencoding\tlength\tvalue\n");
  let asciiCount = 0;
  let utf16Count = 0;
  const min = 4;

  for (let i = 0; i < bytes.length; ) {
    if ((i & 0x7fffff) === 0) stopped(signal);
    if (!printableAscii(bytes[i])) {
      i++;
      continue;
    }
    const start = i;
    let value = "";
    while (i < bytes.length && printableAscii(bytes[i])) {
      value += String.fromCharCode(bytes[i]);
      i++;
      if (value.length === 16_384) {
        if (value.length >= min) {
          const ok = await asciiWriter.write(
            `0x${(i - value.length).toString(16)}\tascii\t${value.length}\t${cleanString(value)}\n`
          );
          if (ok) asciiCount++;
        }
        value = "";
      }
    }
    if (value.length >= min) {
      const ok = await asciiWriter.write(
        `0x${(i - value.length).toString(16)}\tascii\t${value.length}\t${cleanString(value)}\n`
      );
      if (ok) asciiCount++;
    }
    if (i === start) i++;
  }

  for (const parity of [0, 1]) {
    for (let i = parity; i + 1 < bytes.length; ) {
      if ((i & 0x7fffff) === parity) stopped(signal);
      const first = bytes[i] | (bytes[i + 1] << 8);
      if (first < 0x20 || first === 0x7f || first > 0xfffd) {
        i += 2;
        continue;
      }
      let value = "";
      while (i + 1 < bytes.length) {
        const code = bytes[i] | (bytes[i + 1] << 8);
        if (code < 0x20 || code === 0x7f || code > 0xfffd) break;
        value += String.fromCharCode(code);
        i += 2;
        if (value.length === 16_384) {
          const ok = await utfWriter.write(
            `0x${(i - value.length * 2).toString(16)}\tutf16le/${parity === 0 ? "even" : "odd"}\t${value.length}\t${cleanString(value)}\n`
          );
          if (ok) utf16Count++;
          value = "";
        }
      }
      if (value.length >= min) {
        const ok = await utfWriter.write(
          `0x${(i - value.length * 2).toString(16)}\tutf16le/${parity === 0 ? "even" : "odd"}\t${value.length}\t${cleanString(value)}\n`
        );
        if (ok) utf16Count++;
      }
      if (value.length < min) i += 2;
    }
  }

  await asciiWriter.finish();
  await utfWriter.finish();
  return {
    count: asciiCount + utf16Count,
    ascii: asciiCount,
    utf16: utf16Count,
    outputs: [...asciiWriter.files, ...utfWriter.files].map((file) =>
      relative(workspaceRoot, file)
    ),
    truncated: asciiWriter.truncated || utfWriter.truncated,
  };
}

function blockEntropy(bytes: Uint8Array, offset: number, size: number): number {
  if (size <= 0) return 0;
  const counts = new Uint32Array(256);
  const end = Math.min(bytes.length, offset + size);
  for (let i = offset; i < end; i++) counts[bytes[i]]++;
  const n = end - offset;
  if (!n) return 0;
  let result = 0;
  for (const count of counts) {
    if (!count) continue;
    const p = count / n;
    result -= p * Math.log2(p);
  }
  return result;
}

async function writeEntropyMap(
  bytes: Uint8Array,
  inspection: PeInspection,
  dir: string,
  workspaceRoot: string,
  signal?: AbortSignal
): Promise<EntropyMapResult> {
  const windowBytes = 4096;
  const outputs: string[] = [];
  let lines: string[] = ["offset\tsize\tentropy\tsection\n"];
  let chars = lines[0].length;
  let part = 0;
  const flush = async () => {
    if (lines.length <= 1) return;
    part++;
    const output = path.join(
      dir,
      `entropy-map-${String(part).padStart(4, "0")}.tsv`
    );
    await fs.writeFile(output, lines.join(""), "utf8");
    outputs.push(relative(workspaceRoot, output));
    lines = ["offset\tsize\tentropy\tsection\n"];
    chars = lines[0].length;
  };
  let min = 8;
  let max = 0;
  let sum = 0;
  let windows = 0;
  for (let offset = 0; offset < bytes.length; offset += windowBytes) {
    if ((offset & 0x7fffff) === 0) stopped(signal);
    const size = Math.min(windowBytes, bytes.length - offset);
    const value = blockEntropy(bytes, offset, size);
    const section = inspection.sections.find(
      (candidate) =>
        offset >= candidate.rawOffset &&
        offset < candidate.rawOffset + candidate.rawSize
    );
    const line =
      `0x${offset.toString(16)}\t${size}\t${value.toFixed(4)}\t` +
      `${section?.name ?? "headers/overlay"}\n`;
    if (chars + line.length > STRINGS_CHUNK_BYTES) await flush();
    lines.push(line);
    chars += line.length;
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
    windows++;
  }
  await flush();
  return {
    windowBytes,
    windows,
    min: windows ? Number(min.toFixed(4)) : 0,
    max: Number(max.toFixed(4)),
    average: windows ? Number((sum / windows).toFixed(4)) : 0,
    outputs,
  };
}

function u16(bytes: Uint8Array, at: number): number | null {
  return at >= 0 && at + 2 <= bytes.length
    ? bytes[at] | (bytes[at + 1] << 8)
    : null;
}

function u32(bytes: Uint8Array, at: number): number | null {
  return at >= 0 && at + 4 <= bytes.length
    ? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
    : null;
}

function embeddedPe(bytes: Uint8Array, offset: number): { size: number; dll: boolean } | null {
  if (bytes[offset] !== 0x4d || bytes[offset + 1] !== 0x5a) return null;
  const peRelative = u32(bytes, offset + 0x3c);
  if (peRelative === null || peRelative < 0x40 || peRelative > 16 * 1024 * 1024) return null;
  const pe = offset + peRelative;
  if (
    pe + 24 > bytes.length ||
    bytes[pe] !== 0x50 ||
    bytes[pe + 1] !== 0x45 ||
    bytes[pe + 2] !== 0 ||
    bytes[pe + 3] !== 0
  ) return null;
  const sections = u16(bytes, pe + 6) ?? 0;
  const optionalSize = u16(bytes, pe + 20) ?? 0;
  const characteristics = u16(bytes, pe + 22) ?? 0;
  if (!sections || sections > 512 || optionalSize < 96) return null;
  const optional = pe + 24;
  const sectionTable = optional + optionalSize;
  if (sectionTable + sections * 40 > bytes.length) return null;
  let end = sectionTable + sections * 40 - offset;
  for (let i = 0; i < sections; i++) {
    const at = sectionTable + i * 40;
    const rawSize = u32(bytes, at + 16) ?? 0;
    const rawOffset = u32(bytes, at + 20) ?? 0;
    if (rawOffset + rawSize > end) end = rawOffset + rawSize;
  }
  const magic = u16(bytes, optional);
  const dataStart = optional + (magic === 0x20b ? 112 : 96);
  if (magic === 0x10b || magic === 0x20b) {
    const securityOffset = u32(bytes, dataStart + 4 * 8) ?? 0;
    const securitySize = u32(bytes, dataStart + 4 * 8 + 4) ?? 0;
    end = Math.max(end, securityOffset + securitySize);
  }
  if (end <= 0 || end > bytes.length - offset) return null;
  return { size: end, dll: Boolean(characteristics & 0x2000) };
}

function findAll(bytes: Uint8Array, signature: Uint8Array, start = 0): number[] {
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const needle = Buffer.from(signature);
  const out: number[] = [];
  let at = source.indexOf(needle, start);
  while (at !== -1 && out.length < 10_000) {
    out.push(at);
    at = source.indexOf(needle, at + 1);
  }
  return out;
}

function findEnd(bytes: Uint8Array, signature: Uint8Array, start: number): number | null {
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = source.indexOf(Buffer.from(signature), start);
  return at === -1 ? null : at + signature.length;
}

interface CarveCandidate {
  kind: CarvedBlob["kind"];
  offset: number;
  end: number;
  extension: string;
  note: string;
}

function carveCandidates(bytes: Uint8Array): CarveCandidate[] {
  const candidates: CarveCandidate[] = [];
  for (const offset of findAll(bytes, new Uint8Array([0x4d, 0x5a]), 1)) {
    const pe = embeddedPe(bytes, offset);
    if (!pe) continue;
    candidates.push({
      kind: "PE",
      offset,
      end: offset + pe.size,
      extension: pe.dll ? "dll" : "exe",
      note: `Embedded ${pe.dll ? "DLL" : "EXE"} with a self-consistent PE section table.`,
    });
  }

  const luaSignatures: [Uint8Array, string][] = [
    [new Uint8Array([0x1b, 0x4c, 0x75, 0x61]), "Lua bytecode"],
    [new Uint8Array([0x1b, 0x4c, 0x4a]), "LuaJIT bytecode"],
  ];
  const allStrongSignatures = [
    new Uint8Array([0x4d, 0x5a]),
    ...luaSignatures.map(([signature]) => signature),
    new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    new TextEncoder().encode("%PDF-"),
  ];
  for (const [signature, label] of luaSignatures) {
    for (const offset of findAll(bytes, signature, 1)) {
      let nextSignature = bytes.length;
      const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (const candidateSignature of allStrongSignatures) {
        const found = source.indexOf(Buffer.from(candidateSignature), offset + signature.length);
        if (found !== -1 && found < nextSignature) nextSignature = found;
      }
      const next = Math.min(
        bytes.length,
        offset + MAX_CARVED_SINGLE_BYTES,
        nextSignature,
        ...candidates.filter((item) => item.offset > offset).map((item) => item.offset)
      );
      candidates.push({
        kind: "Lua bytecode",
        offset,
        end: next,
        extension: "luac",
        note: `${label}; exact embedded length is not encoded, so carving stops at the next known blob or the per-blob cap.`,
      });
    }
  }

  for (const offset of findAll(bytes, new TextEncoder().encode("PK\u0003\u0004"), 1)) {
    const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = source.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), offset + 4);
    if (eocd === -1 || eocd + 22 > bytes.length) continue;
    const comment = u16(bytes, eocd + 20) ?? 0;
    const end = Math.min(bytes.length, eocd + 22 + comment);
    candidates.push({ kind: "ZIP", offset, end, extension: "zip", note: "Embedded ZIP archive ending at EOCD." });
  }
  for (const offset of findAll(bytes, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 1)) {
    const iend = findEnd(bytes, new Uint8Array([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]), offset + 8);
    if (iend) candidates.push({ kind: "PNG", offset, end: iend, extension: "png", note: "Embedded PNG through IEND." });
  }
  for (const offset of findAll(bytes, new TextEncoder().encode("%PDF-"), 1)) {
    const eof = findEnd(bytes, new TextEncoder().encode("%%EOF"), offset + 5);
    if (eof) candidates.push({ kind: "PDF", offset, end: eof, extension: "pdf", note: "Embedded PDF through %%EOF." });
  }

  // Long printable runs that look like actual Lua source, not one token.
  for (let i = 1; i < bytes.length; ) {
    if (!printableAscii(bytes[i])) {
      i++;
      continue;
    }
    const start = i;
    while (i < bytes.length && printableAscii(bytes[i]) && i - start < 2 * 1024 * 1024) i++;
    if (i - start < 80) continue;
    const text = new TextDecoder("ascii").decode(bytes.subarray(start, i));
    if (
      /\bfunction\s+[A-Za-z_]|\blocal\s+[A-Za-z_]/.test(text) &&
      /\b(require|end|then|elseif|pairs|ipairs)\b/.test(text)
    ) {
      candidates.push({
        kind: "Lua source",
        offset: start,
        end: i,
        extension: "lua",
        note: "Long printable region containing multiple Lua source-language tokens.",
      });
    }
  }

  return candidates
    .filter((candidate) => candidate.end > candidate.offset)
    .sort((a, b) => a.offset - b.offset || b.end - a.end);
}

function opaqueCandidates(
  bytes: Uint8Array,
  inspection: PeInspection
): CarveCandidate[] {
  const candidates: CarveCandidate[] = [];
  for (const section of inspection.sections) {
    if (
      section.rawSize < 512 ||
      section.entropy < 7.2 ||
      section.rawOffset < 0 ||
      section.rawOffset >= bytes.length
    ) continue;
    candidates.push({
      kind: "opaque high-entropy section",
      offset: section.rawOffset,
      end: Math.min(bytes.length, section.rawOffset + section.rawSize),
      extension: "bin",
      note:
        `Section ${section.name} has entropy ${section.entropy}. It is preserved ` +
        `as opaque compressed/encrypted data; no plaintext payload signature ` +
        `was claimed.`,
    });
  }
  if (inspection.overlayBytes >= 4096) {
    candidates.push({
      kind: "opaque overlay",
      offset: Math.max(0, bytes.length - inspection.overlayBytes),
      end: bytes.length,
      extension: "bin",
      note:
        `The PE overlay has ${inspection.overlayBytes} bytes and is preserved ` +
        `even though no plaintext child format was identified.`,
    });
  }
  return candidates;
}

async function carveBlobs(
  bytes: Uint8Array,
  inspection: PeInspection,
  dir: string,
  workspaceRoot: string,
  signal?: AbortSignal
): Promise<CarvedBlob[]> {
  const outputDir = path.join(dir, "carved");
  const stringsDir = path.join(outputDir, "strings");
  await fs.mkdir(stringsDir, { recursive: true });
  const carved: CarvedBlob[] = [];
  const occupied: [number, number][] = [];
  let total = 0;

  // Strong magic-based children first, then overlapping opaque regions. This
  // preserves a real embedded PE/Lua/PDF and the encrypted section containing
  // it instead of letting the broad section carve hide the specific child.
  const candidates = [
    ...carveCandidates(bytes),
    ...opaqueCandidates(bytes, inspection),
  ];
  for (const candidate of candidates) {
    stopped(signal);
    if (carved.length >= MAX_CARVED_BLOBS) break;
    const size = Math.min(candidate.end - candidate.offset, MAX_CARVED_SINGLE_BYTES);
    if (size <= 0 || total + size > MAX_CARVED_TOTAL_BYTES) continue;
    // A strong blob fully inside one already carved is usually a signature in
    // that child, not a second independent payload.
    if (occupied.some(([from, to]) => candidate.offset >= from && candidate.end <= to)) continue;
    const index = carved.length + 1;
    const base = `blob-${String(index).padStart(3, "0")}-0x${candidate.offset.toString(16)}-${safe(candidate.kind.toLowerCase())}`;
    const full = path.join(outputDir, `${base}.${candidate.extension}`);
    const data = new Uint8Array(bytes.subarray(candidate.offset, candidate.offset + size));
    await fs.writeFile(full, data);
    const ownStrings = await dumpStrings(
      data,
      stringsDir,
      `${base}-strings`,
      workspaceRoot,
      signal,
      32 * 1024 * 1024
    );
    carved.push({
      index,
      kind: candidate.kind,
      offset: candidate.offset,
      bytes: data.length,
      path: relative(workspaceRoot, full),
      strings: ownStrings.outputs,
      note:
        candidate.note +
        (size < candidate.end - candidate.offset ? " Carve hit the per-blob size cap." : ""),
    });
    occupied.push([candidate.offset, candidate.offset + size]);
    total += size;
  }

  await fs.writeFile(
    path.join(outputDir, "index.json"),
    JSON.stringify(carved, null, 2) + "\n",
    "utf8"
  );
  return carved;
}

function emptyStrings(): StringsDumpResult {
  return { count: 0, ascii: 0, utf16: 0, outputs: [], truncated: false };
}

function emptyEntropy(): EntropyMapResult {
  return {
    windowBytes: 4096,
    windows: 0,
    min: 0,
    max: 0,
    average: 0,
    outputs: [],
  };
}

const ALL_LAYERS: StaticArtifactLayers = {
  summary: true,
  strings: true,
  entropy: true,
  carve: true,
};

export async function generateStaticBinaryArtifacts(
  workspaceId: string,
  target: string,
  bytes: Uint8Array,
  inspection: PeInspection,
  options: {
    force?: boolean;
    signal?: AbortSignal;
    layers?: Partial<StaticArtifactLayers>;
  } = {}
): Promise<StaticBinaryArtifacts> {
  const workspaceRoot = workspaceDirectory(workspaceId);
  const rootRelative = binaryAnalysisRoot(target, inspection.hashes.sha256);
  const staticDir = resolveInside(workspaceId, `${rootRelative}/static`);
  const markerPath = path.join(staticDir, ".apim-static.json");
  const layers: StaticArtifactLayers = options.layers
    ? {
        summary: options.layers.summary === true,
        strings: options.layers.strings === true,
        entropy: options.layers.entropy === true,
        carve: options.layers.carve === true,
      }
    : { ...ALL_LAYERS };

  let cache: StaticArtifactCache = {
    schema: STATIC_SCHEMA,
    hash: inspection.hashes.sha256,
  };
  if (!options.force) {
    try {
      const loaded = JSON.parse(
        await fs.readFile(markerPath, "utf8")
      ) as StaticArtifactCache;
      if (
        loaded.schema === STATIC_SCHEMA &&
        loaded.hash === inspection.hashes.sha256
      ) {
        cache = loaded;
      } else {
        await fs.rm(staticDir, { recursive: true, force: true });
      }
    } catch {
      /* no compatible incremental cache */
    }
  } else {
    await fs.rm(staticDir, { recursive: true, force: true });
  }

  await fs.mkdir(staticDir, { recursive: true });
  stopped(options.signal);
  let allRequestedWereCached = true;

  if (layers.summary && !cache.summaryOutput) {
    allRequestedWereCached = false;
    const summaryPath = path.join(staticDir, "pe-summary.json");
    await fs.writeFile(
      summaryPath,
      JSON.stringify(
        {
          path: target,
          generatedAt: new Date().toISOString(),
          packedAssessment: inspection.packing,
          inspection: { ...inspection, strings: undefined },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    cache.summaryOutput = relative(workspaceRoot, summaryPath);
  }

  if (layers.strings && !cache.strings) {
    allRequestedWereCached = false;
    const stringsDir = path.join(staticDir, "strings");
    await fs.rm(stringsDir, { recursive: true, force: true });
    cache.strings = await dumpStrings(
      bytes,
      stringsDir,
      "full-strings",
      workspaceRoot,
      options.signal
    );
  }

  if (layers.entropy && !cache.entropy) {
    allRequestedWereCached = false;
    // Remove only old entropy chunks; other completed layers stay intact.
    const existing = await fs.readdir(staticDir).catch(() => [] as string[]);
    await Promise.all(
      existing
        .filter((name) => /^entropy-map-\d+\.tsv$/.test(name))
        .map((name) => fs.rm(path.join(staticDir, name), { force: true }))
    );
    cache.entropy = await writeEntropyMap(
      bytes,
      inspection,
      staticDir,
      workspaceRoot,
      options.signal
    );
  }

  if (layers.carve && !cache.carved) {
    allRequestedWereCached = false;
    await fs.rm(path.join(staticDir, "carved"), {
      recursive: true,
      force: true,
    });
    cache.carved = await carveBlobs(
      bytes,
      inspection,
      staticDir,
      workspaceRoot,
      options.signal
    );
  }

  await fs.writeFile(markerPath, JSON.stringify(cache, null, 2) + "\n", "utf8");

  const strings = layers.strings ? cache.strings ?? emptyStrings() : emptyStrings();
  const entropy = layers.entropy ? cache.entropy ?? emptyEntropy() : emptyEntropy();
  const carved = layers.carve ? cache.carved ?? [] : [];
  const outputs: string[] = [];
  if (layers.summary && cache.summaryOutput) outputs.push(cache.summaryOutput);
  if (layers.strings) outputs.push(...strings.outputs);
  if (layers.entropy) outputs.push(...entropy.outputs);
  if (layers.carve) {
    outputs.push(
      relative(workspaceRoot, path.join(staticDir, "carved", "index.json"))
    );
    for (const blob of carved) outputs.push(blob.path, ...blob.strings);
  }

  const requested = (Object.keys(layers) as (keyof StaticArtifactLayers)[])
    .filter((layer) => layers[layer]);
  const details: string[] = [];
  if (layers.summary) details.push("PE summary");
  if (layers.strings) details.push(`${strings.count.toLocaleString()} strings`);
  if (layers.entropy) details.push(`${entropy.windows.toLocaleString()} entropy windows`);
  if (layers.carve) details.push(`${carved.length} carved blobs`);

  return {
    root: rootRelative,
    outputs: [...new Set(outputs)],
    strings,
    entropy,
    carved,
    layers,
    cached: requested.length > 0 && allRequestedWereCached,
    summary:
      requested.length > 0
        ? `${allRequestedWereCached ? "Reused" : "Prepared"} ${details.join(", ")}.`
        : "No exhaustive static artifact layer was requested.",
  };
}

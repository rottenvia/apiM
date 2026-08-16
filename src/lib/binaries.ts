/**
 * Static executable inspection.
 *
 * An executable is not text, but it is not opaque either. Windows PE files
 * have tables describing their architecture, sections, imported DLLs and
 * functions, exports, debug symbols, managed runtime metadata and signing
 * envelope. Reading those tables gives the model evidence instead of binary
 * mojibake, and it does not execute a single byte from the target.
 *
 * The parser is deliberately dependency-free. It runs on every installation;
 * optional ILSpy/Ghidra adapters add source-like decompilation when those
 * larger tools are present (see binary-decompiler.ts).
 */

import { createHash } from "node:crypto";
import path from "node:path";
import {
  listFiles,
  readFileBytes,
  WorkspaceError,
} from "@/lib/workspace";
import {
  runDeepDecompilation,
  type DeepDecompilationResult,
} from "@/lib/binary-decompiler";
import {
  isPeFilename,
  MAX_PE_UPLOAD_BYTES,
} from "@/lib/binary-types";

export const MAX_BINARY_ANALYSIS_BYTES = MAX_PE_UPLOAD_BYTES;
export const MAX_IMPORT_DLLS = 512;
export const MAX_IMPORTS_PER_DLL = 8_192;
export const MAX_EXPORTS = 20_000;
export const MAX_DEPENDENCY_FILES = 128;
export const MAX_DEPENDENCY_DEPTH = 8;
export const MAX_REPORTED_STRINGS = 300;

export class BinaryInspectionError extends Error {}

export interface PeSection {
  name: string;
  virtualAddress: number;
  virtualSize: number;
  rawOffset: number;
  rawSize: number;
  characteristics: number;
  readable: boolean;
  writable: boolean;
  executable: boolean;
  entropy: number;
}

export interface PeImport {
  dll: string;
  functions: string[];
  ordinals: number[];
  delayLoaded: boolean;
  truncated: boolean;
}

export interface PeExport {
  name: string | null;
  ordinal: number;
  rva: number;
  forwarder?: string;
}

export interface ManagedAssembly {
  name: string | null;
  version: string | null;
  runtimeVersion: string | null;
  flags: number;
  references: { name: string; version: string; flags: number }[];
}

export interface PeInspection {
  format: "PE32" | "PE32+" | "DOS/NE" | "DOS/LE" | "DOS/LX" | "DOS/MZ";
  architecture: string;
  machine: number;
  bytes: number;
  hashes: { sha256: string; sha1: string; md5: string; imphash?: string };
  timestamp: number;
  timestampIso: string | null;
  characteristics: number;
  isDll: boolean;
  subsystem: string;
  imageBase: string;
  entryPointRva: number;
  sizeOfImage: number;
  sections: PeSection[];
  imports: PeImport[];
  exports: PeExport[];
  managed: ManagedAssembly | null;
  authenticode: {
    present: boolean;
    size: number;
    revision?: number;
    certificateType?: number;
    /** Presence is structural only; trust verification is OS-specific. */
    verified: false;
  };
  pdbPaths: string[];
  versionInfo: Record<string, string>;
  strings: string[];
  possibleDynamicLibraries: string[];
  overlayBytes: number;
  mitigations: {
    aslr: boolean;
    highEntropyVa: boolean;
    dep: boolean;
    controlFlowGuard: boolean;
    forceIntegrity: boolean;
  };
  indicators: string[];
  truncated: {
    imports: boolean;
    exports: boolean;
    strings: boolean;
  };
}

export interface DependencyNode {
  name: string;
  requestedBy: string;
  kind: "local" | "system" | "external" | "managed" | "cycle" | "limit";
  path?: string;
  architecture?: string;
  imports?: number;
  children?: DependencyNode[];
  note?: string;
}

export interface WorkspaceBinaryInspection {
  path: string;
  inspection: PeInspection;
  dependencies: DependencyNode[];
  localFilesInspected: number;
  unresolvedLibraries: string[];
  deep: DeepDecompilationResult;
}

export interface InspectBinaryOptions {
  includeStrings?: boolean;
  stringFilter?: string;
  minStringLength?: number;
  maxStrings?: number;
  dependencies?: boolean;
  maxDepth?: number;
  deep?: boolean;
  forceDeep?: boolean;
  signal?: AbortSignal;
}

class Reader {
  readonly bytes: Uint8Array;
  readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  has(offset: number, size = 1): boolean {
    return Number.isInteger(offset) && offset >= 0 && size >= 0 && offset + size <= this.bytes.length;
  }

  u8(offset: number): number {
    if (!this.has(offset)) throw new BinaryInspectionError("Unexpected end of executable");
    return this.view.getUint8(offset);
  }

  u16(offset: number): number {
    if (!this.has(offset, 2)) throw new BinaryInspectionError("Unexpected end of executable");
    return this.view.getUint16(offset, true);
  }

  u32(offset: number): number {
    if (!this.has(offset, 4)) throw new BinaryInspectionError("Unexpected end of executable");
    return this.view.getUint32(offset, true);
  }

  u64(offset: number): bigint {
    if (!this.has(offset, 8)) throw new BinaryInspectionError("Unexpected end of executable");
    return this.view.getBigUint64(offset, true);
  }

  ascii(offset: number, max: number): string {
    if (!this.has(offset)) return "";
    const end = Math.min(this.bytes.length, offset + Math.max(0, max));
    let out = "";
    for (let i = offset; i < end; i++) {
      const b = this.bytes[i];
      if (b === 0) break;
      if (b < 0x20 || b > 0x7e) break;
      out += String.fromCharCode(b);
    }
    return out;
  }

  utf16(offset: number, maxChars: number): string {
    if (!this.has(offset, 2)) return "";
    let out = "";
    for (let i = 0; i < maxChars && this.has(offset + i * 2, 2); i++) {
      const code = this.u16(offset + i * 2);
      if (code === 0) break;
      // Reject control-heavy garbage while still allowing non-ASCII names.
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      out += String.fromCharCode(code);
    }
    return out;
  }
}

const MACHINE: Record<number, string> = {
  0x014c: "x86",
  0x0162: "MIPS R3000",
  0x0166: "MIPS R4000",
  0x01c0: "ARM",
  0x01c2: "Thumb",
  0x01c4: "ARMv7",
  0x0200: "Itanium",
  0x8664: "x86-64",
  0xaa64: "ARM64",
  0x5032: "RISC-V 32",
  0x5064: "RISC-V 64",
  0x5128: "RISC-V 128",
};

const SUBSYSTEM: Record<number, string> = {
  0: "unknown",
  1: "native",
  2: "Windows GUI",
  3: "Windows console",
  5: "OS/2 console",
  7: "POSIX console",
  9: "Windows CE GUI",
  10: "EFI application",
  11: "EFI boot-service driver",
  12: "EFI runtime driver",
  13: "EFI ROM",
  14: "Xbox",
  16: "Windows boot application",
};

const SYSTEM_DLLS = new Set([
  "advapi32.dll", "bcrypt.dll", "bcryptprimitives.dll", "cabinet.dll",
  "cfgmgr32.dll", "clbcatq.dll", "combase.dll", "comctl32.dll",
  "comdlg32.dll", "crypt32.dll", "cryptbase.dll", "cryptsp.dll",
  "d3d11.dll", "d3d12.dll", "dbghelp.dll", "dnsapi.dll", "dwmapi.dll",
  "dxgi.dll", "gdi32.dll", "gdi32full.dll", "imagehlp.dll", "imm32.dll",
  "iphlpapi.dll", "kernel32.dll", "kernelbase.dll", "mpr.dll", "mscoree.dll",
  "msimg32.dll", "msvcrt.dll", "netapi32.dll", "ncrypt.dll", "normaliz.dll",
  "ntdll.dll", "ole32.dll", "oleaut32.dll", "powrprof.dll", "profapi.dll",
  "propsys.dll", "psapi.dll", "rpcrt4.dll", "sechost.dll", "setupapi.dll",
  "shell32.dll", "shlwapi.dll", "sspicli.dll", "ucrtbase.dll", "urlmon.dll",
  "user32.dll", "userenv.dll", "usp10.dll", "version.dll", "winhttp.dll",
  "wininet.dll", "winmm.dll", "winnsi.dll", "winspool.drv", "wintrust.dll",
  "wldap32.dll", "ws2_32.dll", "wtsapi32.dll",
]);

function isSystemLibrary(name: string): boolean {
  const n = name.toLowerCase();
  return (
    SYSTEM_DLLS.has(n) ||
    n.startsWith("api-ms-win-") ||
    n.startsWith("ext-ms-win-") ||
    /^msvcp\d+(_\d+)?\.dll$/.test(n) ||
    /^vcruntime\d+(_\d+)?\.dll$/.test(n) ||
    /^concrt\d+\.dll$/.test(n)
  );
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

function hashBytes(bytes: Uint8Array): PeInspection["hashes"] {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha1: createHash("sha1").update(bytes).digest("hex"),
    md5: createHash("md5").update(bytes).digest("hex"),
  };
}

function entropy(bytes: Uint8Array, offset: number, size: number): number {
  if (size <= 0 || offset < 0 || offset >= bytes.length) return 0;
  const available = Math.min(size, bytes.length - offset);
  if (available <= 0) return 0;
  // Sampling keeps a 200MB resource section from monopolising the event loop.
  const sampleSize = Math.min(available, 1_048_576);
  const step = available / sampleSize;
  const counts = new Uint32Array(256);
  for (let i = 0; i < sampleSize; i++) counts[bytes[offset + Math.floor(i * step)]]++;
  let h = 0;
  for (const count of counts) {
    if (!count) continue;
    const p = count / sampleSize;
    h -= p * Math.log2(p);
  }
  return Number(h.toFixed(3));
}

function formatTimestamp(seconds: number): string | null {
  // Zero and impossible future/past values are common in reproducible or
  // intentionally scrubbed builds. Do not turn them into confident dates.
  if (!seconds) return null;
  const ms = seconds * 1000;
  const min = Date.UTC(1980, 0, 1);
  const max = Date.now() + 366 * 24 * 60 * 60 * 1000;
  return ms >= min && ms <= max ? new Date(ms).toISOString() : null;
}

function readSections(
  r: Reader,
  sectionTable: number,
  count: number
): PeSection[] {
  if (count > 512) throw new BinaryInspectionError(`Unreasonable PE section count: ${count}`);
  const sections: PeSection[] = [];
  for (let i = 0; i < count; i++) {
    const at = sectionTable + i * 40;
    if (!r.has(at, 40)) throw new BinaryInspectionError("Section table is truncated");
    const nameBytes = r.bytes.subarray(at, at + 8);
    const zero = nameBytes.indexOf(0);
    const name = new TextDecoder("ascii").decode(zero === -1 ? nameBytes : nameBytes.subarray(0, zero)) || `<section-${i + 1}>`;
    const characteristics = r.u32(at + 36);
    const rawOffset = r.u32(at + 20);
    const rawSize = r.u32(at + 16);
    sections.push({
      name,
      virtualSize: r.u32(at + 8),
      virtualAddress: r.u32(at + 12),
      rawSize,
      rawOffset,
      characteristics,
      executable: Boolean(characteristics & 0x20000000),
      readable: Boolean(characteristics & 0x40000000),
      writable: Boolean(characteristics & 0x80000000),
      entropy: entropy(r.bytes, rawOffset, rawSize),
    });
  }
  return sections;
}

function rvaToOffset(r: Reader, sections: PeSection[], sizeOfHeaders: number, rva: number): number | null {
  if (!rva) return null;
  if (rva < sizeOfHeaders && r.has(rva)) return rva;
  for (const section of sections) {
    const span = Math.max(section.virtualSize, section.rawSize);
    if (rva < section.virtualAddress || rva >= section.virtualAddress + span) continue;
    const offset = section.rawOffset + (rva - section.virtualAddress);
    return r.has(offset) ? offset : null;
  }
  return null;
}

interface DataDirectory { rva: number; size: number }

function readThunkTable(
  r: Reader,
  sections: PeSection[],
  sizeOfHeaders: number,
  thunkRva: number,
  pe64: boolean
): { functions: string[]; ordinals: number[]; truncated: boolean } {
  const at = rvaToOffset(r, sections, sizeOfHeaders, thunkRva);
  if (at === null) return { functions: [], ordinals: [], truncated: false };
  const width = pe64 ? 8 : 4;
  const ordinalFlag = pe64 ? BigInt("0x8000000000000000") : BigInt("0x80000000");
  const addressMask = pe64 ? BigInt("0x7fffffffffffffff") : BigInt("0x7fffffff");
  const functions: string[] = [];
  const ordinals: number[] = [];
  let truncated = false;

  for (let i = 0; i < MAX_IMPORTS_PER_DLL; i++) {
    const pos = at + i * width;
    if (!r.has(pos, width)) break;
    const value = pe64 ? r.u64(pos) : BigInt(r.u32(pos));
    if (value === BigInt(0)) break;
    if (value & ordinalFlag) {
      ordinals.push(Number(value & BigInt(0xffff)));
      continue;
    }
    const nameRva = Number(value & addressMask);
    const nameAt = rvaToOffset(r, sections, sizeOfHeaders, nameRva);
    if (nameAt === null || !r.has(nameAt + 2)) continue;
    const name = r.ascii(nameAt + 2, 2048);
    if (name) functions.push(name);
    if (i === MAX_IMPORTS_PER_DLL - 1) truncated = true;
  }
  return { functions, ordinals, truncated };
}

function readImports(
  r: Reader,
  sections: PeSection[],
  sizeOfHeaders: number,
  directory: DataDirectory,
  pe64: boolean,
  delayLoaded: boolean,
  imageBase: bigint
): { imports: PeImport[]; truncated: boolean } {
  const start = rvaToOffset(r, sections, sizeOfHeaders, directory.rva);
  if (start === null || !directory.size) return { imports: [], truncated: false };
  const stride = delayLoaded ? 32 : 20;
  const imports: PeImport[] = [];
  let truncated = false;

  for (let i = 0; i < MAX_IMPORT_DLLS; i++) {
    const at = start + i * stride;
    if (!r.has(at, stride)) break;
    const values = Array.from({ length: stride / 4 }, (_, x) => r.u32(at + x * 4));
    if (values.every((v) => v === 0)) break;

    let nameRva: number;
    let thunkRva: number;
    if (delayLoaded) {
      const attrs = values[0];
      nameRva = values[1];
      thunkRva = values[4];
      // Old delay descriptors store virtual addresses instead of RVAs.
      if (!(attrs & 1)) {
        const base = Number(imageBase <= BigInt(Number.MAX_SAFE_INTEGER) ? imageBase : BigInt(0));
        nameRva = Math.max(0, nameRva - base);
        thunkRva = Math.max(0, thunkRva - base);
      }
    } else {
      nameRva = values[3];
      thunkRva = values[0] || values[4];
    }

    const nameAt = rvaToOffset(r, sections, sizeOfHeaders, nameRva);
    const dll = nameAt === null ? "" : r.ascii(nameAt, 1024);
    if (!dll) continue;
    const thunks = readThunkTable(r, sections, sizeOfHeaders, thunkRva, pe64);
    imports.push({ dll, ...thunks, delayLoaded });
    if (i === MAX_IMPORT_DLLS - 1) truncated = true;
  }

  return { imports, truncated };
}

function mergeImports(imports: PeImport[]): PeImport[] {
  const out = new Map<string, PeImport>();
  for (const item of imports) {
    const key = `${item.delayLoaded ? "delay:" : "normal:"}${item.dll.toLowerCase()}`;
    const old = out.get(key);
    if (!old) {
      out.set(key, {
        ...item,
        functions: [...new Set(item.functions)],
        ordinals: [...new Set(item.ordinals)],
      });
      continue;
    }
    old.functions = [...new Set([...old.functions, ...item.functions])];
    old.ordinals = [...new Set([...old.ordinals, ...item.ordinals])];
    old.truncated ||= item.truncated;
  }
  return [...out.values()].sort((a, b) => a.dll.localeCompare(b.dll));
}

function readExports(
  r: Reader,
  sections: PeSection[],
  sizeOfHeaders: number,
  directory: DataDirectory
): { exports: PeExport[]; truncated: boolean } {
  const at = rvaToOffset(r, sections, sizeOfHeaders, directory.rva);
  if (at === null || !r.has(at, 40)) return { exports: [], truncated: false };
  const ordinalBase = r.u32(at + 16);
  const functionCount = r.u32(at + 20);
  const nameCount = r.u32(at + 24);
  const functionsAt = rvaToOffset(r, sections, sizeOfHeaders, r.u32(at + 28));
  const namesAt = rvaToOffset(r, sections, sizeOfHeaders, r.u32(at + 32));
  const ordinalsAt = rvaToOffset(r, sections, sizeOfHeaders, r.u32(at + 36));
  if (functionsAt === null) return { exports: [], truncated: false };

  const names = new Map<number, string>();
  const maxNames = Math.min(nameCount, MAX_EXPORTS);
  if (namesAt !== null && ordinalsAt !== null) {
    for (let i = 0; i < maxNames; i++) {
      if (!r.has(namesAt + i * 4, 4) || !r.has(ordinalsAt + i * 2, 2)) break;
      const nameAt = rvaToOffset(r, sections, sizeOfHeaders, r.u32(namesAt + i * 4));
      if (nameAt === null) continue;
      const name = r.ascii(nameAt, 4096);
      if (name) names.set(r.u16(ordinalsAt + i * 2), name);
    }
  }

  const count = Math.min(functionCount, MAX_EXPORTS);
  const exports: PeExport[] = [];
  for (let index = 0; index < count; index++) {
    if (!r.has(functionsAt + index * 4, 4)) break;
    const functionRva = r.u32(functionsAt + index * 4);
    if (!functionRva) continue;
    const entry: PeExport = {
      name: names.get(index) ?? null,
      ordinal: ordinalBase + index,
      rva: functionRva,
    };
    if (functionRva >= directory.rva && functionRva < directory.rva + directory.size) {
      const forwardAt = rvaToOffset(r, sections, sizeOfHeaders, functionRva);
      if (forwardAt !== null) entry.forwarder = r.ascii(forwardAt, 2048) || undefined;
    }
    exports.push(entry);
  }
  return { exports, truncated: functionCount > count || nameCount > maxNames };
}

function readPdbPaths(
  r: Reader,
  sections: PeSection[],
  sizeOfHeaders: number,
  directory: DataDirectory
): string[] {
  const start = rvaToOffset(r, sections, sizeOfHeaders, directory.rva);
  if (start === null || directory.size < 28) return [];
  const paths: string[] = [];
  const count = Math.min(Math.floor(directory.size / 28), 256);
  for (let i = 0; i < count; i++) {
    const at = start + i * 28;
    if (!r.has(at, 28) || r.u32(at + 12) !== 2) continue; // IMAGE_DEBUG_TYPE_CODEVIEW
    const size = r.u32(at + 16);
    const raw = r.u32(at + 24) || rvaToOffset(r, sections, sizeOfHeaders, r.u32(at + 20)) || 0;
    if (!r.has(raw, Math.min(size, 24)) || size < 24) continue;
    const sig = String.fromCharCode(...r.bytes.subarray(raw, raw + 4));
    const pathOffset = sig === "RSDS" ? raw + 24 : sig === "NB10" ? raw + 16 : 0;
    if (!pathOffset) continue;
    const found = r.ascii(pathOffset, Math.min(32_768, size));
    if (found) paths.push(found);
  }
  return [...new Set(paths)];
}

function findBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (!needle.length) return -1;
  // Buffer.indexOf is implemented in native code. The previous nested
  // JavaScript loop scanned a 200MB executable once per version key, turning
  // eight harmless metadata lookups into billions of byte comparisons on the
  // server event loop.
  const source = Buffer.from(
    haystack.buffer,
    haystack.byteOffset,
    haystack.byteLength
  );
  return source.indexOf(Buffer.from(needle), Math.max(0, from));
}

function utf16Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = c >>> 8;
  }
  return out;
}

function readVersionInfo(r: Reader): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = [
    "CompanyName", "FileDescription", "FileVersion", "InternalName",
    "LegalCopyright", "OriginalFilename", "ProductName", "ProductVersion",
  ];
  for (const key of keys) {
    const needle = utf16Bytes(key + "\0");
    let at = findBytes(r.bytes, needle);
    while (at !== -1) {
      const block = at - 6;
      if (block >= 0 && r.has(block, 6)) {
        const total = r.u16(block);
        const valueChars = r.u16(block + 2);
        const type = r.u16(block + 4);
        let valueAt = at + needle.length;
        valueAt = (valueAt + 3) & ~3;
        if (type === 1 && valueChars > 0 && valueChars < 4096 && valueAt < block + total) {
          const value = r.utf16(valueAt, valueChars).trim();
          if (value) {
            out[key] = value;
            break;
          }
        }
      }
      at = findBytes(r.bytes, needle, at + 2);
    }
  }
  return out;
}

function indexSize(rows: number[]): (table: number) => number {
  return (table) => (rows[table] >= 0x10000 ? 4 : 2);
}

function codedSize(rows: number[], tables: number[], tagBits: number): number {
  const max = Math.max(0, ...tables.map((t) => rows[t] ?? 0));
  return max < 1 << (16 - tagBits) ? 2 : 4;
}

/** Row sizes for ECMA-335 metadata tables 0..44. */
function metadataRowSize(
  table: number,
  rows: number[],
  str: number,
  guid: number,
  blob: number
): number {
  const ix = indexSize(rows);
  const coded = (tables: number[], bits: number) => codedSize(rows, tables, bits);
  const typeDefOrRef = coded([2, 1, 27], 2);
  const methodDefOrRef = coded([6, 10], 1);
  switch (table) {
    case 0: return 2 + str + guid * 3;
    case 1: return coded([0, 26, 35, 1], 2) + str * 2;
    case 2: return 4 + str * 2 + typeDefOrRef + ix(4) + ix(6);
    case 3: return ix(4);
    case 4: return 2 + str + blob;
    case 5: return ix(6);
    case 6: return 8 + str + blob + ix(8);
    case 7: return ix(8);
    case 8: return 4 + str;
    case 9: return ix(2) + typeDefOrRef;
    case 10: return coded([2, 1, 26, 6, 27], 3) + str + blob;
    case 11: return 2 + coded([4, 8, 23], 2) + blob;
    case 12: return coded([6, 4, 1, 2, 8, 9, 10, 0, 14, 23, 20, 17, 26, 27, 32, 35, 38, 39, 40, 42, 44], 5) + coded([6, 10], 3) + blob;
    case 13: return coded([4, 8], 1) + blob;
    case 14: return 2 + coded([2, 6, 32], 2) + blob;
    case 15: return 6 + ix(2);
    case 16: return 4 + ix(4);
    case 17: return blob;
    case 18: return ix(2) + ix(20);
    case 19: return ix(20);
    case 20: return 2 + str + typeDefOrRef;
    case 21: return ix(2) + ix(23);
    case 22: return ix(23);
    case 23: return 2 + str + blob;
    case 24: return 2 + ix(6) + coded([20, 23], 1);
    case 25: return ix(2) + methodDefOrRef * 2;
    case 26: return str;
    case 27: return blob;
    case 28: return 2 + coded([4, 6], 1) + str + ix(26);
    case 29: return 4 + ix(4);
    case 30: return 8;
    case 31: return 4;
    case 32: return 16 + blob + str * 2;
    case 33: return 4;
    case 34: return 12;
    case 35: return 12 + blob * 2 + str * 2;
    case 36: return 4 + ix(35);
    case 37: return 12 + ix(35);
    case 38: return 4 + str + blob;
    case 39: return 8 + str * 2 + coded([38, 35, 39], 2);
    case 40: return 8 + str + coded([38, 35, 39], 2);
    case 41: return ix(2) * 2;
    case 42: return 4 + coded([2, 6], 1) + str;
    case 43: return methodDefOrRef + blob;
    case 44: return ix(42) + typeDefOrRef;
    default: return 0;
  }
}

function heapIndex(r: Reader, at: number, size: number): number {
  return size === 4 ? r.u32(at) : r.u16(at);
}

function readManagedMetadata(
  r: Reader,
  sections: PeSection[],
  sizeOfHeaders: number,
  clr: DataDirectory
): ManagedAssembly | null {
  const clrAt = rvaToOffset(r, sections, sizeOfHeaders, clr.rva);
  if (clrAt === null || !r.has(clrAt, 24)) return null;
  const metadataAt = rvaToOffset(r, sections, sizeOfHeaders, r.u32(clrAt + 8));
  if (metadataAt === null || !r.has(metadataAt, 20) || r.u32(metadataAt) !== 0x424a5342) {
    return { name: null, version: null, runtimeVersion: null, flags: r.u32(clrAt + 16), references: [] };
  }

  const versionLen = r.u32(metadataAt + 12);
  const runtimeVersion = r.has(metadataAt + 16, versionLen)
    ? new TextDecoder("utf-8").decode(r.bytes.subarray(metadataAt + 16, metadataAt + 16 + versionLen)).replace(/\0.*$/, "").trim()
    : null;
  let at = (metadataAt + 16 + versionLen + 3) & ~3;
  if (!r.has(at, 4)) return { name: null, version: null, runtimeVersion, flags: r.u32(clrAt + 16), references: [] };
  const streams = r.u16(at + 2);
  at += 4;
  const streamMap = new Map<string, { offset: number; size: number }>();
  for (let i = 0; i < streams; i++) {
    if (!r.has(at, 8)) break;
    const offset = r.u32(at);
    const size = r.u32(at + 4);
    const name = r.ascii(at + 8, 32);
    const nameBytes = Math.min(32, name.length + 1);
    at = (at + 8 + nameBytes + 3) & ~3;
    streamMap.set(name, { offset: metadataAt + offset, size });
  }

  const table = streamMap.get("#~") ?? streamMap.get("#-");
  const strings = streamMap.get("#Strings");
  if (!table || !strings || !r.has(table.offset, 24)) {
    return { name: null, version: null, runtimeVersion, flags: r.u32(clrAt + 16), references: [] };
  }
  const heapSizes = r.u8(table.offset + 6);
  const strSize = heapSizes & 1 ? 4 : 2;
  const guidSize = heapSizes & 2 ? 4 : 2;
  const blobSize = heapSizes & 4 ? 4 : 2;
  const valid = r.u64(table.offset + 8);
  const rows = new Array<number>(64).fill(0);
  let rowAt = table.offset + 24;
  for (let i = 0; i < 64; i++) {
    if (!(valid & (BigInt(1) << BigInt(i)))) continue;
    if (!r.has(rowAt, 4)) break;
    rows[i] = r.u32(rowAt);
    rowAt += 4;
  }

  const offsets = new Array<number>(64).fill(-1);
  let dataAt = rowAt;
  for (let i = 0; i < 64; i++) {
    if (!(valid & (BigInt(1) << BigInt(i)))) continue;
    offsets[i] = dataAt;
    const size = metadataRowSize(i, rows, strSize, guidSize, blobSize);
    if (!size) return { name: null, version: null, runtimeVersion, flags: r.u32(clrAt + 16), references: [] };
    dataAt += size * rows[i];
  }

  const getString = (index: number) =>
    index > 0 && index < strings.size ? r.ascii(strings.offset + index, Math.min(16_384, strings.size - index)) : "";

  let assemblyName: string | null = null;
  let assemblyVersion: string | null = null;
  if (rows[32] && offsets[32] >= 0) {
    const p = offsets[32];
    assemblyVersion = `${r.u16(p + 4)}.${r.u16(p + 6)}.${r.u16(p + 8)}.${r.u16(p + 10)}`;
    const nameIndexAt = p + 16 + blobSize;
    assemblyName = getString(heapIndex(r, nameIndexAt, strSize)) || null;
  }

  const references: ManagedAssembly["references"] = [];
  if (rows[35] && offsets[35] >= 0) {
    const size = metadataRowSize(35, rows, strSize, guidSize, blobSize);
    for (let i = 0; i < Math.min(rows[35], 20_000); i++) {
      const p = offsets[35] + i * size;
      if (!r.has(p, size)) break;
      const version = `${r.u16(p)}.${r.u16(p + 2)}.${r.u16(p + 4)}.${r.u16(p + 6)}`;
      const flags = r.u32(p + 8);
      const nameAt = p + 12 + blobSize;
      const name = getString(heapIndex(r, nameAt, strSize));
      if (name) references.push({ name, version, flags });
    }
  }

  return {
    name: assemblyName,
    version: assemblyVersion,
    runtimeVersion,
    flags: r.u32(clrAt + 16),
    references,
  };
}

function stringScore(value: string): number {
  let score = Math.min(value.length, 160);
  if (/https?:\/\//i.test(value)) score += 220;
  if (/([a-z]:\\|\/)[\w .\\/-]+/i.test(value)) score += 100;
  if (/\.(dll|exe|sys|pdb|json|config|xml|ini|db|sqlite)\b/i.test(value)) score += 80;
  if (/error|failed|exception|warning|password|token|secret|debug/i.test(value)) score += 70;
  if (/^[A-Za-z_?$@][\w?$@.:<>~-]{5,}$/.test(value)) score += 25;
  return score;
}

function extractStrings(
  r: Reader,
  options: InspectBinaryOptions
): { strings: string[]; truncated: boolean } {
  if (options.includeStrings === false) return { strings: [], truncated: false };
  const min = clampNumber(options.minStringLength, 6, 4, 64);
  const max = clampNumber(options.maxStrings, 160, 1, MAX_REPORTED_STRINGS);
  const filter = options.stringFilter?.trim().toLowerCase() ?? "";
  const found = new Map<string, number>();
  const MAX_CANDIDATES = 20_000;
  let candidateFloor = 0;
  const consider = (value: string) => {
    const clean = value.replace(/\s+/g, " ").trim();
    if (clean.length < min || clean.length > 4096) return;
    if (filter && !clean.toLowerCase().includes(filter)) return;
    const old = found.get(clean);
    const score = stringScore(clean);
    if (old !== undefined) {
      if (score > old) found.set(clean, score);
      return;
    }
    if (!filter && found.size >= MAX_CANDIDATES) {
      if (score <= candidateFloor) return;
      for (const [candidate, valueScore] of found) {
        if (valueScore === candidateFloor) {
          found.delete(candidate);
          break;
        }
      }
    }
    found.set(clean, score);
    if (!filter && found.size >= MAX_CANDIDATES) {
      candidateFloor = Infinity;
      for (const valueScore of found.values()) {
        if (valueScore < candidateFloor) candidateFloor = valueScore;
      }
    }
  };

  let ascii = "";
  for (let i = 0; i < r.bytes.length; i++) {
    const b = r.bytes[i];
    if (b >= 0x20 && b <= 0x7e) {
      ascii += String.fromCharCode(b);
      // A huge printable overlay must not build one giant JS string. Long
      // runs are split into useful bounded excerpts instead.
      if (ascii.length === 4096) {
        consider(ascii);
        ascii = "";
      }
    } else {
      if (ascii.length >= min) consider(ascii);
      ascii = "";
    }
  }
  if (ascii.length >= min) consider(ascii);

  /*
   * Scan both UTF-16 alignments independently.
   *
   * Advancing byte-by-byte and jumping past a found run loses real strings:
   * one byte before "h\0t\0t\0p\0" decodes as plausible CJK code points, so
   * the misaligned run consumes the correctly aligned URL before it is ever
   * considered. Even and odd offsets are separate streams; neither may hide
   * the other. This also handles resource strings stored at odd file offsets.
   */
  for (const parity of [0, 1]) {
    for (let i = parity; i + 1 < r.bytes.length; ) {
      let value = "";
      let j = i;
      while (j + 1 < r.bytes.length && value.length < 4096) {
        const code = r.bytes[j] | (r.bytes[j + 1] << 8);
        if (code >= 0x20 && code !== 0x7f && code <= 0xfffd) {
          value += String.fromCharCode(code);
          j += 2;
        } else break;
      }
      if (value.length >= min) {
        consider(value);
        i = Math.max(j, i + 2);
      } else i += 2;
    }
  }

  const ranked = [...found.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value]) => value);
  return { strings: ranked.slice(0, max), truncated: ranked.length > max };
}

function dynamicLibraries(strings: string[], imported: PeImport[]): string[] {
  const statically = new Set(imported.map((x) => x.dll.toLowerCase()));
  const out = new Set<string>();
  for (const value of strings) {
    for (const match of value.matchAll(/(?:^|[^A-Za-z0-9_.-])([A-Za-z0-9_.+-]{1,120}\.(?:dll|ocx|drv))\b/gi)) {
      const name = match[1];
      if (!statically.has(name.toLowerCase())) out.add(name);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

function imphash(imports: PeImport[]): string | undefined {
  const parts: string[] = [];
  for (const item of imports.filter((x) => !x.delayLoaded)) {
    const dll = item.dll.toLowerCase().replace(/\.(dll|sys|ocx)$/i, "");
    for (const fn of item.functions) parts.push(`${dll}.${fn.toLowerCase()}`);
    for (const ordinal of item.ordinals) parts.push(`${dll}.ord${ordinal}`);
  }
  return parts.length ? createHash("md5").update(parts.join(",")).digest("hex") : undefined;
}

/** Parse one PE file from bytes. Never executes it. */
export function inspectPortableExecutable(
  input: Uint8Array,
  options: InspectBinaryOptions = {}
): PeInspection {
  if (input.byteLength > MAX_BINARY_ANALYSIS_BYTES) {
    throw new BinaryInspectionError(
      `Executable is ${(input.byteLength / 1024 / 1024).toFixed(1)}MB; static analysis is capped at ${MAX_BINARY_ANALYSIS_BYTES / 1024 / 1024}MB.`
    );
  }
  const bytes = input.byteOffset === 0 && input.byteLength === input.buffer.byteLength
    ? input
    : new Uint8Array(input);
  const r = new Reader(bytes);
  if (!r.has(0, 64) || r.u16(0) !== 0x5a4d) {
    throw new BinaryInspectionError("Not a Windows executable: missing MZ header");
  }
  const hashes = hashBytes(bytes);
  const peAt = r.u32(0x3c);
  if (!r.has(peAt, 4)) throw new BinaryInspectionError("MZ header points outside the file");
  const signature = String.fromCharCode(...r.bytes.subarray(peAt, peAt + 2));
  if (!r.has(peAt, 24) || r.u32(peAt) !== 0x00004550) {
    const legacy = signature === "NE" ? "DOS/NE" : signature === "LE" ? "DOS/LE" : signature === "LX" ? "DOS/LX" : "DOS/MZ";
    const stringResult = extractStrings(r, options);
    return {
      format: legacy,
      architecture: "legacy DOS/Windows",
      machine: 0,
      bytes: bytes.length,
      hashes,
      timestamp: 0,
      timestampIso: null,
      characteristics: 0,
      isDll: false,
      subsystem: "legacy",
      imageBase: "0x0",
      entryPointRva: 0,
      sizeOfImage: 0,
      sections: [], imports: [], exports: [], managed: null,
      authenticode: { present: false, size: 0, verified: false },
      pdbPaths: [], versionInfo: {}, strings: stringResult.strings,
      possibleDynamicLibraries: dynamicLibraries(stringResult.strings, []),
      overlayBytes: 0,
      mitigations: { aslr: false, highEntropyVa: false, dep: false, controlFlowGuard: false, forceIntegrity: false },
      indicators: ["Legacy MZ executable: modern PE import/decompile metadata is unavailable."],
      truncated: { imports: false, exports: false, strings: stringResult.truncated },
    };
  }

  const coff = peAt + 4;
  const machine = r.u16(coff);
  const sectionCount = r.u16(coff + 2);
  const timestamp = r.u32(coff + 4);
  const optionalSize = r.u16(coff + 16);
  const characteristics = r.u16(coff + 18);
  const optional = coff + 20;
  if (!r.has(optional, optionalSize) || optionalSize < 96) {
    throw new BinaryInspectionError("PE optional header is truncated");
  }
  const magic = r.u16(optional);
  const pe64 = magic === 0x20b;
  if (!pe64 && magic !== 0x10b) {
    throw new BinaryInspectionError(`Unsupported PE optional-header magic 0x${magic.toString(16)}`);
  }
  const dataStart = optional + (pe64 ? 112 : 96);
  const directoryCountAt = optional + (pe64 ? 108 : 92);
  const directoryCount = Math.min(r.u32(directoryCountAt), 16);
  const directories: DataDirectory[] = Array.from({ length: 16 }, (_, i) =>
    i < directoryCount && r.has(dataStart + i * 8, 8)
      ? { rva: r.u32(dataStart + i * 8), size: r.u32(dataStart + i * 8 + 4) }
      : { rva: 0, size: 0 }
  );

  const sizeOfHeaders = r.u32(optional + 60);
  const sections = readSections(r, optional + optionalSize, sectionCount);
  const imageBase = pe64 ? r.u64(optional + 24) : BigInt(r.u32(optional + 28));
  const normal = readImports(r, sections, sizeOfHeaders, directories[1], pe64, false, imageBase);
  const delayed = readImports(r, sections, sizeOfHeaders, directories[13], pe64, true, imageBase);
  const imports = mergeImports([...normal.imports, ...delayed.imports]);
  const exported = readExports(r, sections, sizeOfHeaders, directories[0]);
  const stringResult = extractStrings(r, options);
  const managed = directories[14].rva ? readManagedMetadata(r, sections, sizeOfHeaders, directories[14]) : null;

  const security = directories[4]; // Unlike every other directory, rva is a file offset.
  let revision: number | undefined;
  let certificateType: number | undefined;
  if (security.rva && security.size >= 8 && r.has(security.rva, 8)) {
    revision = r.u16(security.rva + 4);
    certificateType = r.u16(security.rva + 6);
  }

  const dllCharacteristics = r.u16(optional + 70);
  const entryPointRva = r.u32(optional + 16);
  const indicators: string[] = [];
  for (const section of sections) {
    if (section.executable && section.writable) indicators.push(`${section.name} is writable and executable (RWX).`);
    if (section.entropy >= 7.2 && section.rawSize >= 4096) indicators.push(`${section.name} has high entropy (${section.entropy}); it may be compressed, encrypted, or simply contain dense assets.`);
  }
  const entrySection = sections.find(
    (s) => entryPointRva >= s.virtualAddress && entryPointRva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize)
  );
  if (entryPointRva && !entrySection) indicators.push("Entry point does not fall inside a declared section.");
  else if (entrySection && !entrySection.executable) indicators.push(`Entry point is inside non-executable section ${entrySection.name}.`);
  if (timestamp && !formatTimestamp(timestamp)) indicators.push(`COFF timestamp ${timestamp} is outside a plausible build-date range.`);
  if (!imports.length) indicators.push("No static imports were found; the file may be packed, very small, or resolve APIs dynamically.");
  if (security.rva && !r.has(security.rva, Math.min(security.size, 8))) indicators.push("Authenticode directory points outside the file.");

  const maxSectionEnd = sections.reduce(
    (max, section) => Math.max(max, section.rawOffset + section.rawSize),
    sizeOfHeaders
  );
  // A certificate is an overlay by PE design, so count it as explained rather
  // than describing every signed program as carrying unknown appended data.
  const explainedEnd = security.rva && security.size
    ? Math.max(maxSectionEnd, security.rva + security.size)
    : maxSectionEnd;
  const overlayBytes = Math.max(0, bytes.length - Math.min(bytes.length, explainedEnd));
  if (overlayBytes > 1024) indicators.push(`${overlayBytes} byte(s) follow the mapped image/certificate (overlay or appended payload).`);

  hashes.imphash = imphash(imports);
  return {
    format: pe64 ? "PE32+" : "PE32",
    architecture: MACHINE[machine] ?? `unknown machine 0x${machine.toString(16)}`,
    machine,
    bytes: bytes.length,
    hashes,
    timestamp,
    timestampIso: formatTimestamp(timestamp),
    characteristics,
    isDll: Boolean(characteristics & 0x2000),
    subsystem: SUBSYSTEM[r.u16(optional + 68)] ?? `subsystem ${r.u16(optional + 68)}`,
    imageBase: `0x${imageBase.toString(16)}`,
    entryPointRva,
    sizeOfImage: r.u32(optional + 56),
    sections,
    imports,
    exports: exported.exports,
    managed,
    authenticode: {
      present: Boolean(security.rva && security.size >= 8),
      size: security.size,
      revision,
      certificateType,
      verified: false,
    },
    pdbPaths: readPdbPaths(r, sections, sizeOfHeaders, directories[6]),
    versionInfo: readVersionInfo(r),
    strings: stringResult.strings,
    possibleDynamicLibraries: dynamicLibraries(stringResult.strings, imports),
    overlayBytes,
    mitigations: {
      highEntropyVa: Boolean(dllCharacteristics & 0x0020),
      aslr: Boolean(dllCharacteristics & 0x0040),
      forceIntegrity: Boolean(dllCharacteristics & 0x0080),
      dep: Boolean(dllCharacteristics & 0x0100),
      controlFlowGuard: Boolean(dllCharacteristics & 0x4000),
    },
    indicators,
    truncated: {
      imports: normal.truncated || delayed.truncated || imports.some((x) => x.truncated),
      exports: exported.truncated,
      strings: stringResult.truncated,
    },
  };
}

function basename(value: string): string {
  return value.replace(/\\/g, "/").split("/").pop() ?? value;
}

function dirname(value: string): string {
  const normal = value.replace(/\\/g, "/");
  const at = normal.lastIndexOf("/");
  return at === -1 ? "" : normal.slice(0, at);
}

function joinRelative(dir: string, name: string): string {
  return dir ? path.posix.join(dir, name) : name;
}

interface DependencyContext {
  workspaceId: string;
  filesByBase: Map<string, string[]>;
  maxDepth: number;
  inspected: Map<string, PeInspection>;
  visiting: Set<string>;
  unresolved: Set<string>;
  count: number;
  signal?: AbortSignal;
}

function resolveLocalLibrary(
  requested: string,
  parentPath: string,
  filesByBase: Map<string, string[]>
): string | null {
  const candidates = filesByBase.get(basename(requested).toLowerCase()) ?? [];
  if (!candidates.length) return null;
  const wantedSame = joinRelative(dirname(parentPath), basename(requested)).toLowerCase();
  const same = candidates.find((x) => x.toLowerCase() === wantedSame);
  if (same) return same;
  return [...candidates].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

async function dependencyChildren(
  sourcePath: string,
  inspection: PeInspection,
  depth: number,
  ctx: DependencyContext
): Promise<DependencyNode[]> {
  const nodes: DependencyNode[] = [];
  const requests = [
    ...inspection.imports.map((x) => ({ name: x.dll, managed: false })),
    ...(inspection.managed?.references.map((x) => ({ name: `${x.name}.dll`, managed: true })) ?? []),
  ];
  const seen = new Set<string>();

  for (const request of requests) {
    if (ctx.signal?.aborted) {
      throw new DOMException("Executable inspection stopped", "AbortError");
    }
    const key = `${request.managed ? "managed:" : "native:"}${request.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const local = resolveLocalLibrary(request.name, sourcePath, ctx.filesByBase);
    if (!local) {
      const kind = request.managed ? "managed" : isSystemLibrary(request.name) ? "system" : "external";
      if (kind === "external" || kind === "managed") ctx.unresolved.add(request.name);
      nodes.push({
        name: request.name,
        requestedBy: sourcePath,
        kind,
        note:
          kind === "system"
            ? "Windows/system runtime; API names are listed in the import table."
            : request.managed
              ? "Managed assembly reference; no matching DLL was supplied in this workspace."
              : "Not present in this workspace. It may be installed beside the app or loaded from Windows/PATH at runtime.",
      });
      continue;
    }

    const localKey = local.toLowerCase();
    if (ctx.visiting.has(localKey)) {
      nodes.push({ name: request.name, requestedBy: sourcePath, kind: "cycle", path: local, note: "Dependency cycle; already on this branch." });
      continue;
    }
    if (depth >= ctx.maxDepth || ctx.count >= MAX_DEPENDENCY_FILES) {
      nodes.push({ name: request.name, requestedBy: sourcePath, kind: "limit", path: local, note: depth >= ctx.maxDepth ? `Depth limit ${ctx.maxDepth} reached.` : `File limit ${MAX_DEPENDENCY_FILES} reached.` });
      continue;
    }

    let child = ctx.inspected.get(localKey);
    if (!child) {
      try {
        const bytes = await readFileBytes(ctx.workspaceId, local);
        child = inspectPortableExecutable(bytes, { includeStrings: false });
        ctx.inspected.set(localKey, child);
        ctx.count++;
      } catch (error) {
        nodes.push({
          name: request.name,
          requestedBy: sourcePath,
          kind: "local",
          path: local,
          note: `Found locally but could not parse: ${error instanceof Error ? error.message : "unknown error"}`,
        });
        continue;
      }
    }

    ctx.visiting.add(localKey);
    const children = await dependencyChildren(local, child, depth + 1, ctx);
    ctx.visiting.delete(localKey);
    nodes.push({
      name: request.name,
      requestedBy: sourcePath,
      kind: "local",
      path: local,
      architecture: child.architecture,
      imports: child.imports.reduce((n, x) => n + x.functions.length + x.ordinals.length, 0),
      children,
      note:
        child.architecture !== inspection.architecture
          ? `Architecture differs from parent (${inspection.architecture}).`
          : undefined,
    });
  }
  return nodes;
}

/** Inspect a workspace executable plus DLLs that were supplied beside it. */
export async function inspectWorkspaceBinary(
  workspaceId: string,
  target: string,
  options: InspectBinaryOptions = {}
): Promise<WorkspaceBinaryInspection> {
  const bytes = await readFileBytes(workspaceId, target);
  const inspection = inspectPortableExecutable(bytes, options);
  const dependenciesEnabled = options.dependencies !== false;
  let dependencies: DependencyNode[] = [];
  const unresolved = new Set<string>();
  const inspected = new Map<string, PeInspection>([[target.toLowerCase(), inspection]]);
  let localFilesInspected = 1;

  if (dependenciesEnabled && inspection.format.startsWith("PE")) {
    const files = await listFiles(workspaceId);
    const filesByBase = new Map<string, string[]>();
    for (const file of files) {
      const base = basename(file.path).toLowerCase();
      const list = filesByBase.get(base);
      if (list) list.push(file.path);
      else filesByBase.set(base, [file.path]);
    }
    const ctx: DependencyContext = {
      workspaceId,
      filesByBase,
      maxDepth: clampNumber(options.maxDepth, 4, 0, MAX_DEPENDENCY_DEPTH),
      inspected,
      visiting: new Set([target.toLowerCase()]),
      unresolved,
      count: 1,
      signal: options.signal,
    };
    dependencies = await dependencyChildren(target, inspection, 0, ctx);
    localFilesInspected = ctx.count;
  }

  const deep = options.deep === false
    ? { attempted: false, status: "disabled", engine: "none", outputs: [], cached: false, summary: "Deep decompilation was disabled." } satisfies DeepDecompilationResult
      : await runDeepDecompilation(workspaceId, target, inspection, {
        force: options.forceDeep === true,
        signal: options.signal,
      });

  return {
    path: target,
    inspection,
    dependencies,
    localFilesInspected,
    unresolvedLibraries: [...unresolved].sort((a, b) => a.localeCompare(b)),
    deep,
  };
}

function hex(value: number, width = 8): string {
  return `0x${value.toString(16).padStart(width, "0")}`;
}

function dependencyLines(nodes: DependencyNode[], prefix = ""): string[] {
  const lines: string[] = [];
  nodes.forEach((node, index) => {
    const last = index === nodes.length - 1;
    const branch = last ? "└─" : "├─";
    const detail = node.path
      ? ` → ${node.path}${node.architecture ? ` [${node.architecture}]` : ""}`
      : ` [${node.kind}]`;
    lines.push(`${prefix}${branch} ${node.name}${detail}${node.note ? ` — ${node.note}` : ""}`);
    if (node.children?.length) {
      lines.push(...dependencyLines(node.children, `${prefix}${last ? "   " : "│  "}`));
    }
  });
  return lines;
}

/** Stable, bounded text for the model. */
export function formatBinaryInspection(result: WorkspaceBinaryInspection): string {
  const p = result.inspection;
  const lines: string[] = [
    `Binary: ${result.path}`,
    `Format: ${p.format} · ${p.architecture} · ${p.isDll ? "DLL/library" : p.subsystem}`,
    `Size: ${p.bytes.toLocaleString()} bytes · SHA-256: ${p.hashes.sha256}`,
    `MD5: ${p.hashes.md5} · SHA-1: ${p.hashes.sha1}${p.hashes.imphash ? ` · imphash: ${p.hashes.imphash}` : ""}`,
  ];

  if (p.format.startsWith("PE")) {
    lines.push(
      `Entry point: ${hex(p.entryPointRva)} · image base ${p.imageBase} · mapped size ${p.sizeOfImage.toLocaleString()} bytes`,
      `Build timestamp: ${p.timestampIso ?? `unreliable/raw ${p.timestamp}`}`,
      `Mitigations: ASLR ${p.mitigations.aslr ? "yes" : "no"}, DEP ${p.mitigations.dep ? "yes" : "no"}, CFG ${p.mitigations.controlFlowGuard ? "yes" : "no"}, high-entropy VA ${p.mitigations.highEntropyVa ? "yes" : "no"}`,
      `Authenticode envelope: ${p.authenticode.present ? `present (${p.authenticode.size} bytes; trust NOT verified)` : "not present"}`,
    );
  }

  if (Object.keys(p.versionInfo).length) {
    lines.push("", "Version information:");
    for (const [key, value] of Object.entries(p.versionInfo)) lines.push(`  ${key}: ${value}`);
  }
  if (p.managed) {
    lines.push(
      "",
      `.NET managed assembly: ${p.managed.name ?? "name unavailable"}${p.managed.version ? ` ${p.managed.version}` : ""}`,
      `CLR metadata version: ${p.managed.runtimeVersion ?? "unknown"}`,
    );
    if (p.managed.references.length) {
      lines.push(`Managed references (${p.managed.references.length}):`);
      for (const ref of p.managed.references.slice(0, 300)) lines.push(`  ${ref.name}, Version=${ref.version}`);
    }
  }

  if (p.sections.length) {
    lines.push("", `Sections (${p.sections.length}):`, "  name       RVA       virtual   raw       entropy  permissions");
    for (const section of p.sections) {
      const perms = `${section.readable ? "R" : "-"}${section.writable ? "W" : "-"}${section.executable ? "X" : "-"}`;
      lines.push(
        `  ${section.name.padEnd(10).slice(0, 10)} ${hex(section.virtualAddress)} ${String(section.virtualSize).padStart(9)} ${String(section.rawSize).padStart(9)} ${section.entropy.toFixed(3).padStart(8)}  ${perms}`
      );
    }
  }

  if (p.imports.length) {
    lines.push("", `Imported libraries (${p.imports.length}):`);
    for (const item of p.imports) {
      const functions = [
        ...item.functions.slice(0, 300),
        ...item.ordinals.slice(0, 100).map((n) => `#${n}`),
      ];
      lines.push(
        `  ${item.dll}${item.delayLoaded ? " (delay-loaded)" : ""} — ${functions.length ? functions.join(", ") : "no named imports recovered"}${item.truncated || item.functions.length > 300 || item.ordinals.length > 100 ? " … [truncated]" : ""}`
      );
    }
  }

  if (p.exports.length) {
    lines.push("", `Exports (${p.exports.length}${p.truncated.exports ? ", truncated" : ""}):`);
    for (const item of p.exports.slice(0, 1000)) {
      lines.push(`  ${item.name ?? `#${item.ordinal}`} @ ${hex(item.rva)}${item.forwarder ? ` → ${item.forwarder}` : ""}`);
    }
    if (p.exports.length > 1000) lines.push(`  … ${p.exports.length - 1000} more not printed`);
  }

  if (p.pdbPaths.length) lines.push("", "Debug/PDB paths:", ...p.pdbPaths.map((x) => `  ${x}`));
  if (p.overlayBytes) lines.push("", `Overlay/appended data: ${p.overlayBytes.toLocaleString()} bytes`);
  if (p.indicators.length) lines.push("", "Structural observations (not malware verdicts):", ...p.indicators.map((x) => `  - ${x}`));

  if (result.dependencies.length) {
    lines.push("", `Dependency graph (${result.localFilesInspected} local PE file(s) parsed):`, result.path, ...dependencyLines(result.dependencies));
  }
  if (p.possibleDynamicLibraries.length) {
    lines.push("", "Possible runtime-loaded libraries found in strings (not proven imports):", ...p.possibleDynamicLibraries.map((x) => `  ${x}`));
  }

  if (p.strings.length) {
    lines.push("", `Selected strings (${p.strings.length}${p.truncated.strings ? ", more exist" : ""}):`);
    for (const value of p.strings) lines.push(`  ${JSON.stringify(value)}`);
  }

  lines.push(
    "",
    `Deep decompilation: ${result.deep.status} via ${result.deep.engine}${result.deep.cached ? " (cached)" : ""}`,
    result.deep.summary,
  );
  if (result.deep.outputs.length) {
    lines.push("Generated analysis files:", ...result.deep.outputs.slice(0, 200).map((x) => `  ${x}`));
  }
  if (result.deep.setup) lines.push(`Setup needed for deeper output: ${result.deep.setup}`);

  return lines.join("\n");
}

export function assertPeUpload(bytes: Uint8Array, name: string): void {
  if (!isPeFilename(name)) throw new WorkspaceError(`${name} is not a supported Windows executable/library filename.`);
  if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new WorkspaceError(`${name} does not have a Windows MZ executable header.`);
  }
}

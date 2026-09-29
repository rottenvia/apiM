import { Worker } from "node:worker_threads";
import fsSync, { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import {
  ensureRoot,
  isProtectedPath,
  resolveInside,
  workspaceDirectory,
  WorkspaceError,
} from "@/lib/workspace";

/**
 * Archive extraction for workspace uploads.
 *
 * One engine for every format: 7-Zip 24.09 compiled to WebAssembly (the
 * `7z-wasm` package). It reads zip, 7z, rar (v4 and v5), tar, gzip, bzip2,
 * xz, zstd, cab, iso/udf, wim, cpio, deb/ar, rpm, lzh, arj and more, and it is
 * pure WASM, so it behaves the same on Windows and Linux with nothing to
 * install beside node_modules. Licence: 7-Zip is GNU LGPL with the unRAR
 * restriction (the RAR decoder may not be used to re-create the RAR
 * compressor); both allow using it as a decompressor in this app.
 *
 * Nothing is held in memory. The archive's folder and a temporary output
 * folder are mounted into the WASM filesystem with Emscripten's NODEFS, so
 * 7-Zip streams reads and writes straight to disk: a 300MB member costs no
 * more memory than a 3KB one.
 *
 * 7-Zip runs in a worker thread. `callMain` is synchronous and a large
 * archive can take a minute; on the main thread that would freeze every chat
 * the server is streaming. The worker is also how cancellation works — an
 * abort terminates it mid-write — and how limits are enforced during the
 * write rather than after it.
 *
 * Safety is layered rather than trusted to any one check:
 *  1. The archive is listed first. Traversal entries, symlinks and hardlinks
 *     are excluded from extraction by exact name; declared size, file count
 *     and compression ratio are checked before a byte is written.
 *  2. Inside the worker, the output mount can only be written below its root
 *     (every name is sanitised on the way to the host, `..` cannot survive),
 *     symlink creation is refused outright, the input mount is read-only, and
 *     every byte and file written is counted against the limits — exceeding
 *     one kills the worker on the spot.
 *  3. Output lands in a temporary sibling folder. It is walked (any link or
 *     special file removed, totals re-checked on disk) before being renamed
 *     into place, and every final path is re-verified with resolveInside.
 *     Any failure removes the temporary folder, so nothing half-written is
 *     ever visible.
 */

export type ArchiveKind =
  | "zip"
  | "7z"
  | "rar"
  | "tar"
  | "gzip"
  | "bzip2"
  | "xz"
  | "zstd"
  | "lzma"
  | "compress"
  | "cab"
  | "iso"
  | "wim"
  | "cpio"
  | "ar"
  | "rpm"
  | "xar"
  | "lzh"
  | "arj"
  | "split";

export interface ExtractResult {
  /** Workspace-relative directory the files landed in ("." for the root). */
  dest: string;
  files: number;
  dirs: number;
  bytes: number;
  /** Workspace-relative files, shallowest first, capped at MAX_LISTED_ENTRIES. */
  entries: { path: string; bytes: number }[];
  /** Archives found inside (not extracted), workspace-relative. */
  nestedArchives: string[];
  /** `path` is the entry's path inside the archive; `reason` says why. */
  skipped: { path: string; reason: string }[];
  warnings: string[];
  /**
   * Exact per-folder totals from the full walk (not capped like `entries`),
   * for folders up to three levels below dest, shallowest first. Lets the
   * summary report true sizes even when only part of the tree is listed.
   */
  folders?: { path: string; files: number; bytes: number }[];
  /** Exact file-type histogram from the full walk, most common first. */
  fileTypes?: { ext: string; files: number; bytes: number }[];
}

export interface ExtractOptions {
  /** Workspace-relative destination directory. Default: next to the archive. */
  dest?: string;
  password?: string;
  signal?: AbortSignal;
  /** Maximum unpacked bytes. Default 4 GiB. */
  maxBytes?: number;
  /** Maximum number of files (and, separately, folders). Default 200,000. */
  maxFiles?: number;
  /**
   * Code page for entry names that are not UTF-8 (old zips from Windows,
   * RAR4, some tars): a WHATWG label such as "ibm866" or "windows-1251", or
   * "cp437". Detected automatically when omitted.
   */
  encoding?: string;
}

export type ExtractErrorCode =
  | "not_found"
  | "not_archive"
  | "password_required"
  | "wrong_password"
  | "too_large"
  | "aborted"
  | "corrupt"
  | "bad_dest"
  | "engine";

export class ExtractError extends Error {
  code: ExtractErrorCode;
  constructor(message: string, code: ExtractErrorCode = "corrupt") {
    super(message);
    this.name = "ExtractError";
    this.code = code;
  }
}

export const DEFAULT_MAX_BYTES = 4 * 1024 ** 3;
export const DEFAULT_MAX_FILES = 200_000;
export const MAX_LISTED_ENTRIES = 5000;
/** Declared ratio above which a large archive is treated as a bomb. */
const MAX_RATIO = 1000;
const RATIO_APPLIES_ABOVE = 1024 ** 3;
/** Enough of the head to see ISO 9660's "CD001" at 0x8001. */
const HEAD_BYTES = 0x8006;
const TEMP_PREFIX = ".apim-extract-";

/* ------------------------------------------------------------------ */
/* Sniffing                                                            */
/* ------------------------------------------------------------------ */

/**
 * Zip- and gzip-based formats that are documents or packages, not folders.
 * A dropped .docx must stay a .docx; extractArchive still opens one when
 * asked to explicitly (the agent may want to look inside).
 */
const CONTAINER_FILE_EXTS = new Set([
  "docx", "docm", "dotx", "dotm", "xlsx", "xlsm", "xltx", "xltm", "xlsb", "pptx", "pptm",
  "potx", "ppsx", "ppsm", "odt", "ods", "odp", "odg", "odf", "ott", "ots", "otp", "epub",
  "jar", "war", "ear", "aar", "apk", "apks", "aab", "xapk", "ipa", "xpi", "crx", "vsix",
  "nupkg", "whl", "egg", "appx", "appxbundle", "msix", "msixbundle", "xps", "oxps",
  "kmz", "3mf", "sketch", "pages", "numbers", "key", "pbix", "usdz", "mcpack",
  "mcaddon", "mcworld", "ora", "svgz", "emz", "wmz", "fig", "xd", "vsdx", "one",
]);

const EXT_KIND: Record<string, ArchiveKind> = {
  zip: "zip", zipx: "zip", "7z": "7z", rar: "rar", tar: "tar", gz: "gzip", gzip: "gzip",
  tgz: "gzip", tpz: "gzip", bz2: "bzip2", bzip2: "bzip2", tbz: "bzip2", tbz2: "bzip2",
  xz: "xz", txz: "xz", zst: "zstd", zstd: "zstd", tzst: "zstd", lzma: "lzma", z: "compress",
  taz: "compress", cab: "cab", iso: "iso", udf: "iso", wim: "wim", swm: "wim", esd: "wim",
  cpio: "cpio", deb: "ar", udeb: "ar", ar: "ar", rpm: "rpm", xar: "xar", lzh: "lzh",
  lha: "lzh", arj: "arj", "001": "split",
};

function extOf(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function startsWith(head: Uint8Array, bytes: number[], at = 0): boolean {
  if (head.length < at + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (head[at + i] !== bytes[i]) return false;
  return true;
}

function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

/**
 * What kind of archive is this, if any?
 *
 * Magic bytes decide first; the extension is the fallback for formats with
 * weak or missing magic (old tar, lzma) or when `head` is too short. Returns
 * null for documents built on zip (docx, xlsx, jar, apk, epub, odt…) unless
 * `force` is set.
 */
export function sniffArchive(
  head: Uint8Array,
  name: string,
  opts: { force?: boolean } = {}
): ArchiveKind | null {
  const ext = extOf(name);
  if (!opts.force && CONTAINER_FILE_EXTS.has(ext)) return null;

  const h = head ?? new Uint8Array(0);
  if (startsWith(h, [0x50, 0x4b, 0x03, 0x04]) || startsWith(h, [0x50, 0x4b, 0x05, 0x06]) ||
      startsWith(h, [0x50, 0x4b, 0x07, 0x08])) return "zip";
  if (startsWith(h, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "7z";
  if (startsWith(h, ascii("Rar!\x1a\x07"))) return "rar";
  if (startsWith(h, [0x1f, 0x8b])) return "gzip";
  if (startsWith(h, ascii("BZh")) && h.length > 3 && h[3] >= 0x31 && h[3] <= 0x39) return "bzip2";
  if (startsWith(h, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return "xz";
  if (startsWith(h, [0x28, 0xb5, 0x2f, 0xfd])) return "zstd";
  if (startsWith(h, [0x1f, 0x9d])) return "compress";
  if (startsWith(h, ascii("MSCF\0\0\0\0"))) return "cab";
  if (startsWith(h, ascii("MSWIM\0\0\0"))) return "wim";
  if (startsWith(h, ascii("ustar"), 257)) return "tar";
  if (startsWith(h, ascii("CD001"), 0x8001) || startsWith(h, ascii("BEA01"), 0x8001)) return "iso";
  if (startsWith(h, ascii("!<arch>\n"))) return "ar";
  if (startsWith(h, [0xed, 0xab, 0xee, 0xdb])) return "rpm";
  if (startsWith(h, ascii("xar!"))) return "xar";
  if (startsWith(h, ascii("070707")) || startsWith(h, ascii("070701")) ||
      startsWith(h, ascii("070702")) || startsWith(h, [0xc7, 0x71]) ||
      startsWith(h, [0x71, 0xc7])) return "cpio";
  if (startsWith(h, ascii("-lh"), 2) && h.length > 6 && h[6] === 0x2d) return "lzh";
  if (startsWith(h, [0x60, 0xea])) return "arj";

  const byExt = EXT_KIND[ext];
  if (!byExt) return null;
  // With enough bytes to judge, an extension whose magic is absent is only
  // believed for formats that have no reliable magic of their own.
  const weakMagic: ArchiveKind[] = ["tar", "lzma", "split", "iso"];
  if (!opts.force && h.length >= 512 && !weakMagic.includes(byExt)) return null;
  if (!opts.force && byExt === "iso" && h.length >= HEAD_BYTES) return null;
  return byExt;
}

/** "game.tar.gz" → "game", "x.part1.rar" → "x", "a.7z.001" → "a". */
export function stripArchiveExt(name: string): string {
  let base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  base = base.replace(/\.(part0*1\.rar|7z\.0*1|zip\.0*1|tar\.[a-z0-9]{1,5}|t[gbx]z2?|tzst|taz|tpz)$/i, "");
  if (base === name.split(/[\\/]/).pop()) {
    base = base.replace(/\.[A-Za-z0-9]{1,6}$/, "");
  }
  base = base.replace(/[. ]+$/, "");
  return base || "archive";
}

/** "data.json.gz" → "data.json"; for single-file compressors. */
function stripCompressorExt(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  const out = base.replace(/\.(gz|gzip|bz2|bzip2|xz|zst|zstd|lzma|z|001)$/i, "");
  return out && out !== base ? out : "";
}

/* ------------------------------------------------------------------ */
/* Shared JS: lossless UTF-8 codec and name sanitiser                  */
/* ------------------------------------------------------------------ */

/**
 * Plain JavaScript shared by the worker and this module.
 *
 * The codec replaces Emscripten's UTF-8 helpers inside the engine. Names in
 * old zips and RAR4 archives are raw bytes in some DOS/Windows code page;
 * 7-Zip passes those bytes through untouched, and the stock helper decodes
 * them as UTF-8 and replaces them with U+FFFD — lossy, and two different
 * names can collapse into one. This version keeps every invalid byte as a
 * lone surrogate (U+DC80–U+DCFF, Python's "surrogateescape"), so the exact
 * bytes survive to the filesystem hook, where they are decoded with the
 * archive's real code page. `-mcp=` does nothing in this build: it has no
 * code page tables.
 */
const SHARED_JS = String.raw`
var APIM_CP437 = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
function apimDecode(a, idx, maxBytesToRead) {
  idx = idx || 0;
  var endIdx = idx + maxBytesToRead;
  var end = idx;
  while (a[end] && !(end >= endIdx)) ++end;
  var out = "", codes = [];
  for (var i = idx; i < end; ) {
    var b0 = a[i];
    if (b0 < 0x80) { codes.push(b0); i++; }
    else {
      var need = 0, cp = 0, min = 0;
      if (b0 >= 0xc2 && b0 <= 0xdf) { need = 1; cp = b0 & 0x1f; min = 0x80; }
      else if (b0 >= 0xe0 && b0 <= 0xef) { need = 2; cp = b0 & 0x0f; min = 0x800; }
      else if (b0 >= 0xf0 && b0 <= 0xf4) { need = 3; cp = b0 & 0x07; min = 0x10000; }
      var ok = need > 0 && i + need < end;
      for (var k = 1; ok && k <= need; k++) {
        var b = a[i + k];
        if ((b & 0xc0) !== 0x80) ok = false; else cp = (cp << 6) | (b & 0x3f);
      }
      if (ok && (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))) ok = false;
      if (!ok) { codes.push(0xdc00 + b0); i++; }
      else {
        if (cp >= 0x10000) { cp -= 0x10000; codes.push(0xd800 | (cp >> 10), 0xdc00 | (cp & 0x3ff)); }
        else codes.push(cp);
        i += need + 1;
      }
    }
    if (codes.length >= 8192) { out += String.fromCharCode.apply(null, codes); codes = []; }
  }
  return out + String.fromCharCode.apply(null, codes);
}
function apimLength(str) {
  var len = 0;
  for (var i = 0; i < str.length; ++i) {
    var u = str.codePointAt(i);
    if (u >= 0xdc80 && u <= 0xdcff) len += 1;
    else if (u <= 0x7f) len += 1;
    else if (u <= 0x7ff) len += 2;
    else if (u <= 0xffff) len += 3;
    else { len += 4; i++; }
  }
  return len;
}
function apimEncode(str, heap, outIdx, maxBytesToWrite) {
  if (!(maxBytesToWrite > 0)) return 0;
  var start = outIdx, endIdx = outIdx + maxBytesToWrite - 1;
  for (var i = 0; i < str.length; ++i) {
    var u = str.codePointAt(i);
    if (u >= 0xdc80 && u <= 0xdcff) { if (outIdx >= endIdx) break; heap[outIdx++] = u - 0xdc00; }
    else if (u <= 0x7f) { if (outIdx >= endIdx) break; heap[outIdx++] = u; }
    else if (u <= 0x7ff) { if (outIdx + 1 >= endIdx) break; heap[outIdx++] = 0xc0 | (u >> 6); heap[outIdx++] = 0x80 | (u & 63); }
    else if (u <= 0xffff) { if (outIdx + 2 >= endIdx) break; heap[outIdx++] = 0xe0 | (u >> 12); heap[outIdx++] = 0x80 | ((u >> 6) & 63); heap[outIdx++] = 0x80 | (u & 63); }
    else { if (outIdx + 3 >= endIdx) break; heap[outIdx++] = 0xf0 | (u >> 18); heap[outIdx++] = 0x80 | ((u >> 12) & 63); heap[outIdx++] = 0x80 | ((u >> 6) & 63); heap[outIdx++] = 0x80 | (u & 63); i++; }
  }
  heap[outIdx] = 0;
  return outIdx - start;
}
function apimToBytes(str) {
  var buf = new Uint8Array(apimLength(str) + 1);
  var n = apimEncode(str, buf, 0, buf.length);
  return buf.subarray(0, n);
}
function apimHasEscape(str) {
  for (var i = 0; i < str.length; i++) {
    var c = str.codePointAt(i);
    if (c > 0xffff) { i++; continue; }
    if (c >= 0xdc80 && c <= 0xdcff) return true;
  }
  return false;
}
function apimDecodeCp(bytes, label) {
  if (label === "cp437") {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += bytes[i] < 128 ? String.fromCharCode(bytes[i]) : APIM_CP437.charAt(bytes[i] - 128);
    return s;
  }
  return new TextDecoder(label).decode(bytes);
}
function apimSanitizeSegment(seg) {
  var s = seg.replace(/[\u0000-\u001f<>:"|?*\\]/g, "_");
  if (s === "" || s === "." || s === "..") return "_";
  s = s.replace(/[. ]+$/, function (m) { return m.replace(/[\s\S]/g, "_"); });
  if (/^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i.test(s)) s = "_" + s;
  if (s.length > 240) {
    var dot = s.lastIndexOf(".");
    var ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : "";
    s = s.slice(0, 240 - ext.length) + "~" + ext;
  }
  return s;
}
function apimMapName(name) {
  var parts = name.split("\\").filter(function (p) { return p !== ""; });
  if (!parts.length) return "_";
  return parts.map(apimSanitizeSegment).join("/");
}
`;

interface SharedFns {
  toBytes(str: string): Uint8Array;
  hasEscape(str: string): boolean;
  decodeCp(bytes: Uint8Array, label: string): string;
  mapName(name: string): string;
  decode(bytes: Uint8Array, idx?: number, max?: number): string;
}

let shared: SharedFns | null = null;
function sharedFns(): SharedFns {
  if (!shared) {
    shared = new Function(
      SHARED_JS +
        "; return { toBytes: apimToBytes, hasEscape: apimHasEscape, decodeCp: apimDecodeCp, mapName: apimMapName, decode: apimDecode };"
    )() as SharedFns;
  }
  return shared;
}

/* ------------------------------------------------------------------ */
/* Worker                                                              */
/* ------------------------------------------------------------------ */

const WORKER_JS =
  SHARED_JS +
  String.raw`
"use strict";
var wt = require("worker_threads");
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var nodeModule = require("module");
var W = wt.workerData;
var port = wt.parentPort;

(async function () {
  var src = fs.readFileSync(W.modulePath, "utf8");
  var A1 = "var FS_stdin_getChar_buffer=[];";
  var A2 = "var intArrayFromString=";
  var patched = false;
  if (src.split(A1).length === 2 && src.split(A2).length === 2 &&
      src.indexOf("var UTF8ArrayToString=") >= 0 && src.indexOf("var stringToUTF8Array=") >= 0) {
    globalThis.__apimCodec = { decode: apimDecode, length: apimLength, encode: apimEncode };
    src = src.replace(A1, "UTF8ArrayToString=globalThis.__apimCodec.decode;" + A1)
             .replace(A2, "lengthBytesUTF8=globalThis.__apimCodec.length;stringToUTF8Array=globalThis.__apimCodec.encode;" + A2);
    patched = true;
  }
  var fn = vm.compileFunction(src, ["module", "exports", "require", "__filename", "__dirname"], { filename: W.modulePath });
  var modObj = { exports: {} };
  fn(modObj, modObj.exports, nodeModule.createRequire(W.modulePath), W.modulePath, path.dirname(W.modulePath));
  var factory = modObj.exports;

  var listing = W.mode === "list";
  var records = [], cur = null, state = 0, header = {}, notes = [], stderr = [];
  function note(line) { if (notes.length < 400) notes.push(line); }
  function flush() { if (cur) { records.push(cur); cur = null; } }
  function kv(line) {
    var i = line.indexOf(" = ");
    if (i > 0) return [line.slice(0, i), line.slice(i + 3)];
    if (/^[A-Za-z][A-Za-z ]* =$/.test(line)) return [line.slice(0, -2), ""];
    return null;
  }
  function onOut(line) {
    if (!listing) {
      if (/error|warning|wrong password|cannot|can not|unsupported|unexpected|crc failed|data after|is not/i.test(line)) note(line);
      return;
    }
    if (state === 0) { if (line === "--") state = 1; else if (line.trim() && !/^(7-Zip|Scanning|Listing archive| *[0-9]+M Scan| 32-bit| 64-bit)/.test(line)) note(line); return; }
    if (line === "----------") { flush(); state = 2; return; }
    var p = kv(line);
    if (state === 1) {
      // Nested levels (a split set holding a 7z, say) each start with "--";
      // the innermost archive's properties are the ones that matter.
      if (line === "--") { header = {}; return; }
      if (line === "----") return;
      if (p) { if (!(p[0] in header)) header[p[0]] = p[1]; } else if (line.trim()) note(line);
      return;
    }
    if (line === "") { flush(); return; }
    if (!p) { if (line.trim()) note(line); return; }
    var key = p[0], val = p[1];
    if (key === "Path") { flush(); cur = { p: val }; return; }
    if (!cur) return;
    switch (key) {
      case "Folder": cur.d = val === "+"; break;
      case "Size": cur.s = val === "" ? -1 : Number(val); break;
      case "Packed Size": cur.k = val === "" ? -1 : Number(val); break;
      case "Attributes": cur.a = val; break;
      case "Encrypted": cur.e = val === "+"; break;
      case "Symbolic Link": if (val) cur.l = val; break;
      case "Hard Link": if (val) cur.h = val; break;
      case "Copy Link": if (val) cur.c = val; break;
    }
  }
  var opts = {
    print: onOut,
    printErr: function (l) { if (stderr.length < 400) stderr.push(l); },
    stdin: function () { return null; },
  };
  if (W.wasmModule) {
    opts.instantiateWasm = function (imports, cb) {
      WebAssembly.instantiate(W.wasmModule, imports).then(
        function (inst) { cb(inst, W.wasmModule); },
        function (e) { port.postMessage({ type: "fatal", message: String(e) }); }
      );
      return {};
    };
  }
  var m = await factory(opts);
  var FS = m.FS, N = m.NODEFS;
  FS.mkdir("/in");
  FS.mount(N, { root: W.inDir }, "/in");
  if (W.outDir) { FS.mkdir("/out"); FS.mount(N, { root: W.outDir }, "/out"); }
  if (W.exclude && W.exclude.length) FS.writeFile("/apim-exclude.txt", apimToBytes(W.exclude.join("\n") + "\n"));

  var EPERM = 63;
  function mountOf(node) { return node && node.mount && node.mount.mountpoint; }
  function isOut(node) { return mountOf(node) === "/out"; }
  function isIn(node) { return mountOf(node) === "/in"; }
  var bytes = 0, files = 0, dirs = 0, decoded = 0;
  var renamed = [], renamedSeen = new Set(), blocked = [];
  // Host file descriptors NODEFS has open. A worker that exits does not close
  // them for us, and on Windows an open handle would keep the temp folder
  // from being deleted — so every exit path closes them first.
  var openFds = new Set();
  function closeAll() {
    openFds.forEach(function (fd) { try { fs.closeSync(fd); } catch (e) { /* already closed */ } });
    openFds.clear();
  }
  var ctrl = new Int32Array(W.ctrl);
  function checkCancel() {
    if (Atomics.load(ctrl, 0) !== 0) { closeAll(); process.exit(89); }
  }
  function limit(code, what) {
    closeAll();
    port.postMessage({ type: "limit", what: what, bytes: bytes, files: files, dirs: dirs });
    process.exit(code);
  }
  function mapName(name) {
    var n = name;
    if (W.codePage && apimHasEscape(n)) {
      try { n = apimDecodeCp(apimToBytes(n), W.codePage); decoded++; } catch (e) { /* keep the escaped form */ }
    }
    var out = apimMapName(n);
    if (out !== n && !renamedSeen.has(n) && renamed.length < 500) { renamedSeen.add(n); renamed.push([n, out]); }
    return out;
  }
  function fixMode(mode, isDir) { return (mode & ~4095) | (mode & 511) | (isDir ? 448 : 384); }
  var ops = N.node_ops, o = Object.assign({}, ops);
  ops.lookup = function (parent, name) { checkCancel(); return o.lookup.call(this, parent, isOut(parent) ? mapName(name) : name); };
  ops.mknod = function (parent, name, mode, dev) {
    checkCancel();
    if (isIn(parent)) throw new FS.ErrnoError(EPERM);
    if (isOut(parent)) {
      name = mapName(name);
      if (FS.isDir(mode)) { if (++dirs > W.maxFiles) limit(88, "dirs"); }
      else if (++files > W.maxFiles) limit(88, "files");
      mode = fixMode(mode, FS.isDir(mode));
      if (name.indexOf("/") >= 0) fs.mkdirSync(path.join(N.realPath(parent), path.posix.dirname(name)), { recursive: true });
    }
    return o.mknod.call(this, parent, name, mode, dev);
  };
  ops.rename = function (oldNode, newDir, newName) {
    if (isIn(oldNode) || isIn(newDir)) throw new FS.ErrnoError(EPERM);
    return o.rename.call(this, oldNode, newDir, isOut(newDir) ? mapName(newName) : newName);
  };
  ops.unlink = function (parent, name) {
    if (isIn(parent)) throw new FS.ErrnoError(EPERM);
    return o.unlink.call(this, parent, isOut(parent) ? mapName(name) : name);
  };
  ops.rmdir = function (parent, name) {
    if (isIn(parent)) throw new FS.ErrnoError(EPERM);
    return o.rmdir.call(this, parent, isOut(parent) ? mapName(name) : name);
  };
  ops.symlink = function (parent, newName, oldPath) {
    if (blocked.length < 500) blocked.push(newName + " -> " + oldPath);
    throw new FS.ErrnoError(EPERM);
  };
  ops.setattr = function (node, attr) {
    if (isIn(node)) throw new FS.ErrnoError(EPERM);
    if (attr && attr.mode != null && isOut(node)) {
      attr = Object.assign({}, attr);
      attr.mode = fixMode(attr.mode, FS.isDir(node.mode));
    }
    return o.setattr.call(this, node, attr);
  };
  var so = N.stream_ops, oOpen = so.open, oClose = so.close, oRead = so.read;
  so.open = function (stream) {
    checkCancel();
    if (isIn(stream.node) && ((stream.flags & 3) !== 0 || (stream.flags & 512))) throw new FS.ErrnoError(EPERM);
    var r = oOpen.call(this, stream);
    if (stream.nfd != null) openFds.add(stream.nfd);
    return r;
  };
  so.close = function (stream) {
    var r = oClose.call(this, stream);
    if (stream.shared && stream.shared.refcount === 0) openFds.delete(stream.nfd);
    return r;
  };
  so.read = function () { checkCancel(); return oRead.apply(this, arguments); };
  var oWrite = FS.write;
  FS.write = function (stream, buffer, offset, length) {
    var node = stream && stream.node;
    if (node && isIn(node)) throw new FS.ErrnoError(EPERM);
    checkCancel();
    if (node && !FS.isChrdev(node.mode)) { bytes += length; if (bytes > W.maxBytes) limit(87, "bytes"); }
    return oWrite.apply(this, arguments);
  };

  var code = null, threw = null;
  try { code = m.callMain(W.args.slice()); }
  catch (e) { threw = String((e && e.message) || e); }
  closeAll();
  flush();
  port.postMessage({
    type: "done", code: code, threw: threw, patched: patched, records: listing ? records : [],
    header: header, notes: notes, stderr: stderr, renamed: renamed, decoded: decoded,
    blocked: blocked, bytes: bytes, files: files, dirs: dirs,
  });
})().catch(function (e) { port.postMessage({ type: "fatal", message: String((e && e.stack) || e) }); });
`;

interface ListRecord {
  p: string;
  d?: boolean;
  s?: number;
  k?: number;
  a?: string;
  e?: boolean;
  l?: string;
  h?: string;
  c?: string;
}

interface RunResult {
  code: number | null;
  threw: string | null;
  patched: boolean;
  records: ListRecord[];
  header: Record<string, string>;
  notes: string[];
  stderr: string[];
  renamed: [string, string][];
  decoded: number;
  blocked: string[];
  bytes: number;
  files: number;
  dirs: number;
}

interface Engine {
  modulePath: string;
  wasmPath: string;
}

let enginePromise: Promise<{ engine: Engine; wasm: WebAssembly.Module | null }> | null = null;

/**
 * Find the installed 7z-wasm.
 *
 * Deliberately not an `import`: the engine is only ever loaded inside the
 * worker, from its real location in node_modules, so the Next.js bundler
 * never sees it and no `serverExternalPackages` entry is needed. The
 * specifier is assembled at runtime to keep bundlers from trying to trace it.
 */
function locateEngine(): Engine {
  const candidates: string[] = [];
  if (process.env.APIM_7Z_WASM_DIR) candidates.push(process.env.APIM_7Z_WASM_DIR);
  try {
    const req = createRequire(path.join(/*turbopackIgnore: true*/ process.cwd(), "noop.js"));
    candidates.push(path.dirname(req.resolve(["7z-wasm", "package.json"].join("/"))));
  } catch {
    /* fall through to the walk */
  }
  let dir = /*turbopackIgnore: true*/ process.cwd();
  for (let hop = 0; hop < 12; hop++) {
    candidates.push(path.join(/*turbopackIgnore: true*/ dir, ["node", "modules"].join("_"), "7z-wasm"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const c of candidates) {
    const modulePath = path.join(/*turbopackIgnore: true*/ c, "7zz.umd.js");
    const wasmPath = path.join(/*turbopackIgnore: true*/ c, "7zz.wasm");
    if (fsSync.existsSync(/*turbopackIgnore: true*/ modulePath) && fsSync.existsSync(/*turbopackIgnore: true*/ wasmPath)) {
      return { modulePath, wasmPath };
    }
  }
  throw new ExtractError(
    "The archive engine (7z-wasm) is not installed. Run `npm install` in the app folder.",
    "engine"
  );
}

function loadEngine(): Promise<{ engine: Engine; wasm: WebAssembly.Module | null }> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const engine = locateEngine();
      let wasm: WebAssembly.Module | null = null;
      try {
        // Compiled once per process and shared with every worker.
        wasm = await WebAssembly.compile(await fs.readFile(/*turbopackIgnore: true*/ engine.wasmPath));
      } catch {
        wasm = null; // Each worker compiles its own copy instead.
      }
      return { engine, wasm };
    })();
    enginePromise.catch(() => {
      enginePromise = null;
    });
  }
  return enginePromise;
}

interface RunOptions {
  inDir: string;
  outDir?: string;
  mode: "list" | "extract";
  maxBytes: number;
  maxFiles: number;
  codePage?: string | null;
  exclude?: string[];
  signal?: AbortSignal;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/**
 * At most a few engines at once. Each worker holds its own WASM heap (tens of
 * MB), and an agent that fires off extractions in parallel should queue them
 * rather than multiply that.
 */
const MAX_ENGINES = 3;
let enginesRunning = 0;
const engineWaiters: (() => void)[] = [];

function acquireEngine(signal?: AbortSignal): Promise<void> {
  if (enginesRunning < MAX_ENGINES) {
    enginesRunning++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const i = engineWaiters.indexOf(go);
      if (i >= 0) engineWaiters.splice(i, 1);
      reject(new ExtractError("Extraction was cancelled", "aborted"));
    };
    const go = () => {
      signal?.removeEventListener("abort", onAbort);
      enginesRunning++;
      resolve();
    };
    engineWaiters.push(go);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function releaseEngine(): void {
  enginesRunning--;
  engineWaiters.shift()?.();
}

async function run7z(args: string[], o: RunOptions): Promise<RunResult> {
  const { engine, wasm } = await loadEngine();
  if (o.signal?.aborted) throw new ExtractError("Extraction was cancelled", "aborted");
  await acquireEngine(o.signal);
  try {
    return await runWorker(engine, wasm, args, o);
  } finally {
    releaseEngine();
  }
}

function runWorker(engine: Engine, wasm: WebAssembly.Module | null, args: string[], o: RunOptions): Promise<RunResult> {
  if (o.signal?.aborted) return Promise.reject(new ExtractError("Extraction was cancelled", "aborted"));
  return new Promise<RunResult>((resolve, reject) => {
    const ctrl = new SharedArrayBuffer(4);
    const worker = new Worker(/*turbopackIgnore: true*/ WORKER_JS, {
      eval: true,
      workerData: {
        modulePath: engine.modulePath,
        wasmModule: wasm,
        mode: o.mode,
        args,
        inDir: o.inDir,
        outDir: o.outDir ?? null,
        maxBytes: o.maxBytes,
        maxFiles: o.maxFiles,
        codePage: o.codePage ?? null,
        exclude: o.exclude ?? [],
        ctrl,
      },
      stdout: true,
      stderr: true,
    });
    // Emscripten may print stray diagnostics; never let them reach the
    // server console or pile up unread.
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      o.signal?.removeEventListener("abort", onAbort);
      worker.terminate().catch(() => {});
      fn();
    };
    const limitError = (what: string) =>
      new ExtractError(
        what === "bytes"
          ? `Extraction stopped: the archive unpacks to more than ${fmtBytes(o.maxBytes)}`
          : `Extraction stopped: the archive contains more than ${o.maxFiles.toLocaleString("en-US")} ${what === "dirs" ? "folders" : "files"}`,
        "too_large"
      );
    // Cancel cooperatively: the worker sees the flag at its next file
    // operation, closes its handles and exits, so the caller can delete the
    // temp folder safely (even on Windows). terminate() is only the backstop.
    let cancelling = false;
    const onAbort = () => {
      if (settled || cancelling) return;
      cancelling = true;
      Atomics.store(new Int32Array(ctrl), 0, 1);
      const backstop = setTimeout(
        () => finish(() => reject(new ExtractError("Extraction was cancelled", "aborted"))),
        3000
      );
      backstop.unref?.();
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (msg: { type: string; what?: string; message?: string } & RunResult) => {
      if (msg.type === "done") finish(() => resolve(msg));
      else if (msg.type === "limit") finish(() => reject(limitError(msg.what ?? "bytes")));
      else if (msg.type === "fatal")
        finish(() => reject(new ExtractError(`The archive engine failed: ${msg.message}`, "engine")));
    });
    worker.on("error", (err) =>
      finish(() => reject(new ExtractError(`The archive engine failed: ${err?.message ?? err}`, "engine")))
    );
    worker.on("exit", (code) =>
      finish(() => {
        if (cancelling || code === 89) reject(new ExtractError("Extraction was cancelled", "aborted"));
        else if (code === 87) reject(limitError("bytes"));
        else if (code === 88) reject(limitError("files"));
        else reject(new ExtractError(`The archive engine stopped unexpectedly (exit ${code})`, "engine"));
      })
    );
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function joinRel(...parts: string[]): string {
  const joined = parts
    .map(toPosix)
    .filter((p) => p && p !== ".")
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "");
  return joined || ".";
}

function relDir(rel: string): string {
  const d = path.posix.dirname(toPosix(rel));
  return d === "." || d === "/" ? "" : d;
}

async function readHead(file: string, n = HEAD_BYTES): Promise<Uint8Array> {
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } finally {
    await fh.close();
  }
}

async function exists(p: string): Promise<fsSync.Stats | null> {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

async function isEmptyDir(p: string): Promise<boolean> {
  try {
    return (await fs.readdir(p)).length === 0;
  } catch {
    return false;
  }
}

async function removeTree(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

/** rename() that tolerates Windows' transient EPERM/EBUSY (indexers, AV). */
async function renameRetry(src: string, dest: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (attempt >= 6 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      // Windows reports a taken destination as EPERM too; that will not clear.
      if (await exists(dest)) throw err;
      await new Promise((r) => setTimeout(r, 80 * (attempt + 1)));
    }
  }
}

async function makeTemp(parent: string): Promise<string> {
  await fs.mkdir(parent, { recursive: true });
  const dir = path.join(parent, `${TEMP_PREFIX}${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`);
  await fs.mkdir(dir);
  return dir;
}

/** Temp folders left behind by a crash (a finished run always removes its own). */
async function sweepStaleTemps(parent: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(parent);
  } catch {
    return;
  }
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const full = path.join(parent, name);
    const st = await exists(full);
    if (st?.isDirectory() && st.mtimeMs < cutoff) await removeTree(full);
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExtractError("Extraction was cancelled", "aborted");
}

function isSymlinkRecord(r: ListRecord): boolean {
  if (r.l) return true;
  return (r.a ?? "")
    .split(/\s+/)
    .some((t) => /^l[r-][w-][xsS-][r-][w-][xsS-][r-][w-][xtT-]$/.test(t));
}

function pathIssue(p: string): "traversal" | "absolute" | null {
  if (p.split(/[\\/]+/).some((s) => s === "..")) return "traversal";
  if (/^([\\/]|[A-Za-z]:)/.test(p)) return "absolute";
  return null;
}

/** Score a decoded name: real words in a real script beat symbol soup. */
function scoreText(s: string): number {
  let score = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x80) continue;
    if ((c >= 0x410 && c <= 0x44f) || c === 0x401 || c === 0x451) score += 2;
    else if (c >= 0xc0 && c <= 0xff && c !== 0xd7 && c !== 0xf7) score += 1;
    else if (c >= 0x400 && c <= 0x4ff) score += 0;
    else if ((c >= 0x2500 && c <= 0x25ff) || c < 0xa0 || c === 0xfffd) score -= 3;
    else score -= 1;
  }
  for (const w of s.split(/[^A-Za-zÀ-ɏЀ-ӿ]+/)) {
    if (/[A-Za-zÀ-ɏ]/.test(w) && /[Ѐ-ӿ]/.test(w)) score -= 3;
  }
  return score;
}

const CODE_PAGES = ["ibm866", "windows-1251", "cp437", "windows-1252"];

/**
 * The bytes behind a name as 7-Zip lists it, or null if it is plain text.
 *
 * For a name that is not flagged UTF-8 this build lists each high byte b as
 * U+FF00+b (a sign-extension artefact), while the file-system calls carry the
 * raw bytes — which the patched decoder turns into U+DC00+b. Both forms map
 * back to the original bytes here.
 */
function listingBytes(name: string): Uint8Array | null {
  let raw = false;
  const out: number[] = [];
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0xff80 && c <= 0xffff) {
      out.push(c - 0xff00);
      raw = true;
    } else if (c >= 0xdc80 && c <= 0xdcff) {
      out.push(c - 0xdc00);
      raw = true;
    } else {
      for (const b of Buffer.from(ch, "utf8")) out.push(b);
    }
  }
  return raw ? Uint8Array.from(out) : null;
}

function strictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Pick the code page for names that are not valid UTF-8.
 *
 * Russian Windows writes zip names in CP866 (Explorer, WinRAR) or CP1251
 * (some tools); Western DOS uses CP437. Each candidate decodes every such
 * name and the most plausible text wins; ties go to CP866, the most likely
 * for this app's users. Names whose bytes are valid UTF-8 (Linux zips that
 * omit the UTF-8 flag) are already right and do not vote.
 */
function detectCodePage(names: string[]): string | null {
  const raw: Uint8Array[] = [];
  for (const n of names) {
    const b = listingBytes(n);
    if (b && strictUtf8(b) === null) raw.push(b);
    if (raw.length >= 2000) break;
  }
  if (!raw.length) return null;
  const f = sharedFns();
  let best = CODE_PAGES[0];
  let bestScore = -Infinity;
  for (const cp of CODE_PAGES) {
    let score = 0;
    try {
      for (const b of raw) score += scoreText(f.decodeCp(b, cp));
    } catch {
      continue;
    }
    if (score > bestScore) {
      bestScore = score;
      best = cp;
    }
  }
  return best;
}

/** A listed name as readable text (for reports and link targets). */
function displayName(p: string, codePage: string | null): string {
  const bytes = listingBytes(p);
  if (!bytes) return p;
  const utf8 = strictUtf8(bytes);
  if (utf8 !== null) return utf8;
  if (codePage) {
    try {
      return sharedFns().decodeCp(bytes, codePage);
    } catch {
      /* fall through */
    }
  }
  return p.replace(/[\uff80-\uffff\udc80-\udcff]/g, "?");
}

/** Where 7-Zip puts an archive path, after the same mapping the worker applies. */
function mapArchivePath(p: string, codePage: string | null): string {
  const f = sharedFns();
  return displayName(p, codePage)
    .split("/")
    .filter((s) => s && s !== ".")
    .map((s) => f.mapName(s))
    .join("/");
}

/**
 * Is this 7z's header encrypted (7z -mhe)?
 *
 * Needed because this engine build cannot catch C++ exceptions: opening
 * such an archive without the right password aborts 7-Zip instead of
 * printing "Wrong password", so the cause has to be read from the file.
 */
async function sevenZipHeadersEncrypted(file: string): Promise<boolean> {
  try {
    const fh = await fs.open(file, "r");
    try {
      const start = Buffer.alloc(32);
      await fh.read(start, 0, 32, 0);
      const offset = Number(start.readBigUInt64LE(12));
      const size = Number(start.readBigUInt64LE(20));
      if (!size || size > 1 << 20) return false;
      const hdr = Buffer.alloc(size);
      await fh.read(hdr, 0, size, 32 + offset);
      return hdr[0] === 0x17 && hdr.includes(Buffer.from([0x06, 0xf1, 0x07, 0x01]));
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

const PASSWORD_RE = /wrong password|encrypted archive|enter password|can not open encrypted/i;

function engineMessages(r: RunResult): string[] {
  const lines = [...r.stderr, ...r.notes]
    .map((l) => l.trim())
    .filter((l) => l && !/^(Sub items Errors|Archives with Errors|Errors|Warnings):/i.test(l));
  return Array.from(new Set(lines)).slice(0, 8);
}

function passwordError(hadPassword: boolean, name: string): ExtractError {
  return hadPassword
    ? new ExtractError(`Wrong password for ${name}. Ask the user for the correct password.`, "wrong_password")
    : new ExtractError(
        `${name} is password-protected. Ask the user for the password and extract again with it.`,
        "password_required"
      );
}

/* ------------------------------------------------------------------ */
/* One 7-Zip pass: list, check, extract                                */
/* ------------------------------------------------------------------ */

interface Ctx {
  displayArchive: string;
  password?: string;
  signal?: AbortSignal;
  maxBytes: number;
  maxFiles: number;
  encoding?: string;
  skipped: { path: string; reason: string }[];
  warnings: string[];
}

interface Pass {
  type: string;
  records: ListRecord[];
  codePage: string | null;
  /** Hardlink / copy-link entries to materialise as copies: [link, target] (mapped paths). */
  links: [string, string][];
}

function pushSkip(ctx: Ctx, p: string, reason: string): void {
  if (ctx.skipped.length < 1000) ctx.skipped.push({ path: p, reason });
}

async function unpack(archiveAbs: string, outDir: string, ctx: Ctx): Promise<Pass> {
  const inDir = path.dirname(archiveAbs);
  const inName = `/in/${path.basename(archiveAbs)}`;
  const pw = `-p${ctx.password ?? ""}`;
  const common = ["-sccUTF-8", "-scsUTF-8", pw];

  // 1. List.
  const list = await run7z(["l", "-slt", ...common, inName], {
    inDir,
    mode: "list",
    maxBytes: 64 * 1024 * 1024,
    maxFiles: ctx.maxFiles,
    signal: ctx.signal,
  });
  if (list.threw) {
    if (sniffArchive(await readHead(archiveAbs, 8), "x") === "7z" && (await sevenZipHeadersEncrypted(archiveAbs))) {
      throw passwordError(!!ctx.password, ctx.displayArchive);
    }
    throw new ExtractError(`${ctx.displayArchive} could not be read: the archive is damaged or in an unsupported variant.`, "corrupt");
  }
  const listMsgs = engineMessages(list);
  if (list.code !== 0 && list.code !== 1) {
    if (listMsgs.some((l) => PASSWORD_RE.test(l))) throw passwordError(!!ctx.password, ctx.displayArchive);
    if (listMsgs.some((l) => /can ?not open the file as|is not archive/i.test(l)))
      throw new ExtractError(`${ctx.displayArchive} is not an archive 7-Zip can open (${listMsgs[0] ?? "unknown format"}).`, "not_archive");
    throw new ExtractError(`${ctx.displayArchive} could not be opened: ${listMsgs.join("; ") || `7-Zip exit ${list.code}`}`, "corrupt");
  }
  for (const m of listMsgs) if (/warning|data after|unexpected end|headers error/i.test(m)) ctx.warnings.push(`7-Zip: ${m}`);
  checkAbort(ctx.signal);

  const records = list.records;
  const codePage = list.patched ? ctx.encoding ?? detectCodePage(records.map((r) => r.p)) : null;

  // 2. Classify entries.
  const exclude: string[] = [];
  const links: [string, string][] = [];
  let absolute = 0;
  let encrypted = false;
  let declared = 0;
  let files = 0;
  let dirs = 0;
  for (const r of records) {
    const shown = displayName(r.p, codePage);
    if (r.e) encrypted = true;
    const issue = pathIssue(r.p);
    if (issue === "traversal") {
      exclude.push(r.p);
      pushSkip(ctx, shown, "unsafe path ('..' would escape the destination)");
      continue;
    }
    if (isSymlinkRecord(r)) {
      exclude.push(r.p);
      pushSkip(ctx, shown, `symbolic link${r.l ? ` → ${r.l}` : ""} (links are not created)`);
      continue;
    }
    if (r.h || r.c) {
      exclude.push(r.p);
      links.push([mapArchivePath(r.p, codePage), mapArchivePath(r.h ?? r.c ?? "", codePage)]);
      continue;
    }
    if (issue === "absolute") absolute++;
    if (r.d) dirs++;
    else {
      files++;
      if (typeof r.s === "number" && r.s > 0) declared += r.s;
    }
  }
  if (absolute) ctx.warnings.push(`${absolute} entr${absolute === 1 ? "y has" : "ies have"} an absolute path; extracted relative to the destination instead.`);

  if (encrypted && !ctx.password) throw passwordError(false, ctx.displayArchive);
  if (files > ctx.maxFiles || dirs > ctx.maxFiles) {
    throw new ExtractError(
      `${ctx.displayArchive} contains ${files.toLocaleString("en-US")} files and ${dirs.toLocaleString("en-US")} folders, over the limit of ${ctx.maxFiles.toLocaleString("en-US")}.`,
      "too_large"
    );
  }
  if (declared > ctx.maxBytes) {
    throw new ExtractError(
      `${ctx.displayArchive} would unpack to ${fmtBytes(declared)}, over the limit of ${fmtBytes(ctx.maxBytes)}.`,
      "too_large"
    );
  }
  const physical = (await fs.stat(archiveAbs)).size;
  if (declared > RATIO_APPLIES_ABOVE && declared / Math.max(1, physical) > MAX_RATIO) {
    throw new ExtractError(
      `${ctx.displayArchive} declares ${fmtBytes(declared)} from ${fmtBytes(physical)} (over ${MAX_RATIO}:1). Refusing it as a likely zip bomb.`,
      "too_large"
    );
  }
  checkAbort(ctx.signal);

  // 3. Extract.
  const args = ["x", inName, "-o/out", "-y", "-aou", "-bsp0", "-spd", ...common];
  if (exclude.length) args.push("-x@/apim-exclude.txt");
  const ex = await run7z(args, {
    inDir,
    outDir,
    mode: "extract",
    maxBytes: ctx.maxBytes,
    maxFiles: ctx.maxFiles,
    codePage,
    exclude,
    signal: ctx.signal,
  });
  const exMsgs = engineMessages(ex);
  if (ex.threw) {
    if (ctx.password && encrypted) throw passwordError(true, ctx.displayArchive);
    throw new ExtractError(`${ctx.displayArchive} could not be extracted: the archive is damaged or in an unsupported variant.`, "corrupt");
  }
  if (ex.code !== 0 && ex.code !== 1) {
    if (exMsgs.some((l) => PASSWORD_RE.test(l))) throw passwordError(!!ctx.password, ctx.displayArchive);
    throw new ExtractError(
      `${ctx.displayArchive} could not be fully extracted: ${exMsgs.join("; ") || `7-Zip exit ${ex.code}`}. Nothing was written.`,
      "corrupt"
    );
  }
  if (ex.code === 1) for (const m of exMsgs) ctx.warnings.push(`7-Zip: ${m}`);
  if (ex.decoded > 0 && codePage) {
    ctx.warnings.push(`Some names were stored in a legacy code page, not UTF-8; decoded them as ${codePage}.`);
  }
  for (const b of ex.blocked) pushSkip(ctx, b, "symbolic link (not created)");
  if (ex.renamed.length) {
    const sample = ex.renamed
      .slice(0, 3)
      .map(([a, b]) => `'${a}' → '${b}'`)
      .join(", ");
    ctx.warnings.push(
      `Renamed ${ex.renamed.length}${ex.renamed.length >= 500 ? "+" : ""} name${ex.renamed.length === 1 ? "" : "s"} that are not valid on Windows (e.g. ${sample}).`
    );
  }
  return { type: (list.header.Type ?? "").toLowerCase(), records, codePage, links };
}

/* ------------------------------------------------------------------ */
/* Placing the output                                                  */
/* ------------------------------------------------------------------ */

interface WalkOut {
  files: { rel: string; bytes: number }[];
  dirs: string[];
  bytes: number;
}

/** Walk the unpacked tree: drop anything that is not a plain file or folder. */
async function walkOutput(root: string, ctx: Ctx): Promise<WalkOut> {
  const out: WalkOut = { files: [], dirs: [], bytes: 0 };
  const stack: string[] = [""];
  while (stack.length) {
    const rel = stack.pop()!;
    const abs = rel ? path.join(root, rel) : root;
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const fileStats: Promise<void>[] = [];
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(abs, e.name);
      if (e.isSymbolicLink()) {
        await fs.unlink(childAbs).catch(() => {});
        pushSkip(ctx, childRel, "symbolic link (removed)");
      } else if (e.isDirectory()) {
        out.dirs.push(childRel);
        stack.push(childRel);
      } else if (e.isFile()) {
        fileStats.push(
          fs.lstat(childAbs).then((st) => {
            out.files.push({ rel: childRel, bytes: st.size });
            out.bytes += st.size;
          })
        );
      } else {
        await fs.rm(childAbs, { force: true }).catch(() => {});
        pushSkip(ctx, childRel, "special file (device/fifo/socket, not created)");
      }
    }
    await Promise.all(fileStats);
    if (out.files.length > ctx.maxFiles || out.dirs.length > ctx.maxFiles) {
      throw new ExtractError(`Extraction stopped: more than ${ctx.maxFiles.toLocaleString("en-US")} entries`, "too_large");
    }
    if (out.bytes > ctx.maxBytes) {
      throw new ExtractError(`Extraction stopped: the archive unpacks to more than ${fmtBytes(ctx.maxBytes)}`, "too_large");
    }
    checkAbort(ctx.signal);
  }
  return out;
}

/** Hardlinks become ordinary copies of their target, when it was extracted. */
async function materialiseLinks(root: string, links: [string, string][], ctx: Ctx): Promise<void> {
  for (const [link, target] of links) {
    const bad = !link || !target || pathIssue(link) || pathIssue(target);
    const src = path.join(root, target);
    const dst = path.join(root, link);
    const st = bad ? null : await exists(src);
    if (!st?.isFile() || (await exists(dst))) {
      pushSkip(ctx, link, `hard link to ${target || "?"} (target not extracted)`);
      continue;
    }
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
  }
  if (links.length) ctx.warnings.push(`${links.length} hard link${links.length === 1 ? " was" : "s were"} extracted as a copy of the linked file.`);
}

function isFirstSegmentInternal(rel: string): boolean {
  const first = toPosix(rel).split("/").filter((s) => s && s !== ".")[0] ?? "";
  const lower = process.platform === "win32" ? first.toLowerCase() : first;
  return lower === ".history" || lower === ".snapshots" || lower === ".workspace-id";
}

/**
 * Merge `src` into an existing, non-empty `dest`. Never overwrites a file,
 * never writes into the app's internal folders or into an existing .git.
 * Returns the set of source-relative paths that were NOT moved.
 */
async function mergeInto(
  workspaceId: string,
  src: string,
  destRel: string,
  ctx: Ctx
): Promise<Set<string>> {
  const notMoved = new Set<string>();
  async function walk(rel: string): Promise<void> {
    const entries = await fs.readdir(rel ? path.join(src, rel) : src, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const wsRel = joinRel(destRel, childRel);
      const target = resolveInside(workspaceId, wsRel);
      const there = await exists(target);
      // Merging never creates or touches .git (a planted .git/config can
      // name programs git runs) or the app's internal folders. A fresh
      // destination folder is different: it holds only the archive.
      if (isFirstSegmentInternal(wsRel) || isProtectedPath(wsRel)) {
        notMoved.add(childRel);
        pushSkip(ctx, childRel, `would write ${wsRel}, a protected path (.git, .history, .snapshots)`);
        continue;
      }
      if (!there) {
        await renameRetry(path.join(src, childRel), target);
      } else if (there.isDirectory() && e.isDirectory()) {
        await walk(childRel);
      } else {
        notMoved.add(childRel);
        pushSkip(ctx, childRel, `${wsRel} already exists (kept the existing one)`);
      }
    }
  }
  await walk("");
  return notMoved;
}

function sortEntries(a: { path: string }, b: { path: string }): number {
  const da = a.path.split("/").length;
  const db = b.path.split("/").length;
  return da - db || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function nestedArchivesOf(paths: string[]): string[] {
  return paths.filter((p) => sniffArchive(new Uint8Array(0), p) !== null).slice(0, 200);
}

/** Every moved file relative to dest (the full walk, not the capped list). */
function* entriesAll(
  walked: WalkOut,
  prefix: string,
  isMoved: (rel: string) => boolean
): Generator<{ rel: string; bytes: number }> {
  for (const f of walked.files) {
    if (prefix && !f.rel.startsWith(prefix)) continue;
    const rel = f.rel.slice(prefix.length);
    if (isMoved(rel)) yield { rel, bytes: f.bytes };
  }
}

/** Pick `base`, `base-2`, … — the first that is missing or an empty folder. */
async function uniqueDir(workspaceId: string, parentRel: string, base: string): Promise<string> {
  for (let n = 1; n < 10_000; n++) {
    const rel = joinRel(parentRel, n === 1 ? base : `${base}-${n}`);
    const abs = resolveInside(workspaceId, rel);
    const st = await exists(abs);
    if (!st || (st.isDirectory() && (await isEmptyDir(abs)))) return rel;
  }
  throw new ExtractError(`No free folder name for ${base}`, "bad_dest");
}

async function uniqueFile(workspaceId: string, dirRel: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; n < 10_000; n++) {
    const rel = joinRel(dirRel, n === 1 ? name : `${stem}-${n}${ext}`);
    if (!(await exists(resolveInside(workspaceId, rel)))) return rel;
  }
  throw new ExtractError(`No free file name for ${name}`, "bad_dest");
}

function validateDest(workspaceId: string, rel: string): string {
  const clean = toPosix(rel.trim()).replace(/\/+$/, "") || ".";
  if (clean !== "." && (isProtectedPath(clean) || isFirstSegmentInternal(clean))) {
    throw new ExtractError(`${clean} is a protected folder; choose another destination.`, "bad_dest");
  }
  try {
    resolveInside(workspaceId, clean);
  } catch (err) {
    throw new ExtractError(`Invalid destination ${clean}: ${(err as Error).message}`, "bad_dest");
  }
  return clean;
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

const COMPRESSOR_TYPES = new Set(["gzip", "gz", "bzip2", "bz2", "xz", "zstd", "zst", "lzma", "lzma86", "z", "split"]);

/**
 * Unpack an archive that is already in the workspace.
 *
 * Folders land next to the archive in a folder named after it
 * (`uploads/game.zip` → `uploads/game/`, or `game-2/` if that is taken);
 * when the archive holds a single top-level folder of that same name its
 * contents are hoisted, so the result is not `game/game/`. Single-file
 * compressors (`data.json.gz`) produce the file itself next to the archive;
 * a compressed tar (`.tar.gz`, `.tgz`, `.tar.xz`, …) is unpacked fully.
 * An explicit `dest` folder that already has files is merged into without
 * overwriting anything.
 */
export async function extractArchive(
  workspaceId: string,
  archivePath: string,
  opts: ExtractOptions = {}
): Promise<ExtractResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  checkAbort(opts.signal);

  await ensureRoot(workspaceId);
  const archiveRel = toPosix(String(archivePath ?? "").trim()).replace(/^\.\//, "");
  let archiveAbs: string;
  try {
    archiveAbs = resolveInside(workspaceId, archiveRel);
  } catch (err) {
    if (err instanceof WorkspaceError) throw new ExtractError(err.message, "not_found");
    throw err;
  }
  const st = await exists(archiveAbs);
  if (!st) throw new ExtractError(`${archiveRel} does not exist in the workspace`, "not_found");
  if (!st.isFile()) throw new ExtractError(`${archiveRel} is not a file`, "not_found");

  const archiveName = path.basename(archiveAbs);
  const head = await readHead(archiveAbs);
  const kind = sniffArchive(head, archiveName, { force: true });
  if (!kind) throw new ExtractError(`${archiveRel} is not a recognised archive`, "not_archive");

  const archiveDirRel = relDir(archiveRel);
  if (opts.dest == null || String(opts.dest).trim() === "") {
    if (archiveDirRel && (isProtectedPath(archiveDirRel) || isFirstSegmentInternal(archiveDirRel))) {
      throw new ExtractError(
        `${archiveRel} is inside a protected folder; pass a destination folder to extract it elsewhere.`,
        "bad_dest"
      );
    }
  }
  const explicitDest = opts.dest != null && String(opts.dest).trim() !== "" ? validateDest(workspaceId, String(opts.dest)) : null;

  const ctx: Ctx = {
    displayArchive: archiveRel,
    password: opts.password,
    signal: opts.signal,
    maxBytes,
    maxFiles,
    encoding: opts.encoding,
    skipped: [],
    warnings: [],
  };

  // Temp folders are siblings of where the output will land, so the final
  // move is a rename on the same volume.
  const tempParentRel = explicitDest ? relDir(explicitDest) : archiveDirRel;
  const tempParent = tempParentRel ? resolveInside(workspaceId, tempParentRel) : workspaceDirectory(workspaceId);
  await sweepStaleTemps(tempParent);

  const temps: string[] = [];
  const cleanup = async () => {
    for (const t of temps) await removeTree(t);
  };

  try {
    const temp1 = await makeTemp(tempParent);
    temps.push(temp1);
    let pass = await unpack(archiveAbs, temp1, ctx);
    let outRoot = temp1;

    if (COMPRESSOR_TYPES.has(pass.type)) {
      // gzip & co. hold one stream. It is either a tar (or, for a split
      // .001 set, the joined archive) to unpack further, or the result.
      const produced = (await fs.readdir(temp1, { withFileTypes: true })).filter((e) => e.isFile());
      if (produced.length !== 1) throw new ExtractError(`${archiveRel} did not decompress to a single file`, "corrupt");
      const innerAbs = path.join(temp1, produced[0].name);
      const innerKind = sniffArchive(await readHead(innerAbs), produced[0].name, { force: true });
      const tarByName =
        /\.(tgz|tbz2?|txz|tzst|taz|tpz)$/i.test(archiveName) || /\.tar$/i.test(produced[0].name);
      const unpackInner = innerKind === "tar" || (innerKind !== null && tarByName) || (pass.type === "split" && innerKind !== null);

      if (!unpackInner) {
        const name = stripCompressorExt(archiveName) || (produced[0].name !== archiveName ? produced[0].name : `${archiveName}.out`);
        const dirRel = explicitDest ?? (archiveDirRel || ".");
        const dirAbs = dirRel === "." ? workspaceDirectory(workspaceId) : resolveInside(workspaceId, dirRel);
        await fs.mkdir(dirAbs, { recursive: true });
        const finalRel = await uniqueFile(workspaceId, dirRel, sharedFns().mapName(name));
        const finalAbs = resolveInside(workspaceId, finalRel);
        await renameRetry(innerAbs, finalAbs);
        resolveInside(workspaceId, finalRel);
        await cleanup();
        const size = (await fs.stat(finalAbs)).size;
        return {
          dest: dirRel,
          files: 1,
          dirs: 0,
          bytes: size,
          entries: [{ path: finalRel, bytes: size }],
          nestedArchives: nestedArchivesOf([finalRel]),
          skipped: ctx.skipped,
          warnings: ctx.warnings,
        };
      }

      checkAbort(opts.signal);
      const temp2 = await makeTemp(tempParent);
      temps.push(temp2);
      pass = await unpack(innerAbs, temp2, { ...ctx, displayArchive: `${archiveRel} (inner ${produced[0].name})` });
      await removeTree(temp1);
      outRoot = temp2;
    }

    checkAbort(opts.signal);
    await materialiseLinks(outRoot, pass.links, ctx);
    const walked = await walkOutput(outRoot, ctx);

    // Choose the destination and move the tree into place.
    const base = sharedFns().mapName(stripArchiveExt(archiveName));
    let src = outRoot;
    let prefix = "";
    let destRel: string;
    let notMoved = new Set<string>();
    let freshDest = false;

    if (explicitDest) {
      destRel = explicitDest;
      const destAbs = destRel === "." ? workspaceDirectory(workspaceId) : resolveInside(workspaceId, destRel);
      const destStat = await exists(destAbs);
      if (destStat && !destStat.isDirectory()) throw new ExtractError(`${destRel} exists and is not a folder`, "bad_dest");
      checkAbort(opts.signal);
      if (!destStat || (await isEmptyDir(destAbs))) {
        if (destStat) await fs.rmdir(destAbs);
        await fs.mkdir(path.dirname(destAbs), { recursive: true });
        await renameRetry(src, destAbs);
        freshDest = true;
      } else {
        notMoved = await mergeInto(workspaceId, src, destRel, ctx);
      }
    } else {
      const top = await fs.readdir(outRoot, { withFileTypes: true });
      if (top.length === 1 && top[0].isDirectory() && top[0].name.toLowerCase() === base.toLowerCase()) {
        src = path.join(outRoot, top[0].name);
        prefix = `${top[0].name}/`;
      }
      checkAbort(opts.signal);
      // A default destination is always a fresh folder. Another extraction
      // may claim the same name between the check and the rename; whoever
      // loses simply takes the next free name.
      for (let attempt = 0; ; attempt++) {
        destRel = await uniqueDir(workspaceId, archiveDirRel, base);
        const destAbs = resolveInside(workspaceId, destRel);
        try {
          if (await exists(destAbs)) await fs.rmdir(destAbs);
          await fs.mkdir(path.dirname(destAbs), { recursive: true });
          await renameRetry(src, destAbs);
          freshDest = true;
          break;
        } catch (err) {
          if (attempt >= 50 || !(await exists(destAbs))) throw err;
        }
      }
    }
    await cleanup();

    // Report what is really there now, and verify every path.
    const isMoved = (rel: string) => {
      const parts = rel.split("/");
      for (let i = 1; i <= parts.length; i++) if (notMoved.has(parts.slice(0, i).join("/"))) return false;
      return true;
    };
    const entries: { path: string; bytes: number }[] = [];
    let files = 0;
    let bytes = 0;
    try {
      for (const f of walked.files) {
        if (prefix && !f.rel.startsWith(prefix)) continue;
        const rel = f.rel.slice(prefix.length);
        if (!isMoved(rel)) continue;
        const wsRel = joinRel(destRel, rel);
        resolveInside(workspaceId, wsRel);
        files++;
        bytes += f.bytes;
        entries.push({ path: wsRel, bytes: f.bytes });
      }
    } catch (err) {
      // Cannot happen with the checks above; if it ever does, take the whole
      // result back out rather than leave a tree that escapes the workspace.
      if (freshDest && destRel !== ".") await removeTree(resolveInside(workspaceId, destRel));
      throw err;
    }
    const movedDirs = walked.dirs
      .filter((d) => (!prefix || d.startsWith(prefix)) && isMoved(d.slice(prefix.length)))
      .map((d) => d.slice(prefix.length));
    const dirs = movedDirs.length;
    entries.sort(sortEntries);
    const nestedArchives = nestedArchivesOf(entries.map((e) => e.path));

    // Exact aggregates for the summary, from every file rather than the
    // capped listing.
    const folderAgg = new Map<string, { files: number; bytes: number }>();
    for (const d of movedDirs) if (d.split("/").length <= 3) folderAgg.set(d, { files: 0, bytes: 0 });
    const typeAgg = new Map<string, { files: number; bytes: number }>();
    for (const e of entriesAll(walked, prefix, isMoved)) {
      const parts = e.rel.split("/");
      for (let i = 1; i < parts.length && i <= 3; i++) {
        const key = parts.slice(0, i).join("/");
        const a = folderAgg.get(key) ?? { files: 0, bytes: 0 };
        a.files++;
        a.bytes += e.bytes;
        folderAgg.set(key, a);
      }
      const t = typeAgg.get(typeKey(e.rel)) ?? { files: 0, bytes: 0 };
      t.files++;
      t.bytes += e.bytes;
      typeAgg.set(typeKey(e.rel), t);
    }
    const folders = [...folderAgg.entries()]
      .map(([k, v]) => ({ path: joinRel(destRel, k), ...v }))
      .sort(sortEntries)
      .slice(0, 2000);
    const fileTypes = [...typeAgg.entries()]
      .map(([ext, v]) => ({ ext, ...v }))
      .sort((a, b) => b.files - a.files || b.bytes - a.bytes);

    return {
      dest: destRel,
      files,
      dirs,
      bytes,
      entries: entries.slice(0, MAX_LISTED_ENTRIES),
      nestedArchives,
      skipped: ctx.skipped,
      warnings: ctx.warnings,
      folders,
      fileTypes,
    };
  } catch (err) {
    await cleanup();
    if (err instanceof ExtractError) throw err;
    if (err instanceof WorkspaceError) throw new ExtractError(err.message, "bad_dest");
    throw new ExtractError(`Extraction failed: ${(err as Error)?.message ?? err}`, "engine");
  }
}

/* ------------------------------------------------------------------ */
/* Summary for the model                                               */
/* ------------------------------------------------------------------ */

interface TreeNode {
  name: string;
  dirs: Map<string, TreeNode>;
  files: { name: string; bytes: number }[];
  count: number;
  bytes: number;
  exact?: { files: number; bytes: number };
}

function newNode(name: string): TreeNode {
  return { name, dirs: new Map(), files: [], count: 0, bytes: 0 };
}

function typeKey(p: string): string {
  const ext = extOf(p);
  return ext ? `.${ext}` : "(no ext)";
}

const NOTABLE_NAMES = new Set([
  "package.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "pipfile",
  "cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "cmakelists.txt",
  "makefile", "dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yaml",
  "composer.json", "gemfile", "project.godot", "tsconfig.json", "vite.config.ts",
  "vite.config.js", "next.config.js", "next.config.ts", "index.html", "main.py", "__main__.py",
  "app.py", "manage.py", "index.js", "index.ts", "main.js", "main.ts", "server.js", "app.js",
  "main.go", "main.rs", "lib.rs", "program.cs", "main.c", "main.cpp", "main.java", "main.kt",
  "build.sh", "install.sh", "run.sh", "start.bat", "run.bat",
]);
const NOTABLE_EXTS = new Set([
  "sln", "csproj", "vcxproj", "fsproj", "uproject", "xcodeproj", "exe", "dll", "so", "dylib",
  "msi", "sys", "apk", "ipa", "jar", "ps1",
]);

function isNotable(p: string): boolean {
  const base = p.split("/").pop() ?? "";
  const lower = base.toLowerCase();
  return /^readme(\.|$)/.test(lower) || NOTABLE_NAMES.has(lower) || NOTABLE_EXTS.has(extOf(lower));
}

/**
 * A compact, model-facing manifest of an extraction: counts, a directory
 * tree (collapsed to fit), a file-type histogram, notable files, nested
 * archives, and anything skipped or worth a warning.
 */
export function formatExtractSummary(r: ExtractResult, opts: { maxTreeLines?: number } = {}): string {
  const maxTree = Math.max(5, opts.maxTreeLines ?? 60);
  const lines: string[] = [];
  const destShown = r.dest === "." ? "the workspace root" : `${r.dest}/`;
  lines.push(
    `Extracted ${r.files.toLocaleString("en-US")} file${r.files === 1 ? "" : "s"}` +
      (r.dirs ? ` in ${r.dirs.toLocaleString("en-US")} folder${r.dirs === 1 ? "" : "s"}` : "") +
      ` (${fmtBytes(r.bytes)}) to ${destShown}`
  );

  // Tree, relative to dest.
  const prefix = r.dest === "." ? "" : `${r.dest}/`;
  const relOf = (p: string) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
  const root = newNode(".");
  root.exact = { files: r.files, bytes: r.bytes };
  const nodeFor = (parts: string[]): TreeNode => {
    let node = root;
    for (const part of parts) {
      let next = node.dirs.get(part);
      if (!next) {
        next = newNode(part);
        node.dirs.set(part, next);
      }
      node = next;
    }
    return node;
  };
  for (const e of r.entries) {
    const parts = relOf(e.path).split("/");
    let node = root;
    node.count++;
    node.bytes += e.bytes;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) {
        next = newNode(part);
        node.dirs.set(part, next);
      }
      node = next;
      node.count++;
      node.bytes += e.bytes;
    }
    node.files.push({ name: parts[parts.length - 1], bytes: e.bytes });
  }
  for (const f of r.folders ?? []) {
    const node = nodeFor(relOf(f.path).split("/").filter(Boolean));
    node.exact = { files: f.files, bytes: f.bytes };
  }
  const total = (n: TreeNode) => n.exact ?? { files: n.count, bytes: n.bytes };

  const plural = (n: number, w: string) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
  const render = (maxDepth: number, DIRS_PER_DIR: number, FILES_PER_DIR: number): string[] => {
    const out: string[] = [];
    const walk = (node: TreeNode, depth: number, indent: string) => {
      const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
      for (const d of dirs.slice(0, DIRS_PER_DIR)) {
        // Collapse chains of single-folder directories: a/b/c/
        let label = d.name;
        let cur = d;
        while (cur.files.length === 0 && cur.dirs.size === 1) {
          const only = [...cur.dirs.values()][0];
          if (total(only).files !== total(cur).files) break;
          cur = only;
          label += `/${cur.name}`;
        }
        const t = total(cur);
        out.push(`${indent}${label}/  (${t.files ? `${plural(t.files, "file")}, ${fmtBytes(t.bytes)}` : "empty"})`);
        if (depth + 1 < maxDepth) walk(cur, depth + 1, indent + "  ");
      }
      if (dirs.length > DIRS_PER_DIR) {
        const rest = dirs.slice(DIRS_PER_DIR);
        const n = rest.reduce((a, d) => a + total(d).files, 0);
        const b = rest.reduce((a, d) => a + total(d).bytes, 0);
        out.push(`${indent}… ${plural(rest.length, "more folder")} (${plural(n, "file")}, ${fmtBytes(b)})`);
      }
      const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
      for (const f of files.slice(0, FILES_PER_DIR)) out.push(`${indent}${f.name}  (${fmtBytes(f.bytes)})`);
      // Everything under this folder not accounted for by a line above.
      const shownFiles = files.slice(0, FILES_PER_DIR);
      const t = total(node);
      const n = t.files - shownFiles.length - dirs.reduce((a, d) => a + total(d).files, 0);
      const b = t.bytes - shownFiles.reduce((a, f) => a + f.bytes, 0) - dirs.reduce((a, d) => a + total(d).bytes, 0);
      if (n > 0) out.push(`${indent}… ${plural(n, "more file")} (${fmtBytes(Math.max(0, b))})`);
    };
    walk(root, 0, "  ");
    return out;
  };
  // Widest listing that fits at the top level, then as deep as still fits.
  const CAPS: [number, number][] = [[12, 8], [8, 5], [5, 3], [3, 2], [1, 1]];
  const caps = CAPS.find(([dc, fc]) => render(1, dc, fc).length <= maxTree) ?? CAPS[CAPS.length - 1];
  let tree = render(1, caps[0], caps[1]);
  for (let depth = 2; depth <= 8; depth++) {
    const next = render(depth, caps[0], caps[1]);
    if (next.length > maxTree || next.length === tree.length) break;
    tree = next;
  }
  if (tree.length > maxTree) {
    const hidden = tree.length - maxTree + 1;
    tree = [...tree.slice(0, maxTree - 1), `  … ${hidden} more lines`];
  }
  if (r.files || r.dirs) {
    lines.push("", `${r.dest === "." ? "./" : `${r.dest}/`}`, ...tree);
  }

  // File types.
  let types = r.fileTypes?.map((t) => [t.ext, { n: t.files, bytes: t.bytes }] as const);
  if (!types) {
    const m = new Map<string, { n: number; bytes: number }>();
    for (const e of r.entries) {
      const key = typeKey(e.path);
      const t = m.get(key) ?? { n: 0, bytes: 0 };
      t.n++;
      t.bytes += e.bytes;
      m.set(key, t);
    }
    types = [...m.entries()].sort((a, b) => b[1].n - a[1].n || b[1].bytes - a[1].bytes);
  }
  if (types.length > 1) {
    const shown = types.slice(0, 10).map(([k, v]) => `${k} ${v.n.toLocaleString("en-US")} (${fmtBytes(v.bytes)})`);
    if (types.length > 10) shown.push(`${types.length - 10} other types`);
    lines.push("", `File types: ${shown.join(" · ")}`);
  }

  const notable = r.entries.filter((e) => isNotable(e.path)).slice(0, 15);
  if (notable.length) {
    lines.push("", "Notable files:", ...notable.map((e) => `  ${e.path}  (${fmtBytes(e.bytes)})`));
  }

  if (r.nestedArchives.length) {
    const sizes = new Map(r.entries.map((e) => [e.path, e.bytes] as const));
    lines.push(
      "",
      `Nested archives (${r.nestedArchives.length}, NOT extracted — call extract_archive on one if you need its contents):`,
      ...r.nestedArchives.slice(0, 20).map((p) => `  ${p}${sizes.has(p) ? `  (${fmtBytes(sizes.get(p)!)})` : ""}`)
    );
    if (r.nestedArchives.length > 20) lines.push(`  … ${r.nestedArchives.length - 20} more`);
  }

  if (r.skipped.length) {
    lines.push("", `Skipped ${r.skipped.length}:`, ...r.skipped.slice(0, 15).map((s) => `  ${s.path} — ${s.reason}`));
    if (r.skipped.length > 15) lines.push(`  … ${r.skipped.length - 15} more`);
  }
  if (r.warnings.length) {
    lines.push("", "Warnings:", ...r.warnings.slice(0, 10).map((w) => `  ${w}`));
  }
  return lines.join("\n");
}

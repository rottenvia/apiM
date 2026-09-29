/**
 * Archive extraction: every format unpacks byte-exact, and hostile archives
 * cannot escape the destination, bomb the disk, or leave half-written output.
 *
 * Run:  npm run test:extract
 *       npm run test:extract -- --perf   (adds timing + peak RSS for a 200MB
 *                                         zip of 20k files and a 300MB 7z member)
 *
 * Fixtures are built at test time wherever a writer exists: 7-Zip itself
 * (7z-wasm) for zip/7z/tar/gzip/bzip2/xz/wim and split volumes, Node's zlib,
 * the small zip/tar/zstd writers below for entries no well-behaved tool
 * produces (`..`, symlinks, forged sizes, CP866 names), and Python's
 * zipfile/tarfile when a Python is installed, as a second independent
 * writer. Nothing can create RAR, CAB or ISO here, so tiny samples from
 * libarchive's test suite (BSD-2-Clause, libarchive/test/test_read_format_*)
 * are committed in scripts/fixtures/extract/.
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.APIM_DATA_ROOT ??= path.join(ROOT, ".test-data", "extract");
const DATA = path.resolve(process.env.APIM_DATA_ROOT);
fs.rmSync(DATA, { recursive: true, force: true });
const FIX = path.join(ROOT, "scripts", "fixtures", "extract");
const PERF = process.argv.includes("--perf");

const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const X = await load("src/lib/extract.ts");
const WS = await load("src/lib/workspace.ts");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);
let pass = 0,
  fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

/** Run fn, return the ExtractError it throws (or null). */
async function failure(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
}

const fdCount = () => {
  try {
    return fs.readdirSync("/proc/self/fd").length;
  } catch {
    return -1; // Not Linux.
  }
};
const fdsAtStart = fdCount();

/* ------------------------------------------------------------------ */
/* Writers                                                             */
/* ------------------------------------------------------------------ */

const require = createRequire(path.join(ROOT, "package.json"));
const SevenZip = require("7z-wasm");

/** Run the real 7-Zip (in-process) with `cwd` mounted as the working dir. */
async function sevenZip(cwd, args) {
  const out = [];
  const m = await SevenZip({ print: (s) => out.push(s), printErr: (s) => out.push(s), stdin: () => null });
  m.FS.mkdir("/w");
  m.FS.mount(m.NODEFS, { root: path.resolve(cwd, "..") }, "/w");
  m.FS.chdir("/w/" + path.basename(cwd));
  let code;
  try {
    code = m.callMain(args);
  } catch (e) {
    code = `threw ${e}`;
  }
  if (code !== 0) throw new Error(`7z ${args.join(" ")} → ${code}: ${out.slice(-6).join(" | ")}`);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A stored-only zip with full control over names and headers.
 * entry: { name: string|Buffer, data?, dir?, mode? (unix), utf8?, declared? }
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, "utf8");
    const data = e.data ? Buffer.from(e.data) : Buffer.alloc(0);
    const utf8 = e.utf8 ?? (!Buffer.isBuffer(e.name) && /[^\x00-\x7f]/.test(e.name));
    const flags = utf8 ? 0x800 : 0;
    const crc = crc32(data);
    const size = e.declared ?? data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(size >>> 0, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(e.mode ? (3 << 8) | 20 : 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(size >>> 0, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((((e.mode ?? 0) << 16) | (e.dir ? 0x10 : 0)) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A ustar archive. entry: { name, data?, type? ('0','2' symlink,'1' hardlink,'5' dir), link?, mode? } */
function makeTar(entries) {
  const parts = [];
  const octal = (h, v, off, len) => h.write(v.toString(8).padStart(len - 1, "0") + "\0", off, len, "ascii");
  for (const e of entries) {
    const data = e.data ? Buffer.from(e.data) : Buffer.alloc(0);
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, "utf8");
    octal(h, e.mode ?? 0o644, 100, 8);
    octal(h, 0, 108, 8);
    octal(h, 0, 116, 8);
    octal(h, data.length, 124, 12);
    octal(h, 1_600_000_000, 136, 12);
    h.write("        ", 148, 8, "ascii");
    h.write(e.type ?? "0", 156, 1, "ascii");
    if (e.link) h.write(e.link, 157, 100, "utf8");
    h.write("ustar\0", 257, 6, "ascii");
    h.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** A valid zstd frame made of raw (uncompressed) blocks. */
function makeZstd(content) {
  const out = [Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xa0])];
  const fcs = Buffer.alloc(4);
  fcs.writeUInt32LE(content.length, 0);
  out.push(fcs);
  const MAX = 128 * 1024;
  for (let off = 0; off < content.length || off === 0; off += MAX) {
    const chunk = content.subarray(off, off + MAX);
    const last = off + MAX >= content.length ? 1 : 0;
    const v = last | (0 << 1) | (chunk.length << 3);
    out.push(Buffer.from([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff]), chunk);
    if (!content.length) break;
  }
  return Buffer.concat(out);
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** Every file under dir → { rel: sha256 }, plus folders and any symlinks. */
function snapshot(dir) {
  const files = {};
  const dirs = [];
  const links = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(abs, e.name);
      if (e.isSymbolicLink()) links.push(childRel);
      else if (e.isDirectory()) {
        dirs.push(childRel);
        walk(childAbs, childRel);
      } else files[childRel] = sha(fs.readFileSync(childAbs));
    }
  };
  walk(dir, "");
  return { files, dirs, links };
}

/* ------------------------------------------------------------------ */
/* Workspace and source tree                                           */
/* ------------------------------------------------------------------ */

const WID = "extract-test";
const wsRoot = await WS.ensureRoot(WID);
const IN = path.join(wsRoot, "in");
fs.mkdirSync(IN, { recursive: true });
const BUILD = path.join(DATA, "build");
const TREE = path.join(BUILD, "tree");
const ARCH = path.join(BUILD, "arch");
fs.mkdirSync(ARCH, { recursive: true });

const innerZip = makeZip([{ name: "inside.txt", data: "nested\n" }]);
const allBytes = Buffer.alloc(256 * 64);
for (let i = 0; i < allBytes.length; i++) allBytes[i] = i & 0xff;
const TREE_FILES = {
  "README.md": "# Demo\n",
  "package.json": '{ "name": "demo" }\n',
  "src/index.js": "console.log('hi');\n",
  "src/lib/util.js": "export const x = 1;\n",
  "assets/blob.bin": crypto.randomBytes(300_000),
  "assets/all-bytes.bin": allBytes,
  "assets/zero.bin": Buffer.alloc(0),
  "unicode/привет мир.txt": "privet\n",
  "unicode/日本語 ファイル.txt": "nihongo\n",
  "deep/a/b/c/d/e.txt": "deep\n",
  "vendor/inner.zip": innerZip,
  "bin/tool.exe": Buffer.concat([Buffer.from("MZ"), crypto.randomBytes(2000)]),
};
for (const [rel, data] of Object.entries(TREE_FILES)) {
  fs.mkdirSync(path.dirname(path.join(TREE, rel)), { recursive: true });
  fs.writeFileSync(path.join(TREE, rel), data);
}
fs.mkdirSync(path.join(TREE, "emptydir"), { recursive: true });
const TREE_SHA = Object.fromEntries(Object.entries(TREE_FILES).map(([k, v]) => [k, sha(Buffer.from(v))]));

const put = (name, data) => {
  fs.mkdirSync(path.dirname(path.join(IN, name)), { recursive: true });
  fs.writeFileSync(path.join(IN, name), data);
  return `in/${name}`;
};
const putFile = (name, src) => put(name, fs.readFileSync(src));
const tempLeftovers = () => {
  const found = [];
  const walk = (abs) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith(".apim-extract-")) found.push(path.join(abs, e.name));
      else if (e.isDirectory()) walk(path.join(abs, e.name));
    }
  };
  walk(wsRoot);
  return found;
};

/* ------------------------------------------------------------------ */
console.log("\nsniffArchive");
/* ------------------------------------------------------------------ */
{
  const head = (name) => new Uint8Array(fs.readFileSync(path.join(FIX, name)).subarray(0, 0x8006));
  const zip = new Uint8Array(innerZip);
  check("zip by magic", X.sniffArchive(zip, "x.bin") === "zip");
  check("7z by magic", X.sniffArchive(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]), "a") === "7z");
  check("rar5 by magic", X.sniffArchive(head("rar5-stored.rar"), "x") === "rar");
  check("rar4 by magic", X.sniffArchive(head("rar4-basic.rar"), "x") === "rar");
  check("cab by magic", X.sniffArchive(head("cab1.cab"), "x") === "cab");
  check(".Z (compress) by magic", X.sniffArchive(head("image.iso.Z"), "x") === "compress");
  check("gzip by magic", X.sniffArchive(new Uint8Array(zlib.gzipSync("x")), "data") === "gzip");
  check("bzip2 by magic", X.sniffArchive(new Uint8Array(Buffer.from("BZh91AY&SY")), "d") === "bzip2");
  check("xz by magic", X.sniffArchive(new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0, 0, 4]), "d") === "xz");
  check("zstd by magic", X.sniffArchive(new Uint8Array(makeZstd(Buffer.from("hi"))), "d") === "zstd");
  check("tar by ustar magic", X.sniffArchive(new Uint8Array(makeTar([{ name: "a", data: "b" }])), "noext") === "tar");
  const iso = new Uint8Array(0x8006);
  iso.set(Buffer.from("CD001"), 0x8001);
  check("iso by CD001 at 0x8001", X.sniffArchive(iso, "disc.bin") === "iso");
  check("docx is not claimed", X.sniffArchive(zip, "report.docx") === null);
  check("xlsx / jar / apk / epub / odt are not claimed", ["a.xlsx", "a.jar", "a.apk", "a.epub", "a.odt", "a.pptx"].every((n) => X.sniffArchive(zip, n) === null));
  check("docx is claimed when forced", X.sniffArchive(zip, "report.docx", { force: true }) === "zip");
  check("extension fallback for a short head", X.sniffArchive(new Uint8Array(0), "x.tar.gz") === "gzip" && X.sniffArchive(new Uint8Array(0), "a.7z") === "7z");
  check("text with a .zip name is not a zip", X.sniffArchive(new Uint8Array(Buffer.alloc(600, 0x41)), "fake.zip") === null);
  check("plain text is not an archive", X.sniffArchive(new Uint8Array(Buffer.from("hello world")), "notes.txt") === null);
  check("stripArchiveExt", X.stripArchiveExt("game.tar.gz") === "game" && X.stripArchiveExt("x.part1.rar") === "x" && X.stripArchiveExt("a.7z.001") === "a" && X.stripArchiveExt("b.tgz") === "b" && X.stripArchiveExt("c.zip") === "c");
}

/* ------------------------------------------------------------------ */
console.log("\nround trip (built by 7-Zip, zlib and the writers here)");
/* ------------------------------------------------------------------ */
await sevenZip(TREE, ["a", "-tzip", "../arch/fmt-zip.zip", "*"]);
await sevenZip(TREE, ["a", "-t7z", "../arch/fmt-7z.7z", "*"]);
await sevenZip(TREE, ["a", "-ttar", "../arch/fmt-tar.tar", "*"]);
await sevenZip(TREE, ["a", "-twim", "../arch/fmt-wim.wim", "*"]);
await sevenZip(TREE, ["a", "-t7z", "-v100k", "../arch/fmt-vol.7z", "*"]);
fs.copyFileSync(path.join(ARCH, "fmt-tar.tar"), path.join(ARCH, "fmt-targz.tar"));
await sevenZip(ARCH, ["a", "-tgzip", "fmt-targz.tar.gz", "fmt-targz.tar"]);
fs.copyFileSync(path.join(ARCH, "fmt-tar.tar"), path.join(ARCH, "fmt-tarbz2.tar"));
await sevenZip(ARCH, ["a", "-tbzip2", "fmt-tarbz2.tar.bz2", "fmt-tarbz2.tar"]);
fs.copyFileSync(path.join(ARCH, "fmt-tar.tar"), path.join(ARCH, "fmt-tarxz.tar"));
await sevenZip(ARCH, ["a", "-txz", "fmt-tarxz.tar.xz", "fmt-tarxz.tar"]);
const tarBytes = fs.readFileSync(path.join(ARCH, "fmt-tar.tar"));
fs.writeFileSync(path.join(ARCH, "fmt-tgz.tgz"), zlib.gzipSync(tarBytes));
fs.writeFileSync(path.join(ARCH, "fmt-tarzst.tar.zst"), makeZstd(tarBytes));
fs.writeFileSync(path.join(ARCH, "backup.gz"), zlib.gzipSync(tarBytes)); // a tar, named only .gz

const formats = [
  ["fmt-zip.zip", "fmt-zip"],
  ["fmt-7z.7z", "fmt-7z"],
  ["fmt-tar.tar", "fmt-tar"],
  ["fmt-targz.tar.gz", "fmt-targz"],
  ["fmt-tgz.tgz", "fmt-tgz"],
  ["fmt-tarbz2.tar.bz2", "fmt-tarbz2"],
  ["fmt-tarxz.tar.xz", "fmt-tarxz"],
  ["fmt-tarzst.tar.zst", "fmt-tarzst"],
  ["fmt-wim.wim", "fmt-wim"],
  ["backup.gz", "backup"],
];

const PY = ["python3", "python", "py"].find((cmd) => {
  try {
    return spawnSync(cmd, cmd === "py" ? ["-3", "--version"] : ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
});
if (PY) {
  const script = `
import sys, os, zipfile, tarfile
tree, out = sys.argv[1], sys.argv[2]
def walk():
    for base, dirs, files in os.walk(tree):
        dirs.sort()
        for n in sorted(dirs + files):
            full = os.path.join(base, n)
            yield full, os.path.relpath(full, tree).replace(os.sep, "/")
with zipfile.ZipFile(os.path.join(out, "py-zip.zip"), "w", zipfile.ZIP_DEFLATED) as z:
    for full, rel in walk():
        z.write(full, rel)
for mode, ext in (("w:gz", "tar.gz"), ("w:bz2", "tar.bz2"), ("w:xz", "tar.xz")):
    with tarfile.open(os.path.join(out, "py-" + ext.replace(".", "") + "." + ext), mode) as t:
        for full, rel in walk():
            t.add(full, rel, recursive=False)
`;
  const res = spawnSync(PY, [...(PY === "py" ? ["-3"] : []), "-c", script, TREE, ARCH], { encoding: "utf8" });
  if (res.status === 0) {
    formats.push(["py-zip.zip", "py-zip"], ["py-targz.tar.gz", "py-targz"], ["py-tarbz2.tar.bz2", "py-tarbz2"], ["py-tarxz.tar.xz", "py-tarxz"]);
  } else console.log(d(`  (python writer failed: ${res.stderr.trim().split("\n").pop()})`));
} else {
  console.log(d("  (no python found — skipping the python-built archives)"));
}

for (const f of fs.readdirSync(ARCH).filter((n) => n.startsWith("fmt-vol.7z."))) putFile(f, path.join(ARCH, f));
formats.push(["fmt-vol.7z.001", "fmt-vol"]);

let zipResult = null;
for (const [file, base] of formats) {
  if (!fs.existsSync(path.join(IN, file))) putFile(file, path.join(ARCH, file));
  let res;
  try {
    res = await X.extractArchive(WID, `in/${file}`);
  } catch (err) {
    check(`${file}: extracts`, false, `${err.code}: ${err.message}`);
    continue;
  }
  if (file === "fmt-zip.zip") zipResult = res;
  const snap = snapshot(path.join(IN, base));
  const expected = Object.keys(TREE_SHA);
  const exact = expected.every((k) => snap.files[k] === TREE_SHA[k]) && Object.keys(snap.files).length === expected.length;
  check(`${file}: lands in in/${base}/`, res.dest === `in/${base}`, res.dest);
  check(`${file}: all ${expected.length} files byte-exact (sha256), unicode names intact`, exact,
    exact ? "" : JSON.stringify(Object.keys(snap.files).filter((k) => snap.files[k] !== TREE_SHA[k]).slice(0, 4)));
  check(`${file}: counts match (files, bytes)`, res.files === expected.length && res.bytes === Object.values(TREE_FILES).reduce((n, v) => n + Buffer.from(v).length, 0));
  if (file !== "fmt-wim.wim") check(`${file}: empty folder kept, nested dirs intact`, snap.dirs.includes("emptydir") && snap.dirs.includes("deep/a/b/c/d"));
}

/* ------------------------------------------------------------------ */
console.log("\nRAR, CAB and ISO (libarchive samples)");
/* ------------------------------------------------------------------ */
{
  const readIn = (rel) => fs.readFileSync(path.join(IN, rel));
  let res = await X.extractArchive(WID, putFile("rar5-stored.rar", path.join(FIX, "rar5-stored.rar")));
  check("RAR5 stored", readIn("rar5-stored/helloworld.txt").toString() === "hello libarchive test suite!\n", res.dest);
  res = await X.extractArchive(WID, putFile("rar5-compressed.rar", path.join(FIX, "rar5-compressed.rar")));
  check("RAR5 compressed (CRC-verified by 7-Zip)", readIn("rar5-compressed/test.bin").length === 1200);
  res = await X.extractArchive(WID, putFile("rar5-multiple.rar", path.join(FIX, "rar5-multiple.rar")));
  check("RAR5 several files", res.files === 4 && [1, 2, 3, 4].every((i) => readIn(`rar5-multiple/test${i}.bin`).length === 4096));
  res = await X.extractArchive(WID, putFile("rar4-unicode.rar", path.join(FIX, "rar4-unicode.rar")));
  check("RAR4 unicode names", fs.existsSync(path.join(IN, "rar4-unicode/表だよ/新しいフォルダ/新規テキスト ドキュメント.txt")) &&
    readIn("rar4-unicode/abcdefghijklmnopqrsテスト.txt").length === 16);
  res = await X.extractArchive(WID, putFile("rar4-basic.rar", path.join(FIX, "rar4-basic.rar")));
  check("RAR4 folders and empty folder", readIn("rar4-basic/testdir/test.txt").toString().startsWith("test text document") &&
    fs.statSync(path.join(IN, "rar4-basic/testemptydir")).isDirectory());
  res = await X.extractArchive(WID, putFile("rar5-hardlink.rar", path.join(FIX, "rar5-hardlink.rar")));
  check("RAR5 hard link becomes a copy of its target", readIn("rar5-hardlink/hardlink.txt").equals(readIn("rar5-hardlink/file.txt")) &&
    !fs.lstatSync(path.join(IN, "rar5-hardlink/hardlink.txt")).isSymbolicLink() && res.warnings.some((w) => /hard link/.test(w)));

  const encH = putFile("rar5-encrypted-headers.rar", path.join(FIX, "rar5-encrypted-headers.rar"));
  let err = await failure(() => X.extractArchive(WID, encH));
  check("RAR5 with encrypted headers, no password → password_required", err?.code === "password_required", err?.message);
  err = await failure(() => X.extractArchive(WID, encH, { password: "nope" }));
  check("RAR5 with encrypted headers, wrong password → wrong_password", err?.code === "wrong_password", err?.message);
  res = await X.extractArchive(WID, encH, { password: "password" });
  check("RAR5 with encrypted headers, right password → extracted", res.files > 0, `${res.files} files`);

  const enc4 = putFile("rar4-encrypted.rar", path.join(FIX, "rar4-encrypted.rar"));
  err = await failure(() => X.extractArchive(WID, enc4));
  check("RAR4 encrypted, no password → password_required", err?.code === "password_required", err?.message);
  res = await X.extractArchive(WID, enc4, { password: "12345678" });
  check("RAR4 encrypted, right password → extracted", res.files === 2 && fs.existsSync(path.join(IN, "rar4-encrypted/foo.txt")));

  res = await X.extractArchive(WID, putFile("cab1.cab", path.join(FIX, "cab1.cab")));
  check("CAB", readIn("cab1/dir1/file1").length === 60 && readIn("cab1/dir2/file2").length === 78 && readIn("cab1/empty").length === 0);
  res = await X.extractArchive(WID, putFile("cab2.cab", path.join(FIX, "cab2.cab")));
  check("CAB, compressed 33000-byte file", readIn("cab2/zero").equals(Buffer.alloc(33000)));

  res = await X.extractArchive(WID, putFile("image.iso.Z", path.join(FIX, "image.iso.Z")));
  check(".Z decompresses to the single file next to it", res.entries.length === 1 && res.entries[0].path === "in/image.iso" && res.dest === "in");
  check("…and the .iso inside is reported as a nested archive", res.nestedArchives.includes("in/image.iso"));
  res = await X.extractArchive(WID, "in/image.iso");
  check("ISO 9660", readIn("image/A/B").toString() === "hello\n" && readIn("image/C/D").toString() === "hello\n", res.dest);
}

/* ------------------------------------------------------------------ */
console.log("\nsingle-file compressors");
/* ------------------------------------------------------------------ */
{
  const json = Buffer.from(JSON.stringify({ hello: "мир", n: [1, 2, 3] }));
  let res = await X.extractArchive(WID, put("single/data.json.gz", zlib.gzipSync(json)));
  check(".gz → the file itself next to the archive", res.dest === "in/single" && res.entries[0]?.path === "in/single/data.json" &&
    fs.readFileSync(path.join(IN, "single/data.json")).equals(json), JSON.stringify(res.entries));
  res = await X.extractArchive(WID, "in/single/data.json.gz");
  check(".gz again → data-2.json, the first is not overwritten", res.entries[0]?.path === "in/single/data-2.json");
  fs.writeFileSync(path.join(BUILD, "log.txt"), "line\n".repeat(1000));
  await sevenZip(BUILD, ["a", "-txz", "arch/log.txt.xz", "log.txt"]);
  await sevenZip(BUILD, ["a", "-tbzip2", "arch/log.txt.bz2", "log.txt"]);
  res = await X.extractArchive(WID, putFile("single/log.txt.xz", path.join(ARCH, "log.txt.xz")));
  check(".xz → log.txt", res.entries[0]?.path === "in/single/log.txt" && fs.readFileSync(path.join(IN, "single/log.txt"), "utf8") === "line\n".repeat(1000));
  res = await X.extractArchive(WID, putFile("single/b/log.txt.bz2", path.join(ARCH, "log.txt.bz2")));
  check(".bz2 → log.txt", res.entries[0]?.path === "in/single/b/log.txt" && res.files === 1);
  res = await X.extractArchive(WID, put("single/z/data.bin.zst", makeZstd(allBytes)));
  check(".zst → data.bin, byte-exact", fs.readFileSync(path.join(IN, "single/z/data.bin")).equals(allBytes));
  check("a .gz holding a tar is unpacked as a folder", fs.existsSync(path.join(IN, "backup/README.md")));
}

/* ------------------------------------------------------------------ */
console.log("\nzip-slip, absolute paths, links");
/* ------------------------------------------------------------------ */
{
  const slip = makeZip([
    { name: "good.txt", data: "good" },
    { name: "../../evil.txt", data: "evil" },
    { name: "..\\..\\evil2.txt", data: "evil" },
    { name: "ok/../../../evil3.txt", data: "evil" },
    { name: "/abs/abs.txt", data: "abs" },
    { name: "C:/win/drive.txt", data: "drive" },
    { name: "link-out", data: "/etc/passwd", mode: 0o120777 },
    { name: "link-rel", data: "good.txt", mode: 0o120777 },
  ]);
  const res = await X.extractArchive(WID, put("hostile/slip.zip", slip));
  const snap = snapshot(path.join(IN, "hostile/slip"));
  const evil = [];
  const hunt = (abs) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (/^evil\d?\.txt$/.test(e.name)) evil.push(path.join(abs, e.name));
      if (e.isDirectory()) hunt(path.join(abs, e.name));
    }
  };
  hunt(DATA);
  check("'..' entries are written nowhere (searched the whole data root)", evil.length === 0, evil.join(", "));
  check("'..' entries are reported as skipped", ["../../evil.txt", "..\\..\\evil2.txt", "ok/../../../evil3.txt"].every((p) => res.skipped.some((s) => s.path === p && /unsafe/.test(s.reason))));
  check("absolute path lands inside dest", snap.files["abs/abs.txt"] === sha(Buffer.from("abs")));
  check("drive-letter path lands inside dest, sanitised", snap.files["C_/win/drive.txt"] === sha(Buffer.from("drive")));
  check("absolute paths are warned about", res.warnings.some((w) => /absolute path/.test(w)));
  check("zip symlinks are not created (neither absolute nor relative)", snap.links.length === 0 && !("link-out" in snap.files) && !("link-rel" in snap.files));
  check("zip symlinks are reported as skipped", ["link-out", "link-rel"].every((p) => res.skipped.some((s) => s.path === p && /symbolic link/.test(s.reason))));
  check("the ordinary file still extracts", snap.files["good.txt"] === sha(Buffer.from("good")));

  const tar = makeTar([
    { name: "d/file.txt", data: "hi" },
    { name: "d/sym", type: "2", link: "/etc/passwd" },
    { name: "d/relsym", type: "2", link: "file.txt" },
    { name: "d/hard", type: "1", link: "d/file.txt" },
    { name: "../slip.txt", data: "slip" },
    { name: "d/zero-mode", data: "z", mode: 0 },
    { name: "d/locked", type: "5", mode: 0 },
    { name: "d/locked/inner.txt", data: "inner" },
  ]);
  const tres = await X.extractArchive(WID, put("hostile/links.tar", tar));
  const tsnap = snapshot(path.join(IN, "hostile/links"));
  check("tar symlinks are not created", tsnap.links.length === 0 && !("d/sym" in tsnap.files) && !("d/relsym" in tsnap.files));
  check("tar symlinks are listed in skipped", tres.skipped.filter((s) => /symbolic link/.test(s.reason)).length === 2);
  check("tar hard link is a plain copy", tsnap.files["d/hard"] === sha(Buffer.from("hi")) && fs.lstatSync(path.join(IN, "hostile/links/d/hard")).nlink === 1);
  check("tar '..' entry skipped", !fs.existsSync(path.join(IN, "hostile/slip.txt")) && tres.skipped.some((s) => s.path === "../slip.txt"));
  check("mode-000 file and folder are still readable and deletable", tsnap.files["d/zero-mode"] === sha(Buffer.from("z")) && tsnap.files["d/locked/inner.txt"] === sha(Buffer.from("inner")) &&
    (process.platform === "win32" || (fs.statSync(path.join(IN, "hostile/links/d/locked")).mode & 0o700) === 0o700));
}

/* ------------------------------------------------------------------ */
console.log("\nbombs and limits");
/* ------------------------------------------------------------------ */
{
  const bomb = makeZip([
    { name: "a.bin", data: "x", declared: 0xf0000000 },
    { name: "b.bin", data: "x", declared: 0xf0000000 },
  ]);
  const archive = put("bomb/declared.zip", bomb);
  let err = await failure(() => X.extractArchive(WID, archive));
  check("declared 7.5 GB (> 4 GiB default) is refused up front", err?.code === "too_large" && /would unpack/.test(err.message), err?.message);
  check("…and nothing was written", !fs.existsSync(path.join(IN, "bomb/declared")) && tempLeftovers().length === 0);

  const ratio = makeZip([{ name: "big.bin", data: "x", declared: 0x60000000 }]);
  err = await failure(() => X.extractArchive(WID, put("bomb/ratio.zip", ratio)));
  check("1.5 GiB declared from ~100 bytes (> 1000:1) is refused as a bomb", err?.code === "too_large" && /bomb/.test(err.message), err?.message);

  err = await failure(() => X.extractArchive(WID, "in/fmt-zip.zip", { maxBytes: 100_000 }));
  check("maxBytes is honoured from the listing", err?.code === "too_large", err?.message);
  err = await failure(() => X.extractArchive(WID, "in/fmt-zip.zip", { maxFiles: 5 }));
  check("maxFiles is honoured from the listing", err?.code === "too_large" && /files/.test(err.message), err?.message);

  // bzip2 declares no size, so only the byte count during the write can stop it.
  fs.writeFileSync(path.join(BUILD, "zeros.bin"), Buffer.alloc(20 * 1024 * 1024));
  await sevenZip(BUILD, ["a", "-tbzip2", "arch/zeros.bin.bz2", "zeros.bin"]);
  const zb = putFile("bomb/zeros.bin.bz2", path.join(ARCH, "zeros.bin.bz2"));
  const t0 = Date.now();
  err = await failure(() => X.extractArchive(WID, zb, { maxBytes: 5 * 1024 * 1024 }));
  check("undeclared size is stopped while writing (bzip2 of 20MB zeros, 5MB cap)", err?.code === "too_large" && /more than/.test(err.message), `${err?.message} (${Date.now() - t0} ms)`);
  check("…and the partial output is removed", !fs.existsSync(path.join(IN, "bomb/zeros.bin")) && tempLeftovers().length === 0);
}

/* ------------------------------------------------------------------ */
console.log("\nencrypted archives");
/* ------------------------------------------------------------------ */
{
  fs.mkdirSync(path.join(BUILD, "secret"), { recursive: true });
  fs.writeFileSync(path.join(BUILD, "secret", "s.txt"), "top secret\n");
  await sevenZip(path.join(BUILD, "secret"), ["a", "-tzip", "-pS3cret", "-mem=AES256", "../arch/enc-aes.zip", "s.txt"]);
  await sevenZip(path.join(BUILD, "secret"), ["a", "-tzip", "-pS3cret", "-mem=ZipCrypto", "../arch/enc-zc.zip", "s.txt"]);
  await sevenZip(path.join(BUILD, "secret"), ["a", "-t7z", "-pS3cret", "../arch/enc-7z.7z", "s.txt"]);
  await sevenZip(path.join(BUILD, "secret"), ["a", "-t7z", "-pS3cret", "-mhe=on", "../arch/enc-he.7z", "s.txt"]);
  for (const f of ["enc-aes.zip", "enc-zc.zip", "enc-7z.7z", "enc-he.7z"]) {
    const a = putFile(`enc/${f}`, path.join(ARCH, f));
    let err = await failure(() => X.extractArchive(WID, a));
    check(`${f}: no password → password_required, clear message`, err?.code === "password_required" && /password-protected/.test(err.message), err?.message);
    err = await failure(() => X.extractArchive(WID, a, { password: "wrong" }));
    check(`${f}: wrong password → wrong_password`, err?.code === "wrong_password", err?.message);
    check(`${f}: failed attempts leave nothing behind`, tempLeftovers().length === 0 && !fs.existsSync(path.join(IN, "enc", X.stripArchiveExt(f))));
    const res = await X.extractArchive(WID, a, { password: "S3cret" });
    check(`${f}: right password → content`, fs.readFileSync(path.join(wsRoot, res.entries[0].path), "utf8") === "top secret\n");
  }
}

/* ------------------------------------------------------------------ */
console.log("\ncancellation");
/* ------------------------------------------------------------------ */
{
  const ac = new AbortController();
  ac.abort();
  let err = await failure(() => X.extractArchive(WID, "in/fmt-zip.zip", { signal: ac.signal }));
  check("an already-aborted signal is refused", err?.code === "aborted");

  const entries = [];
  for (let i = 0; i < 40; i++) entries.push({ name: `chunk${i}.bin`, data: crypto.randomBytes(2 * 1024 * 1024) });
  const big = put("abort/big.zip", makeZip(entries));
  const ac2 = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac2.abort(), 60);
  err = await failure(() => X.extractArchive(WID, big, { signal: ac2.signal }));
  check("abort mid-extraction stops it", err?.code === "aborted", `${err?.message} after ${Date.now() - t0} ms`);
  check("…and cleans up (no dest, no temp)", !fs.existsSync(path.join(IN, "abort/big")) && tempLeftovers().length === 0, JSON.stringify(fs.readdirSync(path.join(IN, "abort"))));
}

/* ------------------------------------------------------------------ */
console.log("\ndestinations");
/* ------------------------------------------------------------------ */
{
  let res = await X.extractArchive(WID, "in/fmt-zip.zip");
  check("second extraction picks fmt-zip-2/", res.dest === "in/fmt-zip-2", res.dest);
  res = await X.extractArchive(WID, "in/fmt-zip.zip");
  check("third picks fmt-zip-3/", res.dest === "in/fmt-zip-3", res.dest);
  fs.mkdirSync(path.join(IN, "emptytarget"));
  fs.copyFileSync(path.join(IN, "fmt-zip.zip"), path.join(IN, "emptytarget.zip"));
  res = await X.extractArchive(WID, "in/emptytarget.zip");
  check("an existing empty folder of that name is used", res.dest === "in/emptytarget" && fs.existsSync(path.join(IN, "emptytarget/README.md")));

  res = await X.extractArchive(WID, "in/fmt-zip.zip", { dest: "out/custom" });
  check("explicit dest", res.dest === "out/custom" && fs.existsSync(path.join(wsRoot, "out/custom/src/lib/util.js")));
  fs.mkdirSync(path.join(wsRoot, "out/merge"), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, "out/merge/README.md"), "mine\n");
  res = await X.extractArchive(WID, "in/fmt-zip.zip", { dest: "out/merge" });
  check("explicit non-empty dest is merged without overwriting", fs.readFileSync(path.join(wsRoot, "out/merge/README.md"), "utf8") === "mine\n" &&
    fs.existsSync(path.join(wsRoot, "out/merge/package.json")) && res.skipped.some((s) => s.path === "README.md" && /out\/merge\/README\.md already exists/.test(s.reason)));
  check("…and the kept file is not counted as extracted", !res.entries.some((e) => e.path === "out/merge/README.md") && res.files === Object.keys(TREE_FILES).length - 1);
  for (const bad of [".history/x", ".snapshots", ".git/hooks", "../outside", "/abs"]) {
    const err = await failure(() => X.extractArchive(WID, "in/fmt-zip.zip", { dest: bad }));
    check(`dest ${bad} is refused`, err?.code === "bad_dest", err?.message);
  }

  const gitZip = makeZip([
    { name: ".git/config", data: "[core]\n" },
    { name: ".git/HEAD", data: "ref: refs/heads/main\n" },
    { name: "src/a.txt", data: "a" },
  ]);
  res = await X.extractArchive(WID, put("withgit.zip", gitZip));
  check("an archive's own .git/ lands inside the dest folder", fs.existsSync(path.join(IN, "withgit/.git/config")) && !fs.existsSync(path.join(wsRoot, ".git")));
  res = await X.extractArchive(WID, "in/withgit.zip", { dest: "." });
  check("merging into the workspace root never creates .git there", fs.existsSync(path.join(wsRoot, "src/a.txt")) &&
    !fs.existsSync(path.join(wsRoot, ".git")) && res.skipped.some((s) => s.path === ".git" && /protected path/.test(s.reason)));
  const internal = makeZip([{ name: ".history/forged", data: "x" }, { name: ".workspace-id", data: "hijack" }, { name: "fine.txt", data: "ok" }]);
  res = await X.extractArchive(WID, put("internal.zip", internal), { dest: "." });
  check("never writes the app's internal folders at the workspace root", !fs.existsSync(path.join(wsRoot, ".history/forged")) &&
    fs.readFileSync(path.join(wsRoot, ".workspace-id"), "utf8") === WID && fs.existsSync(path.join(wsRoot, "fine.txt")));

  const hoist = makeZip([{ name: "proj/", dir: true }, { name: "proj/a.txt", data: "a" }, { name: "proj/sub/b.txt", data: "b" }]);
  res = await X.extractArchive(WID, put("proj.zip", hoist));
  fs.mkdirSync(path.join(wsRoot, ".snapshots"), { recursive: true });
  fs.copyFileSync(path.join(IN, "proj.zip"), path.join(wsRoot, ".snapshots", "p.zip"));
  const perr = await failure(() => X.extractArchive(WID, ".snapshots/p.zip"));
  check("an archive inside a protected folder needs an explicit dest", perr?.code === "bad_dest" && !fs.existsSync(path.join(wsRoot, ".snapshots/p")), perr?.message);
  const many = await Promise.all([1, 2, 3, 4, 5, 6].map(() => X.extractArchive(WID, "in/fmt-7z.7z")));
  const dests = new Set(many.map((m) => m.dest));
  check("six parallel extractions of one archive all succeed into distinct folders", dests.size === 6 && many.every((m) => m.files === Object.keys(TREE_FILES).length), [...dests].join(" "));
  check("single top-level folder named like the archive is not doubled (proj/, not proj/proj/)", res.dest === "in/proj" &&
    fs.existsSync(path.join(IN, "proj/a.txt")) && fs.existsSync(path.join(IN, "proj/sub/b.txt")) && !fs.existsSync(path.join(IN, "proj/proj")));
}

/* ------------------------------------------------------------------ */
console.log("\nnames: Windows-hostile and legacy code pages");
/* ------------------------------------------------------------------ */
{
  const hostile = makeZip([
    { name: "CON", data: "1" },
    { name: "aux.txt", data: "2" },
    { name: "trail.", data: "3" },
    { name: "space ", data: "4" },
    { name: "a:b.txt", data: "5" },
    { name: "q?.txt", data: "6" },
    { name: '<x>|"y".txt', data: "7" },
    { name: "nul/inside.txt", data: "8" },
    { name: "win\\style\\path.txt", data: "9" },
  ]);
  const res = await X.extractArchive(WID, put("names/hostile.zip", hostile));
  const snap = snapshot(path.join(IN, "names/hostile"));
  const want = { _CON: "1", "_aux.txt": "2", trail_: "3", space_: "4", "a_b.txt": "5", "q_.txt": "6", "_x___y_.txt": "7", "_nul/inside.txt": "8", "win/style/path.txt": "9" };
  const missing = Object.entries(want).filter(([k, v]) => snap.files[k] !== sha(Buffer.from(v)));
  check("reserved/illegal Windows names are sanitised, not fatal", missing.length === 0, missing.length ? `missing ${missing.map(([k]) => k)}; got ${Object.keys(snap.files)}` : "");
  check("backslash paths become folders", "win/style/path.txt" in snap.files);
  check("renames are reported in warnings", res.warnings.some((w) => /Renamed \d+ name/.test(w)));

  const name = "Документ отчёт.txt";
  const cp866 = makeZip([{ name: Buffer.from(iconv(name, "cp866")), data: "866", utf8: false }]);
  let r1 = await X.extractArchive(WID, put("names/cp866.zip", cp866));
  check("CP866 names (Russian Windows zip) come out readable", fs.existsSync(path.join(IN, "names/cp866", name)), JSON.stringify(r1.entries.map((e) => e.path)));
  check("…with a note about the code page", r1.warnings.some((w) => /ibm866/.test(w)));
  const cp1251 = makeZip([{ name: Buffer.from(iconv(name, "cp1251")), data: "1251", utf8: false }]);
  r1 = await X.extractArchive(WID, put("names/cp1251.zip", cp1251));
  check("CP1251 names come out readable", fs.existsSync(path.join(IN, "names/cp1251", name)), JSON.stringify(r1.entries.map((e) => e.path)));
  const noflag = makeZip([{ name: Buffer.from(name, "utf8"), data: "utf8", utf8: false }]);
  r1 = await X.extractArchive(WID, put("names/noflag.zip", noflag));
  check("UTF-8 names without the UTF-8 flag stay as they are", fs.existsSync(path.join(IN, "names/noflag", name)));
  r1 = await X.extractArchive(WID, "in/names/cp866.zip", { encoding: "windows-1251", dest: "in/names/forced" });
  check("an explicit encoding overrides detection", r1.files === 1 && !fs.existsSync(path.join(IN, "names/forced", name)));
}

/** Encode text in a single-byte code page, using Node's own decoder tables. */
function iconv(text, cp) {
  const label = cp === "cp866" ? "ibm866" : "windows-1251";
  const dec = new TextDecoder(label);
  const rev = new Map();
  for (let b = 0x80; b < 0x100; b++) rev.set(dec.decode(Uint8Array.of(b)), b);
  return Uint8Array.from(Array.from(text, (ch) => (ch.charCodeAt(0) < 0x80 ? ch.charCodeAt(0) : rev.get(ch))));
}

/* ------------------------------------------------------------------ */
console.log("\nerrors");
/* ------------------------------------------------------------------ */
{
  let err = await failure(() => X.extractArchive(WID, put("notes.txt", "just text\n")));
  check("a text file is not_archive", err?.code === "not_archive", err?.message);
  err = await failure(() => X.extractArchive(WID, "in/missing.zip"));
  check("a missing file is not_found", err?.code === "not_found", err?.message);
  err = await failure(() => X.extractArchive(WID, "../escape.zip"));
  check("an archive path outside the workspace is refused", err?.code === "not_found", err?.message);
  const whole = fs.readFileSync(path.join(IN, "fmt-7z.7z"));
  err = await failure(() => X.extractArchive(WID, put("broken.7z", whole.subarray(0, Math.floor(whole.length * 0.6)))));
  check("a truncated archive fails cleanly", err instanceof X.ExtractError && ["corrupt", "not_archive"].includes(err.code), `${err?.code}: ${err?.message}`);
  check("…leaving nothing behind", !fs.existsSync(path.join(IN, "broken")) && tempLeftovers().length === 0);
  const docx = put("report.docx", makeZip([{ name: "word/document.xml", data: "<w/>" }]));
  const res = await X.extractArchive(WID, docx);
  check("a .docx still opens when extraction is explicitly asked for", fs.existsSync(path.join(IN, "report/word/document.xml")));
}

/* ------------------------------------------------------------------ */
console.log("\nsummary for the model");
/* ------------------------------------------------------------------ */
{
  const s = X.formatExtractSummary(zipResult);
  check("headline has counts, size and dest", /^Extracted 12 files in \d+ folders \(.+\) to in\/fmt-zip\//.test(s), s.split("\n")[0]);
  check("tree shows folders with sizes", /\n  src\/  \(2 files, /.test(s) && /deep\/a\/b\/c\/d\//.test(s));
  check("notable files are called out", /Notable files:[\s\S]*README\.md[\s\S]*package\.json/.test(s) && /bin\/tool\.exe/.test(s));
  check("nested archive listed with the extract_archive hint", /Nested archives[\s\S]*extract_archive[\s\S]*in\/fmt-zip\/vendor\/inner\.zip/.test(s));
  check("nested archive was not auto-extracted", zipResult.nestedArchives.includes("in/fmt-zip/vendor/inner.zip") && !fs.existsSync(path.join(IN, "fmt-zip/vendor/inner")));
  check("file-type histogram from every file", /File types: .*\.bin 3 /.test(s) && /\.txt 3 /.test(s), s.match(/File types:.*/)?.[0]);

  // Synthetic: 50 folders × 10 files, listing capped, exact folder totals.
  const entries = [];
  for (let i = 0; i < 50; i++) for (let j = 0; j < 10; j++) entries.push({ path: `x/big/dir${String(i).padStart(2, "0")}/f${j}.js`, bytes: 1000 });
  const folders = [];
  for (let i = 0; i < 50; i++) folders.push({ path: `x/big/dir${String(i).padStart(2, "0")}`, files: 10, bytes: 10_000 });
  const synthetic = {
    dest: "x/big", files: 800, dirs: 80, bytes: 800_000, entries: entries.slice(0, 300),
    nestedArchives: ["x/big/dir01/a.tar.gz"], skipped: [{ path: "evil", reason: "symbolic link (links are not created)" }],
    warnings: ["Renamed 1 name that is not valid on Windows."], folders,
  };
  const t = X.formatExtractSummary(synthetic, { maxTreeLines: 12 });
  const treeLines = t.split("\n").filter((l) => l.startsWith("  ") && !/^  (x\/|evil|Renamed)/.test(l) && !l.includes("—"));
  check("tree respects maxTreeLines", treeLines.length <= 12, `${treeLines.length} lines`);
  check("collapsed folders are summarised with exact totals", /more folders? \(\d+ files?, /.test(t));
  check("unlisted files are still accounted for (800 files, 300 listed)", /more files?/.test(t));
  check("skipped and warnings sections", /Skipped 1:[\s\S]*evil — symbolic link/.test(t) && /Warnings:[\s\S]*Renamed/.test(t));
}

/* ------------------------------------------------------------------ */
console.log("\nhygiene");
/* ------------------------------------------------------------------ */
{
  const snap = snapshot(wsRoot);
  check("no symlinks anywhere in the workspace", snap.links.length === 0, snap.links.join(", "));
  check("no temp folders left anywhere", tempLeftovers().length === 0);
  if (fdsAtStart >= 0) {
    await new Promise((res) => setTimeout(res, 200));
    const now = fdCount();
    check("no leaked file descriptors (incl. the aborted and failed runs)", now - fdsAtStart <= 4, `${fdsAtStart} → ${now}`);
  }
}

/* ------------------------------------------------------------------ */
if (PERF) {
  console.log("\nperformance");
  const P = path.join(DATA, "perf");
  fs.mkdirSync(P, { recursive: true });
  const perfWid = "extract-perf";
  const perfRoot = await WS.ensureRoot(perfWid);
  // (a) ~200MB zip of 20,000 small files. Random data, stored: nothing to gain from compressing it.
  {
    const many = [];
    for (let i = 0; i < 20_000; i++) many.push({ name: `proj/pkg${i % 50}/sub${i % 7}/file${i}.bin`, data: crypto.randomBytes(10_000) });
    fs.writeFileSync(path.join(perfRoot, "many.zip"), makeZip(many));
  }
  // (b) one 300MB file inside a 7z (LZMA2, -mx1).
  {
    const fd = fs.openSync(path.join(P, "big.bin"), "w");
    for (let i = 0; i < 300; i++) fs.writeSync(fd, crypto.randomBytes(1024 * 1024));
    fs.closeSync(fd);
    const t = Date.now();
    await sevenZip(P, ["a", "-t7z", "-mx1", "big.7z", "big.bin"]);
    console.log(d(`  (built big.7z in ${((Date.now() - t) / 1000).toFixed(1)} s)`));
    fs.renameSync(path.join(P, "big.7z"), path.join(perfRoot, "big.7z"));
    fs.rmSync(path.join(P, "big.bin"));
  }
  for (const f of ["many.zip", "big.7z"]) {
    global.gc?.();
    const before = process.memoryUsage().rss;
    let peak = before;
    const iv = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 10);
    const t = performance.now();
    const res = await X.extractArchive(perfWid, f);
    const ms = performance.now() - t;
    clearInterval(iv);
    const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
    console.log(`  ${f}: ${res.files.toLocaleString("en-US")} files, ${mb(res.bytes)} in ${(ms / 1000).toFixed(2)} s — RSS ${mb(before)} → peak ${mb(peak)} (+${mb(peak - before)})`);
    check(`${f}: extracted completely`, f === "many.zip" ? res.files === 20_000 : res.bytes === 300 * 1024 * 1024);
  }
  fs.rmSync(path.join(DATA, "workspaces", perfWid), { recursive: true, force: true });
}

console.log(`\n${pass + fail} checks · ${pass} passed${fail ? ` · ${r(`${fail} failed`)}` : ""}`);
process.exit(fail ? 1 : 0);

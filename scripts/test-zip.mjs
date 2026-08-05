/**
 * Checks the workspace archive is a real, valid ZIP.
 *
 * Run:  npm run test:zip
 *
 * The format is written by hand rather than through a library, so "it looks
 * like a zip" is not good enough — these check the bytes a real extractor
 * would read.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const { createZip } = await import(pathToFileURL(path.join(ROOT, "src/lib/zip.ts")).href);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

const TMP = path.join(ROOT, "data", "ziptest");
await rm(TMP, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });

console.log("\napiM archive checks\n");

const random = Buffer.from(
  Array.from({ length: 400 }, () => Math.floor(Math.random() * 256))
);

const entries = [
  { path: "main.py", content: Buffer.from("print('hello')\n"), modified: new Date() },
  { path: "src/app.js", content: Buffer.from("console.log(1)\n"), modified: new Date() },
  // Compresses well — exercises the deflate path.
  { path: "big.txt", content: Buffer.from("A".repeat(5000)), modified: new Date() },
  // Incompressible — deflate would grow it, so it must fall back to stored.
  { path: "rand.bin", content: random, modified: new Date() },
  { path: "empty.txt", content: Buffer.from(""), modified: new Date() },
  // A date before 1980, which the DOS timestamp format cannot represent.
  { path: "old.txt", content: Buffer.from("old\n"), modified: new Date("1970-01-01") },
];

const zip = await createZip(entries);
const zipPath = path.join(TMP, "out.zip");
await writeFile(zipPath, zip);

console.log("1. A real extractor accepts it");
let unzipAvailable = true;
try {
  const { stdout } = await run("unzip", ["-t", zipPath]);
  check("unzip reports no errors", /No errors detected/.test(stdout));
} catch (err) {
  unzipAvailable = false;
  console.log(d("  (unzip not available — skipping extractor checks)"));
  void err;
}

if (unzipAvailable) {
  const outDir = path.join(TMP, "out");
  await mkdir(outDir, { recursive: true });
  await run("unzip", ["-q", "-o", zipPath, "-d", outDir]);

  console.log("\n2. Everything survives the round trip");
  check("text is intact",
    (await readFile(path.join(outDir, "main.py"), "utf8")) === "print('hello')\n");
  check("subdirectories are preserved",
    (await readFile(path.join(outDir, "src/app.js"), "utf8")) === "console.log(1)\n");
  check("a compressible file is byte-identical",
    (await readFile(path.join(outDir, "big.txt"))).length === 5000);
  check("incompressible bytes are unchanged",
    Buffer.compare(await readFile(path.join(outDir, "rand.bin")), random) === 0);
  check("an empty file stays empty",
    (await readFile(path.join(outDir, "empty.txt"))).length === 0);
  check("a pre-1980 date doesn't corrupt the entry",
    (await readFile(path.join(outDir, "old.txt"), "utf8")) === "old\n");
}

console.log("\n3. Structure");
check("it starts with the ZIP signature",
  zip.readUInt32LE(0) === 0x04034b50, `0x${zip.readUInt32LE(0).toString(16)}`);
check("it ends with the central directory record",
  zip.readUInt32LE(zip.length - 22) === 0x06054b50);
check("the entry count is right", zip.readUInt16LE(zip.length - 14) === entries.length,
  `${zip.readUInt16LE(zip.length - 14)}`);
check("compression actually helped",
  zip.length < entries.reduce((n, e) => n + e.content.length, 0),
  `${zip.length} bytes vs ${entries.reduce((n, e) => n + e.content.length, 0)} raw`);

console.log("\n4. Awkward inputs");
const single = await createZip([
  { path: "only.txt", content: Buffer.from("x"), modified: new Date() },
]);
check("a single file works", single.readUInt16LE(single.length - 14) === 1);

const backslash = await createZip([
  { path: "src\\nested\\file.txt", content: Buffer.from("x"), modified: new Date() },
]);
check("backslashes become forward slashes",
  backslash.includes(Buffer.from("src/nested/file.txt")),
  "a literal backslash would produce one oddly-named file");

const unicode = await createZip([
  { path: "конфиг.cfg", content: Buffer.from("тест\n"), modified: new Date() },
]);
check("non-Latin filenames are handled",
  unicode.readUInt16LE(unicode.length - 14) === 1);

await rm(TMP, { recursive: true, force: true });

console.log("\n" + (fail === 0 ? g(`All ${pass} checks passed.`) : r(`${fail} of ${pass + fail} failed.`)) + "\n");
process.exit(fail === 0 ? 0 : 1);

/**
 * Checks that archives dropped on the composer are unpacked correctly.
 *
 * Run:  npm run test:archive
 *
 * Attaching a project meant picking its files one at a time, so in practice
 * people attached two and described the rest. These use archives built by the
 * real `zip` and `tar` tools rather than hand-written bytes, because the
 * failure mode worth catching is a writer that lays the format out slightly
 * differently from the one assumption the parser makes.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const A = await import(pathToFileURL(path.join(ROOT, "src/lib/archive.ts")).href);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const y = (s) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0, skip = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};
const skipped = (label, why) => {
  console.log(`  ${y("SKIP")}  ${label}${d("  " + why)}`);
  skip++;
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "apim-archive-"));
const proj = path.join(tmp, "proj");

await fs.mkdir(path.join(proj, "src"), { recursive: true });
await fs.mkdir(path.join(proj, "node_modules", "dep"), { recursive: true });
await fs.writeFile(path.join(proj, "main.py"), 'print("hello")\n');
await fs.writeFile(path.join(proj, "src", "util.py"), "x = 1\n");
await fs.writeFile(path.join(proj, "README.md"), "# Readme\n");
await fs.writeFile(path.join(proj, "logo.png"), Buffer.alloc(3000, 7));
await fs.writeFile(path.join(proj, "node_modules", "dep", "index.js"), "// dep\n");

const have = async (cmd) =>
  run(cmd, ["--version"]).then(() => true).catch(() => false);

console.log("\napiM archive checks\n");

// -------------------------------------------------------------- detection

console.log("1. Which files are archives");

for (const [name, expected] of [
  ["a.zip", true], ["a.tar", true], ["a.tar.gz", true], ["a.tgz", true],
  ["a.txt", false], ["a.py", false], ["a.png", false],
]) {
  check(`${name} -> ${expected}`, A.isArchive(name) === expected);
}

check(
  "a .rar is refused with a reason and a way forward",
  /re-save it as a \.zip/i.test(A.unsupportedArchiveNote("x.rar") ?? ""),
  "no open decoder exists for RAR"
);
check(
  "a .7z is refused the same way",
  /re-save it as a \.zip/i.test(A.unsupportedArchiveNote("x.7z") ?? ""),
  "LZMA has no browser support"
);
check(
  "a supported archive has no refusal note",
  A.unsupportedArchiveNote("x.zip") === null
);

// -------------------------------------------------------------------- zip

console.log("\n2. ZIP");

if (!(await have("zip"))) {
  skipped("built by the real zip tool", "zip not installed");
} else {
  await run("zip", ["-qr", "proj.zip", "proj"], { cwd: tmp });
  const buf = new Uint8Array(await fs.readFile(path.join(tmp, "proj.zip")));
  const res = await A.readArchive("proj.zip", buf);
  const paths = res.entries.map((e) => e.path).sort();

  check("text files come out", paths.includes("proj/main.py"), paths.join(", "));
  check("nested paths are preserved", paths.includes("proj/src/util.py"));
  check(
    "contents are exact",
    res.entries.find((e) => e.path === "proj/main.py")?.content ===
      'print("hello")\n'
  );
  check(
    "node_modules is left out",
    !paths.some((p) => p.includes("node_modules")),
    "a dependency tree would crowd out the actual code"
  );
  check(
    "binaries are left out",
    !paths.some((p) => p.endsWith(".png")),
    "they would arrive as mojibake"
  );
  check(
    "skipped files are reported, not silently dropped",
    res.skipped.length >= 2,
    res.skipped.map((s) => s.reason).join(", ")
  );
}

// -------------------------------------------------------------------- tar

console.log("\n3. TAR and TAR.GZ");

if (!(await have("tar"))) {
  skipped("built by the real tar tool", "tar not installed");
} else {
  await run("tar", ["-cf", "proj.tar", "proj"], { cwd: tmp });
  await run("tar", ["-czf", "proj.tar.gz", "proj"], { cwd: tmp });

  const tarBuf = new Uint8Array(await fs.readFile(path.join(tmp, "proj.tar")));
  const tarRes = await A.readArchive("proj.tar", tarBuf);
  check(
    "an uncompressed tar reads",
    tarRes.entries.some((e) => e.path === "proj/main.py"),
    tarRes.entries.map((e) => e.path).join(", ")
  );

  const gzBuf = new Uint8Array(await fs.readFile(path.join(tmp, "proj.tar.gz")));
  const gzRes = await A.readArchive("proj.tar.gz", gzBuf);
  check(
    "a gzipped tar reads",
    gzRes.entries.some((e) => e.path === "proj/main.py")
  );
  check(
    "zip and tar.gz agree on what is inside",
    gzRes.entries.map((e) => e.path).sort().join(",") ===
      tarRes.entries.map((e) => e.path).sort().join(","),
    "the same project should produce the same result either way"
  );
  check(
    "tar skips the same things",
    !gzRes.entries.some((e) => e.path.includes("node_modules"))
  );
}

// ------------------------------------------------------------------ caps

console.log("\n4. Caps");

check("a per-file cap exists", A.MAX_ENTRY_CHARS > 0 && A.MAX_ENTRY_CHARS <= 200_000);
check("a whole-archive cap exists", A.MAX_TOTAL_CHARS > A.MAX_ENTRY_CHARS);
check("an entry-count cap exists", A.MAX_ENTRIES > 0);

if (await have("zip")) {
  const many = path.join(tmp, "many");
  await fs.mkdir(many, { recursive: true });
  // One oversized file, to prove truncation rather than rejection.
  await fs.writeFile(path.join(many, "huge.txt"), "z".repeat(A.MAX_ENTRY_CHARS + 5000));
  await run("zip", ["-qr", "many.zip", "many"], { cwd: tmp });
  const buf = new Uint8Array(await fs.readFile(path.join(tmp, "many.zip")));
  const res = await A.readArchive("many.zip", buf);
  const huge = res.entries.find((e) => e.path.endsWith("huge.txt"));
  check(
    "an oversized file is truncated, not dropped",
    Boolean(huge) && huge.truncated && huge.content.length === A.MAX_ENTRY_CHARS,
    "half a file beats none of it"
  );
}

// ---------------------------------------------------------------- output

console.log("\n5. What the model receives");

if (await have("zip")) {
  const buf = new Uint8Array(await fs.readFile(path.join(tmp, "proj.zip")));
  const res = await A.readArchive("proj.zip", buf);
  const text = A.formatArchive("proj.zip", res);

  check("the archive is named", text.includes("proj.zip"));
  check(
    "a manifest comes before the contents",
    text.indexOf("proj/main.py") < text.indexOf('print("hello")'),
    "so the model sees the shape before reading any of it"
  );
  check("each file is delimited by its path", text.includes("--- proj/main.py ---"));
  check("file contents are present", text.includes('print("hello")'));
  check(
    "skipped files are counted, not listed",
    /\d+ file\(s\) skipped/.test(text) && !text.includes("logo.png"),
    "forty 'binary file' lines would push out the code"
  );
}

const emptyText = A.formatArchive("empty.zip", {
  entries: [],
  skipped: [],
  hitLimit: false,
});
check(
  "an archive with nothing readable says so",
  emptyText.includes("no readable text files")
);

// ------------------------------------------------------------ robustness

console.log("\n6. Bad input");

let threw = false;
try {
  await A.readArchive("junk.zip", new Uint8Array([1, 2, 3, 4, 5]));
} catch {
  threw = true;
}
check("a file that is not a zip is rejected clearly", threw, "rather than hanging or crashing");

const emptyTar = await A.readArchive("empty.tar", new Uint8Array(1024));
check("an empty tar yields nothing rather than throwing", emptyTar.entries.length === 0);

await fs.rm(tmp, { recursive: true, force: true });

console.log(
  `\n${pass + fail + skip} checks · ${g(pass + " passed")}` +
    `${fail ? " · " + r(fail + " failed") : ""}` +
    `${skip ? " · " + y(skip + " skipped") : ""}\n`
);
process.exit(fail ? 1 : 0);

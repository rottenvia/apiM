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

check(
  "the per-file cap clears an ordinary source file",
  A.MAX_ENTRY_CHARS >= 200_000,
  `${A.MAX_ENTRY_CHARS.toLocaleString()} chars — 60k cut files at about 1,500 lines`
);
check("a whole-archive cap exists", A.MAX_TOTAL_CHARS > A.MAX_ENTRY_CHARS);
check(
  "the archive cap uses a real share of the context window",
  A.MAX_TOTAL_CHARS >= 1_000_000,
  `${Math.round(A.MAX_TOTAL_CHARS / 3.6 / 1000)}k tokens of a 1M window`
);
check(
  "the entry cap clears a real project",
  A.MAX_ENTRIES >= 500,
  `${A.MAX_ENTRIES} files`
);

// A file large enough that the old 60k cap would have cut it.
if (await have("zip")) {
  const realistic = path.join(tmp, "realistic");
  await fs.mkdir(realistic, { recursive: true });
  const source = Array.from(
    { length: 2500 },
    (_, i) => `def function_${i}(argument):\n    return argument * ${i}\n`
  ).join("\n");
  await fs.writeFile(path.join(realistic, "module.py"), source);
  await run("zip", ["-qr", path.join(tmp, "realistic.zip"), "."], {
    cwd: realistic,
  });

  const buf = new Uint8Array(await fs.readFile(path.join(tmp, "realistic.zip")));
  const res = await A.readArchive("realistic.zip", buf);
  const entry = res.entries.find((e) => e.path.endsWith("module.py"));
  check(
    "a 2,500-line source file arrives whole",
    Boolean(entry) && !entry.truncated && entry.content === source,
    `${source.length.toLocaleString()} chars — over the old 60k cap`
  );
}

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

// ------------------------------------------------- the attachment reader

console.log("\n7. Reading a file that was dropped on the composer");

const AT = await import(
  pathToFileURL(path.join(ROOT, "src/lib/attachments.ts")).href
);

check(
  "an unknown extension is not refused for being unknown",
  AT.binaryFormatNote("cs2_config.vdf") === null,
  "a list of known extensions can only ever be incomplete"
);
check(
  "a PDF is refused with something actionable",
  /copy the text out/i.test(AT.binaryFormatNote("paper.pdf") ?? ""),
  "rather than 'appears to be binary'"
);
check(
  "a .docx is no longer refused — it is read",
  AT.binaryFormatNote("notes.docx") === null,
  "office documents are zips of xml, so their text can be extracted"
);
check(
  "the older .doc format still says what to do instead",
  /save as \.docx/i.test(AT.binaryFormatNote("old.doc") ?? ""),
  "it is a different, binary format with no open layout"
);
check(
  "a plain binary is named for what it is",
  /an executable/.test(AT.binaryFormatNote("thing.exe") ?? "")
);

check(
  "text bytes are recognised as text",
  !AT.bytesLookBinary(new TextEncoder().encode("hello\nworld\n"))
);
check(
  "a NUL byte marks it binary",
  AT.bytesLookBinary(new Uint8Array([104, 105, 0, 104, 105]))
);
check(
  "an empty file is not binary",
  !AT.bytesLookBinary(new Uint8Array(0)),
  "an empty file is a valid, if boring, text file"
);
check(
  "UTF-8 above ASCII stays text",
  !AT.bytesLookBinary(new TextEncoder().encode("привіт — ok\n")),
  "high bytes are ordinary in UTF-8 and must not trip the check"
);
check(
  "mostly control bytes is binary",
  AT.bytesLookBinary(new Uint8Array(Array.from({ length: 500 }, (_, i) => (i % 2 ? 1 : 65))))
);

check(
  "only a small head is inspected",
  AT.SNIFF_BYTES <= 16_000,
  `${AT.SNIFF_BYTES} bytes — the old path decoded the entire file first`
);

// ------------------------------------------------------------- progress

console.log("\n8. Progress while a file is read");

check(
  "every stage has a label",
  ["reading", "unpacking", "extracting", "analyzing"].every(
    (k) => typeof AT.STAGE_LABELS[k] === "string" && AT.STAGE_LABELS[k].length > 0
  ),
  Object.values(AT.STAGE_LABELS).join(" / ")
);
check(
  "the labels say what is happening, not just 'loading'",
  AT.STAGE_LABELS.unpacking !== AT.STAGE_LABELS.extracting &&
    AT.STAGE_LABELS.unpacking !== AT.STAGE_LABELS.reading,
  "unpacking a zip and pulling text out of a docx are different waits"
);

if (await have("zip")) {
  // A File stand-in, enough of the interface for readTextFile.
  const asFile = (name, buf) => ({
    name,
    size: buf.length,
    type: "",
    arrayBuffer: async () =>
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
    slice: (a = 0, b = buf.length) => asFile(name, buf.subarray(a, b)),
    text: async () => buf.toString("utf8"),
  });

  const zipBuf = await fs.readFile(path.join(tmp, "proj.zip"));
  const zipStages = [];
  const zipRes = await AT.readTextFile(asFile("proj.zip", zipBuf), (st) =>
    zipStages.push(st)
  );
  check(
    "an archive reports that it is unpacking",
    zipStages.includes("unpacking"),
    zipStages.join(" -> ") || "(none)"
  );
  check("and still produces an attachment", Boolean(zipRes.attachment));

  const txt = Buffer.from("just some text\n");
  const txtStages = [];
  await AT.readTextFile(asFile("notes.txt", txt), (st) => txtStages.push(st));
  check(
    "a plain file reports reading, not unpacking",
    txtStages.includes("reading") && !txtStages.includes("unpacking"),
    txtStages.join(" -> ")
  );
}

// ------------------------------------------------- unpacking to the disk

console.log("\n9. Unpacked files land in the workspace");

check(
  "an archive name becomes a folder name",
  A.archiveFolderName("EXT-Faceit-Intelligence.zip") ===
    "EXT-Faceit-Intelligence"
);
check(
  "the extension is dropped, including two-part ones",
  A.archiveFolderName("proj.tar.gz") === "proj"
);
check(
  "traversal cannot survive the folder name",
  !A.archiveFolderName("../../etc.zip").includes(".."),
  A.archiveFolderName("../../etc.zip")
);
check(
  "a name made only of punctuation still yields something",
  A.archiveFolderName("....zip").length > 0,
  A.archiveFolderName("....zip")
);

const W = await import(pathToFileURL(path.join(ROOT, "src/lib/workspace.ts")).href);
const WSROOT = path.join(ROOT, "data", "workspaces");
await fs.rm(path.join(WSROOT, "archtest"), { recursive: true, force: true });

// An archive entry is attacker-controlled, so the path it produces has to be
// rejected rather than trusted.
let blocked = 0;
for (const evil of ["../escaped.txt", "../../etc/passwd", "a/../../../out"]) {
  try {
    await W.writeFile("archtest", `uploads/proj/${evil}`, "x");
  } catch {
    blocked += 1;
  }
}
check(
  "a zip-slip path is refused",
  blocked === 3,
  "an archive can contain '..' and would otherwise write outside the workspace"
);

if (await have("zip")) {
  const buf = new Uint8Array(await fs.readFile(path.join(tmp, "proj.zip")));
  const res = await A.readArchive("proj.zip", buf);
  const dir = `uploads/${A.archiveFolderName("proj.zip")}`;
  for (const e of res.entries) {
    await W.writeFile("archtest", `${dir}/${e.path}`, e.content);
  }

  const listed = (await W.listFiles("archtest")).map((f) => f.path);
  check(
    "every entry becomes a real file",
    listed.length === res.entries.length,
    listed.join(", ")
  );
  check(
    "they sit under uploads/, named after the archive",
    listed.every((f) => f.startsWith("uploads/proj/"))
  );
  check(
    "nested structure is preserved",
    listed.some((f) => f.includes("/src/")),
    "a flat dump would lose which module a file belonged to"
  );

  const back = await W.readFile("archtest", `${dir}/proj/main.py`);
  check(
    "the agent can read one back later",
    back.content === 'print("hello")\n',
    "this is the whole point — the files outlive the message"
  );

  const manifest = A.formatArchiveManifest("proj.zip", dir, res);
  check("the manifest names where they went", manifest.includes(dir));
  check(
    "the manifest does not repeat the file contents",
    !manifest.includes('print("hello")'),
    "they are on disk; sending them again would double the cost"
  );
  check(
    "the manifest tells the model how to reach them",
    /read_file/.test(manifest) && /search_files/.test(manifest)
  );
}

await fs.rm(path.join(WSROOT, "archtest"), { recursive: true, force: true });
await fs.rm(tmp, { recursive: true, force: true });

console.log(
  `\n${pass + fail + skip} checks · ${g(pass + " passed")}` +
    `${fail ? " · " + r(fail + " failed") : ""}` +
    `${skip ? " · " + y(skip + " skipped") : ""}\n`
);
process.exit(fail ? 1 : 0);

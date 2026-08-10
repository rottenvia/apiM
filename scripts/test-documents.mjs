/**
 * Checks that office documents are readable.
 *
 * Run:  npm run test:documents
 *
 * DOCX, XLSX, PPTX, EPUB and ODT are ZIP archives of XML, so they need no
 * parser library — but every writer lays them out slightly differently, and
 * the interesting failures are in the details: shared string tables, entity
 * escaping, sheet ordering, and text that is not ASCII.
 *
 * The fixtures are built by python-docx, openpyxl and python-pptx where
 * available, because a hand-written file only proves the parser agrees with
 * itself. Skipped rather than failed when those libraries are absent.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const D = await import(pathToFileURL(path.join(ROOT, "src/lib/documents.ts")).href);

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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "apim-docs-"));
const read = async (name) =>
  new Uint8Array(await fs.readFile(path.join(tmp, name)));

console.log("\napiM document checks\n");

// -------------------------------------------------------------- detection

console.log("1. Which files are documents");

for (const [name, expected] of [
  ["a.docx", "docx"], ["a.xlsx", "xlsx"], ["a.pptx", "pptx"],
  ["a.epub", "epub"], ["a.odt", "odt"],
  // PDF was deliberately unsupported and is now handled — it was the one
  // format people actually send, so "read this document" failed on the
  // common case while working on ODT.
  ["a.pdf", "pdf"],
  ["a.txt", null], ["a.zip", null],
]) {
  check(`${name} -> ${expected ?? "not a document"}`, D.documentKind(name) === expected);
}
check("the check is case-insensitive", D.documentKind("REPORT.DOCX") === "docx");

// --------------------------------------------------------------- fixtures

let venv = null;
try {
  await run("python3", ["-m", "venv", path.join(tmp, "venv")]);
  const pip = path.join(tmp, "venv", "bin", "pip");
  await run(pip, ["install", "-q", "python-docx", "openpyxl", "python-pptx"], {
    timeout: 180_000,
  });
  venv = path.join(tmp, "venv", "bin", "python");
} catch {
  venv = null;
}

if (venv) {
  const script = path.join(tmp, "make.py");
  await fs.writeFile(
    script,
    `
from docx import Document
from openpyxl import Workbook
from pptx import Presentation
import zipfile, os
os.chdir(${JSON.stringify(tmp)})

d = Document()
d.add_heading("Project Report", 0)
d.add_paragraph("First paragraph with some text.")
d.add_paragraph("Second paragraph - with an ampersand & a <bracket>.")
d.add_paragraph("Ukrainian: привіт світ")
d.save("test.docx")

wb = Workbook()
ws = wb.active; ws.title = "Data"
ws.append(["Name", "Qty", "Price"])
ws.append(["Widget", 5, 9.99])
ws2 = wb.create_sheet("Notes")
ws2.append(["remember to check stock"])
wb.save("test.xlsx")

p = Presentation()
s1 = p.slides.add_slide(p.slide_layouts[0])
s1.shapes.title.text = "Quarterly Update"
s1.placeholders[1].text = "Prepared by Marsel"
s2 = p.slides.add_slide(p.slide_layouts[1])
s2.shapes.title.text = "Numbers"
p.save("test.pptx")

with zipfile.ZipFile("test.epub", "w") as z:
    z.writestr("mimetype", "application/epub+zip")
    z.writestr("OEBPS/ch1.xhtml", "<html><body><h1>Chapter One</h1><p>It was a dark and stormy night and the sentence continued.</p></body></html>")
    z.writestr("OEBPS/ch2.xhtml", "<html><body><h1>Chapter Two</h1><p>The second chapter had rather more to say than the first.</p></body></html>")
`
  );
  await run(venv, [script]);
}

// ------------------------------------------------------------------- docx

console.log("\n2. Word");

if (!venv) {
  skipped("built by python-docx", "python libraries unavailable");
} else {
  const res = await D.readDocument("docx", await read("test.docx"));
  check("the heading is read", res.text.includes("Project Report"));
  check("body paragraphs are read", res.text.includes("First paragraph with some text."));
  check(
    "paragraphs stay on separate lines",
    res.text.split("\n").filter((l) => l.trim()).length >= 4,
    "without paragraph breaks the whole document is one line"
  );
  check(
    "XML entities are decoded",
    res.text.includes("&") && res.text.includes("<bracket>"),
    "an escaped ampersand must not arrive as &amp;"
  );
  check(
    "non-ASCII survives",
    res.text.includes("привіт світ"),
    "the decoder must not mangle anything outside ASCII"
  );
  check("no XML tags leak through", !/<[a-z]+:/i.test(res.text));
}

// ------------------------------------------------------------------- xlsx

console.log("\n3. Excel");

if (!venv) {
  skipped("built by openpyxl", "python libraries unavailable");
} else {
  const res = await D.readDocument("xlsx", await read("test.xlsx"));
  check("every sheet is read", res.sections === 2, `${res.sections} sheets`);
  check("sheets are named, not numbered", res.text.includes("--- Data ---"));
  check(
    "text cells resolve through the shared string table",
    res.text.includes("Widget"),
    "cells store an index, not the string — unresolved they come out as numbers"
  );
  check("numbers are kept", res.text.includes("9.99"));
  check("rows are tab separated", res.text.includes("Name\tQty\tPrice"));
  check("later sheets are included", res.text.includes("remember to check stock"));
}

// ------------------------------------------------------------------- pptx

console.log("\n4. PowerPoint");

if (!venv) {
  skipped("built by python-pptx", "python libraries unavailable");
} else {
  const res = await D.readDocument("pptx", await read("test.pptx"));
  check("every slide is read", res.sections === 2, `${res.sections} slides`);
  check("slides are labelled", res.text.includes("--- Slide 1 ---"));
  check("slide text is read", res.text.includes("Quarterly Update"));
  check(
    "slides stay in order",
    res.text.indexOf("Quarterly Update") < res.text.indexOf("Numbers"),
    "sorting by filename alone puts slide10 before slide2"
  );
}

// ------------------------------------------------------------------- epub

console.log("\n5. EPUB");

if (!venv) {
  skipped("epub fixture", "python unavailable");
} else {
  const res = await D.readDocument("epub", await read("test.epub"));
  check("chapters are read", res.sections === 2, `${res.sections} chapters`);
  check("chapter text is read", res.text.includes("dark and stormy night"));
  check("headings are kept", res.text.includes("Chapter One"));
  check("no HTML leaks through", !res.text.includes("<p>"));
}

// -------------------------------------------------------------------- odt

console.log("\n6. OpenDocument");

// ODT is simple enough to build by hand, and no common python library ships
// for it — so this is the one format where a hand-written fixture is right.
const { execFile: raw } = await import("node:child_process");
const zipAvailable = await run("zip", ["--version"]).then(() => true).catch(() => false);

if (!zipAvailable) {
  skipped("odt fixture", "zip not installed");
} else {
  const odtDir = path.join(tmp, "odt");
  await fs.mkdir(odtDir, { recursive: true });
  await fs.writeFile(
    path.join(odtDir, "content.xml"),
    `<?xml version="1.0"?><office:document-content xmlns:office="x" xmlns:text="y"><office:body><office:text><text:h>Title Here</text:h><text:p>A paragraph of body text.</text:p><text:p>Another one, with &amp; an entity.</text:p></office:text></office:body></office:document-content>`
  );
  await run("zip", ["-qr", path.join(tmp, "test.odt"), "."], { cwd: odtDir });

  const res = await D.readDocument("odt", await read("test.odt"));
  check("the heading is read", res.text.includes("Title Here"));
  check("paragraphs are read", res.text.includes("A paragraph of body text."));
  check("paragraphs are separated", res.text.split("\n").filter((l) => l.trim()).length >= 3);
  check("entities are decoded", res.text.includes("& an entity"));
}

// ------------------------------------------------------------------ limits

console.log("\n7. Limits and failure");

check(
  "a character cap exists, sized for the model in use",
  D.MAX_DOC_CHARS >= 500_000,
  `${D.MAX_DOC_CHARS.toLocaleString()} chars — about ${Math.round(
    D.MAX_DOC_CHARS / 3.6 / 1000
  )}k tokens of a 1M window`
);

let threw = false;
try {
  await D.readDocument("docx", new Uint8Array([1, 2, 3, 4]));
} catch {
  threw = true;
}
check("a file that is not a zip fails clearly", threw);

if (zipAvailable) {
  // A valid zip with none of the parts a docx needs.
  const junkDir = path.join(tmp, "junk");
  await fs.mkdir(junkDir, { recursive: true });
  await fs.writeFile(path.join(junkDir, "hello.txt"), "not a document");
  await run("zip", ["-qr", path.join(tmp, "junk.docx"), "."], { cwd: junkDir });

  let msg = "";
  try {
    await D.readDocument("docx", await read("junk.docx"));
  } catch (e) {
    msg = e.message;
  }
  check(
    "a zip that is not really a docx says so",
    /really a \.docx/.test(msg),
    msg || "should name the problem"
  );
}

await fs.rm(tmp, { recursive: true, force: true });

console.log(
  `\n${pass + fail + skip} checks · ${g(pass + " passed")}` +
    `${fail ? " · " + r(fail + " failed") : ""}` +
    `${skip ? " · " + y(skip + " skipped") : ""}\n`
);
process.exit(fail ? 1 : 0);

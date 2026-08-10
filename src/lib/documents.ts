/**
 * Reading office documents.
 *
 * DOCX, XLSX, PPTX, EPUB and ODT are all ZIP archives containing XML, so they
 * need no new dependency — the ZIP reader already exists for attached
 * archives, and the rest is pulling the text out of known parts.
 *
 * The aim is the text, not a faithful reproduction. Fonts, colours and
 * absolute positioning are lost on purpose: the model reads words, and
 * carrying the formatting through would cost tokens without adding meaning.
 */

import { zipMembers } from "@/lib/archive";

export type DocumentKind = "docx" | "xlsx" | "pptx" | "epub" | "odt" | "pdf";

export interface DocumentResult {
  text: string;
  /** Sheets, slides or chapters, when the format has them. */
  sections: number;
  truncated: boolean;
}

/** Matches the attachment cap, so a document cannot outgrow a text file. */
export const MAX_DOC_CHARS = 800_000;

const KINDS: Record<string, DocumentKind> = {
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  epub: "epub",
  odt: "odt",
  pdf: "pdf",
};

export function documentKind(name: string): DocumentKind | null {
  const at = name.lastIndexOf(".");
  if (at === -1) return null;
  return KINDS[name.slice(at + 1).toLowerCase()] ?? null;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Turn an XML fragment into readable text.
 *
 * Deliberately not a real parser. These parts are machine-generated and the
 * only thing wanted from them is the character data, so tag-stripping is
 * enough — and it cannot fail on the malformed markup that some writers
 * produce, which a strict parser would reject outright.
 */
function xmlToText(xml: string, breakOn: RegExp): string {
  return (
    xml
      // Paragraph and row boundaries become newlines before tags are dropped,
      // or the entire document collapses into one unreadable line.
      .replace(breakOn, "\n")
      // Tabs in Word are their own element.
      .replace(/<w:tab\b[^>]*\/?>/g, "\t")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      // Ampersand last, or the entities above would be corrupted.
      .replace(/&amp;/g, "&")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function clamp(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DOC_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_DOC_CHARS), truncated: true };
}

/** Word: one main part, plus headers and footnotes worth keeping. */
async function readDocx(buf: Uint8Array): Promise<DocumentResult> {
  const parts = await zipMembers(
    buf,
    (p) =>
      p === "word/document.xml" ||
      p === "word/footnotes.xml" ||
      p === "word/endnotes.xml"
  );

  const main = parts.get("word/document.xml");
  if (!main) throw new Error("no document part — is this really a .docx?");

  const chunks: string[] = [
    xmlToText(decoder.decode(main), /<\/w:p>|<w:br\b[^>]*\/?>/g),
  ];

  for (const [name, label] of [
    ["word/footnotes.xml", "Footnotes"],
    ["word/endnotes.xml", "Endnotes"],
  ] as const) {
    const part = parts.get(name);
    if (!part) continue;
    const text = xmlToText(decoder.decode(part), /<\/w:p>/g);
    // Word always writes these parts, usually holding only separator marks.
    if (text.length > 20) chunks.push(`\n\n--- ${label} ---\n${text}`);
  }

  const { text, truncated } = clamp(chunks.join(""));
  return { text, sections: 1, truncated };
}

/**
 * Excel: sheets rendered as rows of tab-separated cells.
 *
 * Most cell values are indices into a shared string table rather than inline
 * text, so that has to be read first or every text cell comes out as a
 * number.
 */
async function readXlsx(buf: Uint8Array): Promise<DocumentResult> {
  const parts = await zipMembers(
    buf,
    (p) =>
      p === "xl/sharedStrings.xml" ||
      p === "xl/workbook.xml" ||
      p.startsWith("xl/worksheets/sheet")
  );

  const sharedRaw = parts.get("xl/sharedStrings.xml");
  const shared: string[] = [];
  if (sharedRaw) {
    const xml = decoder.decode(sharedRaw);
    for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      shared.push(xmlToText(m[1], /<\/a:p>/g).replace(/\n/g, " ").trim());
    }
  }

  // Sheet names live in the workbook part, in the same order as the files.
  const names: string[] = [];
  const workbook = parts.get("xl/workbook.xml");
  if (workbook) {
    for (const m of decoder.decode(workbook).matchAll(/<sheet\b[^>]*name="([^"]*)"/g)) {
      names.push(m[1]);
    }
  }

  const sheetPaths = [...parts.keys()]
    .filter((p) => p.startsWith("xl/worksheets/sheet"))
    .sort((a, b) => {
      const n = (s: string) => Number(s.match(/(\d+)\.xml$/)?.[1] ?? 0);
      return n(a) - n(b);
    });

  const out: string[] = [];
  sheetPaths.forEach((path, i) => {
    const xml = decoder.decode(parts.get(path)!);
    const rows: string[] = [];

    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cellMatch of rowMatch[1].matchAll(
        /<c\b([^>]*)>([\s\S]*?)<\/c>/g
      )) {
        const attrs = cellMatch[1];
        const body = cellMatch[2];
        const value = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";

        if (/t="s"/.test(attrs)) {
          cells.push(shared[Number(value)] ?? "");
        } else if (/t="inlineStr"/.test(attrs)) {
          cells.push(xmlToText(body, /<\/a:p>/g).replace(/\n/g, " "));
        } else {
          cells.push(value);
        }
      }
      // A row of empty cells is layout, not data.
      if (cells.some((c) => c !== "")) rows.push(cells.join("\t"));
    }

    if (rows.length === 0) return;
    out.push(`--- ${names[i] ?? `Sheet ${i + 1}`} ---\n${rows.join("\n")}`);
  });

  if (out.length === 0) throw new Error("no readable sheets");
  const { text, truncated } = clamp(out.join("\n\n"));
  return { text, sections: out.length, truncated };
}

/** PowerPoint: one section per slide, in slide order. */
async function readPptx(buf: Uint8Array): Promise<DocumentResult> {
  const parts = await zipMembers(buf, (p) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(p)
  );

  const paths = [...parts.keys()].sort((a, b) => {
    const n = (s: string) => Number(s.match(/(\d+)\.xml$/)?.[1] ?? 0);
    return n(a) - n(b);
  });

  const out: string[] = [];
  paths.forEach((path, i) => {
    const text = xmlToText(decoder.decode(parts.get(path)!), /<\/a:p>/g);
    if (text) out.push(`--- Slide ${i + 1} ---\n${text}`);
  });

  if (out.length === 0) throw new Error("no readable slides");
  const { text, truncated } = clamp(out.join("\n\n"));
  return { text, sections: out.length, truncated };
}

/** EPUB: the XHTML chapters, in the order the archive lists them. */
async function readEpub(buf: Uint8Array): Promise<DocumentResult> {
  const parts = await zipMembers(buf, (p) => /\.x?html?$/i.test(p));

  const paths = [...parts.keys()].sort();
  const out: string[] = [];
  for (const path of paths) {
    const raw = decoder.decode(parts.get(path)!);
    // Scripts and styles are inside the body and would otherwise be read as
    // prose once their tags are stripped.
    const cleaned = raw
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "");
    const text = xmlToText(cleaned, /<\/p>|<br\b[^>]*\/?>|<\/h[1-6]>|<\/div>/gi);
    if (text.length > 40) out.push(text);
  }

  if (out.length === 0) throw new Error("no readable chapters");
  const { text, truncated } = clamp(out.join("\n\n"));
  return { text, sections: out.length, truncated };
}

/** OpenDocument text: a single content part, like DOCX but different tags. */
async function readOdt(buf: Uint8Array): Promise<DocumentResult> {
  const parts = await zipMembers(buf, (p) => p === "content.xml");
  const main = parts.get("content.xml");
  if (!main) throw new Error("no content part — is this really an .odt?");

  const text = xmlToText(
    decoder.decode(main),
    /<\/text:p>|<\/text:h>|<text:line-break\b[^>]*\/?>/g
  );
  if (!text) throw new Error("no readable text");

  const clamped = clamp(text);
  return { text: clamped.text, sections: 1, truncated: clamped.truncated };
}

/** Read a document, or throw with a reason worth showing the user. */
export async function readDocument(
  kind: DocumentKind,
  buf: Uint8Array
): Promise<DocumentResult> {
  switch (kind) {
    case "docx":
      return readDocx(buf);
    case "xlsx":
      return readXlsx(buf);
    case "pptx":
      return readPptx(buf);
    case "epub":
      return readEpub(buf);
    case "odt":
      return readOdt(buf);
    case "pdf":
      return readPdf(buf);
  }
}

/**
 * PDF text extraction.
 *
 * The one format people actually send, and the only one this tool could not
 * open — which made "read this document" fail on the common case while
 * succeeding on ODT.
 *
 * Two things worth stating about how this works:
 *
 * A PDF has no paragraphs. It is a set of positioned glyph runs, so the text
 * has to be reassembled from coordinates: a run that starts on a new vertical
 * position is a new line, and a gap on the same line is a space. Concatenating
 * the runs in file order — which is the naive approach — produces text with
 * words fused together and columns interleaved.
 *
 * A scanned PDF contains no text at all, only images. It extracts to an empty
 * string, and saying "this file is empty" would be actively misleading. That
 * case is detected and explained, with a usable suggestion, rather than
 * reported as success.
 */
async function readPdf(buf: Uint8Array): Promise<DocumentResult> {
  // The legacy build is the one that runs under Node without a DOM.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const doc = await pdfjs.getDocument({
    // pdf.js takes ownership of the buffer, so it gets a copy — the caller's
    // Uint8Array is reused elsewhere and would be detached.
    data: new Uint8Array(buf),
    useSystemFonts: true,
    // Nothing here should ever reach the network or execute embedded code.
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  const pages: string[] = [];
  let chars = 0;
  let truncated = false;

  for (let i = 1; i <= doc.numPages; i++) {
    if (chars >= MAX_DOC_CHARS) {
      truncated = true;
      break;
    }
    const page = await doc.getPage(i);
    const content = await page.getTextContent();

    let text = "";
    let lastY: number | null = null;
    let lastEndX: number | null = null;

    for (const item of content.items as { str: string; transform?: number[]; width?: number }[]) {
      const str = item.str ?? "";
      if (!str) continue;
      const x = item.transform?.[4];
      const y = item.transform?.[5];

      if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) {
        // A different vertical position is a new line.
        text += "\n";
      } else if (
        lastEndX !== null &&
        x !== undefined &&
        x - lastEndX > 1 &&
        !/\s$/.test(text) &&
        !/^\s/.test(str)
      ) {
        // Same line, but a visible gap: a space the PDF did not encode.
        text += " ";
      }

      text += str;
      if (y !== undefined) lastY = y;
      if (x !== undefined) lastEndX = x + (item.width ?? 0);
    }

    pages.push(text.trim());
    chars += text.length;
  }

  const joined = pages.join("\n\n");

  if (!joined.trim()) {
    return {
      text:
        "[This PDF contains no extractable text. It is almost certainly a " +
        "scan or an export of images, so the words are pixels rather than " +
        "characters. To read it, convert the pages to images and use " +
        "view_image, which can actually look at them.]",
      sections: doc.numPages,
      truncated: false,
    };
  }

  return {
    text: joined.slice(0, MAX_DOC_CHARS),
    sections: doc.numPages,
    truncated: truncated || joined.length > MAX_DOC_CHARS,
  };
}

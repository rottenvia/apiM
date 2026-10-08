//! Reading office documents (src/lib/documents.ts): DOCX, XLSX, PPTX, EPUB and ODT are zips of XML, so the text is
//! pulled out of known parts by stripping tags, not by a real XML parser (it cannot fail on sloppy markup). PDF needs
//! a parser: see `pdf_pages`.

use super::{js_trim, len16, slice16};
use regex::Regex;
use std::collections::BTreeMap;
use std::sync::LazyLock;

/// Matches the attachment cap, so a document cannot outgrow a text file.
pub const MAX_DOC_CHARS: usize = 800_000;

macro_rules! re {
    ($pattern:expr) => {{
        static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new($pattern).unwrap());
        &*RE
    }};
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocumentKind {
    Docx,
    Xlsx,
    Pptx,
    Epub,
    Odt,
    Pdf,
}

impl DocumentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DocumentKind::Docx => "docx",
            DocumentKind::Xlsx => "xlsx",
            DocumentKind::Pptx => "pptx",
            DocumentKind::Epub => "epub",
            DocumentKind::Odt => "odt",
            DocumentKind::Pdf => "pdf",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DocumentResult {
    pub text: String,
    /// Sheets, slides or chapters, when the format has them.
    pub sections: usize,
    pub truncated: bool,
}

/// The kind of document a file name says it is.
pub fn document_kind(name: &str) -> Option<DocumentKind> {
    let at = name.rfind('.')?;
    Some(match name[at + 1..].to_lowercase().as_str() {
        "docx" => DocumentKind::Docx,
        "xlsx" => DocumentKind::Xlsx,
        "pptx" => DocumentKind::Pptx,
        "epub" => DocumentKind::Epub,
        "odt" => DocumentKind::Odt,
        "pdf" => DocumentKind::Pdf,
        _ => return None,
    })
}

/// UTF-8 the way `TextDecoder` does it: bad bytes become U+FFFD and a leading byte-order mark disappears.
fn utf8(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.strip_prefix('\u{feff}').unwrap_or(&text).to_string()
}

/// An XML fragment as readable text. Paragraph and row ends become newlines before the tags go, or the whole
/// document would collapse into one line.
fn xml_to_text(xml: &str, break_on: &Regex) -> String {
    let text = break_on.replace_all(xml, "\n");
    let text = re!(r"<w:tab\b[^>]*/?>").replace_all(&text, "\t");
    let text = re!(r"<[^>]+>").replace_all(&text, "");
    let text = text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'");
    // `String.fromCharCode`: one UTF-16 unit, so anything past 65535 wraps and a lone surrogate cannot be kept.
    let text = re!(r"&#([0-9]+);").replace_all(&text, |c: &regex::Captures| {
        let unit = c[1].parse::<u64>().map_or(0, |n| (n % 65536) as u32);
        char::from_u32(unit).unwrap_or('\u{fffd}').to_string()
    });
    // Ampersand last, or the entities above would be corrupted.
    let text = text.replace("&amp;", "&");
    let text = re!(r"[ \t]+\n").replace_all(&text, "\n");
    let text = re!(r"\n{3,}").replace_all(&text, "\n\n");
    js_trim(&text).to_string()
}

fn clamp(text: String, max_chars: usize) -> (String, bool) {
    if len16(&text) <= max_chars {
        return (text, false);
    }
    (slice16(&text, max_chars).to_string(), true)
}

/// The members of a zip that `want` accepts, by name.
///
/// ponytail: `tools::data` owns the zip reader but keeps it private, so this goes through its public `extract_archive`
/// into a scratch folder and reads the wanted files back. If `data.rs` ever offers a `pub(crate)` "members of a zip",
/// this one function is the only place to change.
fn zip_members(buf: &[u8], want: impl Fn(&str) -> bool) -> Result<BTreeMap<String, Vec<u8>>, String> {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let invalid = || "Not a valid .zip file".to_string();
    let scratch = std::env::temp_dir().join(format!("apim-zip-{}-{}", std::process::id(), COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let result = (|| {
        std::fs::create_dir_all(&scratch).and_then(|_| std::fs::write(scratch.join("doc.zip"), buf)).map_err(|_| invalid())?;
        if !crate::tools::data::extract_archive(&scratch, &serde_json::json!({ "path": "doc.zip", "dest": "out" })).ok {
            return Err(invalid());
        }
        let out = scratch.join("out");
        let mut parts = BTreeMap::new();
        for entry in walkdir::WalkDir::new(&out).into_iter().flatten().filter(|e| e.file_type().is_file()) {
            let name = entry.path().strip_prefix(&out).map_or(String::new(), |p| p.to_string_lossy().replace('\\', "/"));
            if want(&name) {
                parts.insert(name, std::fs::read(entry.path()).map_err(|_| invalid())?);
            }
        }
        Ok(parts)
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

/// The number before `.xml` in a part name, so sheet2 sorts before sheet10.
fn part_number(name: &str) -> u64 {
    re!(r"([0-9]+)\.xml$").captures(name).and_then(|c| c[1].parse().ok()).unwrap_or(0)
}

/// Word: one main part, plus footnotes and endnotes worth keeping.
fn read_docx(buf: &[u8], max_chars: usize) -> Result<DocumentResult, String> {
    let parts = zip_members(buf, |p| matches!(p, "word/document.xml" | "word/footnotes.xml" | "word/endnotes.xml"))?;
    let main = parts.get("word/document.xml").ok_or("no document part — is this really a .docx?")?;
    let mut text = xml_to_text(&utf8(main), re!(r"</w:p>|<w:br\b[^>]*/?>"));
    for (name, label) in [("word/footnotes.xml", "Footnotes"), ("word/endnotes.xml", "Endnotes")] {
        let Some(part) = parts.get(name) else { continue };
        let notes = xml_to_text(&utf8(part), re!(r"</w:p>"));
        // Word always writes these parts, usually holding only separator marks.
        if len16(&notes) > 20 {
            text.push_str(&format!("\n\n--- {label} ---\n{notes}"));
        }
    }
    let (text, truncated) = clamp(text, max_chars);
    Ok(DocumentResult { text, sections: 1, truncated })
}

/// `Number(value)` used as an index: an empty string is 0, anything that is not a whole non-negative number finds nothing.
fn index_of(value: &str) -> Option<usize> {
    let value = js_trim(value);
    if value.is_empty() {
        return Some(0);
    }
    let n: f64 = value.parse().ok()?;
    (n.is_finite() && n >= 0.0 && n.fract() == 0.0).then_some(n as usize)
}

/// Excel: sheets as rows of tab-separated cells. Most cell values are indexes into the shared string table, which has to be read first.
fn read_xlsx(buf: &[u8], max_chars: usize) -> Result<DocumentResult, String> {
    let parts = zip_members(buf, |p| p == "xl/sharedStrings.xml" || p == "xl/workbook.xml" || p.starts_with("xl/worksheets/sheet"))?;
    let mut shared = Vec::new();
    if let Some(raw) = parts.get("xl/sharedStrings.xml") {
        for m in re!(r"(?s)<si\b[^>]*>(.*?)</si>").captures_iter(&utf8(raw)) {
            shared.push(js_trim(&xml_to_text(&m[1], re!(r"</a:p>")).replace('\n', " ")).to_string());
        }
    }
    // Sheet names live in the workbook part, in the same order as the files.
    let names: Vec<String> = parts.get("xl/workbook.xml").map_or(Vec::new(), |w| re!(r#"<sheet\b[^>]*name="([^"]*)""#).captures_iter(&utf8(w)).map(|m| m[1].to_string()).collect());
    let mut sheet_paths: Vec<&String> = parts.keys().filter(|p| p.starts_with("xl/worksheets/sheet")).collect();
    sheet_paths.sort_by_key(|p| part_number(p));

    let mut out = Vec::new();
    for (i, path) in sheet_paths.iter().enumerate() {
        let xml = utf8(&parts[*path]);
        let mut rows = Vec::new();
        for row in re!(r"(?s)<row\b[^>]*>(.*?)</row>").captures_iter(&xml) {
            let mut cells = Vec::new();
            for cell in re!(r"(?s)<c\b([^>]*)>(.*?)</c>").captures_iter(&row[1]) {
                let (attrs, body) = (&cell[1], &cell[2]);
                let value = re!(r"(?s)<v>(.*?)</v>").captures(body).map_or("", |m| m.get(1).unwrap().as_str());
                if attrs.contains(r#"t="s""#) {
                    cells.push(index_of(value).and_then(|n| shared.get(n)).cloned().unwrap_or_default());
                } else if attrs.contains(r#"t="inlineStr""#) {
                    cells.push(xml_to_text(body, re!(r"</a:p>")).replace('\n', " "));
                } else {
                    cells.push(value.to_string());
                }
            }
            // A row of empty cells is layout, not data.
            if cells.iter().any(|c| !c.is_empty()) {
                rows.push(cells.join("\t"));
            }
        }
        if rows.is_empty() {
            continue;
        }
        out.push(format!("--- {} ---\n{}", names.get(i).cloned().unwrap_or_else(|| format!("Sheet {}", i + 1)), rows.join("\n")));
    }
    if out.is_empty() {
        return Err("no readable sheets".into());
    }
    let (text, truncated) = clamp(out.join("\n\n"), max_chars);
    Ok(DocumentResult { text, sections: out.len(), truncated })
}

/// PowerPoint: one section per slide, in slide order.
fn read_pptx(buf: &[u8], max_chars: usize) -> Result<DocumentResult, String> {
    let parts = zip_members(buf, |p| re!(r"^ppt/slides/slide[0-9]+\.xml$").is_match(p))?;
    let mut paths: Vec<&String> = parts.keys().collect();
    paths.sort_by_key(|p| part_number(p));
    let mut out = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        let text = xml_to_text(&utf8(&parts[*path]), re!(r"</a:p>"));
        if !text.is_empty() {
            out.push(format!("--- Slide {} ---\n{text}", i + 1));
        }
    }
    if out.is_empty() {
        return Err("no readable slides".into());
    }
    let (text, truncated) = clamp(out.join("\n\n"), max_chars);
    Ok(DocumentResult { text, sections: out.len(), truncated })
}

/// EPUB: the XHTML chapters, in name order.
fn read_epub(buf: &[u8], max_chars: usize) -> Result<DocumentResult, String> {
    let parts = zip_members(buf, |p| re!(r"(?i)\.x?html?$").is_match(p))?;
    let mut out = Vec::new();
    for raw in parts.values() {
        // Scripts and styles sit inside the body and would be read as prose once their tags are stripped.
        let raw = utf8(raw);
        let cleaned = re!(r"(?is)<script.*?</script>").replace_all(&raw, "");
        let cleaned = re!(r"(?is)<style.*?</style>").replace_all(&cleaned, "");
        let text = xml_to_text(&cleaned, re!(r"(?i)</p>|<br\b[^>]*/?>|</h[1-6]>|</div>"));
        if len16(&text) > 40 {
            out.push(text);
        }
    }
    if out.is_empty() {
        return Err("no readable chapters".into());
    }
    let (text, truncated) = clamp(out.join("\n\n"), max_chars);
    Ok(DocumentResult { text, sections: out.len(), truncated })
}

/// OpenDocument text: a single content part, like DOCX but with different tags.
fn read_odt(buf: &[u8], max_chars: usize) -> Result<DocumentResult, String> {
    let parts = zip_members(buf, |p| p == "content.xml")?;
    let main = parts.get("content.xml").ok_or("no content part — is this really an .odt?")?;
    let text = xml_to_text(&utf8(main), re!(r"</text:p>|</text:h>|<text:line-break\b[^>]*/?>"));
    if text.is_empty() {
        return Err("no readable text".into());
    }
    let (text, truncated) = clamp(text, max_chars);
    Ok(DocumentResult { text, sections: 1, truncated })
}

/// The text of every page of a PDF, one string per page, read by `pdf-extract` (MIT, built on `lopdf`).
///
/// ponytail: pdf.js (the web) and pdf-extract order and space glyph runs differently, so multi-column pages and odd fonts
/// can read differently. Upgrade path: a pdf.js-compatible reader.
pub fn pdf_pages_here(buf: &[u8]) -> Result<Vec<String>, String> {
    pdf_extract::extract_text_from_mem_by_pages(buf).map_err(|e| format!("Not a readable PDF: {e}"))
}

/// Reads a PDF's pages in a child of this program (`apim --pdf-pages`, the file on stdin, JSON on stdout): pdf-extract
/// panics on some malformed files and the release build aborts on panic, so a bad PDF is never parsed in the app's own
/// process. A parse still running after a minute is killed.
#[cfg(not(test))]
fn pdf_pages(buf: &[u8]) -> Result<Vec<String>, String> {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let failed = |why: &str| format!("Not a readable PDF: {why}");
    let mut cmd = Command::new(std::env::current_exe().map_err(|e| failed(&e.to_string()))?);
    cmd.arg("--pdf-pages").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000); // no console window flashing up
    let mut child = cmd.spawn().map_err(|e| failed(&e.to_string()))?;
    let (mut stdin, mut stdout) = (child.stdin.take().expect("piped"), child.stdout.take().expect("piped"));
    let bytes = buf.to_vec();
    std::thread::spawn(move || stdin.write_all(&bytes));
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        out
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < Duration::from_secs(60) => std::thread::sleep(Duration::from_millis(30)),
            _ => {
                let _ = child.kill();
                return Err(failed("it took too long to parse"));
            }
        }
    }
    serde_json::from_str::<Result<Vec<String>, String>>(&reader.join().unwrap_or_default()).unwrap_or_else(|_| Err(failed("the parser gave up on this file")))
}

/// Tests run inside the test binary, which has no `--pdf-pages` mode: they parse in place.
#[cfg(test)]
fn pdf_pages(buf: &[u8]) -> Result<Vec<String>, String> {
    pdf_pages_here(buf)
}

const NO_PDF_TEXT: &str = "[This PDF contains no extractable text. It is almost certainly a scan or an export of images, so the words are pixels rather than characters. To read it, convert the pages to images and use view_image, which can actually look at them.]";

/// Joins page text the way the web does: stops reading pages once enough is kept, and explains a PDF with no text at all.
/// Note the web cuts the result at `MAX_DOC_CHARS` here, not at the caller's limit.
pub fn assemble_pdf(all_pages: &[String], max_chars: usize) -> DocumentResult {
    let (mut pages, mut chars, mut truncated) = (Vec::new(), 0, false);
    for page in all_pages {
        if chars >= max_chars {
            truncated = true;
            break;
        }
        pages.push(js_trim(page).to_string());
        chars += len16(page);
    }
    let joined = pages.join("\n\n");
    if js_trim(&joined).is_empty() {
        return DocumentResult { text: NO_PDF_TEXT.into(), sections: all_pages.len(), truncated: false };
    }
    DocumentResult { text: slice16(&joined, MAX_DOC_CHARS).to_string(), sections: all_pages.len(), truncated: truncated || len16(&joined) > MAX_DOC_CHARS }
}

fn read_pdf(buf: &[u8], max_chars: usize) -> Result<DocumentResult, String> {
    Ok(assemble_pdf(&pdf_pages(buf)?, max_chars))
}

/// Reads a document, or says why not in words worth showing the user.
pub fn read_document(kind: DocumentKind, buf: &[u8], max_chars: usize) -> Result<DocumentResult, String> {
    match kind {
        DocumentKind::Docx => read_docx(buf, max_chars),
        DocumentKind::Xlsx => read_xlsx(buf, max_chars),
        DocumentKind::Pptx => read_pptx(buf, max_chars),
        DocumentKind::Epub => read_epub(buf, max_chars),
        DocumentKind::Odt => read_odt(buf, max_chars),
        DocumentKind::Pdf => read_pdf(buf, max_chars),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::test_zip;

    #[test]
    fn kinds_follow_the_last_extension() {
        assert_eq!((document_kind("a.DOCX"), document_kind("x.tar.pdf"), document_kind(".odt"), document_kind("noext"), document_kind("a.txt")), (Some(DocumentKind::Docx), Some(DocumentKind::Pdf), Some(DocumentKind::Odt), None, None));
    }

    #[test]
    fn xml_becomes_text() {
        let text = xml_to_text("<w:p><w:r><w:t>A &amp;lt; B</w:t></w:r><w:tab/><w:t>&#65;&lt;&#66;</w:t></w:p><w:p> </w:p><w:p></w:p><w:p></w:p><w:p><w:t>end</w:t></w:p>", re!(r"</w:p>"));
        assert_eq!(text, "A &lt; B\tA<B\n\nend");
    }

    #[test]
    fn docx_with_notes_and_xlsx_quirks() {
        let docx = test_zip(&[("word/document.xml", b"<w:p><w:t>Hello</w:t></w:p><w:p><w:t>World</w:t><w:br/><w:t>x</w:t></w:p>"), ("word/footnotes.xml", b"<w:p><w:t>a footnote that is long enough</w:t></w:p>"), ("word/endnotes.xml", b"<w:p><w:t>short</w:t></w:p>")]);
        let doc = read_document(DocumentKind::Docx, &docx, MAX_DOC_CHARS).unwrap();
        assert_eq!((doc.text.as_str(), doc.sections, doc.truncated), ("Hello\nWorld\nx\n\n--- Footnotes ---\na footnote that is long enough", 1, false));
        let cut = read_document(DocumentKind::Docx, &docx, 4).unwrap();
        assert_eq!((cut.text.as_str(), cut.truncated), ("Hell", true));
        assert_eq!(read_document(DocumentKind::Docx, &test_zip(&[("a.txt", b"x")]), 10).unwrap_err(), "no document part — is this really a .docx?");
        assert_eq!(read_document(DocumentKind::Docx, b"not a zip", 10).unwrap_err(), "Not a valid .zip file");

        let xlsx = test_zip(&[
            ("xl/workbook.xml", br#"<sheets><sheet name="Data" sheetId="1"/><sheet name="Other" sheetId="2"/></sheets>"#),
            ("xl/sharedStrings.xml", b"<sst><si><t>name</t></si><si><t>a &amp; b</t></si></sst>"),
            ("xl/worksheets/sheet2.xml", br#"<row><c r="A1" t="s"><v>1</v></c></row>"#),
            ("xl/worksheets/sheet10.xml", br#"<row><c t="s"><v>0</v></c><c t="inlineStr"><is><t>q</t></is></c><c><v>7</v></c></row><row><c t="s"><v></v></c></row>"#),
        ]);
        let sheets = read_document(DocumentKind::Xlsx, &xlsx, MAX_DOC_CHARS).unwrap();
        assert_eq!((sheets.text.as_str(), sheets.sections), ("--- Data ---\na & b\n\n--- Other ---\nname\tq\t7\nname", 2));
    }

    #[test]
    fn slides_chapters_and_odt() {
        let pptx = test_zip(&[("ppt/slides/slide2.xml", b"<a:p><a:t>two</a:t></a:p>"), ("ppt/slides/slide1.xml", b"<a:p><a:t>one</a:t></a:p>"), ("ppt/slides/slide3.xml", b"<a:p></a:p>"), ("ppt/slideLayouts/slideLayout1.xml", b"<a:t>no</a:t>")]);
        let deck = read_document(DocumentKind::Pptx, &pptx, MAX_DOC_CHARS).unwrap();
        assert_eq!((deck.text.as_str(), deck.sections), ("--- Slide 1 ---\none\n\n--- Slide 2 ---\ntwo", 2));
        assert_eq!(read_document(DocumentKind::Pptx, &test_zip(&[("a.txt", b"x")]), 10).unwrap_err(), "no readable slides");
        let chapter = format!("<html><style>p{{}}</style><script>var x;</script><p>{}</p><p>second</p></html>", "word ".repeat(10));
        let epub = test_zip(&[("OEBPS/b.xhtml", chapter.as_bytes()), ("OEBPS/a.html", b"<p>tiny</p>")]);
        let book = read_document(DocumentKind::Epub, &epub, MAX_DOC_CHARS).unwrap();
        assert_eq!((book.sections, book.text.starts_with("word word")), (1, true));
        let odt = test_zip(&[("content.xml", b"<text:p>one</text:p><text:h>two</text:h>three<text:line-break/>four")]);
        assert_eq!(read_document(DocumentKind::Odt, &odt, MAX_DOC_CHARS).unwrap().text, "one\ntwo\nthree\nfour");
        assert_eq!(read_document(DocumentKind::Odt, &test_zip(&[("content.xml", b"<a/>")]), 10).unwrap_err(), "no readable text");
    }

    #[test]
    fn pdf_pages_are_joined_like_the_web() {
        let pages = vec!["  first ".to_string(), "second".to_string()];
        assert_eq!(assemble_pdf(&pages, 100), DocumentResult { text: "first\n\nsecond".into(), sections: 2, truncated: false });
        assert_eq!(assemble_pdf(&pages, 5), DocumentResult { text: "first".into(), sections: 2, truncated: true });
        let scan = assemble_pdf(&[" ".to_string()], 100);
        assert!(scan.text.starts_with("[This PDF contains no extractable text.") && scan.sections == 1 && !scan.truncated);
        assert!(read_document(DocumentKind::Pdf, b"%PDF-1.4", 10).unwrap_err().starts_with("Not a readable PDF"));
    }

    #[test]
    fn pdf_text_is_read_page_by_page() {
        // One page that says "Hello PDF", written out here so the cross-reference offsets are real.
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            "<< /Length 40 >>\nstream\nBT /F1 18 Tf 20 100 Td (Hello PDF) Tj ET\nendstream",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ];
        let mut pdf = String::from("%PDF-1.4\n");
        let mut offsets = Vec::new();
        for (i, body) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.push_str(&format!("{} 0 obj\n{body}\nendobj\n", i + 1));
        }
        let xref = pdf.len();
        pdf.push_str(&format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1));
        for at in offsets {
            pdf.push_str(&format!("{at:010} 00000 n \n"));
        }
        pdf.push_str(&format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1));
        assert_eq!(pdf_pages(pdf.as_bytes()).unwrap().len(), 1);
        let doc = read_document(DocumentKind::Pdf, pdf.as_bytes(), 100).unwrap();
        assert!(doc.text.contains("Hello PDF") && doc.sections == 1 && !doc.truncated);
    }
}

#[cfg(test)]
mod parity {
    use super::*;
    use crate::media::fixtures::{ALL, file, same};

    #[test]
    fn matches_the_web_on_the_recorded_fixtures() {
        for case in ALL["documents"].as_array().unwrap() {
            let name = case["file"].as_str().unwrap();
            let max = case["maxChars"].as_u64().map_or(MAX_DOC_CHARS, |n| n as usize);
            let got = read_document(document_kind(name).unwrap(), &file(name), max);
            let want = &case["expect"];
            match (&got, want["error"].as_str()) {
                (Err(e), Some(w)) => assert_eq!(e, w, "{name}"),
                (Ok(d), None) => assert!(same(&d.text, &want["text"]) && d.sections as u64 == want["sections"].as_u64().unwrap() && d.truncated == want["truncated"].as_bool().unwrap(), "{name}: {} / {} / {} vs {want}", d.text, d.sections, d.truncated),
                _ => panic!("{name}: {got:?} vs {want}"),
            }
        }
        for k in ALL["kinds"].as_array().unwrap() {
            assert_eq!(document_kind(k[0].as_str().unwrap()).map(DocumentKind::as_str), k[1].as_str(), "{k}");
        }
    }
}

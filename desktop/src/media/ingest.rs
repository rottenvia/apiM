//! What the model is told about a file the user dropped in (src/lib/ingest.ts). The file is saved to the workspace as
//! exact bytes first; this describes it the way a person would before opening it: a small file is shown whole, a big one
//! gets its shape (a data file's structure, a log's head and tail, a document's opening text, an archive's tree) with the
//! path and the tool that reads the rest. Every path comes from the workspace and goes through `files::resolve`.

use super::documents::{MAX_DOC_CHARS, document_kind, read_document};
use super::{commas, len16, slice16, to_fixed};
use crate::tools::files::{resolve, walk};
use regex::Regex;
use serde_json::json;
use std::cmp::Ordering;
use std::io::Read;
use std::path::Path;
use std::sync::LazyLock;

/// Text up to this many characters is shown whole (about 28k tokens).
pub const INLINE_CHARS: usize = 100_000;
/// A document's text shown in the message before pointing at read_document.
const DOC_PREVIEW_CHARS: usize = 20_000;
const HEAD_LINES: usize = 80;
const TAIL_LINES: usize = 30;
const PREVIEW_LINE_CHARS: usize = 400;
/// The size past which `query_data` will not load a data file (as in `tools::data`).
const MAX_DATA_BYTES: u64 = 400 * 1024 * 1024;

macro_rules! re {
    ($pattern:expr) => {{
        static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new($pattern).unwrap());
        &*RE
    }};
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UploadKind {
    Text,
    Data,
    Document,
    Image,
    Binary,
    Archive,
    Folder,
}

#[derive(Clone, Debug, PartialEq)]
pub struct UploadDescription {
    pub path: String,
    pub bytes: u64,
    pub kind: UploadKind,
    /// The whole content is in `text`.
    pub inline: bool,
    /// What goes into the message for the model.
    pub text: String,
    /// Short line for the chip, e.g. "JSON · 150,000 items".
    pub label: String,
    pub file_count: Option<usize>,
}

pub fn format_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{} KB", to_fixed(bytes as f64 / 1024.0, 1))
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{} MB", to_fixed(bytes as f64 / 1024.0 / 1024.0, 1))
    } else {
        format!("{} GB", to_fixed(bytes as f64 / 1024.0 / 1024.0 / 1024.0, 2))
    }
}

// ---------------------------------------------------------------- sniffing

/// "PNG", "JPEG", "GIF", "BMP" or "WebP" from the first bytes.
pub fn image_kind(head: &[u8]) -> Option<&'static str> {
    for (magic, name) in [(&[0x89, 0x50, 0x4e, 0x47][..], "PNG"), (&[0xff, 0xd8, 0xff], "JPEG"), (&[0x47, 0x49, 0x46, 0x38], "GIF"), (&[0x42, 0x4d], "BMP")] {
        if head.starts_with(magic) {
            return Some(name);
        }
    }
    (head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WEBP")).then_some("WebP")
}

/// The executable formats `inspect_binary` takes apart (the web's `detectBinaryFormat`, minus the architecture line).
fn detect_binary_format(b: &[u8], name: &str) -> &'static str {
    if b.len() >= 5 && b.starts_with(&[0x7f, 0x45, 0x4c, 0x46]) {
        return "ELF";
    }
    let word = |le: bool| b.get(..4).map_or(0, |w| if le { u32::from_le_bytes([w[0], w[1], w[2], w[3]]) } else { u32::from_be_bytes([w[0], w[1], w[2], w[3]]) });
    let (le, be) = (word(true), word(false));
    if matches!(le, 0xfeedface | 0xfeedfacf) || matches!(be, 0xfeedface | 0xfeedfacf) {
        return "Mach-O";
    }
    // 0xCAFEBABE is both a Mach-O fat header and a Java class file; the next word tells them apart: a fat binary counts
    // its slices there, a class file has its version (45 or more).
    if be == 0xcafebabe {
        let next = b.get(4..8).map_or(0, |w| u32::from_be_bytes([w[0], w[1], w[2], w[3]]));
        return if (45..0x10000).contains(&next) { "Java class" } else { "Mach-O universal" };
    }
    if le == 0xcafebabe {
        return "Mach-O universal";
    }
    if b.starts_with(b"dex\n") {
        return "Android DEX";
    }
    if b.starts_with(b"\0asm") {
        return "WebAssembly";
    }
    let lower = name.to_lowercase();
    if lower.ends_with(".pyc") && b.get(2) == Some(&0x0d) && b.get(3) == Some(&0x0a) {
        return "Python bytecode";
    }
    if b.starts_with(b"PK") {
        if [".apk", ".aab", ".aar"].iter().any(|e| lower.ends_with(e)) {
            return "Android package";
        }
        if [".jar", ".war", ".ear"].iter().any(|e| lower.ends_with(e)) {
            return "Java archive";
        }
    }
    "unknown binary"
}

/// The executable format of a file, if it is one.
pub fn executable_kind(head: &[u8], name: &str) -> Option<&'static str> {
    if head.starts_with(b"MZ") {
        return Some("Windows PE");
    }
    Some(detect_binary_format(head, name)).filter(|f| *f != "unknown binary")
}

fn utf16_bom(head: &[u8]) -> Option<bool> {
    match (head.first(), head.get(1)) {
        (Some(0xff), Some(0xfe)) => Some(true),
        (Some(0xfe), Some(0xff)) => Some(false),
        _ => None,
    }
}

/// A NUL, or more than 10% control bytes, in the first 8 KB; UTF-16 with a byte-order mark is text.
pub fn looks_binary(head: &[u8]) -> bool {
    if utf16_bom(head).is_some() {
        return false;
    }
    let n = head.len().min(8192);
    if n == 0 {
        return false;
    }
    let mut odd = 0;
    for &b in &head[..n] {
        if b == 0 {
            return true;
        }
        if b < 7 || (b > 13 && b < 32 && b != 27) {
            odd += 1;
        }
    }
    odd as f64 / n as f64 > 0.1
}

/// The bytes as text: UTF-16 by its byte-order mark, UTF-8 otherwise, without a leading BOM.
fn decode(buf: &[u8]) -> String {
    let text = match utf16_bom(buf) {
        Some(le) => {
            let units: Vec<u16> = buf.chunks_exact(2).map(|p| if le { u16::from_le_bytes([p[0], p[1]]) } else { u16::from_be_bytes([p[0], p[1]]) }).collect();
            String::from_utf16_lossy(&units)
        }
        None => String::from_utf8_lossy(buf).into_owned(),
    };
    text.strip_prefix('\u{feff}').unwrap_or(&text).to_string()
}

/// Node's `path.extname`: ".gz" for "a.tar.gz", "" for ".bashrc".
fn extname(path: &str) -> &str {
    let base = path.rsplit(['/', '\\']).next().unwrap_or("");
    match base.rfind('.') {
        Some(i) if i > 0 && !base[..i].chars().all(|c| c == '.') => &base[i..],
        _ => "",
    }
}

fn basename(path: &str) -> &str {
    path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("")
}

/// The language hint after the opening code fence.
fn fence(name: &str) -> String {
    let ext = extname(name).trim_start_matches('.').to_lowercase();
    if !ext.is_empty() && len16(&ext) <= 12 && re!(r"^[a-z0-9+#-]+$").is_match(&ext) { ext } else { String::new() }
}

fn clip_line(line: &str) -> String {
    let n = len16(line);
    if n > PREVIEW_LINE_CHARS { format!("{}…[+{} chars]", slice16(line, PREVIEW_LINE_CHARS), n - PREVIEW_LINE_CHARS) } else { line.to_string() }
}

fn read_head(path: &Path, n: usize) -> Result<Vec<u8>, String> {
    let mut head = Vec::new();
    std::fs::File::open(path).and_then(|f| f.take(n as u64).read_to_end(&mut head)).map_err(|e| e.to_string())?;
    Ok(head)
}

/// The data format a file name or its opening text says it has (`tools::data` keeps its own copy private).
fn format_for(name: &str, head: &str) -> Option<&'static str> {
    match extname(name).to_lowercase().as_str() {
        ".jsonl" | ".ndjson" => return Some("jsonl"),
        ".csv" => return Some("csv"),
        ".tsv" | ".tab" => return Some("tsv"),
        ".json" | ".geojson" | ".har" | ".map" => return Some("json"),
        _ => {}
    }
    let t = head.strip_prefix('\u{feff}').unwrap_or(head).trim_start();
    if !t.starts_with(['{', '[']) {
        return None;
    }
    // One object per line reads as JSONL.
    let first = super::js_trim(t.split('\n').next().unwrap_or(""));
    Some(if t.contains('\n') && first.starts_with('{') && first.ends_with('}') { "jsonl" } else { "json" })
}

/// The structure of a data file as `query_data` describes it (its answer without a query), without the web's
/// "main collection" count: `tools::data` keeps `mainCollection` private.
fn data_structure(root: &Path, rel: &str) -> Option<String> {
    let out = crate::tools::data::query_data(root, &json!({ "path": rel }));
    if !out.ok {
        return None;
    }
    let body = out.text.strip_prefix(&format!("{rel}\n"))?;
    Some(body.rsplit_once("\n\nQuery it with JSONPath").map_or(body, |(shape, _)| shape).to_string())
}

/// The example queries the web writes against a data file's own shape.
fn query_examples(shape: &str) -> String {
    if !shape.lines().any(|l| l.starts_with("$: array [")) {
        return "$, $..<key>".into();
    }
    let mut examples = vec!["$[0:5]".to_string(), "$[-1]".to_string()];
    let field = shape.lines().skip_while(|l| !l.starts_with("  [*]: object")).nth(1).and_then(|l| l.trim_start().strip_prefix('.')).and_then(|l| l.split(':').next());
    if let Some(field) = field {
        examples.push(format!("$[?(@.{field} == …)]"));
        examples.push(format!("$[*].{field}"));
    }
    examples.join(", ")
}

// ---------------------------------------------------------------- describe

fn describe_text(root: &Path, rel: &str, abs: &Path, bytes: u64) -> Result<UploadDescription, String> {
    // Big data files: parse for structure instead of loading text that will not be shown.
    let head = String::from_utf8_lossy(&read_head(abs, 4096)?).into_owned();
    if let Some(format) = format_for(rel, &head) {
        if bytes > INLINE_CHARS as u64 && bytes <= MAX_DATA_BYTES {
            // ponytail: the web asks `mainCollection` for the count and the examples; that is private to `tools::data`, so both
            // are read back from the structure text (its first line says "JSON · 0.1MB · 3,000 items"). A top-level array of
            // objects gets the web's examples; any other shape gets the generic pair.
            if let Some(shape) = data_structure(root, rel) {
                let counted = re!(r" · ([0-9,]+) ([A-Za-z_]+)$").captures(shape.lines().next().unwrap_or(""));
                let label = format!("{} · {}{}", format.to_uppercase(), format_size(bytes), counted.map_or(String::new(), |c| format!(" · {} {}", &c[1], &c[2])));
                return Ok(UploadDescription {
                    path: rel.into(),
                    bytes,
                    kind: UploadKind::Data,
                    inline: false,
                    label,
                    text: format!(
                        "Attached file: {rel} ({}) — saved in the workspace; too large to show whole, so here is its structure.\n{shape}\n\nRead it with query_data path=\"{rel}\" — JSONPath queries such as {}; count:true, fields, and save_as to write a subset to a file. For heavy processing, run a script against the file.",
                        format_size(bytes),
                        query_examples(&shape)
                    ),
                    file_count: None,
                });
            }
        }
    }
    // Not parseable as data: describe it as text.
    let text = decode(&std::fs::read(abs).map_err(|e| e.to_string())?);
    let lines: Vec<&str> = text.split('\n').collect();
    if len16(&text) <= INLINE_CHARS {
        return Ok(UploadDescription {
            path: rel.into(),
            bytes,
            kind: UploadKind::Text,
            inline: true,
            label: format!("{} lines", commas(lines.len() as u64)),
            text: format!("Attached file: {rel} (saved in the workspace)\n```{}\n{text}\n```", fence(rel)),
            file_count: None,
        });
    }
    let head_lines: Vec<String> = lines.iter().take(HEAD_LINES).map(|l| clip_line(l)).collect();
    let tail_lines: Vec<String> = if lines.len() > HEAD_LINES + TAIL_LINES { lines[lines.len() - TAIL_LINES..].iter().map(|l| clip_line(l)).collect() } else { Vec::new() };
    let longest = lines.iter().map(|l| len16(l)).max().unwrap_or(0);
    let mut out = format!(
        "Attached file: {rel} ({}, {} lines, {} characters) — saved in the workspace; too large to show whole.\nFirst {} lines:\n```{}\n{}\n```\n",
        format_size(bytes),
        commas(lines.len() as u64),
        commas(len16(&text) as u64),
        head_lines.len(),
        fence(rel),
        head_lines.join("\n")
    );
    if !tail_lines.is_empty() {
        out.push_str(&format!("Last {} lines:\n```{}\n{}\n```\n", tail_lines.len(), fence(rel), tail_lines.join("\n")));
    }
    if longest > 100_000 {
        out.push_str(&format!("Some lines are extremely long (up to {} characters) — read_file cannot page through those; use search_files or a script.\n", commas(longest as u64)));
    }
    out.push_str(&format!("Read more with read_file path=\"{rel}\" start_line=… end_line=…, find things with search_files, or process it with a script."));
    Ok(UploadDescription { path: rel.into(), bytes, kind: UploadKind::Text, inline: false, label: format!("{} · {} lines", format_size(bytes), commas(lines.len() as u64)), text: out, file_count: None })
}

/// Describes one uploaded workspace file. Archives are handled by `ingest_upload` (they are extracted first).
pub fn describe_upload(root: &Path, rel: &str) -> Result<UploadDescription, String> {
    let abs = resolve(root, rel)?;
    let meta = std::fs::metadata(&abs).map_err(|_| format!("No such file: {rel}"))?;
    if meta.is_dir() {
        return describe_folder(root, rel);
    }
    let bytes = meta.len();
    let head = read_head(&abs, 8192)?;
    let name = basename(rel);

    if let Some(kind) = document_kind(name) {
        let upper = kind.as_str().to_uppercase();
        let read = std::fs::read(&abs).map_err(|e| e.to_string()).and_then(|data| read_document(kind, &data, MAX_DOC_CHARS));
        return Ok(match read {
            Ok(out) => {
                let whole = len16(&out.text) <= DOC_PREVIEW_CHARS && !out.truncated;
                UploadDescription {
                    path: rel.into(),
                    bytes,
                    kind: UploadKind::Document,
                    inline: whole,
                    label: format!("{upper} · {}{}", format_size(bytes), if out.sections > 1 { format!(" · {} sections", out.sections) } else { String::new() }),
                    text: format!(
                        "Attached document: {rel} ({}) — saved in the workspace.\n{}",
                        format_size(bytes),
                        if whole { out.text } else { format!("First {} characters of its text:\n{}\n…\nRead the rest with read_document path=\"{rel}\".", commas(DOC_PREVIEW_CHARS as u64), slice16(&out.text, DOC_PREVIEW_CHARS)) }
                    ),
                    file_count: None,
                }
            }
            Err(e) => UploadDescription {
                path: rel.into(),
                bytes,
                kind: UploadKind::Document,
                inline: false,
                label: format!("{upper} · {}", format_size(bytes)),
                text: format!("Attached document: {rel} ({}) — saved in the workspace, but its text could not be extracted here ({e}). Try read_document path=\"{rel}\".", format_size(bytes)),
                file_count: None,
            },
        });
    }

    if let Some(image) = image_kind(&head) {
        return Ok(UploadDescription {
            path: rel.into(),
            bytes,
            kind: UploadKind::Image,
            inline: false,
            label: format!("{image} · {}", format_size(bytes)),
            text: format!("Attached image: {rel} ({image}, {}) — saved in the workspace; view_image path=\"{rel}\" looks at it.", format_size(bytes)),
            file_count: None,
        });
    }

    let exe = executable_kind(&head, name);
    if exe.is_some() || looks_binary(&head) {
        return Ok(UploadDescription {
            path: rel.into(),
            bytes,
            kind: UploadKind::Binary,
            inline: false,
            label: format!("{} · {}", exe.unwrap_or("binary"), format_size(bytes)),
            text: format!(
                "Attached {}: {rel} ({}) — saved as exact bytes; it was not executed. Use inspect_binary path=\"{rel}\": start with analyses:[\"summary\"] or [\"strings\"], then decompile only the functions you need (focus_terms). Do not dump the whole binary.",
                exe.unwrap_or("binary file"),
                format_size(bytes)
            ),
            file_count: None,
        });
    }

    describe_text(root, rel, &abs, bytes)
}

// ---------------------------------------------------------------- saving (src/lib/upload-stream.ts)

/// The next free name: `a.json`, `a-2.json`, `a-3.json`… so a second upload never overwrites the first. (A path that
/// cannot be resolved counts as free, as in the web; saving it then reports the real reason.)
pub fn free_name(root: &Path, rel: &str) -> Result<String, String> {
    let ext = extname(rel);
    let stem = &rel[..rel.len() - ext.len()];
    for n in 1..1000 {
        let candidate = if n == 1 { rel.to_string() } else { format!("{stem}-{n}{ext}") };
        match resolve(root, &candidate) {
            Ok(path) if path.exists() => continue,
            _ => return Ok(candidate),
        }
    }
    Err(format!("Too many files named like {rel}"))
}

/// Copies `source` into the workspace at `target` through a temporary file in the workspace, renamed into place only once it
/// is complete and within `max_bytes`, so a failed or oversized copy never leaves half a file where the agent would read it.
/// Returns the workspace path and the bytes written.
pub fn save_upload(root: &Path, source: &Path, target: &str, max_bytes: u64) -> Result<(String, u64), String> {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dest = resolve(root, target)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = root.join(format!(".upload-{}-{}.tmp", std::process::id(), COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let copied = std::fs::File::open(source).and_then(|f| std::io::copy(&mut f.take(max_bytes + 1), &mut std::fs::File::create(&tmp)?));
    let outcome = match copied {
        Ok(n) if n <= max_bytes => std::fs::rename(&tmp, &dest).map(|_| (target.to_string(), n)).map_err(|e| e.to_string()),
        Ok(_) => Err(format!("{} is larger than the {}MB upload limit.", basename(target), (max_bytes as f64 / 1024.0 / 1024.0 + 0.5).floor())),
        Err(e) => Err(e.to_string()),
    };
    if outcome.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    outcome
}

// ---------------------------------------------------------------- archives

const CONTAINER_EXTS: &[&str] = &[
    "docx", "docm", "dotx", "dotm", "xlsx", "xlsm", "xltx", "xltm", "xlsb", "pptx", "pptm", "potx", "ppsx", "ppsm", "odt", "ods", "odp", "odg", "odf", "ott", "ots", "otp", "epub", "jar", "war", "ear", "aar", "apk", "apks", "aab", "xapk", "ipa", "xpi", "crx",
    "vsix", "nupkg", "whl", "egg", "appx", "appxbundle", "msix", "msixbundle", "xps", "oxps", "kmz", "3mf", "sketch", "pages", "numbers", "key", "pbix", "usdz", "mcpack", "mcaddon", "mcworld", "ora", "svgz", "emz", "wmz", "fig", "xd", "vsdx", "one",
];

const EXT_KIND: &[(&str, &str)] = &[
    ("zip", "zip"), ("zipx", "zip"), ("7z", "7z"), ("rar", "rar"), ("tar", "tar"), ("gz", "gzip"), ("gzip", "gzip"), ("tgz", "gzip"), ("tpz", "gzip"), ("bz2", "bzip2"), ("bzip2", "bzip2"), ("tbz", "bzip2"), ("tbz2", "bzip2"), ("xz", "xz"),
    ("txz", "xz"), ("zst", "zstd"), ("zstd", "zstd"), ("tzst", "zstd"), ("lzma", "lzma"), ("z", "compress"), ("taz", "compress"), ("cab", "cab"), ("iso", "iso"), ("udf", "iso"), ("wim", "wim"), ("swm", "wim"), ("esd", "wim"),
    ("cpio", "cpio"), ("deb", "ar"), ("udeb", "ar"), ("ar", "ar"), ("rpm", "rpm"), ("xar", "xar"), ("lzh", "lzh"), ("lha", "lzh"), ("arj", "arj"), ("001", "split"),
];

/// What kind of archive a file is, if any: magic bytes first, the extension for formats without a reliable magic.
/// Documents built on zip (docx, jar, apk, epub…) are not archives.
pub fn sniff_archive(head: &[u8], name: &str) -> Option<&'static str> {
    const MAGIC: &[(usize, &[u8], &str)] = &[
        (0, b"PK\x03\x04", "zip"), (0, b"PK\x05\x06", "zip"), (0, b"PK\x07\x08", "zip"), (0, b"7z\xbc\xaf\x27\x1c", "7z"), (0, b"Rar!\x1a\x07", "rar"), (0, b"\x1f\x8b", "gzip"), (0, b"BZh", "bzip2"), (0, b"\xfd7zXZ\x00", "xz"),
        (0, b"\x28\xb5\x2f\xfd", "zstd"), (0, b"\x1f\x9d", "compress"), (0, b"MSCF\0\0\0\0", "cab"), (0, b"MSWIM\0\0\0", "wim"), (257, b"ustar", "tar"), (0x8001, b"CD001", "iso"), (0x8001, b"BEA01", "iso"), (0, b"!<arch>\n", "ar"),
        (0, b"\xed\xab\xee\xdb", "rpm"), (0, b"xar!", "xar"), (0, b"070707", "cpio"), (0, b"070701", "cpio"), (0, b"070702", "cpio"), (0, b"\xc7\x71", "cpio"), (0, b"\x71\xc7", "cpio"), (2, b"-lh", "lzh"), (0, b"\x60\xea", "arj"),
    ];
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let ext = base.rfind('.').filter(|&dot| dot > 0).map_or(String::new(), |dot| base[dot + 1..].to_lowercase());
    if CONTAINER_EXTS.contains(&ext.as_str()) {
        return None;
    }
    for &(offset, magic, kind) in MAGIC {
        let also = match kind {
            "bzip2" => matches!(head.get(3), Some(b'1'..=b'9')),
            "lzh" => head.get(6) == Some(&b'-'),
            _ => true,
        };
        if also && head.get(offset..offset + magic.len()) == Some(magic) {
            return Some(kind);
        }
    }
    let by_ext = EXT_KIND.iter().find(|(e, _)| *e == ext).map(|(_, kind)| *kind)?;
    // With enough bytes to judge, an extension whose magic is absent is only believed for formats without a reliable magic.
    let weak = ["tar", "lzma", "split", "iso"].contains(&by_ext);
    if (head.len() >= 512 && !weak) || (by_ext == "iso" && head.len() >= 0x8006) {
        return None;
    }
    Some(by_ext)
}

/// Describes a dropped file, unpacking it first when it is an archive (through `tools::data::extract_archive`, which has the
/// zip-slip, link and bomb checks). The message then carries the unpacked tree instead of "binary file". A password-protected
/// archive is not recognised here: `extract_archive` reports it as unreadable, and that is what the description says.
pub fn ingest_upload(root: &Path, rel: &str, extract: bool) -> Result<UploadDescription, String> {
    if !extract {
        return describe_upload(root, rel);
    }
    let abs = resolve(root, rel)?;
    let meta = std::fs::metadata(&abs).map_err(|_| format!("No such file: {rel}"))?;
    if !meta.is_file() {
        return describe_upload(root, rel);
    }
    let Some(kind) = sniff_archive(&read_head(&abs, 8192)?, basename(rel)) else { return describe_upload(root, rel) };
    let (upper, size) = (kind.to_uppercase(), meta.len());
    let out = crate::tools::data::extract_archive(root, &json!({ "path": rel }));
    let summary = out.text.strip_prefix(&format!("Unpacked {rel}.\n"));
    let (Some(summary), Some(dest), true) = (summary, out.changed.as_deref(), out.ok) else {
        let why = out.text.strip_prefix("Error: ").unwrap_or(&out.text);
        return Ok(UploadDescription {
            path: rel.into(),
            bytes: size,
            kind: UploadKind::Archive,
            inline: false,
            label: format!("{upper} · {} · not unpacked", format_size(size)),
            text: format!("Attached archive: {rel} ({}) — saved, but it could not be unpacked: {why}. If it may be a partial download or another format, say so to the user; extract_archive path=\"{rel}\" retries (with encoding or password if needed).", format_size(size)),
            file_count: None,
        });
    };
    let counts = re!(r"^Extracted ([0-9,]+) files?(?: in ([0-9,]+) folders?)? \(").captures(summary);
    let number = |i: usize| counts.as_ref().and_then(|c| c.get(i)).and_then(|m| m.as_str().replace(',', "").parse::<usize>().ok()).unwrap_or(0);
    let (files, dirs) = (number(1), number(2));
    let unpacked = if dest == "." { Vec::new() } else { resolve(root, dest).map(|d| walk(root, &d)).unwrap_or_default() };
    let bytes: u64 = unpacked.iter().map(|(_, b)| b).sum();
    let single = files == 1 && dirs == 0;
    let mut executables: Vec<&str> = unpacked.iter().map(|(p, _)| p.as_str()).filter(|p| re!(r"(?i)\.(?:exe|dll|sys|so|dylib|jar|apk|class|dex|wasm|pyc)$").is_match(p)).collect();
    executables.truncate(20);
    Ok(UploadDescription {
        path: dest.into(),
        bytes,
        kind: UploadKind::Archive,
        inline: false,
        file_count: Some(files),
        label: format!("{upper} · {} file{} · {}", commas(files as u64), if files == 1 { "" } else { "s" }, format_size(bytes)),
        text: format!(
            "Attached archive: {rel} ({}) — unpacked in the workspace{}.\n{summary}{}\nThe original archive is still at {rel}.",
            format_size(size),
            if single { String::new() } else { format!(" into {dest}/") },
            if executables.is_empty() { String::new() } else { format!("\nExecutables/libraries (inspect_binary; never executed):\n{}", executables.iter().map(|p| format!("  {p}")).collect::<Vec<_>>().join("\n")) }
        ),
    })
}

// ---------------------------------------------------------------- folders

/// ICU-like ordering for `localeCompare`: punctuation, then digits, then letters; letters ignoring case, lower before upper.
fn locale_cmp(a: &str, b: &str) -> Ordering {
    const PUNCT: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    let weight = |c: char| -> (u8, u32) {
        if c.is_alphabetic() {
            (2, c.to_lowercase().next().unwrap_or(c) as u32)
        } else if c.is_numeric() {
            (1, c as u32)
        } else {
            (0, PUNCT.find(c).map_or(1000 + c as u32, |i| i as u32))
        }
    };
    for (x, y) in a.chars().zip(b.chars()) {
        let o = weight(x).cmp(&weight(y));
        if o != Ordering::Equal {
            return o;
        }
    }
    a.chars().count().cmp(&b.chars().count()).then_with(|| {
        for (x, y) in a.chars().zip(b.chars()) {
            if x != y {
                return if x.is_lowercase() { Ordering::Less } else { Ordering::Greater };
            }
        }
        Ordering::Equal
    })
}

/// A folder the user dropped (or an archive once extracted): its map.
pub fn describe_folder(root: &Path, rel: &str) -> Result<UploadDescription, String> {
    let dir = resolve(root, rel)?;
    let files = walk(root, &dir);
    let bytes: u64 = files.iter().map(|(_, b)| b).sum();
    let prefix = format!("{}/", rel.trim_end_matches('/'));
    let rel_of = |p: &str| p.strip_prefix(prefix.as_str()).unwrap_or(p).to_string();

    let mut by_ext: Vec<(String, usize)> = Vec::new();
    for (path, _) in &files {
        let ext = extname(path).to_lowercase();
        let ext = if ext.is_empty() { "(none)".to_string() } else { ext };
        match by_ext.iter_mut().find(|(e, _)| *e == ext) {
            Some(entry) => entry.1 += 1,
            None => by_ext.push((ext, 1)),
        }
    }
    by_ext.sort_by(|a, b| b.1.cmp(&a.1));
    let histogram = by_ext.iter().take(12).map(|(ext, n)| format!("{ext} ×{n}")).collect::<Vec<_>>().join(", ");

    // Directory tree, folded: top two levels in full, deeper levels counted.
    let mut dirs: Vec<(String, usize, u64)> = Vec::new();
    for (path, size) in &files {
        let rel_path = rel_of(path);
        let parts: Vec<&str> = rel_path.split('/').collect();
        for d in 1..parts.len() {
            let name = parts[..d].join("/");
            match dirs.iter_mut().find(|e| e.0 == name) {
                Some(e) => (e.1, e.2) = (e.1 + 1, e.2 + size),
                None => dirs.push((name, 1, *size)),
            }
        }
    }
    dirs.sort_by(|a, b| locale_cmp(&a.0, &b.0));
    const MAX_TREE: usize = 120;
    let mut tree: Vec<String> = Vec::new();
    let top_files: Vec<&(String, u64)> = files.iter().filter(|(p, _)| !rel_of(p).contains('/')).collect();
    for (name, n, size) in &dirs {
        let depth = name.split('/').count();
        if depth > 2 {
            continue;
        }
        if tree.len() >= MAX_TREE {
            break;
        }
        tree.push(format!("{}{}/  ({n} files, {})", "  ".repeat(depth - 1), name.rsplit('/').next().unwrap_or(name), format_size(*size)));
    }
    for (path, size) in top_files.iter().take(MAX_TREE.saturating_sub(tree.len())) {
        tree.push(format!("{}  ({})", rel_of(path), format_size(*size)));
    }
    if dirs.len() + top_files.len() > tree.len() {
        tree.push("…".into());
    }

    let notable_re = re!(r"(?i)(?:^|/)(?:README[^/]*|LICENSE[^/]*|package\.json|pyproject\.toml|requirements[^/]*\.txt|setup\.py|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.sln|[^/]+\.csproj|CMakeLists\.txt|Makefile|Dockerfile|docker-compose\.ya?ml|AGENTS\.md|CLAUDE\.md|main\.[a-z]+|index\.[a-z]+|app\.[a-z]+)$");
    let listing = |matching: &dyn Fn(&str) -> bool| -> Vec<&str> { files.iter().map(|(p, _)| p.as_str()).filter(|p| matching(p)).take(20).collect() };
    let notable = listing(&|p| notable_re.is_match(&rel_of(p)) && rel_of(p).split('/').count() <= 3);
    let executables = listing(&|p| re!(r"(?i)\.(?:exe|dll|sys|so|dylib|jar|apk|class|wasm|pyc)$").is_match(p));
    let archives = listing(&|p| re!(r"(?i)\.(?:zip|rar|7z|tar|tgz|gz|bz2|xz)$").is_match(p));
    let list = |items: &[&str]| items.iter().map(|p| format!("  {p}")).collect::<Vec<_>>().join("\n");

    let mut text = format!("Attached folder: {rel}/ — {} files, {}, saved in the workspace with its structure.\nTypes: {histogram}\nTree:\n{}\n", commas(files.len() as u64), format_size(bytes), tree.join("\n"));
    if !notable.is_empty() {
        text.push_str(&format!("Notable files:\n{}\n", list(&notable)));
    }
    if !executables.is_empty() {
        text.push_str(&format!("Binaries (inspect_binary; never executed):\n{}\n", list(&executables)));
    }
    if !archives.is_empty() {
        text.push_str(&format!("Archives inside (extract_archive to unpack):\n{}\n", list(&archives)));
    }
    text.push_str(&format!("Explore it with list_files path=\"{rel}\", search_files, read_files and find_references — or delegate a survey of it."));
    Ok(UploadDescription { path: rel.into(), bytes, kind: UploadKind::Folder, inline: false, file_count: Some(files.len()), label: format!("{} files · {}", commas(files.len() as u64), format_size(bytes)), text })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::test_zip;

    fn workspace(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("apim-ingest-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("uploads")).unwrap();
        dir
    }

    #[test]
    fn sizes_and_sniffing() {
        assert_eq!((format_size(5), format_size(1280), format_size(3 << 20), format_size(5 << 30)), ("5 B".into(), "1.3 KB".into(), "3.0 MB".into(), "5.00 GB".into()));
        assert_eq!((image_kind(b"\x89PNG\r\n"), image_kind(b"RIFF\0\0\0\0WEBPVP8 "), image_kind(b"RIFF\0\0\0\0WAVE"), image_kind(b"BM")), (Some("PNG"), Some("WebP"), None, Some("BMP")));
        assert_eq!((executable_kind(b"MZ\x90", "a.exe"), executable_kind(b"\x7fELF\x02\x01", "a"), executable_kind(b"\xca\xfe\xba\xbe\0\0\0\x34", "A.class"), executable_kind(b"\xca\xfe\xba\xbe\0\0\0\x02", "a"), executable_kind(b"PK\x03\x04", "x.APK"), executable_kind(b"hello", "a.txt")), (Some("Windows PE"), Some("ELF"), Some("Java class"), Some("Mach-O universal"), Some("Android package"), None));
        assert!(looks_binary(b"a\0b") && !looks_binary(b"\xff\xfea\0b\0") && !looks_binary(b"") && looks_binary(&[1u8; 20]) && !looks_binary(b"\x1b[0m\n"));
        assert_eq!((fence("src/a.RS"), fence("Makefile"), fence(".bashrc"), fence("a.tar.gz"), fence("x.c++"), fence("x.waytoolongextension")), ("rs".into(), "".into(), "".into(), "gz".into(), "c++".into(), "".into()));
        assert_eq!((clip_line("short"), clip_line(&"x".repeat(405))), ("short".into(), format!("{}…[+5 chars]", "x".repeat(400))));
        assert_eq!((sniff_archive(b"PK\x03\x04", "a.zip"), sniff_archive(b"PK\x03\x04", "a.docx"), sniff_archive(b"", "a.tar"), sniff_archive(b"hello", "a.txt"), sniff_archive(&[b'x'; 600], "a.zip")), (Some("zip"), None, Some("tar"), None, None));
    }

    #[test]
    fn text_files_are_shown_whole_or_by_shape() {
        let ws = workspace("text");
        std::fs::write(ws.join("uploads/small.rs"), "fn main() {}\n").unwrap();
        let small = describe_upload(&ws, "uploads/small.rs").unwrap();
        assert_eq!((small.inline, small.kind, small.label.as_str(), small.text.as_str()), (true, UploadKind::Text, "2 lines", "Attached file: uploads/small.rs (saved in the workspace)\n```rs\nfn main() {}\n\n```"));
        let long: String = (0..2000).map(|i| format!("line {i} {}\n", "x".repeat(60))).collect();
        std::fs::write(ws.join("uploads/big.log"), &long).unwrap();
        let big = describe_upload(&ws, "uploads/big.log").unwrap();
        assert!(!big.inline && big.kind == UploadKind::Text && big.label.ends_with(" · 2,001 lines"), "{}", big.label);
        assert!(big.text.starts_with("Attached file: uploads/big.log (") && big.text.contains("First 80 lines:\n```log\nline 0 ") && big.text.contains("Last 30 lines:\n```log\nline 1971 ") && big.text.ends_with("Read more with read_file path=\"uploads/big.log\" start_line=… end_line=…, find things with search_files, or process it with a script."), "{}", big.text);
        std::fs::write(ws.join("uploads/bin.dat"), [0u8, 1, 2, 3]).unwrap();
        assert_eq!(describe_upload(&ws, "uploads/bin.dat").unwrap().kind, UploadKind::Binary);
        std::fs::write(ws.join("uploads/p.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        assert_eq!(describe_upload(&ws, "uploads/p.png").unwrap().text, "Attached image: uploads/p.png (PNG, 8 B) — saved in the workspace; view_image path=\"uploads/p.png\" looks at it.");
        assert!(describe_upload(&ws, "../x").unwrap_err().contains("escapes the workspace"));
        assert_eq!(describe_upload(&ws, "uploads/gone.txt").unwrap_err(), "No such file: uploads/gone.txt");
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn documents_and_archives() {
        let ws = workspace("docs");
        std::fs::write(ws.join("uploads/a.docx"), test_zip(&[("word/document.xml", b"<w:p><w:t>Hi there</w:t></w:p>")])).unwrap();
        let doc = describe_upload(&ws, "uploads/a.docx").unwrap();
        assert_eq!((doc.kind, doc.inline, doc.label.as_str()), (UploadKind::Document, true, "DOCX · 351 B".replace("351", &doc.bytes.to_string()).as_str()));
        assert_eq!(doc.text, format!("Attached document: uploads/a.docx ({}) — saved in the workspace.\nHi there", format_size(doc.bytes)));
        std::fs::write(ws.join("uploads/bad.xlsx"), b"junk").unwrap();
        assert_eq!(describe_upload(&ws, "uploads/bad.xlsx").unwrap().text, "Attached document: uploads/bad.xlsx (4 B) — saved in the workspace, but its text could not be extracted here (Not a valid .zip file). Try read_document path=\"uploads/bad.xlsx\".");
        std::fs::write(ws.join("uploads/p.zip"), test_zip(&[("proj/a.txt", b"hello"), ("proj/tool.dll", b"MZ")])).unwrap();
        let zip = ingest_upload(&ws, "uploads/p.zip", true).unwrap();
        assert_eq!((zip.kind, zip.file_count), (UploadKind::Archive, Some(2)));
        assert!(zip.label.starts_with("ZIP · 2 files · ") && zip.text.starts_with("Attached archive: uploads/p.zip (") && zip.text.contains("Executables/libraries (inspect_binary; never executed):\n  ") && zip.text.ends_with("\nThe original archive is still at uploads/p.zip."), "{}", zip.text);
        std::fs::write(ws.join("uploads/broken.zip"), b"PK\x03\x04garbage").unwrap();
        let broken = ingest_upload(&ws, "uploads/broken.zip", true).unwrap();
        assert!(broken.label.ends_with("· not unpacked") && broken.text.contains("saved, but it could not be unpacked: "), "{}", broken.text);
        assert_eq!(ingest_upload(&ws, "uploads/a.docx", true).unwrap().kind, UploadKind::Document);
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn uploads_get_free_names_and_a_size_cap() {
        let ws = workspace("save");
        let source = ws.join("source.json");
        std::fs::write(&source, b"0123456789").unwrap();
        assert_eq!(free_name(&ws, "uploads/a.json").unwrap(), "uploads/a.json");
        assert_eq!(save_upload(&ws, &source, "uploads/a.json", 100).unwrap(), ("uploads/a.json".to_string(), 10));
        assert_eq!(free_name(&ws, "uploads/a.json").unwrap(), "uploads/a-2.json");
        std::fs::write(ws.join("uploads/a-2.json"), "x").unwrap();
        assert_eq!((free_name(&ws, "uploads/a.json").unwrap(), free_name(&ws, "uploads/noext").unwrap(), free_name(&ws, "uploads/a.tar.gz").unwrap()), ("uploads/a-3.json".into(), "uploads/noext".into(), "uploads/a.tar.gz".into()));
        assert_eq!(std::fs::read(ws.join("uploads/a.json")).unwrap(), b"0123456789");
        assert_eq!(save_upload(&ws, &source, "uploads/big.json", 5).unwrap_err(), "big.json is larger than the 0MB upload limit.");
        assert!(!ws.join("uploads/big.json").exists() && std::fs::read_dir(&ws).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".tmp")));
        assert_eq!(save_upload(&ws, &source, "uploads/deeper/b.json", 5 * 1024 * 1024 / 5).unwrap().1, 10);
        assert!(save_upload(&ws, &source, "../escape.json", 100).unwrap_err().contains("escapes the workspace"));
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn folders_get_a_map() {
        let ws = workspace("folder");
        for (path, data) in [("uploads/proj/README.md", "hi"), ("uploads/proj/src/main.rs", "fn main(){}"), ("uploads/proj/src/deep/x.rs", "x"), ("uploads/proj/tool.exe", "MZ"), ("uploads/proj/Zeta/z.txt", "z"), ("uploads/proj/alpha/a.txt", "a")] {
            std::fs::create_dir_all(ws.join(path).parent().unwrap()).unwrap();
            std::fs::write(ws.join(path), data).unwrap();
        }
        let d = describe_upload(&ws, "uploads/proj").unwrap();
        assert_eq!((d.kind, d.file_count, d.label.as_str()), (UploadKind::Folder, Some(6), "6 files · 18 B"));
        assert!(d.text.starts_with("Attached folder: uploads/proj/ — 6 files, 18 B, saved in the workspace with its structure.
Types: .txt ×2, .rs ×2, .md ×1, .exe ×1
Tree:
alpha/  (1 files, 1 B)
src/  (2 files, 12 B)
  deep/  (1 files, 1 B)
Zeta/  (1 files, 1 B)
"), "{}", d.text);
        assert!(d.text.ends_with("Notable files:
  uploads/proj/README.md
  uploads/proj/src/main.rs
Binaries (inspect_binary; never executed):
  uploads/proj/tool.exe
Explore it with list_files path=\"uploads/proj\", search_files, read_files and find_references — or delegate a survey of it."), "{}", d.text);
        assert_eq!((locale_cmp("a", "B"), locale_cmp("B", "a"), locale_cmp("a", "A"), locale_cmp("_x", "a"), locale_cmp("1", "a")), (Ordering::Less, Ordering::Greater, Ordering::Less, Ordering::Less, Ordering::Less));
        let _ = std::fs::remove_dir_all(ws);
    }
}

#[cfg(test)]
mod parity {
    use super::*;
    use crate::media::fixtures::{ALL, file, same};

    #[test]
    fn descriptions_match_the_web() {
        let ws = std::env::temp_dir().join(format!("apim-parity-ingest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&ws);
        std::fs::create_dir_all(ws.join("uploads")).unwrap();
        let cases = ALL["describe"].as_array().unwrap();
        for case in cases {
            let name = case["rel"].as_str().unwrap().strip_prefix("uploads/").unwrap();
            if ALL["files"].get(name).is_some() {
                std::fs::write(ws.join("uploads").join(name), file(name)).unwrap();
            }
        }
        for (rel, data) in [("README.md", "hi"), ("src/main.rs", "fn main(){}"), ("src/deep/x.rs", "x"), ("tool.exe", "MZ"), ("Zeta/z.txt", "z"), ("alpha/a.txt", "a"), ("node_modules/skip/i.js", "no"), ("_under/u.txt", "u"), ("Cargo.toml", "[package]"), ("2024/notes.txt", "n")] {
            let path = ws.join("uploads/proj").join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, data).unwrap();
        }
        for case in cases {
            let (rel, extract) = (case["rel"].as_str().unwrap(), case["extract"].as_bool().unwrap());
            let got = if extract { ingest_upload(&ws, rel, true) } else { describe_upload(&ws, rel) };
            let want = &case["expect"];
            let got = got.unwrap_or_else(|e| panic!("{rel}: {e}"));
            let kind = match got.kind { UploadKind::Text => "text", UploadKind::Data => "data", UploadKind::Document => "document", UploadKind::Image => "image", UploadKind::Binary => "binary", UploadKind::Archive => "archive", UploadKind::Folder => "folder" };
            assert_eq!((got.path.as_str(), got.bytes, kind, got.inline, got.label.as_str(), got.file_count.map(|n| n as u64)), (want["path"].as_str().unwrap(), want["bytes"].as_u64().unwrap(), want["kind"].as_str().unwrap(), want["inline"].as_bool().unwrap(), want["label"].as_str().unwrap(), want["fileCount"].as_u64()), "{rel}");
            assert!(same(&got.text, &want["text"]), "{rel}\n--- rust\n{}\n--- web\n{}", got.text, want["text"]);
        }
        for (bytes, want) in ALL["formatSize"].as_array().unwrap().iter().map(|c| (c[0].as_u64().unwrap(), c[1].as_str().unwrap())) {
            assert_eq!(format_size(bytes), want);
        }
        let _ = std::fs::remove_dir_all(ws);
    }
}

//! Attaching things in the composer (src/lib/attachments.ts): what is text, a picture or a video, the size and count
//! limits with their error texts, how a text file is read, how a picture is shrunk, and how attachments are written
//! into the message for a model that cannot see.
//!
//! Left out on purpose: the web's inline archive reader (`readArchive`/`formatArchive`, a browser fallback). On the
//! desktop an archive is saved to the workspace and unpacked by `ingest::ingest_upload`, as the web's upload path does.

use super::documents::{MAX_DOC_CHARS, document_kind, read_document};
use super::video::Frame;
use super::{commas, data_url, len16, slice16, to_fixed};
use crate::models::Vision;
use std::io::Read as _;
use std::path::Path;

/// Longest text kept from one file, about 222k tokens.
pub const MAX_CHARS: usize = 800_000;
/// A text file larger than this is refused without being read.
pub const MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Archives and documents get a larger cap: they are compressed, and the extracted text is what costs.
pub const MAX_ARCHIVE_BYTES: u64 = 50 * 1024 * 1024;
pub const MAX_FILES: usize = 10;
/// Pictures are sent whole, so they have their own cap.
pub const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
/// Native video; 100 MB raw is about 137 MB as a data URL.
pub const MAX_VIDEO_BYTES: u64 = 100 * 1024 * 1024;
/// How much of a file is inspected before deciding whether it is text.
pub const SNIFF_BYTES: usize = 8_000;
/// Longest edge a picture keeps; vision models downscale to about this themselves.
pub const IMAGE_MAX_EDGE: u32 = 2048;
/// Below this a picture is sent as it is: re-encoding would gain nothing.
pub const IMAGE_SHRINK_MIN_BYTES: u64 = 400 * 1024;

/// What a file is doing while it is being read, shown on its chip.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttachStage {
    Uploading,
    Describing,
    Reading,
    Saving,
    Unpacking,
    Extracting,
    Analyzing,
    Frames,
}

impl AttachStage {
    pub fn label(self) -> &'static str {
        match self {
            AttachStage::Uploading => "Uploading",
            AttachStage::Describing => "Looking inside",
            AttachStage::Reading => "Reading",
            AttachStage::Saving => "Saving binary",
            AttachStage::Unpacking => "Unpacking",
            AttachStage::Extracting => "Extracting text",
            AttachStage::Analyzing => "Looking at image",
            AttachStage::Frames => "Extracting frames",
        }
    }
}

/// Why the composer must not send yet, or None when every attachment is ready. Each chip is
/// (name, stage while it is being read, whether a picture is still being described).
pub fn attachments_block_send(chips: &[(&str, Option<AttachStage>, bool)]) -> Option<String> {
    let busy = |c: &&(&str, Option<AttachStage>, bool)| c.1.is_some() || c.2;
    let first = chips.iter().find(busy)?;
    let stage = first.1.unwrap_or(AttachStage::Analyzing);
    let others = chips.iter().filter(busy).count() - 1;
    Some(format!("Waiting for {} ({}…){} — you can send once it is ready", first.0, stage.label().to_lowercase(), if others > 0 { format!(" and {others} more") } else { String::new() }))
}

/// The refusal when one more file would pass `MAX_FILES`.
pub fn too_many_files(attached: usize) -> Option<String> {
    (attached >= MAX_FILES).then(|| format!("You can attach up to {MAX_FILES} files"))
}

/// "12 KB", "3.4 MB".
pub fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{} KB", (bytes as f64 / 1024.0 + 0.5).floor())
    } else {
        format!("{} MB", to_fixed(bytes as f64 / (1024.0 * 1024.0), 1))
    }
}

/// MP4 only; other containers stay on the binary refusal list.
pub fn is_video_file(mime: &str, name: &str) -> bool {
    matches!(mime, "video/mp4" | "video/mpeg") || name.to_lowercase().ends_with(".mp4")
}

/// Lower-case text after the last dot, or "".
pub fn extension_of(name: &str) -> String {
    name.rfind('.').map_or(String::new(), |at| name[at + 1..].to_lowercase())
}

pub fn is_archive(name: &str) -> bool {
    let lower = name.to_lowercase();
    [".zip", ".tar", ".tar.gz", ".tgz"].iter().any(|e| lower.ends_with(e))
}

/// Formats that cannot be opened, and what to do instead.
pub fn unsupported_archive_note(name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    if lower.ends_with(".rar") {
        return Some("RAR is a proprietary format with no open decoder, so it can't be opened here. Re-save it as a .zip and it will work.");
    }
    if lower.ends_with(".7z") {
        return Some("7z uses LZMA, which browsers have no built-in support for. Re-save it as a .zip and it will work.");
    }
    None
}

/// A better refusal than "looks like a binary file" for formats everyone knows.
pub fn binary_format_note(name: &str) -> Option<String> {
    let note = match extension_of(name).as_str() {
        "pdf" => "PDFs need a parser this app doesn't have yet — copy the text out, or say the word and I'll add one.",
        "doc" => "The old .doc format isn't readable. Save as .docx and it will work.",
        "xls" => "The old .xls format isn't readable. Save as .xlsx or .csv and it will work.",
        "exe" => "Windows executables must be saved as raw bytes and opened with inspect_binary, not decoded as text.",
        "dll" => "Windows libraries must be saved as raw bytes and opened with inspect_binary, not decoded as text.",
        "sys" => "Windows drivers must be saved as raw bytes and opened with inspect_binary, not decoded as text.",
        "ocx" => "Windows OCX libraries must be saved as raw bytes and opened with inspect_binary, not decoded as text.",
        "scr" => "Windows screen-saver executables must be saved as raw bytes and opened with inspect_binary, not decoded as text.",
        "cpl" => "Windows Control Panel libraries must be saved as raw bytes and opened with inspect_binary, not decoded as text.",
        "drv" => "Windows driver libraries must be saved as raw bytes and opened with inspect_binary, not decoded as text.",
        "efi" => "EFI executables must be saved as raw bytes and opened with inspect_binary, not decoded as text.",
        "so" | "dylib" => "a library",
        "bin" => "a binary",
        "dat" => "a binary data file",
        "db" | "sqlite" => "a database file",
        "mp3" | "wav" | "flac" | "ogg" => "audio",
        "mp4" | "avi" | "mov" | "mkv" | "webm" => "video",
        "ttf" | "otf" | "woff" | "woff2" => "a font",
        "pyc" => "compiled Python",
        "class" => "compiled Java",
        "o" => "an object file",
        _ => return None,
    };
    // A full sentence explains itself; the short ones are a noun phrase and need wrapping.
    Some(if note.ends_with('.') { note.to_string() } else { format!("{name} is {note}, so there's no text to read.") })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Utf16 {
    Le,
    Be,
}

/// UTF-16 text, which Windows writes constantly (PowerShell `>`, Notepad "Unicode", many logs) and which is half zeros:
/// found by the byte-order mark, or by ASCII in one byte position with zeros in the other. Deliberately narrow.
pub fn looks_utf16(bytes: &[u8]) -> Option<Utf16> {
    if bytes.len() < 4 {
        return None;
    }
    match (bytes[0], bytes[1]) {
        (0xff, 0xfe) => return Some(Utf16::Le),
        (0xfe, 0xff) => return Some(Utf16::Be),
        _ => {}
    }
    let n = bytes.len().min(2000) & !1;
    if n < 8 {
        return None;
    }
    let (mut zero_odd, mut zero_even, mut printable_even, mut printable_odd) = (0, 0, 0, 0);
    for pair in bytes[..n].chunks(2) {
        let (even, odd) = (pair[0], pair[1]);
        zero_odd += usize::from(odd == 0);
        zero_even += usize::from(even == 0);
        printable_even += usize::from((9..127).contains(&even));
        printable_odd += usize::from((9..127).contains(&odd));
    }
    let pairs = (n / 2) as f64;
    if zero_odd as f64 / pairs > 0.9 && printable_even as f64 / pairs > 0.9 {
        return Some(Utf16::Le);
    }
    if zero_even as f64 / pairs > 0.9 && printable_odd as f64 / pairs > 0.9 {
        return Some(Utf16::Be);
    }
    None
}

/// Heuristic binary check over raw bytes: a NUL, or more than 10% control characters, in the first 8000.
pub fn bytes_look_binary(bytes: &[u8]) -> bool {
    if bytes.is_empty() || looks_utf16(bytes).is_some() {
        return false;
    }
    let head = &bytes[..bytes.len().min(8000)];
    if head.contains(&0) {
        return true;
    }
    let mut control = 0;
    for (i, &b) in head.iter().enumerate() {
        // ESC starts a colour code in a console log saved to a file; only ESC followed by '[' is forgiven.
        if b == 0x1b && head.get(i + 1) == Some(&0x5b) {
            continue;
        }
        if b < 9 || (b > 13 && b < 32) {
            control += 1;
        }
    }
    control as f64 / head.len() as f64 > 0.1
}

/// The string version of the same check, which the web's archive reader still uses.
pub fn looks_binary(sample: &str) -> bool {
    let head = slice16(sample, 8000);
    if head.contains('\0') {
        return true;
    }
    let control = head.chars().filter(|&c| (c as u32) < 9 || (c as u32 > 13 && (c as u32) < 32)).count();
    !head.is_empty() && control as f64 / len16(head) as f64 > 0.1
}

/// UTF-16 bytes as text, without the byte-order mark.
fn decode_utf16(bytes: &[u8], order: Utf16) -> String {
    let units: Vec<u16> = bytes.chunks_exact(2).map(|p| if order == Utf16::Le { u16::from_le_bytes([p[0], p[1]]) } else { u16::from_be_bytes([p[0], p[1]]) }).collect();
    let mut text = String::from_utf16_lossy(&units);
    if bytes.len() % 2 == 1 {
        text.push('\u{fffd}');
    }
    text.strip_prefix('\u{feff}').unwrap_or(&text).to_string()
}

/// A text file read and ready to inline.
#[derive(Clone, Debug, PartialEq)]
pub struct TextFile {
    pub name: String,
    pub size: u64,
    pub content: String,
    /// The file was longer than `MAX_CHARS` and was cut.
    pub truncated: bool,
    /// Sheets or slides, when a document has more than one.
    pub file_count: Option<usize>,
}

pub enum Read {
    Text(TextFile),
    /// An archive: save it to the workspace and call `ingest::ingest_upload` with `extract` on.
    Archive,
}

/// Reads a file the way the composer does: limits first, documents through `documents`, known binary formats refused
/// with a useful sentence, the rest sniffed from the first 8 KB, decoded as UTF-8 or UTF-16 and cut at `MAX_CHARS`.
pub fn read_text_file(path: &Path) -> Result<Read, String> {
    let name = path.file_name().map_or_else(|| "file".to_string(), |n| n.to_string_lossy().into_owned());
    let unreadable = || format!("Couldn't read {name}");
    let size = std::fs::metadata(path).map_err(|_| unreadable())?.len();
    let kind = document_kind(&name);
    let cap = if is_archive(&name) || kind.is_some() { MAX_ARCHIVE_BYTES } else { MAX_BYTES };
    if size > cap {
        return Err(format!("{name} is {} — the limit is {}", format_bytes(size), format_bytes(cap)));
    }
    if let Some(note) = unsupported_archive_note(&name) {
        return Err(note.to_string());
    }
    if is_archive(&name) {
        return Ok(Read::Archive);
    }
    // Office files are binary as files; the words inside them are not.
    if let Some(kind) = kind {
        let bytes = std::fs::read(path).map_err(|_| unreadable())?;
        return match read_document(kind, &bytes, MAX_DOC_CHARS) {
            Ok(doc) => Ok(Read::Text(TextFile { name, size, content: doc.text, truncated: doc.truncated, file_count: (doc.sections > 1).then_some(doc.sections) })),
            Err(e) => Err(format!("Couldn't read {name}: {e}")),
        };
    }
    if let Some(refusal) = binary_format_note(&name) {
        return Err(refusal);
    }
    let mut file = std::fs::File::open(path).map_err(|_| unreadable())?;
    let mut head = Vec::new();
    (&mut file).take(SNIFF_BYTES as u64).read_to_end(&mut head).map_err(|_| unreadable())?;
    if bytes_look_binary(&head) {
        return Err(format!("{name} looks like a binary file, so there's nothing to read"));
    }
    // Only as much as will be kept: UTF-8 is at most 4 bytes per character.
    let mut bytes = head;
    (&mut file).take(MAX_CHARS as u64 * 4 - bytes.len().min(MAX_CHARS * 4) as u64).read_to_end(&mut bytes).map_err(|_| unreadable())?;
    let raw = match looks_utf16(&bytes) {
        Some(order) => decode_utf16(&bytes, order),
        None => {
            let text = String::from_utf8_lossy(&bytes);
            text.strip_prefix('\u{feff}').unwrap_or(&text).to_string()
        }
    };
    let truncated = len16(&raw) > MAX_CHARS;
    let content = if truncated { slice16(&raw, MAX_CHARS).to_string() } else { raw };
    Ok(Read::Text(TextFile { name, size, content, truncated, file_count: None }))
}

/// The refusal for a folder before it is copied: over the archive cap, or nothing readable inside.
pub fn check_folder(name: &str, total_bytes: u64, file_count: usize) -> Result<(), String> {
    if total_bytes > MAX_ARCHIVE_BYTES {
        return Err(format!("{name} is {} — the limit is {}", format_bytes(total_bytes), format_bytes(MAX_ARCHIVE_BYTES)));
    }
    if file_count == 0 {
        return Err(format!("{name} had no readable text or binary files in it"));
    }
    Ok(())
}

/// A picture ready to send: a data URL and the size that is actually sent.
#[derive(Clone, Debug, PartialEq)]
pub struct Picture {
    pub name: String,
    pub size: u64,
    pub data_url: String,
}

/// "image/png" from the extension; anything unknown is treated as PNG.
pub fn image_mime(name: &str) -> &'static str {
    match extension_of(name).as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "image/png",
    }
}

/// Shrinks a screenshot before it rides in the request: a 4K PNG is 3-5 MB and is re-sent every round, so it is scaled to
/// `IMAGE_MAX_EDGE` and encoded as whichever of PNG or JPEG (quality 90) is smaller. Best effort: any failure keeps the
/// original, and GIFs (may be animated) and SVGs (not pixels) are left alone.
pub fn shrink_image_data_url(mime: &str, bytes: &[u8], original: String) -> String {
    use image::{ExtendedColorType, ImageEncoder, codecs::jpeg::JpegEncoder, codecs::png::PngEncoder, imageops};
    if !matches!(mime, "image/png" | "image/jpeg" | "image/webp" | "image/bmp") {
        return original;
    }
    let Ok(decoded) = image::load_from_memory(bytes) else { return original };
    let edge = decoded.width().max(decoded.height());
    if (bytes.len() as u64) < IMAGE_SHRINK_MIN_BYTES && edge <= IMAGE_MAX_EDGE {
        return original;
    }
    let scale = (IMAGE_MAX_EDGE as f64 / edge as f64).min(1.0);
    let (w, h) = (((decoded.width() as f64 * scale).round() as u32).max(1), ((decoded.height() as f64 * scale).round() as u32).max(1));
    let mut pixels = decoded.to_rgba8();
    if scale < 1.0 {
        pixels = imageops::resize(&pixels, w, h, imageops::FilterType::Lanczos3);
    }
    // JPEG has no alpha: paint white first so transparency does not go black.
    let rgb: Vec<u8> = pixels.pixels().flat_map(|p| [0, 1, 2].map(|i| ((p[i] as u32 * p[3] as u32 + 255 * (255 - p[3] as u32)) / 255) as u8)).collect();
    let (mut png, mut jpeg) = (Vec::new(), Vec::new());
    if PngEncoder::new(&mut png).write_image(&rgb, w, h, ExtendedColorType::Rgb8).is_err() || JpegEncoder::new_with_quality(&mut jpeg, 90).write_image(&rgb, w, h, ExtendedColorType::Rgb8).is_err() {
        return original;
    }
    let mut best = original;
    for candidate in [data_url("image/png", &png), data_url("image/jpeg", &jpeg)] {
        if candidate.len() < best.len() {
            best = candidate;
        }
    }
    best
}

/// Reads a picture for sending. The limit applies to what is SENT: a big screenshot shrinks well under it, so only a file
/// too large to even decode sensibly (five times the limit) is refused up front.
pub fn read_image_file(path: &Path) -> Result<Picture, String> {
    let name = path.file_name().map_or_else(|| "file".to_string(), |n| n.to_string_lossy().into_owned());
    let size = std::fs::metadata(path).map_err(|_| format!("Couldn't read {name}"))?.len();
    let too_big = || format!("{name} is {} — the image limit is {}", format_bytes(size), format_bytes(MAX_IMAGE_BYTES));
    if size > MAX_IMAGE_BYTES * 5 {
        return Err(too_big());
    }
    let bytes = std::fs::read(path).map_err(|_| format!("Couldn't read {name}"))?;
    let mime = image_mime(&name);
    let original = data_url(mime, &bytes);
    let url = shrink_image_data_url(mime, &bytes, original.clone());
    if (url.len() * 3) as f64 / 4.0 > MAX_IMAGE_BYTES as f64 {
        return Err(too_big());
    }
    // What is actually sent: base64 is 4 characters per 3 bytes.
    let sent = if url == original { size } else { (((url.len() - url.find(',').map_or(0, |c| c + 1)) * 3) as f64 / 4.0).round() as u64 };
    Ok(Picture { name, size: sent, data_url: url })
}

/// A video read as a native data URL; the way a clip rides by default.
#[derive(Clone, Debug, PartialEq)]
pub struct Video {
    pub name: String,
    pub size: u64,
    /// Present for a native clip, absent when the clip rides as `frames`. Never both.
    pub data_url: Option<String>,
    pub frames: Vec<Frame>,
    pub duration_sec: f64,
    pub frame_interval_sec: f64,
}

pub fn video_too_big(name: &str, size: u64) -> String {
    format!("{name} is {} — the video limit is {}", format_bytes(size), format_bytes(MAX_VIDEO_BYTES))
}

pub fn read_video_file(path: &Path) -> Result<Video, String> {
    let name = path.file_name().map_or_else(|| "file".to_string(), |n| n.to_string_lossy().into_owned());
    let size = std::fs::metadata(path).map_err(|_| format!("Couldn't read {name}"))?.len();
    if size > MAX_VIDEO_BYTES {
        return Err(video_too_big(&name, size));
    }
    let bytes = std::fs::read(path).map_err(|_| format!("Couldn't read {name}"))?;
    Ok(Video { name, size, data_url: Some(data_url("video/mp4", &bytes)), frames: Vec::new(), duration_sec: 0.0, frame_interval_sec: 0.0 })
}

/// What the message builder needs to know about one attachment.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Attached {
    pub name: String,
    pub size: u64,
    /// File text, or the finished block when `preformatted`.
    pub content: String,
    pub truncated: bool,
    pub kind: AttachedKind,
    /// Saved to the workspace and already described (`ingest`): `content` is the finished block.
    pub preformatted: bool,
    /// Where a picture was also saved in the workspace.
    pub unpacked_to: Option<String>,
    /// Pictures on the helper path: what vision or OCR extracted.
    pub description: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AttachedKind {
    #[default]
    Text,
    Image,
    Video,
}

/// Inlines attachments ahead of the user's own text. Files are fenced with their extension so the model reads them as
/// files; pictures become `<image>` blocks for a model that cannot see, and nothing at all for one that can.
pub fn build_message_with_attachments(text: &str, attachments: &[Attached], vision: Vision) -> String {
    if attachments.is_empty() {
        return text.to_string();
    }
    let mut blocks: Vec<String> = Vec::new();
    for a in attachments {
        match a.kind {
            AttachedKind::Image => {
                // Also on disk, so a tool (view_image, a script) can use the file.
                let saved = a.unpacked_to.as_ref().map(|to| format!("[{} is also saved in the workspace at {to}]", a.name));
                if vision == Vision::Native {
                    blocks.extend(saved);
                } else if let Some(description) = &a.description {
                    blocks.push(format!("<image name=\"{}\">\n{description}\n</image>", a.name));
                    blocks.extend(saved);
                } else {
                    blocks.push(format!("<image name=\"{}\">\n[the image could not be read]\n</image>", a.name));
                }
            }
            AttachedKind::Video => {
                if vision != Vision::Native {
                    blocks.push(format!("<video name=\"{}\">\n[this model cannot watch video — switch to Ox Alpha or Qwen 3.8 27B]\n</video>", a.name));
                }
            }
            AttachedKind::Text if a.preformatted => blocks.push(a.content.clone()),
            AttachedKind::Text => {
                let ext = extension_of(&a.name);
                let fence = if !ext.is_empty() && len16(&ext) <= 12 { ext } else { String::new() };
                let note = if a.truncated { format!("\n[truncated — showing the first {} characters of {}]", commas(MAX_CHARS as u64), format_bytes(a.size)) } else { String::new() };
                blocks.push(format!("Attached file: {}{note}\n```{fence}\n{}\n```", a.name, a.content));
            }
        }
    }
    let typed = super::js_trim(text);
    if typed.is_empty() { blocks.join("\n\n") } else { format!("{}\n\n{typed}", blocks.join("\n\n")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("apim-attach-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn text_of(read: Result<Read, String>) -> TextFile {
        match read {
            Ok(Read::Text(t)) => t,
            Ok(Read::Archive) => panic!("archive"),
            Err(e) => panic!("{e}"),
        }
    }

    #[test]
    fn sizes_and_stage_labels() {
        assert_eq!((format_bytes(900), format_bytes(1536), format_bytes(1024 * 1024 + 102_400), format_bytes(MAX_IMAGE_BYTES), format_bytes(MAX_VIDEO_BYTES)), ("900 B".into(), "2 KB".into(), "1.1 MB".into(), "8.0 MB".into(), "100.0 MB".into()));
        assert_eq!(attachments_block_send(&[("a.txt", None, false)]), None);
        assert_eq!(attachments_block_send(&[("a.zip", Some(AttachStage::Unpacking), false), ("b.png", None, true), ("c", None, false)]).unwrap(), "Waiting for a.zip (unpacking…) and 1 more — you can send once it is ready");
        assert_eq!(attachments_block_send(&[("b.png", None, true)]).unwrap(), "Waiting for b.png (looking at image…) — you can send once it is ready");
        assert_eq!((too_many_files(9), too_many_files(10).as_deref()), (None, Some("You can attach up to 10 files")));
        assert!(is_video_file("video/mpeg", "x") && is_video_file("", "CLIP.MP4") && !is_video_file("video/webm", "x.webm"));
        assert!(is_archive("a.TGZ") && !is_archive("a.gz") && unsupported_archive_note("x.RAR").unwrap().starts_with("RAR is") && unsupported_archive_note("x.7z").unwrap().starts_with("7z uses"));
    }

    #[test]
    fn refusals_have_the_web_wording() {
        assert_eq!(binary_format_note("a.doc").unwrap(), "The old .doc format isn't readable. Save as .docx and it will work.");
        assert_eq!(binary_format_note("song.MP3").unwrap(), "song.MP3 is audio, so there's no text to read.");
        assert_eq!(binary_format_note("a.txt"), None);
        let dir = scratch("refuse");
        std::fs::write(dir.join("pic.bin"), [0u8, 1, 2]).unwrap();
        std::fs::write(dir.join("tool.exe"), b"MZ").unwrap();
        std::fs::write(dir.join("blob.xyz"), [0u8; 50]).unwrap();
        assert_eq!(read_text_file(&dir.join("blob.xyz")).err().unwrap(), "blob.xyz looks like a binary file, so there's nothing to read");
        assert_eq!(read_text_file(&dir.join("pic.bin")).err().unwrap(), "pic.bin is a binary, so there's no text to read.");
        assert!(read_text_file(&dir.join("tool.exe")).err().unwrap().starts_with("Windows executables must be saved"));
        assert_eq!(read_text_file(&dir.join("gone.txt")).err().unwrap(), "Couldn't read gone.txt");
        let big = std::fs::File::create(dir.join("big.txt")).unwrap();
        big.set_len(65 * 1024 * 1024).unwrap();
        assert_eq!(read_text_file(&dir.join("big.txt")).err().unwrap(), "big.txt is 65.0 MB — the limit is 64.0 MB");
        std::fs::write(dir.join("a.7z"), b"x").unwrap();
        assert!(read_text_file(&dir.join("a.7z")).err().unwrap().starts_with("7z uses LZMA"));
        std::fs::write(dir.join("a.zip"), b"x").unwrap();
        assert!(matches!(read_text_file(&dir.join("a.zip")), Ok(Read::Archive)));
        std::fs::write(dir.join("broken.docx"), b"not a zip at all").unwrap();
        assert_eq!(read_text_file(&dir.join("broken.docx")).err().unwrap(), "Couldn't read broken.docx: Not a valid .zip file");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn text_is_sniffed_decoded_and_cut() {
        let dir = scratch("text");
        std::fs::write(dir.join("a.txt"), "\u{feff}héllo\nworld").unwrap();
        let t = text_of(read_text_file(&dir.join("a.txt")));
        assert_eq!((t.content.as_str(), t.truncated, t.size), ("héllo\nworld", false, 15));
        let utf16: Vec<u8> = [0xff, 0xfe].into_iter().chain("log line ü\r\n".encode_utf16().flat_map(u16::to_le_bytes)).collect();
        std::fs::write(dir.join("w.log"), &utf16).unwrap();
        assert_eq!(text_of(read_text_file(&dir.join("w.log"))).content, "log line ü\r\n");
        std::fs::write(dir.join("color.log"), "\x1b[32mINFO\x1b[0m up\n".repeat(50)).unwrap();
        assert!(!text_of(read_text_file(&dir.join("color.log"))).content.is_empty());
        std::fs::write(dir.join("long.txt"), "ab😀".repeat(300_000)).unwrap();
        let long = text_of(read_text_file(&dir.join("long.txt")));
        assert_eq!((len16(&long.content), long.truncated), (MAX_CHARS, true));
        assert!(looks_utf16(b"\xff\xfe").is_none() && looks_utf16(b"\xff\xfeab") == Some(Utf16::Le) && looks_utf16(b"a\0b\0c\0d\0e\0f\0g\0h\0").is_some() && looks_utf16(b"\0a\0b\0c\0d\0e\0f\0g\0h") == Some(Utf16::Be));
        assert!(looks_binary("a\0b") && !looks_binary("plain"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pictures_shrink_and_videos_are_capped() {
        let dir = scratch("pic");
        let noise = image::RgbImage::from_fn(3000, 1500, |x, y| image::Rgb([(x * 7 + y * 13) as u8, (x ^ y) as u8, (x * y) as u8]));
        noise.save(dir.join("shot.png")).unwrap();
        let big = std::fs::metadata(dir.join("shot.png")).unwrap().len();
        let pic = read_image_file(&dir.join("shot.png")).unwrap();
        let sent = image::load_from_memory(&crate::media::base64_lenient(pic.data_url.split_once(',').unwrap().1)).unwrap();
        assert!(big > IMAGE_SHRINK_MIN_BYTES && sent.width() == 2048 && sent.height() == 1024 && pic.size < big && pic.size <= MAX_IMAGE_BYTES, "{big} {} {}", sent.width(), pic.size);
        std::fs::write(dir.join("tiny.png"), [137u8, 80, 78, 71]).unwrap();
        assert_eq!(read_image_file(&dir.join("tiny.png")).unwrap(), Picture { name: "tiny.png".into(), size: 4, data_url: "data:image/png;base64,iVBORw==".into() });
        let huge = std::fs::File::create(dir.join("huge.png")).unwrap();
        huge.set_len(41 * 1024 * 1024).unwrap();
        assert_eq!(read_image_file(&dir.join("huge.png")).err().unwrap(), "huge.png is 41.0 MB — the image limit is 8.0 MB");
        let clip = std::fs::File::create(dir.join("clip.mp4")).unwrap();
        clip.set_len(101 * 1024 * 1024).unwrap();
        assert_eq!(read_video_file(&dir.join("clip.mp4")).err().unwrap(), "clip.mp4 is 101.0 MB — the video limit is 100.0 MB");
        std::fs::write(dir.join("ok.mp4"), [0u8, 1, 2]).unwrap();
        assert_eq!(read_video_file(&dir.join("ok.mp4")).unwrap().data_url.as_deref(), Some("data:video/mp4;base64,AAEC"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn folders_are_checked_before_copying() {
        assert_eq!(check_folder("proj", 3 << 20, 4), Ok(()));
        assert_eq!(check_folder("proj", 60 << 20, 4).unwrap_err(), "proj is 60.0 MB — the limit is 50.0 MB");
        assert_eq!(check_folder("proj", 0, 0).unwrap_err(), "proj had no readable text or binary files in it");
    }

    #[test]
    fn message_blocks_per_vision_mode() {
        let file = Attached { name: "main.rs".into(), size: 11, content: "fn main(){}".into(), ..Default::default() };
        let cut = Attached { name: "Makefile".into(), size: 2_000_000, content: "all:".into(), truncated: true, ..Default::default() };
        let seen = Attached { name: "a.png".into(), kind: AttachedKind::Image, description: Some("a cat".into()), unpacked_to: Some("uploads/a.png".into()), ..Default::default() };
        let blind = Attached { name: "b.png".into(), kind: AttachedKind::Image, ..Default::default() };
        let clip = Attached { name: "c.mp4".into(), kind: AttachedKind::Video, ..Default::default() };
        let done = Attached { content: "Attached file: x (saved in the workspace)".into(), preformatted: true, ..Default::default() };
        assert_eq!(build_message_with_attachments("hi", &[], Vision::Helper), "hi");
        assert_eq!(build_message_with_attachments(" hi ", &[file.clone(), cut], Vision::Native), "Attached file: main.rs\n```rs\nfn main(){}\n```\n\nAttached file: Makefile\n[truncated — showing the first 800,000 characters of 1.9 MB]\n```\nall:\n```\n\nhi");
        assert_eq!(build_message_with_attachments("", &[seen.clone(), blind.clone(), clip.clone()], Vision::Helper), "<image name=\"a.png\">\na cat\n</image>\n\n[a.png is also saved in the workspace at uploads/a.png]\n\n<image name=\"b.png\">\n[the image could not be read]\n</image>\n\n<video name=\"c.mp4\">\n[this model cannot watch video — switch to Ox Alpha or Qwen 3.8 27B]\n</video>");
        assert_eq!(build_message_with_attachments("q", &[seen, blind, clip, done], Vision::Native), "[a.png is also saved in the workspace at uploads/a.png]\n\nAttached file: x (saved in the workspace)\n\nq");
    }
}

#[cfg(test)]
mod parity {
    use super::*;
    use crate::media::fixtures::{ALL, file, hex, same};

    fn text(v: &serde_json::Value, key: &str) -> String {
        v[key].as_str().unwrap_or("").to_string()
    }

    #[test]
    fn reading_and_refusing_match_the_web() {
        let dir = std::env::temp_dir().join(format!("apim-parity-att-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for case in ALL["readText"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            std::fs::write(dir.join(name), file(name)).unwrap();
            let want = &case["expect"];
            match (read_text_file(&dir.join(name)), want["error"].as_str()) {
                (Err(e), Some(w)) => assert_eq!(e, w, "{name}"),
                (Ok(Read::Text(t)), None) => {
                    assert!(same(&t.content, &want["content"]), "{name} content");
                    assert_eq!((t.truncated, t.size, t.file_count.map(|n| n as u64)), (want["truncated"].as_bool().unwrap(), want["size"].as_u64().unwrap(), want["fileCount"].as_u64()), "{name}");
                }
                (Ok(_), w) => panic!("{name}: read, where the web said {w:?}"),
                (Err(e), None) => panic!("{name}: {e}"),
            }
        }
        for case in ALL["oversized"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            std::fs::File::create(dir.join(name)).unwrap().set_len(case["mib"].as_u64().unwrap() * 1024 * 1024).unwrap();
            assert_eq!(read_text_file(&dir.join(name)).err().unwrap(), case["expect"]["error"].as_str().unwrap(), "{name}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn helpers_match_the_web() {
        for c in ALL["formatBytes"].as_array().unwrap() {
            assert_eq!(format_bytes(c[0].as_u64().unwrap()), c[1].as_str().unwrap());
        }
        for c in ALL["binaryNote"].as_array().unwrap() {
            assert_eq!(binary_format_note(c[0].as_str().unwrap()).as_deref(), c[1].as_str(), "{c}");
        }
        for c in ALL["sniff"].as_array().unwrap() {
            let bytes = hex(c[0].as_str().unwrap());
            let order = looks_utf16(&bytes).map(|o| if o == Utf16::Le { "le" } else { "be" });
            assert_eq!((bytes_look_binary(&bytes), order), (c[1].as_bool().unwrap(), c[2].as_str()), "{c}");
        }
        for c in ALL["blockSend"].as_array().unwrap() {
            let chips: Vec<(&str, Option<AttachStage>, bool)> = c[0].as_array().unwrap().iter().map(|chip| {
                let stage = chip["stage"].as_str().map(|s| match s {
                    "unpacking" => AttachStage::Unpacking,
                    other => panic!("stage {other}"),
                });
                (chip["name"].as_str().unwrap(), stage, chip["analyzing"].as_bool().unwrap_or(false))
            }).collect();
            assert_eq!(attachments_block_send(&chips).as_deref(), c[1].as_str(), "{c}");
        }
        for c in ALL["flags"]["archive"].as_array().unwrap() {
            let name = c[0].as_str().unwrap();
            assert_eq!((is_archive(name), unsupported_archive_note(name)), (c[1].as_bool().unwrap(), c[2].as_str()), "{c}");
        }
        for c in ALL["flags"]["video"].as_array().unwrap() {
            assert_eq!(is_video_file(c[0].as_str().unwrap(), c[1].as_str().unwrap()), c[2].as_bool().unwrap(), "{c}");
        }
        for c in ALL["flags"]["image"].as_array().unwrap() {
            assert_eq!(crate::media::vision::is_image_file(c[0].as_str().unwrap(), c[1].as_str().unwrap()), c[2].as_bool().unwrap(), "{c}");
        }
    }

    #[test]
    fn messages_match_the_web() {
        for case in ALL["messages"].as_array().unwrap() {
            let attached: Vec<Attached> = case["attachments"].as_array().unwrap().iter().map(|a| Attached {
                name: text(a, "name"),
                size: a["size"].as_u64().unwrap(),
                content: text(a, "content"),
                truncated: a["truncated"].as_bool().unwrap(),
                kind: match a["kind"].as_str().unwrap() { "image" => AttachedKind::Image, "video" => AttachedKind::Video, _ => AttachedKind::Text },
                preformatted: a["preformatted"].as_bool().unwrap_or(false),
                unpacked_to: a["unpackedTo"].as_str().map(String::from),
                description: a["description"].as_str().map(String::from),
            }).collect();
            let vision = match case["vision"].as_str().unwrap() { "native" => Vision::Native, "none" => Vision::None, _ => Vision::Helper };
            assert_eq!(build_message_with_attachments(case["text"].as_str().unwrap(), &attached, vision), case["expect"].as_str().unwrap(), "{case}");
        }
    }
}

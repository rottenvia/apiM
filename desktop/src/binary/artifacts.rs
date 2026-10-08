//! binary-artifacts.ts: the exhaustive static layers written into the workspace under
//! `analysis/<name>-<sha12>/static/` (full strings dump, entropy map, carved blobs, pe-summary.json),
//! in the web's file names and formats so either app can read the other's output. Cached by SHA-256.

use super::pe::*;
use super::types::*;
use crate::tools::files::resolve;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StringsDumpResult {
    pub count: u64,
    pub ascii: u64,
    pub utf16: u64,
    pub outputs: Vec<String>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntropyMapResult {
    pub window_bytes: u64,
    pub windows: u64,
    #[serde(serialize_with = "ser_js_f64")]
    pub min: f64,
    #[serde(serialize_with = "ser_js_f64")]
    pub max: f64,
    #[serde(serialize_with = "ser_js_f64")]
    pub average: f64,
    pub outputs: Vec<String>,
}

impl Default for EntropyMapResult {
    fn default() -> Self {
        EntropyMapResult { window_bytes: 4096, windows: 0, min: 0.0, max: 0.0, average: 0.0, outputs: vec![] }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CarvedBlob {
    pub index: u64,
    pub kind: String,
    pub offset: u64,
    pub bytes: u64,
    pub path: String,
    pub strings: Vec<String>,
    pub note: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct StaticArtifactLayers {
    pub summary: bool,
    pub strings: bool,
    pub entropy: bool,
    pub carve: bool,
}

#[derive(Clone, Debug)]
pub struct StaticBinaryArtifacts {
    pub root: String,
    pub outputs: Vec<String>,
    pub strings: StringsDumpResult,
    pub entropy: EntropyMapResult,
    pub carved: Vec<CarvedBlob>,
    pub layers: StaticArtifactLayers,
    pub cached: bool,
    pub summary: String,
}

impl StaticBinaryArtifacts {
    /// What the web reports when no static layer was asked for.
    pub fn none() -> StaticBinaryArtifacts {
        StaticBinaryArtifacts {
            root: String::new(),
            outputs: vec![],
            strings: StringsDumpResult::default(),
            entropy: EntropyMapResult::default(),
            carved: vec![],
            layers: StaticArtifactLayers { summary: false, strings: false, entropy: false, carve: false },
            cached: false,
            summary: "No exhaustive static artifact layer was requested.".into(),
        }
    }
}

/// `.apim-static.json`, the per-binary cache marker.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StaticArtifactCache {
    schema: u32,
    hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    summary_output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    strings: Option<StringsDumpResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    entropy: Option<EntropyMapResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    carved: Option<Vec<CarvedBlob>>,
}

const STATIC_SCHEMA: u32 = 5;
// search_files reads up to 512KB per file. Stay below that so exhaustive artifacts are genuinely searchable.
const STRINGS_CHUNK_BYTES: usize = 350_000;
const MAX_CARVED_BLOBS: usize = 64;
const MAX_CARVED_TOTAL_BYTES: usize = 128 * 1024 * 1024;
const MAX_CARVED_SINGLE_BYTES: usize = 64 * 1024 * 1024;

type Res<T> = Result<T, String>;

fn io<T>(r: std::io::Result<T>) -> Res<T> {
    r.map_err(|e| e.to_string())
}

/// `numberEnv`: an unset variable takes the fallback; a set one is read like `Number()` and clamped.
pub fn number_env(name: &str, fallback: f64, min: f64, max: f64) -> f64 {
    let Ok(raw) = std::env::var(name) else { return fallback };
    let t = raw.trim();
    let parsed = if t.is_empty() { Some(0.0) } else { t.parse::<f64>().ok() };
    match parsed {
        Some(n) if n.is_finite() => n.trunc().max(min).min(max),
        _ => fallback,
    }
}

fn relative(root: &Path, full: &Path) -> String {
    full.strip_prefix(root).unwrap_or(full).to_string_lossy().replace('\\', "/")
}

static UNSAFE_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9_.-]+").unwrap());
static DOT_DASH_ENDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[.-]+|[.-]+$").unwrap());

fn safe(value: &str) -> String {
    let dashed = UNSAFE_NAME.replace_all(value, "-");
    let cut: String = DOT_DASH_ENDS.replace_all(&dashed, "").chars().take(90).collect();
    if cut.is_empty() { "blob".into() } else { cut }
}

fn printable(b: u8) -> bool {
    (0x20..=0x7e).contains(&b)
}

/// Writes lines into numbered chunk files that stay small enough to search, up to a total cap.
struct ChunkWriter {
    dir: PathBuf,
    stem: String,
    extension: &'static str,
    max_bytes: usize,
    part: usize,
    buffered: String,
    total_bytes: usize,
    files: Vec<PathBuf>,
    truncated: bool,
    failed: Option<String>,
}

impl ChunkWriter {
    fn new(dir: &Path, stem: &str, extension: &'static str, max_bytes: usize) -> Self {
        ChunkWriter { dir: dir.to_path_buf(), stem: stem.into(), extension, max_bytes, part: 0, buffered: String::new(), total_bytes: 0, files: vec![], truncated: false, failed: None }
    }

    fn write(&mut self, line: &str) -> bool {
        if self.truncated {
            return false;
        }
        let bytes = line.len();
        if self.total_bytes + self.buffered.len() + bytes > self.max_bytes {
            self.truncated = true;
            self.flush();
            return false;
        }
        if !self.buffered.is_empty() && self.buffered.len() + bytes > STRINGS_CHUNK_BYTES {
            self.flush();
        }
        self.buffered.push_str(line);
        true
    }

    fn flush(&mut self) {
        if self.buffered.is_empty() {
            return;
        }
        self.part += 1;
        let full = self.dir.join(format!("{}-{:04}.{}", self.stem, self.part, self.extension));
        if let Err(e) = fs::write(&full, &self.buffered) {
            self.failed.get_or_insert(e.to_string());
        }
        self.files.push(full);
        self.total_bytes += self.buffered.len();
        self.buffered.clear();
    }

    fn finish(mut self) -> Res<(Vec<PathBuf>, bool)> {
        self.flush();
        match self.failed {
            Some(e) => Err(e),
            None => Ok((self.files, self.truncated)),
        }
    }
}

/// Exhaustive ASCII plus both UTF-16LE alignments, written incrementally.
pub fn dump_strings(bytes: &[u8], dir: &Path, stem: &str, workspace_root: &Path, max_output_bytes: Option<usize>) -> Res<StringsDumpResult> {
    io(fs::create_dir_all(dir))?;
    let max = max_output_bytes.unwrap_or_else(|| (number_env("APIM_BINARY_MAX_STATIC_OUTPUT_MB", 512.0, 16.0, 2048.0) as usize) * 1024 * 1024);
    let per_encoding = (8 * 1024 * 1024).max(max / 2);
    let mut ascii_w = ChunkWriter::new(dir, &format!("{stem}-ascii"), "tsv", per_encoding);
    let mut utf_w = ChunkWriter::new(dir, &format!("{stem}-utf16le"), "tsv", per_encoding);
    ascii_w.write("offset\tencoding\tlength\tvalue\n");
    utf_w.write("offset\tencoding\tlength\tvalue\n");
    let (mut ascii_count, mut utf16_count) = (0u64, 0u64);
    const MIN: usize = 4;

    let mut i = 0usize;
    while i < bytes.len() {
        if !printable(bytes[i]) {
            i += 1;
            continue;
        }
        let mut value: Wide = Vec::new();
        while i < bytes.len() && printable(bytes[i]) {
            value.push(bytes[i] as u16);
            i += 1;
            if value.len() == 16_384 {
                if ascii_w.write(&format!("0x{:x}\tascii\t{}\t{}\n", i - value.len(), value.len(), json_units(&value))) {
                    ascii_count += 1;
                }
                value.clear();
            }
        }
        if value.len() >= MIN && ascii_w.write(&format!("0x{:x}\tascii\t{}\t{}\n", i - value.len(), value.len(), json_units(&value))) {
            ascii_count += 1;
        }
    }

    for parity in [0usize, 1] {
        let mut i = parity;
        while i + 1 < bytes.len() {
            let code = |at: usize| bytes[at] as u16 | (bytes[at + 1] as u16) << 8;
            let ok = |c: u16| c >= 0x20 && c != 0x7f && c <= 0xfffd;
            if !ok(code(i)) {
                i += 2;
                continue;
            }
            let name = if parity == 0 { "even" } else { "odd" };
            let mut value: Wide = Vec::new();
            while i + 1 < bytes.len() {
                let c = code(i);
                if !ok(c) {
                    break;
                }
                value.push(c);
                i += 2;
                if value.len() == 16_384 {
                    if utf_w.write(&format!("0x{:x}\tutf16le/{name}\t{}\t{}\n", i - value.len() * 2, value.len(), json_units(&value))) {
                        utf16_count += 1;
                    }
                    value.clear();
                }
            }
            if value.len() >= MIN && utf_w.write(&format!("0x{:x}\tutf16le/{name}\t{}\t{}\n", i - value.len() * 2, value.len(), json_units(&value))) {
                utf16_count += 1;
            }
            if value.len() < MIN {
                i += 2;
            }
        }
    }

    let (ascii_files, ascii_cut) = ascii_w.finish()?;
    let (utf_files, utf_cut) = utf_w.finish()?;
    Ok(StringsDumpResult {
        count: ascii_count + utf16_count,
        ascii: ascii_count,
        utf16: utf16_count,
        outputs: ascii_files.iter().chain(&utf_files).map(|f| relative(workspace_root, f)).collect(),
        truncated: ascii_cut || utf_cut,
    })
}

fn block_entropy(bytes: &[u8], offset: usize, size: usize) -> f64 {
    let end = bytes.len().min(offset + size);
    if end <= offset {
        return 0.0;
    }
    let mut counts = [0u32; 256];
    for &b in &bytes[offset..end] {
        counts[b as usize] += 1;
    }
    let n = (end - offset) as f64;
    let mut result = 0.0f64;
    for &c in counts.iter().filter(|&&c| c != 0) {
        let p = c as f64 / n;
        result -= p * p.log2();
    }
    result
}

const ENTROPY_HEADER: &str = "offset\tsize\tentropy\tsection\n";

fn write_entropy_map(bytes: &[u8], inspection: &PeInspection, dir: &Path, workspace_root: &Path) -> Res<EntropyMapResult> {
    const WINDOW: usize = 4096;
    let mut outputs = Vec::new();
    let mut lines = String::from(ENTROPY_HEADER);
    let mut chars = lines.len();
    let mut count = 0usize;
    let mut part = 0;
    let mut flush = |lines: &mut String, chars: &mut usize, count: &mut usize, part: &mut usize| -> Res<()> {
        if *count == 0 {
            return Ok(());
        }
        *part += 1;
        let output = dir.join(format!("entropy-map-{:04}.tsv", *part));
        io(fs::write(&output, lines.as_bytes()))?;
        outputs.push(relative(workspace_root, &output));
        *lines = ENTROPY_HEADER.to_string();
        *chars = lines.len();
        *count = 0;
        Ok(())
    };
    let (mut min, mut max, mut sum, mut windows) = (8.0f64, 0.0f64, 0.0f64, 0u64);
    let mut offset = 0usize;
    while offset < bytes.len() {
        let size = WINDOW.min(bytes.len() - offset);
        let value = block_entropy(bytes, offset, size);
        let section = inspection.sections.iter().find(|s| (offset as i64) >= s.raw_offset && (offset as i64) < s.raw_offset + s.raw_size);
        let line = format!("0x{:x}\t{}\t{}\t{}\n", offset, size, to_fixed(value, 4), section.map_or("headers/overlay", |s| s.name.as_str()));
        let len = line.chars().count();
        if chars + len > STRINGS_CHUNK_BYTES {
            flush(&mut lines, &mut chars, &mut count, &mut part)?;
        }
        lines.push_str(&line);
        chars += len;
        count += 1;
        min = min.min(value);
        max = max.max(value);
        sum += value;
        windows += 1;
        offset += WINDOW;
    }
    flush(&mut lines, &mut chars, &mut count, &mut part)?;
    Ok(EntropyMapResult {
        window_bytes: WINDOW as u64,
        windows,
        min: if windows > 0 { round_to(min, 4) } else { 0.0 },
        max: round_to(max, 4),
        average: if windows > 0 { round_to(sum / windows as f64, 4) } else { 0.0 },
        outputs,
    })
}

fn rd16(b: &[u8], at: usize) -> Option<usize> {
    b.get(at..at + 2).map(|s| u16::from_le_bytes([s[0], s[1]]) as usize)
}

fn rd32(b: &[u8], at: usize) -> Option<usize> {
    b.get(at..at + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as usize)
}

/// The size of a PE image starting at `offset`, when its headers are self-consistent.
fn embedded_pe(bytes: &[u8], offset: usize) -> Option<(usize, bool)> {
    if bytes.get(offset) != Some(&0x4d) || bytes.get(offset + 1) != Some(&0x5a) {
        return None;
    }
    let pe_relative = rd32(bytes, offset + 0x3c)?;
    if !(0x40..=16 * 1024 * 1024).contains(&pe_relative) {
        return None;
    }
    let pe = offset + pe_relative;
    if pe + 24 > bytes.len() || &bytes[pe..pe + 4] != b"PE\0\0" {
        return None;
    }
    let sections = rd16(bytes, pe + 6).unwrap_or(0);
    let optional_size = rd16(bytes, pe + 20).unwrap_or(0);
    let characteristics = rd16(bytes, pe + 22).unwrap_or(0);
    if sections == 0 || sections > 512 || optional_size < 96 {
        return None;
    }
    let optional = pe + 24;
    let table = optional + optional_size;
    if table + sections * 40 > bytes.len() {
        return None;
    }
    let mut end = table + sections * 40 - offset;
    for i in 0..sections {
        let at = table + i * 40;
        let raw_size = rd32(bytes, at + 16).unwrap_or(0);
        let raw_offset = rd32(bytes, at + 20).unwrap_or(0);
        end = end.max(raw_offset + raw_size);
    }
    let magic = rd16(bytes, optional);
    if magic == Some(0x10b) || magic == Some(0x20b) {
        let data_start = optional + if magic == Some(0x20b) { 112 } else { 96 };
        let security_offset = rd32(bytes, data_start + 32).unwrap_or(0);
        let security_size = rd32(bytes, data_start + 36).unwrap_or(0);
        end = end.max(security_offset + security_size);
    }
    if end == 0 || end > bytes.len() - offset {
        return None;
    }
    Some((end, characteristics & 0x2000 != 0))
}

/// Every occurrence (overlaps included, like repeated Buffer.indexOf), at most 10 000.
fn find_all(bytes: &[u8], signature: &[u8], start: usize) -> Vec<usize> {
    let mut out = Vec::new();
    let mut at = find_bytes(bytes, signature, start);
    while let Some(a) = at {
        if out.len() >= 10_000 {
            break;
        }
        out.push(a);
        at = find_bytes(bytes, signature, a + 1);
    }
    out
}

fn find_end(bytes: &[u8], signature: &[u8], start: usize) -> Option<usize> {
    find_bytes(bytes, signature, start).map(|a| a + signature.len())
}

struct CarveCandidate {
    kind: &'static str,
    offset: usize,
    end: usize,
    extension: &'static str,
    note: String,
}

static RE_LUA_DECL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bfunction\s+[A-Za-z_]|\blocal\s+[A-Za-z_]").unwrap());
static RE_LUA_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(require|end|then|elseif|pairs|ipairs)\b").unwrap());

const PNG_SIG: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

fn carve_candidates(bytes: &[u8]) -> Vec<CarveCandidate> {
    let mut candidates: Vec<CarveCandidate> = Vec::new();
    for offset in find_all(bytes, &[0x4d, 0x5a], 1) {
        let Some((size, dll)) = embedded_pe(bytes, offset) else { continue };
        let what = if dll { "DLL" } else { "EXE" };
        candidates.push(CarveCandidate { kind: "PE", offset, end: offset + size, extension: if dll { "dll" } else { "exe" }, note: format!("Embedded {what} with a self-consistent PE section table.") });
    }

    let lua_signatures: [(&[u8], &str); 2] = [(&[0x1b, 0x4c, 0x75, 0x61], "Lua bytecode"), (&[0x1b, 0x4c, 0x4a], "LuaJIT bytecode")];
    let all_strong: [&[u8]; 5] = [&[0x4d, 0x5a], lua_signatures[0].0, lua_signatures[1].0, b"PK\x03\x04", &PNG_SIG];
    for (signature, label) in lua_signatures {
        for offset in find_all(bytes, signature, 1) {
            let mut next_signature = bytes.len();
            for s in all_strong.iter().chain([&b"%PDF-"[..]].iter()) {
                if let Some(found) = find_bytes(bytes, s, offset + signature.len()) {
                    next_signature = next_signature.min(found);
                }
            }
            let next = candidates.iter().filter(|c| c.offset > offset).map(|c| c.offset).chain([bytes.len(), offset + MAX_CARVED_SINGLE_BYTES, next_signature]).min().unwrap();
            candidates.push(CarveCandidate { kind: "Lua bytecode", offset, end: next, extension: "luac", note: format!("{label}; exact embedded length is not encoded, so carving stops at the next known blob or the per-blob cap.") });
        }
    }

    for offset in find_all(bytes, b"PK\x03\x04", 1) {
        let Some(eocd) = find_bytes(bytes, &[0x50, 0x4b, 0x05, 0x06], offset + 4) else { continue };
        if eocd + 22 > bytes.len() {
            continue;
        }
        let comment = rd16(bytes, eocd + 20).unwrap_or(0);
        let end = bytes.len().min(eocd + 22 + comment);
        candidates.push(CarveCandidate { kind: "ZIP", offset, end, extension: "zip", note: "Embedded ZIP archive ending at EOCD.".into() });
    }
    for offset in find_all(bytes, &PNG_SIG, 1) {
        if let Some(iend) = find_end(bytes, &[0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], offset + 8) {
            candidates.push(CarveCandidate { kind: "PNG", offset, end: iend, extension: "png", note: "Embedded PNG through IEND.".into() });
        }
    }
    for offset in find_all(bytes, b"%PDF-", 1) {
        if let Some(eof) = find_end(bytes, b"%%EOF", offset + 5) {
            candidates.push(CarveCandidate { kind: "PDF", offset, end: eof, extension: "pdf", note: "Embedded PDF through %%EOF.".into() });
        }
    }

    // Long printable runs that look like actual Lua source, not one token.
    let mut i = 1usize;
    while i < bytes.len() {
        if !printable(bytes[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && printable(bytes[i]) && i - start < 2 * 1024 * 1024 {
            i += 1;
        }
        if i - start < 80 {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes[start..i]);
        if RE_LUA_DECL.is_match(&text) && RE_LUA_WORD.is_match(&text) {
            candidates.push(CarveCandidate { kind: "Lua source", offset: start, end: i, extension: "lua", note: "Long printable region containing multiple Lua source-language tokens.".into() });
        }
    }

    candidates.retain(|c| c.end > c.offset);
    candidates.sort_by(|a, b| a.offset.cmp(&b.offset).then(b.end.cmp(&a.end)));
    candidates
}

fn opaque_candidates(bytes: &[u8], inspection: &PeInspection) -> Vec<CarveCandidate> {
    let mut out = Vec::new();
    for s in &inspection.sections {
        if s.raw_size < 512 || s.entropy < 7.2 || s.raw_offset < 0 || s.raw_offset >= bytes.len() as i64 {
            continue;
        }
        out.push(CarveCandidate {
            kind: "opaque high-entropy section",
            offset: s.raw_offset as usize,
            end: bytes.len().min((s.raw_offset + s.raw_size) as usize),
            extension: "bin",
            note: format!("Section {} has entropy {}. It is preserved as opaque compressed/encrypted data; no plaintext payload signature was claimed.", s.name, js_num(s.entropy)),
        });
    }
    if inspection.overlay_bytes >= 4096 {
        out.push(CarveCandidate {
            kind: "opaque overlay",
            offset: (bytes.len() as i64 - inspection.overlay_bytes).max(0) as usize,
            end: bytes.len(),
            extension: "bin",
            note: format!("The PE overlay has {} bytes and is preserved even though no plaintext child format was identified.", inspection.overlay_bytes),
        });
    }
    out
}

fn carve_blobs(bytes: &[u8], inspection: &PeInspection, dir: &Path, workspace_root: &Path) -> Res<Vec<CarvedBlob>> {
    let output_dir = dir.join("carved");
    let strings_dir = output_dir.join("strings");
    io(fs::create_dir_all(&strings_dir))?;
    let mut carved: Vec<CarvedBlob> = Vec::new();
    let mut occupied: Vec<(usize, usize)> = Vec::new();
    let mut total = 0usize;

    // Strong magic-based children first, then overlapping opaque regions.
    let candidates: Vec<CarveCandidate> = carve_candidates(bytes).into_iter().chain(opaque_candidates(bytes, inspection)).collect();
    for c in candidates {
        if carved.len() >= MAX_CARVED_BLOBS {
            break;
        }
        let size = (c.end - c.offset).min(MAX_CARVED_SINGLE_BYTES);
        if size == 0 || total + size > MAX_CARVED_TOTAL_BYTES {
            continue;
        }
        // A strong blob fully inside one already carved is usually a signature in that child.
        if occupied.iter().any(|&(from, to)| c.offset >= from && c.end <= to) {
            continue;
        }
        let index = carved.len() + 1;
        let base = format!("blob-{index:03}-0x{:x}-{}", c.offset, safe(&c.kind.to_lowercase()));
        let full = output_dir.join(format!("{base}.{}", c.extension));
        let data = &bytes[c.offset..c.offset + size];
        io(fs::write(&full, data))?;
        let own = dump_strings(data, &strings_dir, &format!("{base}-strings"), workspace_root, Some(32 * 1024 * 1024))?;
        carved.push(CarvedBlob {
            index: index as u64,
            kind: c.kind.into(),
            offset: c.offset as u64,
            bytes: data.len() as u64,
            path: relative(workspace_root, &full),
            strings: own.outputs,
            note: c.note.clone() + if size < c.end - c.offset { " Carve hit the per-blob size cap." } else { "" },
        });
        occupied.push((c.offset, c.offset + size));
        total += size;
    }
    io(fs::write(output_dir.join("index.json"), to_json(&carved)? + "\n"))?;
    Ok(carved)
}

/// `JSON.stringify(value, null, 2)`.
pub fn to_json<T: Serialize>(value: &T) -> Res<String> {
    serde_json::to_string_pretty(value).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SummaryFile<'a> {
    path: &'a str,
    generated_at: String,
    packed_assessment: &'a Packing,
    inspection: &'a PeInspection,
}

/// Builds (or reuses) the requested static layers for one executable and says what exists.
pub fn generate_static_binary_artifacts(root: &Path, target: &str, bytes: &[u8], inspection: &PeInspection, force: bool, layers: Option<StaticArtifactLayers>) -> Res<StaticBinaryArtifacts> {
    let root_relative = binary_analysis_root(target, &inspection.hashes.sha256);
    let static_dir = resolve(root, &format!("{root_relative}/static"))?;
    let marker_path = static_dir.join(".apim-static.json");
    let layers = layers.unwrap_or(StaticArtifactLayers { summary: true, strings: true, entropy: true, carve: true });
    let hash = &inspection.hashes.sha256;

    let mut cache = StaticArtifactCache { schema: STATIC_SCHEMA, hash: hash.clone(), summary_output: None, strings: None, entropy: None, carved: None };
    if !force {
        if let Ok(text) = fs::read_to_string(&marker_path)
            && let Ok(loaded) = serde_json::from_str::<StaticArtifactCache>(&text)
        {
            if loaded.schema == STATIC_SCHEMA && loaded.hash == *hash {
                cache = loaded;
            } else {
                let _ = fs::remove_dir_all(&static_dir);
            }
        }
    } else {
        let _ = fs::remove_dir_all(&static_dir);
    }

    io(fs::create_dir_all(&static_dir))?;
    let mut all_cached = true;

    if layers.summary && cache.summary_output.is_none() {
        all_cached = false;
        let summary_path = static_dir.join("pe-summary.json");
        let file = SummaryFile { path: target, generated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), packed_assessment: &inspection.packing, inspection };
        io(fs::write(&summary_path, to_json(&file)? + "\n"))?;
        cache.summary_output = Some(relative(root, &summary_path));
    }

    if layers.strings && cache.strings.is_none() {
        all_cached = false;
        let strings_dir = static_dir.join("strings");
        let _ = fs::remove_dir_all(&strings_dir);
        cache.strings = Some(dump_strings(bytes, &strings_dir, "full-strings", root, None)?);
    }

    if layers.entropy && cache.entropy.is_none() {
        all_cached = false;
        // Remove only old entropy chunks; other completed layers stay intact.
        if let Ok(entries) = fs::read_dir(&static_dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with("entropy-map-") && name.ends_with(".tsv") && name[12..name.len() - 4].bytes().all(|b| b.is_ascii_digit()) {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
        cache.entropy = Some(write_entropy_map(bytes, inspection, &static_dir, root)?);
    }

    if layers.carve && cache.carved.is_none() {
        all_cached = false;
        let _ = fs::remove_dir_all(static_dir.join("carved"));
        cache.carved = Some(carve_blobs(bytes, inspection, &static_dir, root)?);
    }

    io(fs::write(&marker_path, to_json(&cache)? + "\n"))?;

    let strings = if layers.strings { cache.strings.clone().unwrap_or_default() } else { StringsDumpResult::default() };
    let entropy = if layers.entropy { cache.entropy.clone().unwrap_or_default() } else { EntropyMapResult::default() };
    let carved = if layers.carve { cache.carved.clone().unwrap_or_default() } else { vec![] };
    let mut outputs: Vec<String> = Vec::new();
    if layers.summary {
        outputs.extend(cache.summary_output.clone());
    }
    if layers.strings {
        outputs.extend(strings.outputs.iter().cloned());
    }
    if layers.entropy {
        outputs.extend(entropy.outputs.iter().cloned());
    }
    if layers.carve {
        outputs.push(relative(root, &static_dir.join("carved").join("index.json")));
        for blob in &carved {
            outputs.push(blob.path.clone());
            outputs.extend(blob.strings.iter().cloned());
        }
    }
    let mut seen = std::collections::HashSet::new();
    outputs.retain(|o| seen.insert(o.clone()));

    let requested = [layers.summary, layers.strings, layers.entropy, layers.carve].iter().filter(|&&x| x).count();
    let mut details: Vec<String> = Vec::new();
    if layers.summary {
        details.push("PE summary".into());
    }
    if layers.strings {
        details.push(format!("{} strings", group(strings.count as i64)));
    }
    if layers.entropy {
        details.push(format!("{} entropy windows", group(entropy.windows as i64)));
    }
    if layers.carve {
        details.push(format!("{} carved blobs", carved.len()));
    }
    Ok(StaticBinaryArtifacts {
        root: root_relative,
        outputs,
        strings,
        entropy,
        carved,
        layers,
        cached: requested > 0 && all_cached,
        summary: if requested > 0 { format!("{} {}.", if all_cached { "Reused" } else { "Prepared" }, details.join(", ")) } else { "No exhaustive static artifact layer was requested.".into() },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binary::pe::samples;

    fn inspect(bytes: &[u8]) -> PeInspection {
        inspect_portable_executable(bytes, &StringOptions::default()).unwrap()
    }

    #[test]
    fn writes_every_layer_and_reuses_them() {
        let root = test_dir("artifacts");
        let bytes = samples::pe64();
        let p = inspect(&bytes);
        let a = generate_static_binary_artifacts(&root, "uploads/binaries/sample.exe", &bytes, &p, false, None).unwrap();
        assert!(!a.cached && a.summary.starts_with("Prepared PE summary, "));
        assert_eq!(a.root, format!("analysis/sample-{}", &p.hashes.sha256[..12]));
        let first = fs::read_to_string(root.join(&a.strings.outputs[0])).unwrap();
        assert!(first.starts_with("offset\tencoding\tlength\tvalue\n0x"), "{first}");
        assert!(first.contains("\tascii\t26\t\"https://example.com/api/v1\"\n"));
        assert!(a.strings.outputs.iter().any(|o| o.ends_with("full-strings-utf16le-0001.tsv")));
        let entropy = fs::read_to_string(root.join(&a.entropy.outputs[0])).unwrap();
        assert!(entropy.starts_with("offset\tsize\tentropy\tsection\n0x0\t4096\t") && entropy.contains("\theaders/overlay\n"));
        let kinds: Vec<&str> = a.carved.iter().map(|c| c.kind.as_str()).collect();
        assert!(kinds.contains(&"ZIP") && kinds.contains(&"PNG") && kinds.contains(&"opaque high-entropy section"), "{kinds:?}");
        assert!(root.join(&a.carved[0].path).is_file());
        let index: serde_json::Value = serde_json::from_str(&fs::read_to_string(root.join(&a.root).join("static/carved/index.json")).unwrap()).unwrap();
        assert_eq!(index.as_array().unwrap().len(), a.carved.len());
        let summary: serde_json::Value = serde_json::from_str(&fs::read_to_string(root.join(&a.root).join("static/pe-summary.json")).unwrap()).unwrap();
        assert!(summary["inspection"].get("strings").is_none() && summary["packedAssessment"]["status"].is_string());
        assert_eq!(summary["inspection"]["hashes"]["sha256"], p.hashes.sha256.as_str());
        let again = generate_static_binary_artifacts(&root, "uploads/binaries/sample.exe", &bytes, &p, false, None).unwrap();
        assert!(again.cached && again.summary.starts_with("Reused "));
        assert_eq!(again.outputs, a.outputs);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn partial_layers_and_no_layers() {
        let root = test_dir("artifacts-partial");
        let bytes = samples::pe32_managed();
        let p = inspect(&bytes);
        let only_entropy = StaticArtifactLayers { summary: false, strings: false, entropy: true, carve: false };
        let a = generate_static_binary_artifacts(&root, "m.exe", &bytes, &p, false, Some(only_entropy)).unwrap();
        assert_eq!(a.summary, "Prepared 1 entropy windows.");
        assert_eq!(a.outputs.len(), 1);
        let none = StaticArtifactLayers { summary: false, strings: false, entropy: false, carve: false };
        let b = generate_static_binary_artifacts(&root, "m.exe", &bytes, &p, false, Some(none)).unwrap();
        assert_eq!((b.cached, b.summary.as_str()), (false, "No exhaustive static artifact layer was requested."));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn carves_lua_and_embedded_pe() {
        let mut blob = vec![b'x'; 64];
        blob.extend_from_slice(&samples::pe32_managed());
        blob.extend_from_slice(b"\x1bLuaQ\0\0\0 bytecode");
        blob.extend_from_slice(b" local x = 1 function run() for k,v in pairs(t) do require('a') end end local y = 2 -- padding padding padding");
        let found = carve_candidates(&blob);
        let kinds: Vec<(&str, usize)> = found.iter().map(|c| (c.kind, c.offset)).collect();
        assert!(kinds.contains(&("PE", 64)) && kinds.iter().any(|k| k.0 == "Lua bytecode") && kinds.iter().any(|k| k.0 == "Lua source"), "{kinds:?}");
        assert_eq!(safe("opaque high-entropy section"), "opaque-high-entropy-section");
    }

    #[test]
    fn number_env_reads_like_javascript() {
        assert_eq!(number_env("APIM_SURELY_UNSET_VARIABLE", 512.0, 16.0, 2048.0), 512.0);
    }
}

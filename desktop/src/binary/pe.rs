//! binaries.ts, the Windows side: PE headers, sections, imports, exports, .NET metadata, version info,
//! strings, hashes and the packing heuristics. Reads bytes only; nothing here ever runs the target.

use super::types::*;
use regex::Regex;
use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

pub const MAX_BINARY_ANALYSIS_BYTES: u64 = MAX_PE_UPLOAD_BYTES;
pub const MAX_IMPORT_DLLS: usize = 512;
pub const MAX_IMPORTS_PER_DLL: usize = 8_192;
pub const MAX_EXPORTS: i64 = 20_000;
pub const MAX_REPORTED_STRINGS: f64 = 300.0;

/// Parse failures carry the web's message text, which the model reads.
pub type R<T> = Result<T, String>;
const EOF: &str = "Unexpected end of executable";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeSection {
    pub name: String,
    pub virtual_size: i64,
    pub virtual_address: i64,
    pub raw_size: i64,
    pub raw_offset: i64,
    pub characteristics: i64,
    pub executable: bool,
    pub readable: bool,
    pub writable: bool,
    #[serde(serialize_with = "ser_js_f64")]
    pub entropy: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeImport {
    pub dll: String,
    pub functions: Vec<String>,
    pub ordinals: Vec<i64>,
    pub truncated: bool,
    pub delay_loaded: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeExport {
    pub name: Option<String>,
    pub ordinal: i64,
    pub rva: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forwarder: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRef {
    pub name: String,
    pub version: String,
    pub flags: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAssembly {
    pub name: Option<String>,
    pub version: Option<String>,
    pub runtime_version: Option<String>,
    pub flags: i64,
    pub references: Vec<ManagedRef>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Packing {
    pub status: String,
    pub score: i64,
    pub reasons: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_packer: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightedImport {
    pub dll: String,
    pub function: String,
    pub category: &'static str,
    pub delay_loaded: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Authenticode {
    pub present: bool,
    pub size: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub certificate_type: Option<i64>,
    /// Presence is structural only; trust verification is OS-specific.
    pub verified: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hashes {
    pub sha256: String,
    pub sha1: String,
    pub md5: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imphash: Option<String>,
}

/// The web writes these keys in a different order for PE and for other formats; `pe_order` picks which.
#[derive(Clone, Debug)]
pub struct Mitigations {
    pub aslr: bool,
    pub high_entropy_va: bool,
    pub dep: bool,
    pub control_flow_guard: bool,
    pub force_integrity: bool,
    pub pe_order: bool,
}

impl Serialize for Mitigations {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(5))?;
        if self.pe_order {
            m.serialize_entry("highEntropyVa", &self.high_entropy_va)?;
            m.serialize_entry("aslr", &self.aslr)?;
            m.serialize_entry("forceIntegrity", &self.force_integrity)?;
            m.serialize_entry("dep", &self.dep)?;
            m.serialize_entry("controlFlowGuard", &self.control_flow_guard)?;
        } else {
            m.serialize_entry("aslr", &self.aslr)?;
            m.serialize_entry("highEntropyVa", &self.high_entropy_va)?;
            m.serialize_entry("dep", &self.dep)?;
            m.serialize_entry("controlFlowGuard", &self.control_flow_guard)?;
            m.serialize_entry("forceIntegrity", &self.force_integrity)?;
        }
        m.end()
    }
}

/// An insertion-ordered string map (the web's `Record<string, string>`).
#[derive(Clone, Debug, Default)]
pub struct VersionInfo(pub Vec<(String, String)>);

impl Serialize for VersionInfo {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Truncated {
    pub imports: bool,
    pub exports: bool,
    pub strings: bool,
}

/// The web's `PeInspection`. Field order is the JSON key order of pe-summary.json.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeInspection {
    pub format: String,
    pub architecture: String,
    pub machine: i64,
    pub bytes: i64,
    pub hashes: Hashes,
    pub timestamp: i64,
    pub timestamp_iso: Option<String>,
    pub characteristics: i64,
    pub is_dll: bool,
    pub subsystem: String,
    pub image_base: String,
    pub entry_point_rva: i64,
    pub size_of_image: i64,
    pub sections: Vec<PeSection>,
    pub imports: Vec<PeImport>,
    pub exports: Vec<PeExport>,
    pub managed: Option<ManagedAssembly>,
    pub authenticode: Authenticode,
    pub pdb_paths: Vec<String>,
    pub version_info: VersionInfo,
    /// Left out of pe-summary.json, as the web does.
    #[serde(skip)]
    pub strings: Vec<Wide>,
    pub possible_dynamic_libraries: Vec<String>,
    pub highlighted_imports: Vec<HighlightedImport>,
    pub overlay_bytes: i64,
    pub packing: Packing,
    pub mitigations: Mitigations,
    pub indicators: Vec<String>,
    pub truncated: Truncated,
}

/// The string-related options of `inspect_binary`.
#[derive(Clone, Debug, Default)]
pub struct StringOptions {
    pub include_strings: Option<bool>,
    pub string_filter: Option<String>,
    pub min_string_length: Option<f64>,
    pub max_strings: Option<f64>,
}

pub struct Reader<'a> {
    pub bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    pub fn has(&self, offset: i64, size: i64) -> bool {
        offset >= 0 && size >= 0 && offset.saturating_add(size) <= self.bytes.len() as i64
    }
    fn at(&self, o: i64, n: i64) -> R<usize> {
        if self.has(o, n) { Ok(o as usize) } else { Err(EOF.to_string()) }
    }
    pub fn u8(&self, o: i64) -> R<i64> {
        Ok(self.bytes[self.at(o, 1)?] as i64)
    }
    pub fn u16(&self, o: i64) -> R<i64> {
        let i = self.at(o, 2)?;
        Ok(u16::from_le_bytes([self.bytes[i], self.bytes[i + 1]]) as i64)
    }
    pub fn u32(&self, o: i64) -> R<i64> {
        let i = self.at(o, 4)?;
        Ok(u32::from_le_bytes(self.bytes[i..i + 4].try_into().unwrap()) as i64)
    }
    pub fn u64(&self, o: i64) -> R<u64> {
        let i = self.at(o, 8)?;
        Ok(u64::from_le_bytes(self.bytes[i..i + 8].try_into().unwrap()))
    }
    /// Printable ASCII up to the first NUL or odd byte.
    pub fn ascii(&self, offset: i64, max: i64) -> String {
        if !self.has(offset, 1) {
            return String::new();
        }
        let end = (self.bytes.len() as i64).min(offset + max.max(0));
        self.bytes[offset as usize..end as usize].iter().take_while(|&&b| (0x20..=0x7e).contains(&b)).map(|&b| b as char).collect()
    }
    pub fn utf16(&self, offset: i64, max_chars: i64) -> String {
        let mut out: Wide = Vec::new();
        if !self.has(offset, 2) {
            return String::new();
        }
        let mut i = 0;
        while i < max_chars && self.has(offset + i * 2, 2) {
            let code = self.u16(offset + i * 2).unwrap_or(0) as u16;
            if code == 0 || (code < 0x20 && code != 9 && code != 10 && code != 13) {
                break;
            }
            out.push(code);
            i += 1;
        }
        wide_lossy(&out)
    }
}

fn machine_name(machine: i64) -> String {
    match machine {
        0x014c => "x86",
        0x0162 => "MIPS R3000",
        0x0166 => "MIPS R4000",
        0x01c0 => "ARM",
        0x01c2 => "Thumb",
        0x01c4 => "ARMv7",
        0x0200 => "Itanium",
        0x8664 => "x86-64",
        0xaa64 => "ARM64",
        0x5032 => "RISC-V 32",
        0x5064 => "RISC-V 64",
        0x5128 => "RISC-V 128",
        _ => return format!("unknown machine 0x{machine:x}"),
    }
    .to_string()
}

fn subsystem_name(n: i64) -> String {
    match n {
        0 => "unknown",
        1 => "native",
        2 => "Windows GUI",
        3 => "Windows console",
        5 => "OS/2 console",
        7 => "POSIX console",
        9 => "Windows CE GUI",
        10 => "EFI application",
        11 => "EFI boot-service driver",
        12 => "EFI runtime driver",
        13 => "EFI ROM",
        14 => "Xbox",
        16 => "Windows boot application",
        _ => return format!("subsystem {n}"),
    }
    .to_string()
}

pub const SYSTEM_DLLS: [&str; 59] = [
    "advapi32.dll", "bcrypt.dll", "bcryptprimitives.dll", "cabinet.dll", "cfgmgr32.dll", "clbcatq.dll", "combase.dll", "comctl32.dll", "comdlg32.dll", "crypt32.dll", "cryptbase.dll", "cryptsp.dll", "d3d11.dll", "d3d12.dll", "dbghelp.dll", "dnsapi.dll", "dwmapi.dll", "dxgi.dll", "gdi32.dll", "gdi32full.dll", "imagehlp.dll", "imm32.dll", "iphlpapi.dll", "kernel32.dll", "kernelbase.dll", "mpr.dll", "mscoree.dll", "msimg32.dll", "msvcrt.dll", "netapi32.dll", "ncrypt.dll", "normaliz.dll", "ntdll.dll", "ole32.dll", "oleaut32.dll", "powrprof.dll", "profapi.dll", "propsys.dll", "psapi.dll", "rpcrt4.dll", "sechost.dll", "setupapi.dll", "shell32.dll", "shlwapi.dll", "sspicli.dll", "ucrtbase.dll", "urlmon.dll", "user32.dll", "userenv.dll", "usp10.dll", "version.dll", "winhttp.dll", "wininet.dll", "winmm.dll", "winnsi.dll", "winspool.drv", "wintrust.dll", "wldap32.dll", "ws2_32.dll",
];

static RE_CRT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:msvcp\d+(?:_\d+)?\.dll|vcruntime\d+(?:_\d+)?\.dll|concrt\d+\.dll)$").unwrap());

/// Windows system libraries are named in the dependency graph but never read from outside the workspace.
pub fn is_system_library(name: &str) -> bool {
    let n = name.to_lowercase();
    SYSTEM_DLLS.contains(&n.as_str()) || n.starts_with("api-ms-win-") || n.starts_with("ext-ms-win-") || RE_CRT.is_match(&n)
}

/// `Number(value)` clamped like the web's `clampNumber`; NaN and infinities take the fallback.
pub fn clamp_number(value: Option<f64>, fallback: f64, min: f64, max: f64) -> f64 {
    match value {
        Some(n) if n.is_finite() => n.trunc().max(min).min(max),
        _ => fallback,
    }
}

pub fn hash_bytes(bytes: &[u8]) -> Hashes {
    Hashes { sha256: sha256_hex(bytes), sha1: sha1_hex(bytes), md5: md5_hex(bytes), imphash: None }
}

/// Shannon entropy of a byte range, sampled so a huge section cannot stall the run; rounded to 3 places.
fn entropy(bytes: &[u8], offset: i64, size: i64) -> f64 {
    if size <= 0 || offset < 0 || offset >= bytes.len() as i64 {
        return 0.0;
    }
    let available = size.min(bytes.len() as i64 - offset);
    if available <= 0 {
        return 0.0;
    }
    let sample = available.min(1_048_576);
    let step = available as f64 / sample as f64;
    let mut counts = [0u32; 256];
    for i in 0..sample {
        counts[bytes[(offset + (i as f64 * step).floor() as i64) as usize] as usize] += 1;
    }
    let mut h = 0.0f64;
    for &c in counts.iter().filter(|&&c| c != 0) {
        let p = c as f64 / sample as f64;
        h -= p * p.log2();
    }
    round_to(h, 3)
}

fn format_timestamp(seconds: i64) -> Option<String> {
    // Zero and impossible future/past values are common in reproducible or scrubbed builds.
    if seconds == 0 {
        return None;
    }
    let ms = seconds as i128 * 1000;
    let max = chrono::Utc::now().timestamp_millis() as i128 + 366 * 24 * 60 * 60 * 1000;
    if ms < 315_532_800_000 || ms > max {
        return None;
    }
    chrono::DateTime::from_timestamp(seconds, 0).map(|d| d.format("%Y-%m-%dT%H:%M:%S.000Z").to_string())
}

const CP1252_HIGH: [u32; 32] = [0x20AC, 0x81, 0x201A, 0x192, 0x201E, 0x2026, 0x2020, 0x2021, 0x2C6, 0x2030, 0x160, 0x2039, 0x152, 0x8D, 0x17D, 0x8F, 0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x2DC, 0x2122, 0x161, 0x203A, 0x153, 0x9D, 0x17E, 0x178];

/// `TextDecoder("ascii")` is really windows-1252.
fn win1252(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from_u32(if (0x80..0xA0).contains(&b) { CP1252_HIGH[b as usize - 0x80] } else { b as u32 }).unwrap()).collect()
}

fn read_sections(r: &Reader, table: i64, count: i64) -> R<Vec<PeSection>> {
    if count > 512 {
        return Err(format!("Unreasonable PE section count: {count}"));
    }
    let mut sections = Vec::new();
    for i in 0..count {
        let at = table + i * 40;
        if !r.has(at, 40) {
            return Err("Section table is truncated".into());
        }
        let name_bytes = &r.bytes[at as usize..at as usize + 8];
        let zero = name_bytes.iter().position(|&b| b == 0).unwrap_or(8);
        let mut name = win1252(&name_bytes[..zero]);
        if name.is_empty() {
            name = format!("<section-{}>", i + 1);
        }
        let characteristics = r.u32(at + 36)?;
        let raw_offset = r.u32(at + 20)?;
        let raw_size = r.u32(at + 16)?;
        sections.push(PeSection {
            name,
            virtual_size: r.u32(at + 8)?,
            virtual_address: r.u32(at + 12)?,
            raw_size,
            raw_offset,
            characteristics,
            executable: characteristics & 0x20000000 != 0,
            readable: characteristics & 0x40000000 != 0,
            writable: characteristics & 0x80000000 != 0,
            entropy: entropy(r.bytes, raw_offset, raw_size),
        });
    }
    Ok(sections)
}

struct Image<'a> {
    r: Reader<'a>,
    sections: Vec<PeSection>,
    size_of_headers: i64,
}

impl Image<'_> {
    fn rva_to_offset(&self, rva: i64) -> Option<i64> {
        if rva == 0 {
            return None;
        }
        if rva < self.size_of_headers && self.r.has(rva, 1) {
            return Some(rva);
        }
        for s in &self.sections {
            let span = s.virtual_size.max(s.raw_size);
            if rva < s.virtual_address || rva >= s.virtual_address + span {
                continue;
            }
            let offset = s.raw_offset + (rva - s.virtual_address);
            return if self.r.has(offset, 1) { Some(offset) } else { None };
        }
        None
    }
}

#[derive(Clone, Copy, Default)]
struct DataDirectory {
    rva: i64,
    size: i64,
}

struct Thunks {
    functions: Vec<String>,
    ordinals: Vec<i64>,
    truncated: bool,
}

fn read_thunk_table(img: &Image, thunk_rva: i64, pe64: bool) -> R<Thunks> {
    let r = &img.r;
    let Some(at) = img.rva_to_offset(thunk_rva) else { return Ok(Thunks { functions: vec![], ordinals: vec![], truncated: false }) };
    let width: i64 = if pe64 { 8 } else { 4 };
    let ordinal_flag: u64 = if pe64 { 0x8000000000000000 } else { 0x80000000 };
    let address_mask: u64 = if pe64 { 0x7fffffffffffffff } else { 0x7fffffff };
    let mut out = Thunks { functions: vec![], ordinals: vec![], truncated: false };
    for i in 0..MAX_IMPORTS_PER_DLL as i64 {
        let pos = at + i * width;
        if !r.has(pos, width) {
            break;
        }
        let value = if pe64 { r.u64(pos)? } else { r.u32(pos)? as u64 };
        if value == 0 {
            break;
        }
        if value & ordinal_flag != 0 {
            out.ordinals.push((value & 0xffff) as i64);
            continue;
        }
        let name_rva = (value & address_mask) as i64;
        let Some(name_at) = img.rva_to_offset(name_rva) else { continue };
        if !r.has(name_at + 2, 1) {
            continue;
        }
        let name = r.ascii(name_at + 2, 2048);
        if !name.is_empty() {
            out.functions.push(name);
        }
        if i == MAX_IMPORTS_PER_DLL as i64 - 1 {
            out.truncated = true;
        }
    }
    Ok(out)
}

fn read_imports(img: &Image, dir: DataDirectory, pe64: bool, delay_loaded: bool, image_base: u64) -> R<(Vec<PeImport>, bool)> {
    let r = &img.r;
    let Some(start) = img.rva_to_offset(dir.rva) else { return Ok((vec![], false)) };
    if dir.size == 0 {
        return Ok((vec![], false));
    }
    let stride: i64 = if delay_loaded { 32 } else { 20 };
    let mut imports = Vec::new();
    let mut truncated = false;
    for i in 0..MAX_IMPORT_DLLS as i64 {
        let at = start + i * stride;
        if !r.has(at, stride) {
            break;
        }
        let mut values = Vec::new();
        for x in 0..stride / 4 {
            values.push(r.u32(at + x * 4)?);
        }
        if values.iter().all(|&v| v == 0) {
            break;
        }
        let (name_rva, thunk_rva);
        if delay_loaded {
            let attrs = values[0];
            let (mut n, mut t) = (values[1], values[4]);
            // Old delay descriptors store virtual addresses instead of RVAs.
            if attrs & 1 == 0 {
                let base = if image_base < (1u64 << 53) { image_base as i64 } else { 0 };
                n = (n - base).max(0);
                t = (t - base).max(0);
            }
            name_rva = n;
            thunk_rva = t;
        } else {
            name_rva = values[3];
            thunk_rva = if values[0] != 0 { values[0] } else { values[4] };
        }
        let dll = img.rva_to_offset(name_rva).map(|o| r.ascii(o, 1024)).unwrap_or_default();
        if dll.is_empty() {
            continue;
        }
        let t = read_thunk_table(img, thunk_rva, pe64)?;
        imports.push(PeImport { dll, functions: t.functions, ordinals: t.ordinals, truncated: t.truncated, delay_loaded });
        if i == MAX_IMPORT_DLLS as i64 - 1 {
            truncated = true;
        }
    }
    Ok((imports, truncated))
}

fn dedupe<T: Clone + std::hash::Hash + Eq>(items: impl IntoIterator<Item = T>) -> Vec<T> {
    let mut seen = HashSet::new();
    items.into_iter().filter(|x| seen.insert(x.clone())).collect()
}

fn merge_imports(items: Vec<PeImport>) -> Vec<PeImport> {
    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, PeImport> = HashMap::new();
    for item in items {
        let key = format!("{}{}", if item.delay_loaded { "delay:" } else { "normal:" }, item.dll.to_lowercase());
        match map.get_mut(&key) {
            None => {
                let merged = PeImport { functions: dedupe(item.functions.clone()), ordinals: dedupe(item.ordinals.clone()), ..item };
                map.insert(key.clone(), merged);
                order.push(key);
            }
            Some(old) => {
                old.functions = dedupe(old.functions.iter().cloned().chain(item.functions));
                old.ordinals = dedupe(old.ordinals.iter().copied().chain(item.ordinals));
                old.truncated |= item.truncated;
            }
        }
    }
    let mut out: Vec<PeImport> = order.into_iter().filter_map(|k| map.remove(&k)).collect();
    out.sort_by(|a, b| locale_cmp(&a.dll, &b.dll));
    out
}

fn read_exports(img: &Image, dir: DataDirectory) -> R<(Vec<PeExport>, bool)> {
    let r = &img.r;
    let empty = || Ok((vec![], false));
    let Some(at) = img.rva_to_offset(dir.rva) else { return empty() };
    if !r.has(at, 40) {
        return empty();
    }
    let ordinal_base = r.u32(at + 16)?;
    let function_count = r.u32(at + 20)?;
    let name_count = r.u32(at + 24)?;
    let functions_at = img.rva_to_offset(r.u32(at + 28)?);
    let names_at = img.rva_to_offset(r.u32(at + 32)?);
    let ordinals_at = img.rva_to_offset(r.u32(at + 36)?);
    let Some(functions_at) = functions_at else { return empty() };

    let mut names: HashMap<i64, String> = HashMap::new();
    let max_names = name_count.min(MAX_EXPORTS);
    if let (Some(names_at), Some(ordinals_at)) = (names_at, ordinals_at) {
        for i in 0..max_names {
            if !r.has(names_at + i * 4, 4) || !r.has(ordinals_at + i * 2, 2) {
                break;
            }
            let Some(name_at) = img.rva_to_offset(r.u32(names_at + i * 4)?) else { continue };
            let name = r.ascii(name_at, 4096);
            if !name.is_empty() {
                names.insert(r.u16(ordinals_at + i * 2)?, name);
            }
        }
    }
    let count = function_count.min(MAX_EXPORTS);
    let mut exports = Vec::new();
    for index in 0..count {
        if !r.has(functions_at + index * 4, 4) {
            break;
        }
        let function_rva = r.u32(functions_at + index * 4)?;
        if function_rva == 0 {
            continue;
        }
        let mut entry = PeExport { name: names.get(&index).cloned(), ordinal: ordinal_base + index, rva: function_rva, forwarder: None };
        if function_rva >= dir.rva
            && function_rva < dir.rva + dir.size
            && let Some(fwd) = img.rva_to_offset(function_rva)
        {
            let text = r.ascii(fwd, 2048);
            entry.forwarder = if text.is_empty() { None } else { Some(text) };
        }
        exports.push(entry);
    }
    Ok((exports, function_count > count || name_count > max_names))
}

fn read_pdb_paths(img: &Image, dir: DataDirectory) -> R<Vec<String>> {
    let r = &img.r;
    let Some(start) = img.rva_to_offset(dir.rva) else { return Ok(vec![]) };
    if dir.size < 28 {
        return Ok(vec![]);
    }
    let mut paths = Vec::new();
    let count = (dir.size / 28).min(256);
    for i in 0..count {
        let at = start + i * 28;
        if !r.has(at, 28) || r.u32(at + 12)? != 2 {
            continue; // IMAGE_DEBUG_TYPE_CODEVIEW
        }
        let size = r.u32(at + 16)?;
        let mut raw = r.u32(at + 24)?;
        if raw == 0 {
            raw = img.rva_to_offset(r.u32(at + 20)?).unwrap_or(0);
        }
        if !r.has(raw, size.min(24)) || size < 24 {
            continue;
        }
        let sig = &r.bytes[raw as usize..raw as usize + 4];
        let path_offset = if sig == b"RSDS" { raw + 24 } else if sig == b"NB10" { raw + 16 } else { 0 };
        if path_offset == 0 {
            continue;
        }
        let found = r.ascii(path_offset, 32_768.min(size));
        if !found.is_empty() {
            paths.push(found);
        }
    }
    Ok(dedupe(paths))
}

/// Finds `needle` at or after `from`, like Buffer.indexOf.
pub fn find_bytes(h: &[u8], n: &[u8], from: usize) -> Option<usize> {
    if n.is_empty() || from > h.len() || n.len() > h.len() {
        return None;
    }
    let mut i = from;
    while i + n.len() <= h.len() {
        let p = h[i..=h.len() - n.len()].iter().position(|&b| b == n[0])?;
        let at = i + p;
        if &h[at..at + n.len()] == n {
            return Some(at);
        }
        i = at + 1;
    }
    None
}

fn utf16_bytes(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(|c| c.to_le_bytes()).collect()
}

fn js_trim(s: &str) -> String {
    let w: Wide = s.encode_utf16().collect();
    let start = w.iter().position(|&c| !is_js_space(c)).unwrap_or(w.len());
    let end = w.iter().rposition(|&c| !is_js_space(c)).map_or(start, |p| p + 1);
    wide_lossy(&w[start..end])
}

/// `(x) & ~3` as JavaScript computes it, through a signed 32-bit integer.
fn align4(x: i64) -> i64 {
    ((x as i32) & !3) as i64
}

fn read_version_info(r: &Reader) -> VersionInfo {
    let mut out = Vec::new();
    for key in ["CompanyName", "FileDescription", "FileVersion", "InternalName", "LegalCopyright", "OriginalFilename", "ProductName", "ProductVersion"] {
        let needle = utf16_bytes(&format!("{key}\0"));
        let mut at = find_bytes(r.bytes, &needle, 0);
        while let Some(a) = at {
            let block = a as i64 - 6;
            if block >= 0 && r.has(block, 6) {
                let total = r.u16(block).unwrap_or(0);
                let value_chars = r.u16(block + 2).unwrap_or(0);
                let kind = r.u16(block + 4).unwrap_or(0);
                let value_at = align4(a as i64 + needle.len() as i64 + 3);
                if kind == 1 && value_chars > 0 && value_chars < 4096 && value_at < block + total {
                    let value = js_trim(&r.utf16(value_at, value_chars));
                    if !value.is_empty() {
                        out.push((key.to_string(), value));
                        break;
                    }
                }
            }
            at = find_bytes(r.bytes, &needle, a + 2);
        }
    }
    VersionInfo(out)
}

fn ix(rows: &[i64], table: usize) -> i64 {
    if rows[table] >= 0x10000 { 4 } else { 2 }
}

fn coded(rows: &[i64], tables: &[usize], tag_bits: u32) -> i64 {
    let max = tables.iter().map(|&t| rows[t]).fold(0, i64::max);
    if max < 1 << (16 - tag_bits) { 2 } else { 4 }
}

/// Row sizes for ECMA-335 metadata tables 0..44.
fn metadata_row_size(table: usize, rows: &[i64], s: i64, guid: i64, blob: i64) -> i64 {
    let c = |t: &[usize], b: u32| coded(rows, t, b);
    let type_def_or_ref = c(&[2, 1, 27], 2);
    let method_def_or_ref = c(&[6, 10], 1);
    match table {
        0 => 2 + s + guid * 3,
        1 => c(&[0, 26, 35, 1], 2) + s * 2,
        2 => 4 + s * 2 + type_def_or_ref + ix(rows, 4) + ix(rows, 6),
        3 => ix(rows, 4),
        4 => 2 + s + blob,
        5 => ix(rows, 6),
        6 => 8 + s + blob + ix(rows, 8),
        7 => ix(rows, 8),
        8 => 4 + s,
        9 => ix(rows, 2) + type_def_or_ref,
        10 => c(&[2, 1, 26, 6, 27], 3) + s + blob,
        11 => 2 + c(&[4, 8, 23], 2) + blob,
        12 => c(&[6, 4, 1, 2, 8, 9, 10, 0, 14, 23, 20, 17, 26, 27, 32, 35, 38, 39, 40, 42, 44], 5) + c(&[6, 10], 3) + blob,
        13 => c(&[4, 8], 1) + blob,
        14 => 2 + c(&[2, 6, 32], 2) + blob,
        15 => 6 + ix(rows, 2),
        16 => 4 + ix(rows, 4),
        17 => blob,
        18 => ix(rows, 2) + ix(rows, 20),
        19 => ix(rows, 20),
        20 => 2 + s + type_def_or_ref,
        21 => ix(rows, 2) + ix(rows, 23),
        22 => ix(rows, 23),
        23 => 2 + s + blob,
        24 => 2 + ix(rows, 6) + c(&[20, 23], 1),
        25 => ix(rows, 2) + method_def_or_ref * 2,
        26 => s,
        27 => blob,
        28 => 2 + c(&[4, 6], 1) + s + ix(rows, 26),
        29 => 4 + ix(rows, 4),
        30 => 8,
        31 => 4,
        32 => 16 + blob + s * 2,
        33 => 4,
        34 => 12,
        35 => 12 + blob * 2 + s * 2,
        36 => 4 + ix(rows, 35),
        37 => 12 + ix(rows, 35),
        38 => 4 + s + blob,
        39 => 8 + s * 2 + c(&[38, 35, 39], 2),
        40 => 8 + s + c(&[38, 35, 39], 2),
        41 => ix(rows, 2) * 2,
        42 => 4 + c(&[2, 6], 1) + s,
        43 => method_def_or_ref + blob,
        44 => ix(rows, 42) + type_def_or_ref,
        _ => 0,
    }
}

fn heap_index(r: &Reader, at: i64, size: i64) -> R<i64> {
    if size == 4 { r.u32(at) } else { r.u16(at) }
}

fn read_managed_metadata(img: &Image, clr: DataDirectory) -> R<Option<ManagedAssembly>> {
    let r = &img.r;
    let Some(clr_at) = img.rva_to_offset(clr.rva) else { return Ok(None) };
    if !r.has(clr_at, 24) {
        return Ok(None);
    }
    let flags = r.u32(clr_at + 16)?;
    let bare = |runtime_version: Option<String>| Ok(Some(ManagedAssembly { name: None, version: None, runtime_version, flags, references: vec![] }));
    let metadata_at = img.rva_to_offset(r.u32(clr_at + 8)?);
    let Some(metadata_at) = metadata_at.filter(|&m| r.has(m, 20) && r.u32(m).unwrap_or(0) == 0x424a5342) else { return bare(None) };

    let version_len = r.u32(metadata_at + 12)?;
    let runtime_version = if r.has(metadata_at + 16, version_len) {
        let raw = String::from_utf8_lossy(&r.bytes[(metadata_at + 16) as usize..(metadata_at + 16 + version_len) as usize]).to_string();
        Some(js_trim(&cut_at_nul(&raw)))
    } else {
        None
    };
    let mut at = align4(metadata_at + 16 + version_len + 3);
    if !r.has(at, 4) {
        return bare(runtime_version);
    }
    let streams = r.u16(at + 2)?;
    at += 4;
    let mut stream_map: HashMap<String, (i64, i64)> = HashMap::new();
    for _ in 0..streams {
        if !r.has(at, 8) {
            break;
        }
        let offset = r.u32(at)?;
        let size = r.u32(at + 4)?;
        let name = r.ascii(at + 8, 32);
        let name_bytes = 32.min(name.len() as i64 + 1);
        at = align4(at + 8 + name_bytes + 3);
        stream_map.insert(name, (metadata_at + offset, size));
    }
    let table = stream_map.get("#~").or_else(|| stream_map.get("#-")).copied();
    let strings = stream_map.get("#Strings").copied();
    let (Some(table), Some(strings)) = (table, strings) else { return bare(runtime_version) };
    if !r.has(table.0, 24) {
        return bare(runtime_version);
    }
    let heap_sizes = r.u8(table.0 + 6)?;
    let str_size = if heap_sizes & 1 != 0 { 4 } else { 2 };
    let guid_size = if heap_sizes & 2 != 0 { 4 } else { 2 };
    let blob_size = if heap_sizes & 4 != 0 { 4 } else { 2 };
    let valid = r.u64(table.0 + 8)?;
    let mut rows = vec![0i64; 64];
    let mut row_at = table.0 + 24;
    for i in 0..64 {
        if valid & (1u64 << i) == 0 {
            continue;
        }
        if !r.has(row_at, 4) {
            break;
        }
        rows[i] = r.u32(row_at)?;
        row_at += 4;
    }
    let mut offsets = vec![-1i64; 64];
    let mut data_at = row_at;
    for i in 0..64 {
        if valid & (1u64 << i) == 0 {
            continue;
        }
        offsets[i] = data_at;
        let size = metadata_row_size(i, &rows, str_size, guid_size, blob_size);
        if size == 0 {
            return bare(runtime_version);
        }
        data_at += size * rows[i];
    }
    let get_string = |index: i64| if index > 0 && index < strings.1 { r.ascii(strings.0 + index, 16_384.min(strings.1 - index)) } else { String::new() };

    let (mut name, mut version) = (None, None);
    if rows[32] != 0 && offsets[32] >= 0 {
        let p = offsets[32];
        version = Some(format!("{}.{}.{}.{}", r.u16(p + 4)?, r.u16(p + 6)?, r.u16(p + 8)?, r.u16(p + 10)?));
        let s = get_string(heap_index(r, p + 16 + blob_size, str_size)?);
        name = if s.is_empty() { None } else { Some(s) };
    }
    let mut references = Vec::new();
    if rows[35] != 0 && offsets[35] >= 0 {
        let size = metadata_row_size(35, &rows, str_size, guid_size, blob_size);
        for i in 0..rows[35].min(20_000) {
            let p = offsets[35] + i * size;
            if !r.has(p, size) {
                break;
            }
            let version = format!("{}.{}.{}.{}", r.u16(p)?, r.u16(p + 2)?, r.u16(p + 4)?, r.u16(p + 6)?);
            let flags = r.u32(p + 8)?;
            let name = get_string(heap_index(r, p + 12 + blob_size, str_size)?);
            if !name.is_empty() {
                references.push(ManagedRef { name, version, flags });
            }
        }
    }
    Ok(Some(ManagedAssembly { name, version, runtime_version, flags, references }))
}

/// `.replace(/\0.*$/, "")`: cuts from the first NUL whose rest of the text has no line break.
fn cut_at_nul(s: &str) -> String {
    for (i, c) in s.char_indices() {
        if c == '\0' && !s[i..].contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
            return s[..i].to_string();
        }
    }
    s.to_string()
}

// ---- strings ----

static RE_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i-u)https?://").unwrap());
static RE_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i-u)([a-z]:\\|/)[\w .\\/-]+").unwrap());
static RE_FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i-u)\.(dll|exe|sys|pdb|json|config|xml|ini|db|sqlite)\b").unwrap());
static RE_WORDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i-u)error|failed|exception|warning|password|token|secret|debug").unwrap());
static RE_IDENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?-u)^[A-Za-z_?$@][\w?$@.:<>~-]{5,}$").unwrap());
static RE_ALNUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z0-9]").unwrap());

fn string_score(value: &[u16]) -> i64 {
    let text = wide_lossy(value);
    let mut score = value.len().min(160) as i64;
    if RE_URL.is_match(&text) {
        score += 220;
    }
    if RE_PATH.is_match(&text) {
        score += 100;
    }
    if RE_FILE.is_match(&text) {
        score += 80;
    }
    if RE_WORDS.is_match(&text) {
        score += 70;
    }
    if RE_IDENT.is_match(&text) {
        score += 25;
    }
    // A blob read on the wrong alignment decodes as CJK look-alikes: demote text with no alphanumerics or extreme repetition.
    if !RE_ALNUM.is_match(&text) {
        score = (score as f64 * 0.2).floor() as i64;
    }
    if value.len() >= 8 {
        let mut unique = HashSet::new();
        let mut i = 0;
        while i < value.len() {
            let c = value[i] as u32;
            if (0xD800..0xDC00).contains(&c) && i + 1 < value.len() && (0xDC00..0xE000).contains(&(value[i + 1] as u32)) {
                unique.insert(0x10000 + ((c - 0xD800) << 10) + (value[i + 1] as u32 - 0xDC00));
                i += 1;
            } else {
                unique.insert(c);
            }
            i += 1;
        }
        if (unique.len() as f64) / (value.len() as f64) < 0.3 {
            score = (score as f64 * 0.25).floor() as i64;
        }
    }
    score
}

const MAX_CANDIDATES: usize = 20_000;

/// Candidate strings with their scores, in the order they were first seen (a JavaScript Map).
struct Collector {
    min: usize,
    filter: String,
    index: HashMap<Wide, usize>,
    items: Vec<Option<(Wide, i64)>>,
    live: usize,
    floor: i64,
}

impl Collector {
    fn consider(&mut self, value: &[u16]) {
        let clean = collapse_space(value);
        if clean.len() < self.min || clean.len() > 4096 {
            return;
        }
        if !self.filter.is_empty() && !wide_lossy(&clean).to_lowercase().contains(&self.filter) {
            return;
        }
        let score = string_score(&clean);
        if let Some(&i) = self.index.get(&clean) {
            if let Some((_, old)) = &mut self.items[i]
                && score > *old
            {
                *old = score;
            }
            return;
        }
        let capped = self.filter.is_empty();
        if capped && self.live >= MAX_CANDIDATES {
            if score <= self.floor {
                return;
            }
            if let Some(pos) = self.items.iter().position(|e| matches!(e, Some((_, s)) if *s == self.floor)) {
                let (key, _) = self.items[pos].take().unwrap();
                self.index.remove(&key);
                self.live -= 1;
            }
        }
        self.index.insert(clean.clone(), self.items.len());
        self.items.push(Some((clean, score)));
        self.live += 1;
        if capped && self.live >= MAX_CANDIDATES {
            self.floor = self.items.iter().flatten().map(|(_, s)| *s).min().unwrap_or(i64::MAX);
        }
    }
}

/// The ranked "selected strings": ASCII runs plus both UTF-16LE alignments, best first.
pub fn extract_strings(bytes: &[u8], o: &StringOptions) -> (Vec<Wide>, bool) {
    if o.include_strings == Some(false) {
        return (vec![], false);
    }
    let min = clamp_number(o.min_string_length, 6.0, 4.0, 64.0) as usize;
    let max = clamp_number(o.max_strings, 160.0, 1.0, MAX_REPORTED_STRINGS) as usize;
    let filter = o.string_filter.as_deref().map(|s| js_trim(s).to_lowercase()).unwrap_or_default();
    let mut c = Collector { min, filter, index: HashMap::new(), items: Vec::new(), live: 0, floor: 0 };

    let mut ascii: Wide = Vec::new();
    for &b in bytes {
        if (0x20..=0x7e).contains(&b) {
            ascii.push(b as u16);
            // Long runs are split into bounded excerpts instead of one giant string.
            if ascii.len() == 4096 {
                c.consider(&ascii);
                ascii.clear();
            }
        } else {
            if ascii.len() >= min {
                c.consider(&ascii);
            }
            ascii.clear();
        }
    }
    if ascii.len() >= min {
        c.consider(&ascii);
    }

    // Even and odd offsets are separate streams; neither may hide the other.
    for parity in [0usize, 1] {
        let mut i = parity;
        while i + 1 < bytes.len() {
            let mut value: Wide = Vec::new();
            let mut j = i;
            while j + 1 < bytes.len() && value.len() < 4096 {
                let code = bytes[j] as u16 | (bytes[j + 1] as u16) << 8;
                if code >= 0x20 && code != 0x7f && code <= 0xfffd {
                    value.push(code);
                    j += 2;
                } else {
                    break;
                }
            }
            if value.len() >= min {
                c.consider(&value);
                i = j.max(i + 2);
            } else {
                i += 2;
            }
        }
    }

    let mut ranked: Vec<(Wide, i64)> = c.items.into_iter().flatten().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| locale_cmp(&wide_lossy(&a.0), &wide_lossy(&b.0))));
    let truncated = ranked.len() > max;
    (ranked.into_iter().take(max).map(|(s, _)| s).collect(), truncated)
}

static RE_DYN: LazyLock<regex::bytes::Regex> = LazyLock::new(|| regex::bytes::Regex::new(r"(?i-u)(?:^|[^A-Za-z0-9_.-])([A-Za-z0-9_.+-]{1,120}\.(?:dll|ocx|drv))\b").unwrap());

/// DLL names that appear in strings but not in the import table.
pub fn dynamic_libraries(strings: &[Wide], imported: &[PeImport]) -> Vec<String> {
    let statically: HashSet<String> = imported.iter().map(|x| x.dll.to_lowercase()).collect();
    let mut out: Vec<String> = Vec::new();
    for value in strings {
        let text = wide_lossy(value);
        for m in RE_DYN.captures_iter(text.as_bytes()) {
            let name = String::from_utf8_lossy(&m[1]).to_string();
            if !statically.contains(&name.to_lowercase()) && !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out.sort_by(|a, b| locale_cmp(a, b));
    out
}

fn highlight_imports(imports: &[PeImport]) -> Vec<HighlightedImport> {
    const INJECT: &str = "process injection/memory";
    const LOADING: &str = "library loading/API resolution";
    const CREATE: &str = "process creation";
    let exact = |name: &str| -> Option<&'static str> {
        Some(match name {
            "createremotethread" | "createremotethreadex" | "writeprocessmemory" | "readprocessmemory" | "virtualallocex" | "virtualprotectex" | "openprocess" | "ntwritevirtualmemory" | "ntreadvirtualmemory" | "ntmapviewofsection" | "queueuserapc" | "setthreadcontext" | "resumethread" => INJECT,
            "loadlibrarya" | "loadlibraryw" | "loadlibraryexa" | "loadlibraryexw" | "getprocaddress" | "ldrloaddll" | "ldrgetprocedureaddress" => LOADING,
            "createprocessa" | "createprocessw" | "createprocessasusera" | "createprocessasuserw" | "createprocesswithtokenw" | "createprocesswithlogonw" | "ntcreateuserprocess" | "shellexecutea" | "shellexecutew" | "winexec" => CREATE,
            _ => return None,
        })
    };
    let mut out = Vec::new();
    for item in imports {
        for f in &item.functions {
            let lower = f.to_lowercase();
            let lua = lower.strip_prefix("lua").is_some_and(|rest| rest.strip_prefix('l').unwrap_or(rest).starts_with('_'));
            let category = if lua { Some("Lua API") } else { exact(&lower) };
            if let Some(category) = category {
                out.push(HighlightedImport { dll: item.dll.clone(), function: f.clone(), category, delay_loaded: item.delay_loaded });
            }
        }
    }
    out
}

static PACKER_MARKERS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [(r"(?i-u)\bUPX[0-9!]?\b", "UPX"), (r"(?i-u)\.aspack|ASPack", "ASPack"), (r"(?i-u)MPRESS", "MPRESS"), (r"(?i-u)Themida|WinLicense", "Themida/WinLicense"), (r"(?i-u)VMProtect", "VMProtect"), (r"(?i-u)\.petite|Petite", "Petite")]
        .into_iter()
        .map(|(p, n)| (Regex::new(p).unwrap(), n))
        .collect()
});

fn in_section(s: &PeSection, rva: i64) -> bool {
    rva >= s.virtual_address && rva < s.virtual_address + s.virtual_size.max(s.raw_size)
}

fn assess_packing(sections: &[PeSection], imports: &[PeImport], strings: &[Wide], entry_point_rva: i64, overlay_bytes: i64) -> Packing {
    let mut score = 0i64;
    let mut reasons: Vec<String> = Vec::new();
    let mut known_packer = None;
    let joined_names = sections.iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(" ");
    let joined_strings = strings.iter().take(1000).map(|s| wide_lossy(s)).collect::<Vec<_>>().join("\n");
    for (pattern, name) in PACKER_MARKERS.iter() {
        if pattern.is_match(&joined_names) || pattern.is_match(&joined_strings) {
            known_packer = Some(name.to_string());
            score += 70;
            reasons.push(format!("Known packer marker detected: {name}."));
            break;
        }
    }
    let high: Vec<&PeSection> = sections.iter().filter(|s| s.raw_size >= 4096 && s.entropy >= 7.2).collect();
    if high.len() >= 2 {
        score += 25;
        reasons.push(format!("{} sections have entropy at or above 7.2.", high.len()));
    } else if high.len() == 1 {
        score += 12;
        reasons.push(format!("{} has entropy {}.", high[0].name, js_num(high[0].entropy)));
    }
    if let Some(entry) = sections.iter().find(|s| in_section(s, entry_point_rva))
        && entry.entropy >= 7.2
    {
        score += 18;
        reasons.push(format!("The entry point is in high-entropy section {}.", entry.name));
    }
    if sections.iter().any(|s| s.virtual_size > 64 * 1024 && s.raw_size == 0) {
        score += 20;
        reasons.push("A large virtual section has no raw bytes, a common unpacking destination.".into());
    }
    let imported: usize = imports.iter().map(|i| i.functions.len() + i.ordinals.len()).sum();
    if imported <= 5 {
        score += 14;
        reasons.push(format!("Only {imported} static import(s) were recovered."));
    }
    if overlay_bytes >= 1024 * 1024 {
        score += 10;
        reasons.push(format!("{} overlay bytes may hold a packed payload or installer data.", group(overlay_bytes)));
    }
    let score = score.min(100);
    if reasons.is_empty() {
        reasons.push("No common packer markers or strong structural packing indicators were found.".into());
    }
    let status = if score >= 65 { "likely" } else if score >= 30 { "possible" } else { "unlikely" };
    Packing { status: status.into(), score, reasons, known_packer }
}

fn imphash(imports: &[PeImport]) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for item in imports.iter().filter(|x| !x.delay_loaded) {
        let lower = item.dll.to_lowercase();
        let dll = ["dll", "sys", "ocx"].iter().find_map(|e| lower.strip_suffix(&format!(".{e}"))).unwrap_or(&lower);
        parts.extend(item.functions.iter().map(|f| format!("{dll}.{}", f.to_lowercase())));
        parts.extend(item.ordinals.iter().map(|o| format!("{dll}.ord{o}")));
    }
    if parts.is_empty() { None } else { Some(md5_hex(parts.join(",").as_bytes())) }
}

/// A file that is not a PE still gets this shape: hashes, strings, and empty PE-only layers.
#[allow(clippy::too_many_arguments)]
pub fn non_pe_inspection(bytes: &[u8], format: &str, architecture: &str, subsystem: &str, opts: &StringOptions, packing_reason: &str, indicators: Vec<String>, packing_status: &str, find_dynamic: bool) -> PeInspection {
    let hashes = hash_bytes(bytes);
    let (strings, truncated) = extract_strings(bytes, opts);
    let dynamic = if find_dynamic { dynamic_libraries(&strings, &[]) } else { vec![] };
    PeInspection {
        format: format.into(),
        architecture: architecture.into(),
        machine: 0,
        bytes: bytes.len() as i64,
        hashes,
        timestamp: 0,
        timestamp_iso: None,
        characteristics: 0,
        is_dll: false,
        subsystem: subsystem.into(),
        image_base: "0x0".into(),
        entry_point_rva: 0,
        size_of_image: 0,
        sections: vec![],
        imports: vec![],
        exports: vec![],
        managed: None,
        authenticode: Authenticode { present: false, size: 0, revision: None, certificate_type: None, verified: false },
        pdb_paths: vec![],
        version_info: VersionInfo::default(),
        strings,
        possible_dynamic_libraries: dynamic,
        highlighted_imports: vec![],
        overlay_bytes: 0,
        packing: Packing { status: packing_status.into(), score: 0, reasons: vec![packing_reason.into()], known_packer: None },
        mitigations: Mitigations { aslr: false, high_entropy_va: false, dep: false, control_flow_guard: false, force_integrity: false, pe_order: false },
        indicators,
        truncated: Truncated { imports: false, exports: false, strings: truncated },
    }
}

/// Parses one PE file from bytes. Errors carry the web's wording; a missing MZ header makes the caller fall back to the generic path.
pub fn inspect_portable_executable(input: &[u8], opts: &StringOptions) -> R<PeInspection> {
    if input.len() as u64 > MAX_BINARY_ANALYSIS_BYTES {
        return Err(format!("Executable is {}MB; static analysis is capped at {}MB.", to_fixed(input.len() as f64 / 1024.0 / 1024.0, 1), MAX_BINARY_ANALYSIS_BYTES / 1024 / 1024));
    }
    let r = Reader { bytes: input };
    if !r.has(0, 64) || r.u16(0)? != 0x5a4d {
        return Err("Not a Windows executable: missing MZ header".into());
    }
    let mut hashes = hash_bytes(input);
    let pe_at = r.u32(0x3c)?;
    if !r.has(pe_at, 4) {
        return Err("MZ header points outside the file".into());
    }
    let signature = &input[pe_at as usize..pe_at as usize + 2];
    if !r.has(pe_at, 24) || r.u32(pe_at)? != 0x00004550 {
        let legacy = match signature {
            b"NE" => "DOS/NE",
            b"LE" => "DOS/LE",
            b"LX" => "DOS/LX",
            _ => "DOS/MZ",
        };
        let mut p = non_pe_inspection(input, legacy, "legacy DOS/Windows", "legacy", opts, "Legacy executable format: PE packing heuristics do not apply.", vec!["Legacy MZ executable: modern PE import/decompile metadata is unavailable.".into()], "unknown", true);
        p.hashes = hashes;
        return Ok(p);
    }

    let coff = pe_at + 4;
    let machine = r.u16(coff)?;
    let section_count = r.u16(coff + 2)?;
    let timestamp = r.u32(coff + 4)?;
    let optional_size = r.u16(coff + 16)?;
    let characteristics = r.u16(coff + 18)?;
    let optional = coff + 20;
    if !r.has(optional, optional_size) || optional_size < 96 {
        return Err("PE optional header is truncated".into());
    }
    let magic = r.u16(optional)?;
    let pe64 = magic == 0x20b;
    if !pe64 && magic != 0x10b {
        return Err(format!("Unsupported PE optional-header magic 0x{magic:x}"));
    }
    let data_start = optional + if pe64 { 112 } else { 96 };
    let directory_count_at = optional + if pe64 { 108 } else { 92 };
    let directory_count = r.u32(directory_count_at)?.min(16);
    let mut directories = [DataDirectory::default(); 16];
    for (i, d) in directories.iter_mut().enumerate() {
        if (i as i64) < directory_count && r.has(data_start + i as i64 * 8, 8) {
            *d = DataDirectory { rva: r.u32(data_start + i as i64 * 8)?, size: r.u32(data_start + i as i64 * 8 + 4)? };
        }
    }

    let size_of_headers = r.u32(optional + 60)?;
    let sections = read_sections(&r, optional + optional_size, section_count)?;
    let image_base = if pe64 { r.u64(optional + 24)? } else { r.u32(optional + 28)? as u64 };
    let img = Image { r: Reader { bytes: input }, sections, size_of_headers };
    let (normal, normal_truncated) = read_imports(&img, directories[1], pe64, false, image_base)?;
    let (delayed, delayed_truncated) = read_imports(&img, directories[13], pe64, true, image_base)?;
    let imports = merge_imports(normal.into_iter().chain(delayed).collect());
    let (exports, exports_truncated) = read_exports(&img, directories[0])?;
    let (strings, strings_truncated) = extract_strings(input, opts);
    let managed = if directories[14].rva != 0 { read_managed_metadata(&img, directories[14])? } else { None };

    let security = directories[4]; // Unlike every other directory, rva is a file offset.
    let (mut revision, mut certificate_type) = (None, None);
    if security.rva != 0 && security.size >= 8 && r.has(security.rva, 8) {
        revision = Some(r.u16(security.rva + 4)?);
        certificate_type = Some(r.u16(security.rva + 6)?);
    }

    let dll_characteristics = r.u16(optional + 70)?;
    let entry_point_rva = r.u32(optional + 16)?;
    let sections = &img.sections;
    let mut indicators: Vec<String> = Vec::new();
    for s in sections {
        if s.executable && s.writable {
            indicators.push(format!("{} is writable and executable (RWX).", s.name));
        }
        if s.entropy >= 7.2 && s.raw_size >= 4096 {
            indicators.push(format!("{} has high entropy ({}); it may be compressed, encrypted, or simply contain dense assets.", s.name, js_num(s.entropy)));
        }
    }
    let entry_section = sections.iter().find(|s| in_section(s, entry_point_rva));
    if entry_point_rva != 0 && entry_section.is_none() {
        indicators.push("Entry point does not fall inside a declared section.".into());
    } else if let Some(s) = entry_section.filter(|s| !s.executable) {
        indicators.push(format!("Entry point is inside non-executable section {}.", s.name));
    }
    if timestamp != 0 && format_timestamp(timestamp).is_none() {
        indicators.push(format!("COFF timestamp {timestamp} is outside a plausible build-date range."));
    }
    if imports.is_empty() {
        indicators.push("No static imports were found; the file may be packed, very small, or resolve APIs dynamically.".into());
    }
    if security.rva != 0 && !r.has(security.rva, security.size.min(8)) {
        indicators.push("Authenticode directory points outside the file.".into());
    }

    let max_section_end = sections.iter().fold(size_of_headers, |m, s| m.max(s.raw_offset + s.raw_size));
    // A certificate is an overlay by PE design, so count it as explained.
    let explained_end = if security.rva != 0 && security.size != 0 { max_section_end.max(security.rva + security.size) } else { max_section_end };
    let len = input.len() as i64;
    let overlay_bytes = (len - len.min(explained_end)).max(0);
    if overlay_bytes > 1024 {
        indicators.push(format!("{overlay_bytes} byte(s) follow the mapped image/certificate (overlay or appended payload)."));
    }

    let packing = assess_packing(sections, &imports, &strings, entry_point_rva, overlay_bytes);
    hashes.imphash = imphash(&imports);
    Ok(PeInspection {
        format: if pe64 { "PE32+" } else { "PE32" }.into(),
        architecture: machine_name(machine),
        machine,
        bytes: len,
        hashes,
        timestamp,
        timestamp_iso: format_timestamp(timestamp),
        characteristics,
        is_dll: characteristics & 0x2000 != 0,
        subsystem: subsystem_name(r.u16(optional + 68)?),
        image_base: format!("0x{image_base:x}"),
        entry_point_rva,
        size_of_image: r.u32(optional + 56)?,
        pdb_paths: read_pdb_paths(&img, directories[6])?,
        version_info: read_version_info(&r),
        possible_dynamic_libraries: dynamic_libraries(&strings, &imports),
        highlighted_imports: highlight_imports(&imports),
        truncated: Truncated { imports: normal_truncated || delayed_truncated || imports.iter().any(|x| x.truncated), exports: exports_truncated, strings: strings_truncated },
        sections: img.sections.clone(),
        imports,
        exports,
        managed,
        authenticode: Authenticode { present: security.rva != 0 && security.size >= 8, size: security.size, revision, certificate_type, verified: false },
        strings,
        overlay_bytes,
        packing,
        mitigations: Mitigations {
            high_entropy_va: dll_characteristics & 0x0020 != 0,
            aslr: dll_characteristics & 0x0040 != 0,
            force_integrity: dll_characteristics & 0x0080 != 0,
            dep: dll_characteristics & 0x0100 != 0,
            control_flow_guard: dll_characteristics & 0x4000 != 0,
            pe_order: true,
        },
        indicators,
    })
}

/// Hand-assembled PE images for the tests of every file in this module.
#[cfg(test)]
pub(crate) mod samples {
    fn put(buf: &mut Vec<u8>, at: usize, bytes: &[u8]) {
        if buf.len() < at + bytes.len() {
            buf.resize(at + bytes.len(), 0);
        }
        buf[at..at + bytes.len()].copy_from_slice(bytes);
    }
    fn u16le(buf: &mut Vec<u8>, at: usize, v: u16) {
        put(buf, at, &v.to_le_bytes());
    }
    fn u32le(buf: &mut Vec<u8>, at: usize, v: u32) {
        put(buf, at, &v.to_le_bytes());
    }
    fn wide(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|c| c.to_le_bytes()).collect()
    }
    /// Deterministic noise: entropy close to 8.
    pub fn noise(n: usize, seed: u32) -> Vec<u8> {
        let mut x = seed.max(1);
        (0..n).map(|_| { x ^= x << 13; x ^= x >> 17; x ^= x << 5; (x >> 8) as u8 }).collect()
    }
    #[allow(clippy::too_many_arguments)]
    fn section(buf: &mut Vec<u8>, at: usize, name: &str, vsize: u32, rva: u32, rsize: u32, raw: u32, flags: u32) {
        put(buf, at, name.as_bytes());
        u32le(buf, at + 8, vsize);
        u32le(buf, at + 12, rva);
        u32le(buf, at + 16, rsize);
        u32le(buf, at + 20, raw);
        u32le(buf, at + 36, flags);
    }

    /// A PE32+ x86-64 console program: three imports DLLs (one delay-loaded), exports, version info, a PDB path,
    /// a certificate in the middle of its overlay, an encrypted-looking section and an overlay holding a ZIP and a PNG.
    pub fn pe64() -> Vec<u8> {
        let mut b = vec![0u8; 0x400];
        put(&mut b, 0, b"MZ");
        u32le(&mut b, 0x3c, 0x80);
        put(&mut b, 0x80, b"PE\0\0");
        u16le(&mut b, 0x84, 0x8664);
        u16le(&mut b, 0x86, 4); // sections
        u32le(&mut b, 0x88, 1_600_000_000);
        u16le(&mut b, 0x94, 240);
        u16le(&mut b, 0x96, 0x0022);
        let o = 0x98;
        u16le(&mut b, o, 0x20b);
        u32le(&mut b, o + 16, 0x1000);
        put(&mut b, o + 24, &0x1_4000_0000u64.to_le_bytes());
        u32le(&mut b, o + 32, 0x1000);
        u32le(&mut b, o + 36, 0x200);
        u32le(&mut b, o + 56, 0x5000);
        u32le(&mut b, o + 60, 0x400);
        u16le(&mut b, o + 68, 3);
        u16le(&mut b, o + 70, 0x8160 | 0x4000);
        u32le(&mut b, o + 108, 16);
        let dirs = o + 112;
        // .rdata at rva 0x2000, file 0x600
        let (rd, rd_raw) = (0x2000u32, 0x600usize);
        let at = |rva: u32| rd_raw + (rva - rd) as usize;
        u32le(&mut b, dirs + 8, 0x2000); // import directory
        u32le(&mut b, dirs + 12, 60);
        u32le(&mut b, dirs, 0x2200); // export directory
        u32le(&mut b, dirs + 4, 0x80);
        u32le(&mut b, dirs + 6 * 8, 0x2400); // debug
        u32le(&mut b, dirs + 6 * 8 + 4, 28);
        u32le(&mut b, dirs + 13 * 8, 0x2480); // delay imports
        u32le(&mut b, dirs + 13 * 8 + 4, 64);
        // sections
        section(&mut b, 0x188, ".text", 0x200, 0x1000, 0x200, 0x400, 0x6000_0020);
        section(&mut b, 0x188 + 40, ".rdata", 0x800, 0x2000, 0x800, 0x600, 0x4000_0040);
        section(&mut b, 0x188 + 80, ".data", 0x200, 0x3000, 0x200, 0xe00, 0xC000_0040);
        section(&mut b, 0x188 + 120, ".enc", 0x400, 0x4000, 0x400, 0x1000, 0x4000_0040);
        b.resize(0x1400, 0);
        put(&mut b, 0x400, &[0xCC; 16]);
        // imports: kernel32 (named), user32 (ordinal only)
        for (i, (name_rva, int_rva, iat_rva)) in [(0x2100u32, 0x2140u32, 0x2180u32), (0x2110, 0x21c0, 0x21d0)].into_iter().enumerate() {
            let d = at(0x2000) + i * 20;
            u32le(&mut b, d, int_rva);
            u32le(&mut b, d + 12, name_rva);
            u32le(&mut b, d + 16, iat_rva);
        }
        put(&mut b, at(0x2100), b"KERNEL32.dll\0");
        put(&mut b, at(0x2110), b"user32.dll\0");
        let names = ["GetProcAddress", "LoadLibraryA", "CreateProcessW", "ExitProcess"];
        for (i, n) in names.iter().enumerate() {
            let hint = 0x2300 + (i as u32) * 0x20;
            put(&mut b, at(0x2140) + i * 8, &(hint as u64).to_le_bytes());
            put(&mut b, at(hint) + 2, n.as_bytes());
        }
        put(&mut b, at(0x21c0), &(0x8000000000000000u64 | 7).to_le_bytes());
        // exports: alpha, beta (ordinal base 1), plus a forwarder
        let e = at(0x2200);
        u32le(&mut b, e + 16, 1);
        u32le(&mut b, e + 20, 3);
        u32le(&mut b, e + 24, 2);
        u32le(&mut b, e + 28, 0x2230);
        u32le(&mut b, e + 32, 0x2240);
        u32le(&mut b, e + 36, 0x2250);
        u32le(&mut b, at(0x2230), 0x1010);
        u32le(&mut b, at(0x2230) + 4, 0x1020);
        u32le(&mut b, at(0x2230) + 8, 0x2260); // forwarder, inside the export directory
        u32le(&mut b, at(0x2240), 0x2290);
        u32le(&mut b, at(0x2240) + 4, 0x2298);
        u16le(&mut b, at(0x2250), 0);
        u16le(&mut b, at(0x2250) + 2, 1);
        put(&mut b, at(0x2260), b"NTDLL.RtlAllocateHeap\0");
        put(&mut b, at(0x2290), b"alpha\0");
        put(&mut b, at(0x2298), b"beta\0");
        // debug directory with a CodeView record
        let d = at(0x2400);
        u32le(&mut b, d + 12, 2);
        u32le(&mut b, d + 16, 24 + 27);
        u32le(&mut b, d + 20, 0x2420);
        u32le(&mut b, d + 24, (at(0x2420)) as u32);
        put(&mut b, at(0x2420), b"RSDS");
        put(&mut b, at(0x2420) + 24, b"C:\\build\\sample\\sample.pdb\0");
        // delay-load import: shell32 via an RVA descriptor
        let dl = at(0x2480);
        u32le(&mut b, dl, 1);
        u32le(&mut b, dl + 4, 0x24c0);
        u32le(&mut b, dl + 16, 0x24d0);
        put(&mut b, at(0x24c0), b"SHELL32.dll\0");
        put(&mut b, at(0x24d0), &(0x24f0u64).to_le_bytes());
        put(&mut b, at(0x24f0) + 2, b"ShellExecuteW\0");
        // version info blocks and recognizable strings
        for (i, (key, value)) in [("CompanyName", "Acme Corp"), ("FileDescription", "Sample program"), ("FileVersion", "1.2.3.4")].into_iter().enumerate() {
            let p = at(0x2600) + i * 0x60;
            let k = wide(&format!("{key}\0"));
            let v = wide(&format!("{value}\0"));
            let value_at = (p + 6 + k.len() + 3) & !3;
            u16le(&mut b, p, (value_at - p + v.len()) as u16);
            u16le(&mut b, p + 2, (v.len() / 2) as u16);
            u16le(&mut b, p + 4, 1);
            put(&mut b, p + 6, &k);
            put(&mut b, value_at, &v);
        }
        put(&mut b, at(0x2780), b"https://example.com/api/v1\0Failed to load config.json\0C:\\Windows\\System32\\drivers\\etc\\hosts\0lua_pushstring\0hello world\0");
        put(&mut b, at(0x2730), &wide("loadme.dll and UTF-16 text\0"));
        put(&mut b, 0xe00, b"plain data section text\0 \"quoted\\path\" tab\there\0");
        put(&mut b, 0x1000, &noise(0x400, 7));
        // overlay: ZIP then PNG, a certificate, then a tail
        let overlay = b.len();
        let mut tail: Vec<u8> = Vec::new();
        tail.extend_from_slice(b"PK\x03\x04zipped content here\x00PK\x05\x06\0\0\0\0\x01\0\x01\0\x10\0\0\0\x10\0\0\0\0\0");
        tail.extend_from_slice(b"\x89PNG\r\n\x1a\nIHDR....\xaeB`\x82IEND\xaeB`\x82");
        tail.extend_from_slice(&noise(5000, 11));
        b.extend_from_slice(&tail);
        let cert = b.len();
        b.extend_from_slice(&[16, 0, 0, 0, 0x00, 0x02, 0x02, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]);
        b.extend_from_slice(&noise(1500, 13));
        u32le(&mut b, dirs + 4 * 8, cert as u32);
        u32le(&mut b, dirs + 4 * 8 + 4, 16);
        assert!(overlay >= 0x1400);
        b
    }

    /// A PE32 x86 managed (.NET) image: CLR header, #~/#Strings streams, one Assembly and two AssemblyRef rows.
    pub fn pe32_managed() -> Vec<u8> {
        let mut b = vec![0u8; 0x600];
        put(&mut b, 0, b"MZ");
        u32le(&mut b, 0x3c, 0x80);
        put(&mut b, 0x80, b"PE\0\0");
        u16le(&mut b, 0x84, 0x14c);
        u16le(&mut b, 0x86, 1);
        u16le(&mut b, 0x94, 224);
        u16le(&mut b, 0x96, 0x2102);
        let o = 0x98;
        u16le(&mut b, o, 0x10b);
        u32le(&mut b, o + 16, 0x2000);
        u32le(&mut b, o + 28, 0x400000);
        u32le(&mut b, o + 56, 0x2000);
        u32le(&mut b, o + 60, 0x200);
        u16le(&mut b, o + 68, 2);
        u32le(&mut b, o + 92, 16);
        let dirs = o + 96;
        u32le(&mut b, dirs + 14 * 8, 0x1000);
        u32le(&mut b, dirs + 14 * 8 + 4, 72);
        section(&mut b, 0x178, ".text", 0x600, 0x1000, 0x400, 0x200, 0x6000_0020);
        b.resize(0x600, 0);
        let clr = 0x200; // rva 0x1000
        u32le(&mut b, clr, 72);
        u32le(&mut b, clr + 8, 0x1100); // metadata rva
        u32le(&mut b, clr + 12, 0x200);
        u32le(&mut b, clr + 16, 1); // IL only
        let m = 0x300; // rva 0x1100
        u32le(&mut b, m, 0x424a5342);
        u32le(&mut b, m + 12, 12);
        put(&mut b, m + 16, b"v4.0.30319\0\0");
        let mut at = m + 28;
        u16le(&mut b, at + 2, 2);
        at += 4;
        let streams: [(&str, u32, u32); 2] = [("#~", 0x60, 0x80), ("#Strings", 0xe0, 0x40)];
        for (name, off, size) in streams {
            u32le(&mut b, at, off);
            u32le(&mut b, at + 4, size);
            put(&mut b, at + 8, name.as_bytes());
            at = (at + 8 + name.len() + 1 + 3) & !3;
        }
        // strings: 1 "Sample", 8 "mscorlib", 17 "System.Core"
        put(&mut b, m + 0xe0, b"\0Sample\0mscorlib\0System.Core\0");
        let t = m + 0x60;
        b[t + 6] = 0; // heap sizes: all 2 bytes
        let valid: u64 = 1 | 1 << 2 | 1 << 32 | 1 << 35;
        put(&mut b, t + 8, &valid.to_le_bytes());
        for (i, rows) in [1u32, 1, 1, 2].into_iter().enumerate() {
            u32le(&mut b, t + 24 + i * 4, rows);
        }
        let mut p = t + 24 + 16;
        p += 10 + 14; // Module, TypeDef
        u16le(&mut b, p + 4, 5);
        u16le(&mut b, p + 6, 0);
        u16le(&mut b, p + 8, 0);
        u16le(&mut b, p + 10, 7);
        u16le(&mut b, p + 18, 1); // Assembly name -> "Sample"
        p += 22;
        for (i, (name, major)) in [(8u16, 4u16), (17, 3)].into_iter().enumerate() {
            let q = p + i * 20;
            u16le(&mut b, q, major);
            u32le(&mut b, q + 8, 0);
            u16le(&mut b, q + 14, name);
        }
        b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> StringOptions {
        StringOptions::default()
    }

    #[test]
    fn parses_a_64_bit_pe() {
        let bytes = samples::pe64();
        let p = inspect_portable_executable(&bytes, &opts()).unwrap();
        assert_eq!((p.format.as_str(), p.architecture.as_str(), p.subsystem.as_str()), ("PE32+", "x86-64", "Windows console"));
        assert_eq!(p.image_base, "0x140000000");
        assert_eq!(p.sections.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), [".text", ".rdata", ".data", ".enc"]);
        assert!(p.sections[3].entropy > 7.2 && p.sections[0].entropy < 1.0);
        let dlls: Vec<_> = p.imports.iter().map(|i| (i.dll.as_str(), i.delay_loaded, i.functions.len(), i.ordinals.clone())).collect();
        assert_eq!(dlls, [("KERNEL32.dll", false, 4, vec![]), ("SHELL32.dll", true, 1, vec![]), ("user32.dll", false, 0, vec![7])]);
        assert_eq!(p.exports.iter().map(|e| (e.name.clone(), e.ordinal, e.forwarder.clone())).collect::<Vec<_>>(), [(Some("alpha".into()), 1, None), (Some("beta".into()), 2, None), (None, 3, Some("NTDLL.RtlAllocateHeap".into()))]);
        assert_eq!(p.pdb_paths, ["C:\\build\\sample\\sample.pdb"]);
        assert_eq!(p.version_info.0, [("CompanyName".to_string(), "Acme Corp".to_string()), ("FileDescription".into(), "Sample program".into()), ("FileVersion".into(), "1.2.3.4".into())]);
        assert!(p.authenticode.present && p.authenticode.revision == Some(0x200) && p.authenticode.certificate_type == Some(2));
        assert!(p.highlighted_imports.iter().any(|h| h.function == "CreateProcessW" && h.category == "process creation"));
        assert!(p.mitigations.aslr && p.mitigations.dep && p.mitigations.control_flow_guard);
        assert!(p.hashes.imphash.is_some() && p.possible_dynamic_libraries.contains(&"loadme.dll".to_string()));
        assert!(p.overlay_bytes > 1024 && p.indicators.iter().any(|i| i.contains("follow the mapped image")));
        assert!(p.strings.iter().any(|s| wide_lossy(s) == "https://example.com/api/v1"));
    }

    #[test]
    fn parses_managed_metadata_on_pe32() {
        let p = inspect_portable_executable(&samples::pe32_managed(), &opts()).unwrap();
        assert_eq!((p.format.as_str(), p.architecture.as_str()), ("PE32", "x86"));
        let m = p.managed.unwrap();
        assert_eq!((m.name.as_deref(), m.version.as_deref(), m.runtime_version.as_deref()), (Some("Sample"), Some("5.0.0.7"), Some("v4.0.30319")));
        assert_eq!(m.references.iter().map(|r| (r.name.as_str(), r.version.as_str())).collect::<Vec<_>>(), [("mscorlib", "4.0.0.0"), ("System.Core", "3.0.0.0")]);
        assert!(p.indicators.iter().any(|i| i.contains("No static imports")));
    }

    #[test]
    fn rejects_bad_headers_with_the_web_wording() {
        assert_eq!(inspect_portable_executable(b"hello", &opts()).unwrap_err(), "Not a Windows executable: missing MZ header");
        let mut b = vec![0u8; 64];
        b[..2].copy_from_slice(b"MZ");
        b[0x3c] = 0xff;
        assert_eq!(inspect_portable_executable(&b, &opts()).unwrap_err(), "MZ header points outside the file");
        let mut dos = vec![0u8; 0x100];
        dos[..2].copy_from_slice(b"MZ");
        dos[0x3c] = 0x80;
        dos[0x80..0x82].copy_from_slice(b"NE");
        let p = inspect_portable_executable(&dos, &opts()).unwrap();
        assert_eq!((p.format.as_str(), p.packing.status.as_str()), ("DOS/NE", "unknown"));
        let mut truncated = samples::pe64();
        truncated.truncate(0x100);
        assert_eq!(inspect_portable_executable(&truncated, &opts()).unwrap_err(), "PE optional header is truncated");
    }

    #[test]
    fn string_options_filter_and_limit() {
        let bytes = samples::pe64();
        let o = StringOptions { string_filter: Some(" EXAMPLE.com ".into()), ..Default::default() };
        let (found, more) = extract_strings(&bytes, &o);
        assert_eq!(found.iter().map(|s| wide_lossy(s)).collect::<Vec<_>>(), ["https://example.com/api/v1"]);
        assert!(!more);
        let (few, more) = extract_strings(&bytes, &StringOptions { max_strings: Some(3.0), ..Default::default() });
        assert!(few.len() == 3 && more);
        assert!(extract_strings(&bytes, &StringOptions { include_strings: Some(false), ..Default::default() }).0.is_empty());
    }

    #[test]
    fn size_cap_message() {
        assert_eq!(clamp_number(Some(99.0), 4.0, 0.0, 8.0), 8.0);
        assert_eq!(clamp_number(None, 4.0, 0.0, 8.0), 4.0);
        assert!(is_system_library("API-MS-WIN-core-x.dll") && is_system_library("MSVCP140_1.dll") && !is_system_library("foo.dll"));
    }
}

//! binary-types.ts: executable filename rules and the analysis folder name, plus the small JavaScript
//! behaviours the web output depends on (number formatting, sort order, JSON string escapes, hashes).

use regex::Regex;
use serde::Serializer;
use std::cmp::Ordering;
use std::sync::LazyLock;

pub const MAX_PE_UPLOAD_BYTES: u64 = 256 * 1024 * 1024;
pub const PE_EXTENSIONS: [&str; 8] = ["exe", "dll", "sys", "ocx", "scr", "cpl", "drv", "efi"];

/// A UTF-16 string as JavaScript sees it: lone surrogates survive, which a Rust `String` cannot hold.
pub type Wide = Vec<u16>;

pub fn is_pe_filename(name: &str) -> bool {
    let lower = name.to_lowercase();
    PE_EXTENSIONS.contains(&lower.rsplit('.').next().unwrap_or(""))
}

pub fn base_name(value: &str) -> String {
    value.replace('\\', "/").rsplit('/').next().unwrap_or(value).to_string()
}

static UNSAFE_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9_.()+ -]+").unwrap());
static DOTS_ENDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[. ]+|[. ]+$").unwrap());
static EXTENSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.[^.]+$").unwrap());

fn safe_segment(value: &str, fallback: &str) -> String {
    let dashed = UNSAFE_RUN.replace_all(value, "-");
    let trimmed = DOTS_ENDS.replace_all(&dashed, "");
    let cut: String = trimmed.chars().take(180).collect();
    if cut.is_empty() { fallback.to_string() } else { cut }
}

pub fn binary_upload_path(name: &str) -> String {
    format!("uploads/binaries/{}", safe_segment(&base_name(name), "program.exe"))
}

/// Keeps a picked folder's relative layout so same-named DLLs do not collide.
pub fn binary_folder_upload_path(folder: &str, relative: &str) -> String {
    let root: String = safe_segment(folder, "program").chars().take(80).collect();
    let pieces: Vec<String> = relative.replace('\\', "/").split('/').filter(|p| !p.is_empty() && *p != "." && *p != "..").map(|p| safe_segment(p, "file")).collect();
    let tail = if pieces.is_empty() { "program.exe".to_string() } else { pieces.join("/") };
    format!("uploads/binaries/{root}/{tail}")
}

/// Deterministic output root shared by static artifacts and decompilers.
pub fn binary_analysis_root(name: &str, sha256: &str) -> String {
    let stem: String = safe_segment(&EXTENSION.replace(&base_name(name), ""), "binary").chars().take(80).collect();
    format!("analysis/{stem}-{}", &sha256[..12.min(sha256.len())])
}

// ---- JavaScript behaviours ----

/// `Number.prototype.toString` for the values this feature prints (never huge or tiny).
pub fn js_num(v: f64) -> String {
    format!("{v}")
}

/// `toFixed`: exact ties round up (away from zero), unlike Rust's round-half-even.
pub fn to_fixed(x: f64, d: usize) -> String {
    let neg = x < 0.0;
    let a = x.abs();
    let long = format!("{:.*}", d + 40, a);
    let tail = &long[long.len() - 40..];
    let tie = tail.starts_with('5') && tail[1..].bytes().all(|b| b == b'0');
    let s = if tie { format!("{:.*}", d, f64::from_bits(a.to_bits() + 1)) } else { format!("{:.*}", d, a) };
    if neg && s.bytes().any(|b| b != b'0' && b != b'.') { format!("-{s}") } else { s }
}

/// A float rounded to `d` places as the number JavaScript would hold (`Number(x.toFixed(d))`).
pub fn round_to(x: f64, d: usize) -> f64 {
    to_fixed(x, d).parse().unwrap_or(0.0)
}

/// Serde helper: a float printed like JSON.stringify prints it (`0`, not `0.0`).
pub fn ser_js_f64<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    if v.fract() == 0.0 && v.abs() < 1e15 { s.serialize_i64(*v as i64) } else { s.serialize_f64(*v) }
}

/// `n.toLocaleString()` in en-US.
pub fn group(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 { format!("-{out}") } else { out }
}

/// JSON.stringify of a UTF-16 string (lone surrogates become `\udXXX`).
pub fn json_units(u: &[u16]) -> String {
    let mut out = String::with_capacity(u.len() + 2);
    out.push('"');
    let mut i = 0;
    while i < u.len() {
        let c = u[i];
        match c {
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            8 => out.push_str("\\b"),
            12 => out.push_str("\\f"),
            10 => out.push_str("\\n"),
            13 => out.push_str("\\r"),
            9 => out.push_str("\\t"),
            c if c < 0x20 => out.push_str(&format!("\\u{c:04x}")),
            0xD800..=0xDBFF if i + 1 < u.len() && (0xDC00..=0xDFFF).contains(&u[i + 1]) => {
                let cp = 0x10000 + (((c as u32) - 0xD800) << 10) + (u[i + 1] as u32 - 0xDC00);
                out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                i += 1;
            }
            0xD800..=0xDFFF => out.push_str(&format!("\\u{c:04x}")),
            c => out.push(char::from_u32(c as u32).unwrap_or('\u{fffd}')),
        }
        i += 1;
    }
    out.push('"');
    out
}

pub fn json_str(s: &str) -> String {
    json_units(&s.encode_utf16().collect::<Vec<_>>())
}

pub fn wide_lossy(w: &[u16]) -> String {
    String::from_utf16_lossy(w)
}

/// What `\s` and `String.prototype.trim` treat as white space.
pub fn is_js_space(c: u16) -> bool {
    matches!(c, 9..=13 | 32 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF)
}

/// `s.replace(/\s+/g, " ").trim()`.
pub fn collapse_space(w: &[u16]) -> Wide {
    let mut out: Wide = Vec::with_capacity(w.len());
    let mut in_space = false;
    for &c in w {
        if is_js_space(c) {
            if !in_space {
                out.push(32);
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    let start = out.iter().position(|&c| !is_js_space(c)).unwrap_or(out.len());
    let end = out.iter().rposition(|&c| !is_js_space(c)).map_or(start, |p| p + 1);
    out[start..end].to_vec()
}

/// ICU root collation order of printable ASCII, as `Intl.Collator` returns it (lower case before upper case).
const ORDER: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ";

static RANKS: LazyLock<[(u32, u8); 128]> = LazyLock::new(|| {
    let mut ranks = [(0u32, 0u8); 128];
    let (mut primary, mut prev) = (0u32, '\0');
    for c in ORDER.chars() {
        if c.is_ascii_uppercase() && c.to_ascii_lowercase() == prev {
            ranks[c as usize] = (primary, 1);
        } else {
            primary += 1;
            ranks[c as usize] = (primary, 0);
        }
        prev = c;
    }
    ranks
});

fn collation_key(c: char) -> Option<(u32, u8)> {
    const BAND: u32 = 0x200000;
    const STEP: u32 = 0x400000; // room between two ASCII ranks for the non-ASCII symbols that sort there
    match c as u32 {
        0..=0x1f | 0x7f => None, // control characters are ignorable
        n if n < 128 => {
            let (rank, tertiary) = RANKS[n as usize];
            Some((rank * STEP, tertiary))
        }
        // ponytail: non-ASCII follows ICU's order only roughly: symbols and punctuation sort before digits, then Latin
        // extras, other scripts, Hangul, kana, Han, Han extensions and the rest, each band in code point order;
        // Han is really radical-stroke order, and accents, marks and fullwidth forms are not folded.
        n if !c.is_alphanumeric() && !(0x2E80..=0x2FDF).contains(&n) => Some((RANKS['$' as usize].0 * STEP + 1 + n, 0)),
        n => {
            let band = match n {
                0x2E80..=0x2FDF | 0x4E00..=0x9FFF => 5, // Han and the radicals that collate with it
                0x80..=0x24F => 1,
                0x3040..=0x312F => 4,
                0x3400..=0x4DBF => 6,
                0xAC00..=0xD7AF => 3,
                0x250..=0xABFF => 2,
                _ => 7,
            };
            Some((0x4000_0000 + band * BAND + n, 0))
        }
    }
}

/// `a.localeCompare(b)` for the ASCII names this feature sorts: case-insensitive first, then lower case before upper.
pub fn locale_cmp(a: &str, b: &str) -> Ordering {
    let ka: Vec<(u32, u8)> = a.chars().filter_map(collation_key).collect();
    let kb: Vec<(u32, u8)> = b.chars().filter_map(collation_key).collect();
    let pa = ka.iter().map(|k| k.0);
    let pb = kb.iter().map(|k| k.0);
    pa.cmp(pb).then_with(|| ka.iter().map(|k| k.1).cmp(kb.iter().map(|k| k.1)))
}

pub fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex_lower(&Sha256::digest(data))
}

fn pad_message(data: &[u8], little_endian: bool) -> Vec<u8> {
    let mut m = data.to_vec();
    m.push(0x80);
    while m.len() % 64 != 56 {
        m.push(0);
    }
    let bits = (data.len() as u64).wrapping_mul(8);
    m.extend_from_slice(&if little_endian { bits.to_le_bytes() } else { bits.to_be_bytes() });
    m
}

pub fn md5_hex(data: &[u8]) -> String {
    const S: [u32; 64] = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    let k: Vec<u32> = (0..64).map(|i| ((i as f64 + 1.0).sin().abs() * 4294967296.0) as u32).collect();
    let mut h: [u32; 4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    for chunk in pad_message(data, true).chunks(64) {
        let w: Vec<u32> = chunk.chunks(4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        let [mut a, mut b, mut c, mut d] = h;
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let f2 = f.wrapping_add(a).wrapping_add(k[i]).wrapping_add(w[g]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(f2.rotate_left(S[i]));
        }
        h = [h[0].wrapping_add(a), h[1].wrapping_add(b), h[2].wrapping_add(c), h[3].wrapping_add(d)];
    }
    h.iter().flat_map(|x| x.to_le_bytes()).map(|b| format!("{b:02x}")).collect()
}

pub fn sha1_hex(data: &[u8]) -> String {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    for chunk in pad_message(data, false).chunks(64) {
        let mut w = [0u32; 80];
        for (i, b) in chunk.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i / 20 {
                0 => ((b & c) | (!b & d), 0x5A827999),
                1 => (b ^ c ^ d, 0x6ED9EBA1),
                2 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6u32),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        h = [h[0].wrapping_add(a), h[1].wrapping_add(b), h[2].wrapping_add(c), h[3].wrapping_add(d), h[4].wrapping_add(e)];
    }
    h.iter().flat_map(|x| x.to_be_bytes()).map(|b| format!("{b:02x}")).collect()
}

/// `s.slice(0, n)` counted in UTF-16 units; a cut through a surrogate pair drops the half pair.
pub fn slice_units(s: &str, n: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for c in s.chars() {
        used += c.len_utf16();
        if used > n {
            break;
        }
        out.push(c);
    }
    out
}

pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// A fresh empty folder for a test, named per test so parallel tests never share one.
#[cfg(test)]
pub(crate) fn test_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("apim-binary-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filenames_and_paths() {
        assert!(is_pe_filename("Game.EXE") && is_pe_filename("exe") && !is_pe_filename("a.so"));
        assert_eq!(binary_upload_path("C:\\x\\my prog?.exe"), "uploads/binaries/my prog-.exe");
        assert_eq!(binary_upload_path("..."), "uploads/binaries/program.exe");
        assert_eq!(binary_folder_upload_path("My App", "bin\\..\\x/y z.dll"), "uploads/binaries/My App/bin/x/y z.dll");
        assert_eq!(binary_analysis_root("uploads/binaries/foo.bar.dll", "0123456789abcdef"), "analysis/foo.bar-0123456789ab");
        assert_eq!(binary_analysis_root("", "0123456789abcdef"), "analysis/binary-0123456789ab");
    }

    #[test]
    fn javascript_numbers_and_strings() {
        assert_eq!(to_fixed(0.125, 2), "0.13"); // JS rounds the exact tie up
        assert_eq!(to_fixed(7.2, 3), "7.200");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(group(1234567), "1,234,567");
        assert_eq!(group(12), "12");
        assert_eq!(js_num(7.0), "7");
        assert_eq!(js_num(7.512), "7.512");
        assert_eq!(json_units(&[0x61, 0x22, 0x5c, 0xd800, 0xd83d, 0xde00, 9]), "\"a\\\"\\\\\\ud800😀\\t\"");
        assert_eq!(collapse_space(&" a \t\u{a0} b ".encode_utf16().collect::<Vec<_>>()), "a b".encode_utf16().collect::<Vec<_>>());
    }

    #[test]
    fn collation_matches_icu_for_ascii() {
        let mut v = vec!["b", "a", "B", "A", "a-b", "a.b", "a_b", "1", "A1", "api-ms-win", "advapi32.dll", "Kernel32.dll", "kernel32.dll"];
        v.sort_by(|a, b| locale_cmp(a, b));
        assert_eq!(v, ["1", "a", "A", "a_b", "a-b", "a.b", "A1", "advapi32.dll", "api-ms-win", "b", "B", "kernel32.dll", "Kernel32.dll"]);
    }

    #[test]
    fn hashes_match_known_vectors() {
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let long = vec![b'a'; 1000];
        assert_eq!(md5_hex(&long), "cabe45dcc9ae5b66ba86600cca6b8ba8");
    }
}

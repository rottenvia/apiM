//! Everything the web app does when something is attached or a tool reads a document, without any UI:
//! classifying files and their limits (`attachments`), describing a file saved in the workspace (`ingest`),
//! pulling text out of Office files and PDFs (`documents`), the picture helper for models that cannot see
//! (`vision`, `ocr`), video frames (`video`) and the message shapes sent to the model (`multimodal`).
//! Each file says which web file it follows. Functions take plain parameters; the only network call is `vision`.

pub mod attachments;
pub mod documents;
pub mod ingest;
pub mod multimodal;
pub mod ocr;
pub mod video;
pub mod vision;

use base64::Engine;

/// JavaScript's `string.length`: UTF-16 code units. Every limit in the web app counts these, not bytes.
pub fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, n)` in UTF-16 units. A cut through a surrogate pair drops that character (Rust strings cannot hold half of one).
pub fn slice16(s: &str, n: usize) -> &str {
    let mut used = 0;
    for (at, c) in s.char_indices() {
        used += c.len_utf16();
        if used > n {
            return &s[..at];
        }
    }
    s
}

/// JavaScript's `trim()`: its whitespace set includes the byte-order mark and leaves out U+0085.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// `n.toLocaleString()` for a whole number: "1,234,567".
pub fn commas(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `v.toFixed(digits)`: ties round up (1.25 → "1.3"), where Rust's formatter rounds them to even.
pub fn to_fixed(v: f64, digits: usize) -> String {
    let scale = 10f64.powi(digits as i32);
    let scaled = v * scale;
    if scaled > 0.0 && scaled.fract() == 0.5 {
        return format!("{:.*}", digits, (scaled.floor() + 1.0) / scale);
    }
    format!("{:.*}", digits, v)
}

/// `data:<mime>;base64,<bytes>`.
pub fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

const LENIENT: base64::engine::GeneralPurpose = base64::engine::GeneralPurpose::new(&base64::alphabet::STANDARD, base64::engine::GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true).with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent));

/// Node's `Buffer.from(text, "base64")`: skips characters that are not base64, accepts the URL-safe alphabet and missing padding.
pub fn base64_lenient(text: &str) -> Vec<u8> {
    let mut clean: String = text.chars().filter(|c| c.is_ascii_alphanumeric() || "+/-_".contains(*c)).map(|c| match c { '-' => '+', '_' => '/', c => c }).collect();
    if clean.len() % 4 == 1 {
        clean.pop();
    }
    LENIENT.decode(clean).unwrap_or_default()
}

/// A stored (uncompressed) zip for tests, with the checksums the reader in `tools::data` insists on.
#[cfg(test)]
pub(crate) fn test_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let (mut out, mut central) = (Vec::new(), Vec::new());
    for (name, data) in entries {
        let mut crc = flate2::Crc::new();
        crc.update(data);
        let offset = out.len() as u32;
        let (crc, len, name_len) = (crc.sum(), data.len() as u32, name.len() as u16);
        out.extend(b"PK\x03\x04");
        out.extend([20u16.to_le_bytes().as_slice(), &[0; 8], &crc.to_le_bytes(), &len.to_le_bytes(), &len.to_le_bytes(), &name_len.to_le_bytes(), &[0, 0]].concat());
        out.extend(name.as_bytes());
        out.extend(*data);
        central.extend(b"PK\x01\x02");
        central.extend([20u16.to_le_bytes().as_slice(), &20u16.to_le_bytes(), &[0; 8], &crc.to_le_bytes(), &len.to_le_bytes(), &len.to_le_bytes(), &name_len.to_le_bytes(), &[0; 12], &offset.to_le_bytes()].concat());
        central.extend(name.as_bytes());
    }
    let at = out.len() as u32;
    out.extend(&central);
    out.extend(b"PK\x05\x06\0\0\0\0");
    out.extend([(entries.len() as u16).to_le_bytes().as_slice(), &(entries.len() as u16).to_le_bytes(), &(central.len() as u32).to_le_bytes(), &at.to_le_bytes(), &[0, 0]].concat());
    out
}

/// The web's recorded results (`fixtures.json`, written by running the real TypeScript on small fixtures) for the parity tests.
#[cfg(test)]
pub(crate) mod fixtures {
    use serde_json::Value;
    use std::sync::LazyLock;

    pub static ALL: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("fixtures.json")).unwrap());

    /// A fixture file's bytes: embedded base64, or rebuilt from a recipe for the big text ones.
    pub fn file(name: &str) -> Vec<u8> {
        let f = &ALL["files"][name];
        if let Some(b) = f["b64"].as_str() {
            return super::base64_lenient(b);
        }
        let recipe = f["gen"].as_str().unwrap_or_else(|| panic!("no fixture {name}"));
        let parts: Vec<&str> = recipe.splitn(3, ':').collect();
        let n: usize = parts.last().unwrap().parse().unwrap();
        match parts[0] {
            "lines" => (0..n).map(|i| format!("line {i} {}\n", "x".repeat(60))).collect::<String>().into_bytes(),
            "json" => format!("[{}]", (0..n).map(|i| format!("{{\"id\":{i},\"name\":\"item {i}\",\"tags\":[\"a\",\"b\"]}}")).collect::<Vec<_>>().join(",")).into_bytes(),
            "repeat" => parts[1].repeat(n).into_bytes(),
            other => panic!("unknown recipe {other}"),
        }
    }

    /// Long expected strings are recorded as {len, head, tail}; short ones as themselves.
    pub fn same(actual: &str, expected: &Value) -> bool {
        match expected {
            Value::String(s) => actual == s,
            o => super::len16(actual) as u64 == o["len"].as_u64().unwrap() && actual.starts_with(o["head"].as_str().unwrap()) && actual.ends_with(o["tail"].as_str().unwrap()),
        }
    }

    pub fn hex(text: &str) -> Vec<u8> {
        (0..text.len() / 2).map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).unwrap()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_string_helpers() {
        assert_eq!((len16("a😀"), slice16("a😀b", 3), slice16("a😀b", 2), slice16("abc", 9)), (3, "a😀", "a", "abc"));
        assert_eq!(js_trim("\u{feff} x\u{a0}\n"), "x");
        assert_eq!((commas(0), commas(999), commas(1000), commas(1234567)), ("0".into(), "999".into(), "1,000".into(), "1,234,567".into()));
        assert_eq!((to_fixed(1.25, 1), to_fixed(1.35, 1), to_fixed(0.0, 1), to_fixed(2.0, 2)), ("1.3".into(), "1.4".into(), "0.0".into(), "2.00".into()));
        assert_eq!(base64_lenient("AQID"), [1, 2, 3]);
        assert_eq!(base64_lenient("AQI"), [1, 2]);
        assert_eq!(base64_lenient("AQ I-_w=="), [1, 2, 0x3e, 0xff]);
        assert_eq!(data_url("image/png", &[1, 2, 3]), "data:image/png;base64,AQID");
    }
}

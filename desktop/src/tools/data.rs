//! Data tools: query_data (what jq would do, on JSON, JSON Lines, CSV and TSV) and extract_archive, ported from
//! the web app's src/lib/data-query.ts and src/lib/extract.ts and their cases in src/lib/tools.ts.

use super::code::{bad, commas, inside, int_arg, js_num, js_string, len16, plural, quote, space, to_fixed, trim};
use crate::snapshots::{clip_utf16, is_protected_path, record_previous};
use crate::tools::files::resolve;
use crate::tools::{Output, str_arg};
use regex::Regex;
use serde_json::Value;
use std::borrow::Cow;
use std::cell::OnceCell;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

macro_rules! pattern {
    ($name:ident, $src:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($src).expect("a fixed pattern"));
    };
}

// ================================================================ query_data

/// Parsing past this is a job for a script, not an in-process parse.
const MAX_DATA_BYTES: u64 = 400 * 1024 * 1024;
/// Size of what one query returns to the model.
const RESULT_CHARS: usize = 20_000;
const SCHEMA_SAMPLE: usize = 2_000;
const MAX_MATCHES: usize = 1_000_000;

/// A JSON value as JavaScript holds one: every number a double, object keys in JS order. serde_json's own Value
/// sorts keys, and the structure and every `[*]` are listed in file order.
#[derive(Clone, Debug, PartialEq)]
enum J {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

/// An object the way JS keeps one: a repeated key keeps its first place and its last value, and whole-number keys
/// come first, in numeric order.
fn object(mut entries: Vec<(String, J)>) -> J {
    let index_key = |k: &str| k.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == k);
    // Slow paths only when needed: almost no object repeats a key or uses numbers as keys.
    let mut order: Vec<usize> = (0..entries.len()).collect();
    order.sort_by(|&a, &b| entries[a].0.cmp(&entries[b].0));
    if order.windows(2).any(|w| entries[w[0]].0 == entries[w[1]].0) {
        let mut kept: Vec<(String, J)> = Vec::new();
        for (k, v) in entries {
            match kept.iter_mut().find(|(have, _)| *have == k) {
                Some(slot) => slot.1 = v,
                None => kept.push((k, v)),
            }
        }
        entries = kept;
    }
    if entries.iter().any(|(k, _)| index_key(k).is_some()) {
        entries.sort_by_key(|(k, _)| index_key(k).map_or((1, 0), |n| (0, n)));
    }
    J::Obj(entries)
}

impl<'de> serde::Deserialize<'de> for J {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<J, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = J;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON")
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<J, E> {
                Ok(J::Null)
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<J, E> {
                Ok(J::Bool(v))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<J, E> {
                Ok(J::Num(v as f64))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<J, E> {
                Ok(J::Num(v as f64))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<J, E> {
                Ok(J::Num(v))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<J, E> {
                Ok(J::Str(v.to_string()))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<J, A::Error> {
                let mut out = Vec::new();
                while let Some(v) = seq.next_element()? {
                    out.push(v);
                }
                Ok(J::Arr(out))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<J, A::Error> {
                let mut out = Vec::new();
                while let Some(entry) = map.next_entry::<String, J>()? {
                    out.push(entry);
                }
                Ok(object(out))
            }
        }
        d.deserialize_any(V)
    }
}

impl J {
    fn get(&self, key: &str) -> Option<&J> {
        match self {
            J::Obj(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// `JSON.stringify(self)`, or with `indent` its pretty form.
    fn write(&self, out: &mut String, indent: Option<usize>, depth: usize) {
        let line = |out: &mut String, depth: usize| {
            if let Some(n) = indent {
                out.push('\n');
                out.push_str(&" ".repeat(n * depth));
            }
        };
        match self {
            J::Null => out.push_str("null"),
            J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Num(n) => out.push_str(&if n.is_finite() { js_num(*n) } else { "null".into() }),
            J::Str(s) => out.push_str(&quote(s)),
            J::Arr(items) if items.is_empty() => out.push_str("[]"),
            J::Obj(entries) if entries.is_empty() => out.push_str("{}"),
            J::Arr(items) => {
                out.push('[');
                for (i, v) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    line(out, depth + 1);
                    v.write(out, indent, depth + 1);
                }
                line(out, depth);
                out.push(']');
            }
            J::Obj(entries) => {
                out.push('{');
                for (i, (k, v)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    line(out, depth + 1);
                    out.push_str(&quote(k));
                    out.push_str(if indent.is_some() { ": " } else { ":" });
                    v.write(out, indent, depth + 1);
                }
                line(out, depth);
                out.push('}');
            }
        }
    }
}

// ---------------------------------------------------------------- loading

struct Data {
    format: &'static str,
    value: J,
    bytes: u64,
    /// CSV/TSV: the header row.
    columns: Option<Vec<String>>,
    /// Lines that did not parse (JSONL) or rows with the wrong width (CSV).
    bad_rows: usize,
}

fn format_for(name: &str, head: &str) -> Option<&'static str> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let ext = base.rfind('.').filter(|&dot| dot > 0).map_or(String::new(), |dot| base[dot..].to_lowercase());
    match ext.as_str() {
        ".jsonl" | ".ndjson" => return Some("jsonl"),
        ".csv" => return Some("csv"),
        ".tsv" | ".tab" => return Some("tsv"),
        ".json" | ".geojson" | ".har" | ".map" => return Some("json"),
        _ => {}
    }
    let t = head.strip_prefix('\u{feff}').unwrap_or(head).trim_start_matches(space);
    if !t.starts_with(['{', '[']) {
        return None;
    }
    // One object per line reads as JSONL.
    let first = trim(t.split('\n').next().unwrap_or(""));
    Some(if t.contains('\n') && first.starts_with('{') && first.ends_with('}') { "jsonl" } else { "json" })
}

/// CSV/TSV rows, RFC 4180 quoting.
fn parse_delimited(text: &str, delimiter: char) -> Vec<Vec<String>> {
    let (mut rows, mut row, mut field, mut quoted): (Vec<Vec<String>>, Vec<String>, String, bool) = (Vec::new(), Vec::new(), String::new(), false);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c != '"' {
                field.push(c);
            } else if chars.peek() == Some(&'"') {
                field.push('"');
                chars.next();
            } else {
                quoted = false;
            }
        } else if c == '"' && field.is_empty() {
            quoted = true;
        } else if c == delimiter {
            row.push(std::mem::take(&mut field));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut field));
            let done = std::mem::take(&mut row);
            if done.len() > 1 || !done[0].is_empty() {
                rows.push(done);
            }
        } else {
            field.push(c);
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        if row.len() > 1 || !row[0].is_empty() {
            rows.push(row);
        }
    }
    rows
}

fn parse_text(text: &str, format: &'static str) -> Result<Data, String> {
    let clean = text.strip_prefix('\u{feff}').unwrap_or(text);
    let data = |format, value, columns, bad_rows| Data { format, value, bytes: 0, columns, bad_rows };
    match format {
        // ponytail: serde_json stops at 128 levels of nesting and refuses numbers past f64; JSON.parse takes both.
        "json" => match serde_json::from_str::<J>(clean) {
            Ok(value) => Ok(data(format, value, None, 0)),
            Err(e) => {
                // Several concatenated objects, one per line, often wear .json.
                let lines = parse_text(clean, "jsonl")?;
                if lines.bad_rows == 0 && matches!(&lines.value, J::Arr(items) if items.len() > 1) {
                    return Ok(lines);
                }
                // ponytail: the reason is serde_json's wording, not V8's.
                Err(format!("Not valid JSON: {e}"))
            }
        },
        "jsonl" => {
            let (mut items, mut bad) = (Vec::new(), 0);
            for line in clean.split('\n').map(trim).filter(|l| !l.is_empty()) {
                match serde_json::from_str::<J>(line) {
                    Ok(v) => items.push(v),
                    Err(_) => bad += 1,
                }
            }
            Ok(data(format, J::Arr(items), None, bad))
        }
        _ => {
            let mut rows = parse_delimited(clean, if format == "tsv" { '\t' } else { ',' }).into_iter();
            let columns: Vec<String> = rows.next().unwrap_or_default().iter().enumerate().map(|(i, c)| if trim(c).is_empty() { format!("column_{}", i + 1) } else { trim(c).to_string() }).collect();
            let mut bad = 0;
            let value = rows
                .map(|mut row| {
                    bad += (row.len() != columns.len()) as usize;
                    row.resize(columns.len(), String::new());
                    object(columns.iter().cloned().zip(row.into_iter().map(J::Str)).collect())
                })
                .collect();
            Ok(data(format, J::Arr(value), Some(columns), bad))
        }
    }
}

fn load(root: &Path, name: &str) -> Result<Data, String> {
    let path = inside(root, name)?;
    // The web's own wording for a file that is not there: Node's error, path and all.
    let meta = std::fs::metadata(&path).map_err(|_| format!("ENOENT: no such file or directory, stat '{}'", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{name} is not a file"));
    }
    if meta.len() > MAX_DATA_BYTES {
        return Err(format!("{name} is {}MB — past the {}MB in-process limit. Stream it with a script instead (run_command with python and ijson/pandas chunks).", to_fixed(meta.len() as f64 / 1048576.0, 0), MAX_DATA_BYTES / 1048576));
    }
    let buf = std::fs::read(&path).map_err(|e| format!("Cannot read {name}: {e}"))?;
    let utf16 = |unit: fn([u8; 2]) -> u16| String::from_utf16_lossy(&buf[2..].chunks_exact(2).map(|c| unit([c[0], c[1]])).collect::<Vec<_>>());
    let text = match buf.get(..2) {
        Some([0xff, 0xfe]) => utf16(u16::from_le_bytes),
        Some([0xfe, 0xff]) => utf16(u16::from_be_bytes),
        _ => String::from_utf8_lossy(&buf).into_owned(),
    };
    let format = format_for(name, &clip_utf16(&text, 4096)).ok_or_else(|| format!("{name} does not look like JSON, JSON Lines, CSV or TSV."))?;
    // ponytail: no parse cache (the web keeps the last two files parsed); every call reads the file again. Add one
    // if paging through a huge file feels slow.
    let mut data = parse_text(&text, format)?;
    data.bytes = meta.len();
    Ok(data)
}

// ---------------------------------------------------------------- structure

#[derive(Default)]
struct Shape {
    /// (type, how many values had it), in first-seen order.
    types: Vec<(&'static str, usize)>,
    count: usize,
    keys: Option<Vec<(String, Shape)>>,
    items: Option<Box<Shape>>,
    lens: Option<(usize, usize)>,
    num: Option<(f64, f64)>,
    examples: Option<Vec<String>>,
    /// Strings that are numbers (CSV cells): how many, and their range.
    numeric: Option<(usize, f64, f64)>,
}

pattern!(NUMERIC_TEXT, r"^\s*-?[0-9]+(?:\.[0-9]+)?\s*$");
pattern!(SAFE_KEY, r"^[A-Za-z_$][A-Za-z0-9_$]*$");

fn observe(shape: &mut Shape, v: &J, depth: usize) {
    shape.count += 1;
    let t = match v {
        J::Null => "null",
        J::Bool(_) => "boolean",
        J::Num(_) => "number",
        J::Str(_) => "string",
        J::Arr(_) => "array",
        J::Obj(_) => "object",
    };
    match shape.types.iter_mut().find(|(have, _)| *have == t) {
        Some(slot) => slot.1 += 1,
        None => shape.types.push((t, 1)),
    }
    if depth > 7 {
        return;
    }
    match v {
        J::Obj(entries) => {
            let keys = shape.keys.get_or_insert_with(Vec::new);
            // Objects used as maps (thousands of id keys) are summarised as such.
            for (k, child) in entries.iter().take(200) {
                let at = match keys.iter().position(|(have, _)| have == k) {
                    Some(at) => at,
                    None if keys.len() >= 200 => continue,
                    None => {
                        keys.push((k.clone(), Shape::default()));
                        keys.len() - 1
                    }
                };
                observe(&mut keys[at].1, child, depth + 1);
            }
        }
        J::Arr(items) => {
            shape.lens = Some(shape.lens.map_or((items.len(), items.len()), |(a, b)| (a.min(items.len()), b.max(items.len()))));
            // The head plus an even spread: a stride alone can land on a pattern (every third item) and describe
            // a field as always empty.
            let head = items.len().min(SCHEMA_SAMPLE / 2);
            let rest = items.len() - head;
            let spread = rest.min(SCHEMA_SAMPLE / 2);
            let inner = shape.items.get_or_insert_with(Default::default);
            for i in (0..head).chain((0..spread).map(|k| head + k * rest / spread)) {
                observe(inner, &items[i], depth + 1);
            }
        }
        J::Num(n) => shape.num = Some(shape.num.map_or((*n, *n), |(a, b)| (a.min(*n), b.max(*n)))),
        J::Str(s) => {
            if NUMERIC_TEXT.is_match(s) && let Ok(n) = s.trim().parse::<f64>() {
                shape.numeric = Some(shape.numeric.map_or((1, n, n), |(count, a, b)| (count + 1, a.min(n), b.max(n))));
            }
            let examples = shape.examples.get_or_insert_with(Vec::new);
            if examples.len() < 3 && !examples.iter().any(|e| e == s) {
                examples.push(if len16(s) > 60 { format!("{}…", clip_utf16(s, 57)) } else { s.clone() });
            }
        }
        _ => {}
    }
}

/// `base.key` when the key reads as a name, `base["the key"]` otherwise.
fn key_path(base: &str, key: &str) -> String {
    if SAFE_KEY.is_match(key) { format!("{base}.{key}") } else { format!("{base}[{}]", quote(key)) }
}

fn describe_shape(shape: &Shape, label: &str, indent: &str, lines: &mut Vec<String>, left: &mut i64) {
    if *left <= 0 {
        return;
    }
    let pct = |n: usize, of: usize| (n as f64 / of as f64 * 100.0).round();
    let mut types = shape.types.clone();
    types.sort_by_key(|t| std::cmp::Reverse(t.1));
    let type_text: Vec<String> = types.iter().map(|(t, n)| if types.len() > 1 { format!("{t} {}%", pct(*n, shape.count)) } else { t.to_string() }).collect();
    let mut detail = String::new();
    if let Some((a, b)) = shape.lens {
        detail += &if a == b { format!(" [{}]", commas(a as u64)) } else { format!(" [{}..{}]", commas(a as u64), commas(b as u64)) };
    }
    if let Some((a, b)) = shape.num {
        detail += &if a == b { format!(" = {}", js_num(a)) } else { format!(" {}..{}", js_num(a), js_num(b)) };
    }
    let count_of = |t: &str| shape.types.iter().find(|have| have.0 == t).map(|have| have.1);
    match (&shape.numeric, &shape.examples) {
        // A CSV column of numbers: say so, with the range, not three examples.
        (Some((n, a, b)), _) if count_of("string") == Some(*n) => detail += &format!(" (numeric text) {}..{}", js_num(*a), js_num(*b)),
        (_, Some(examples)) if !examples.is_empty() => detail += &format!(" e.g. {}", examples.iter().map(|e| quote(e)).collect::<Vec<_>>().join(", ")),
        _ => {}
    }
    if shape.keys.as_ref().is_some_and(|keys| keys.len() >= 200) {
        detail += " (200+ keys — likely a map keyed by id)";
    }
    lines.push(format!("{indent}{label}: {}{detail}", type_text.join(" | ")));
    *left -= 1;
    let deeper = format!("{indent}  ");
    for (k, child) in shape.keys.iter().flatten() {
        if *left <= 0 {
            lines.push(format!("{indent}  …"));
            return;
        }
        let presence = if child.count < shape.count { format!(" (in {}%)", pct(child.count, count_of("object").unwrap_or(shape.count).max(1))) } else { String::new() };
        describe_shape(child, &format!("{}{presence}", key_path("", k)), &deeper, lines, left);
    }
    if let Some(items) = &shape.items && items.count > 0 {
        describe_shape(items, "[*]", &deeper, lines, left);
    }
}

/// A compact structural description: types, counts, ranges, examples.
fn describe(data: &Data) -> String {
    let mut shape = Shape::default();
    observe(&mut shape, &data.value, 0);
    let mut lines = Vec::new();
    describe_shape(&shape, "$", "", &mut lines, &mut 120);
    let mut header = format!("{} · {}MB", data.format.to_uppercase(), to_fixed(data.bytes as f64 / 1048576.0, 1));
    if let J::Arr(items) = &data.value {
        header += &format!(" · {} {}", commas(items.len() as u64), if data.columns.is_some() { "rows" } else { "items" });
    }
    if let Some(columns) = &data.columns {
        header += &format!(" · columns: {}", columns.join(", "));
    }
    if data.bad_rows > 0 {
        header += &format!(" · {} malformed row(s) skipped", data.bad_rows);
    }
    format!("{header}\nStructure (sampled; ranges and examples are from the sample):\n{}", lines.join("\n"))
}

// ---------------------------------------------------------------- JSONPath

enum Member {
    At(i64),
    Named(String),
}

/// One step of a path: `.key`, `[n]`, `[a:b:c]`, `[*]`, `..key`, `[?(@…)]`, `[a,b]`.
enum Step {
    Key(String),
    Index(i64),
    Slice(Option<f64>, Option<f64>, Option<f64>),
    Wild,
    Descend(Option<String>),
    /// The filter as written, and its compiled form once something reached it.
    Filter(String, OnceCell<Pred>),
    Union(Vec<Member>),
}

pattern!(IDENT, r"^[A-Za-z_$\x{c0}-\x{10ffff}][A-Za-z0-9_$\-\x{c0}-\x{10ffff}]*");
pattern!(SLICE, r"^-?[0-9]*:-?[0-9]*(?::-?[0-9]+)?$");
pattern!(INT, r"^-?[0-9]+$");
pattern!(COMMA, r"[[\s--\x{85}]\x{feff}]*,[[\s--\x{85}]\x{feff}]*");

/// A whole number out of a path; one too big to hold lands far out of any array's range.
fn int(s: &str) -> i64 {
    s.parse().unwrap_or(if s.starts_with('-') { i64::MIN / 2 } else { i64::MAX / 2 })
}

/// Parses the JSONPath subset: $, .key, ['key'], [n], [a:b], [*], .., [?(@…)], [a,b].
fn parse_path(query: &str) -> Result<Vec<Step>, String> {
    let trimmed = trim(query);
    if trimmed.is_empty() || trimmed == "$" {
        return Ok(Vec::new());
    }
    let owned = match trimmed.strip_prefix('$') {
        Some(rest) => rest.to_string(),
        None if !trimmed.starts_with(['.', '[']) => format!(".{trimmed}"),
        None => trimmed.to_string(),
    };
    let q = owned.as_str();
    let mut steps = Vec::new();
    let mut i = 0;
    while i < q.len() {
        let rest = &q[i..];
        if rest.starts_with("..") {
            i += 2;
            if q[i..].starts_with('*') {
                i += 1;
                steps.push(Step::Descend(None));
            } else if q[i..].starts_with('[') {
                steps.push(Step::Descend(None));
            } else {
                let name = IDENT.find(&q[i..]).ok_or_else(|| format!("Expected a key after \"..\" at {} in {query}", len16(&q[..i])))?.as_str();
                i += name.len();
                steps.push(Step::Descend(Some(name.to_string())));
            }
        } else if rest.starts_with('.') {
            i += 1;
            if q[i..].starts_with('*') {
                i += 1;
                steps.push(Step::Wild);
                continue;
            }
            let name = IDENT.find(&q[i..]).ok_or_else(|| format!("Expected a key after \".\" at {} in {query}", len16(&q[..i])))?.as_str();
            i += name.len();
            steps.push(Step::Key(name.to_string()));
        } else if rest.starts_with('[') {
            // Find the matching ] respecting quotes and parens.
            let (mut depth, mut quote, mut close, mut escaped) = (0i32, None, None, false);
            for (j, c) in rest.char_indices().skip(1) {
                if escaped {
                    escaped = false;
                } else if let Some(open) = quote {
                    if c == '\\' {
                        escaped = true;
                    } else if c == open {
                        quote = None;
                    }
                } else if c == '\'' || c == '"' {
                    quote = Some(c);
                } else if c == '(' {
                    depth += 1;
                } else if c == ')' {
                    depth -= 1;
                } else if c == ']' && depth == 0 {
                    close = Some(j);
                    break;
                }
            }
            let close = close.ok_or_else(|| format!("Unclosed [ in {query}"))?;
            steps.push(bracket(trim(&rest[1..close]), query)?);
            i += close + 1;
        } else {
            return Err(format!("Unexpected \"{}\" at {} in {query}", rest.chars().next().unwrap_or(' '), len16(&q[..i])));
        }
    }
    Ok(steps)
}

fn bracket(inner: &str, query: &str) -> Result<Step, String> {
    if inner == "*" {
        return Ok(Step::Wild);
    }
    if let Some(expr) = inner.strip_prefix('?') {
        let expr = trim(expr);
        let expr = expr.strip_prefix('(').and_then(|e| e.strip_suffix(')')).unwrap_or(expr);
        return Ok(Step::Filter(expr.to_string(), OnceCell::new()));
    }
    if SLICE.is_match(inner) {
        let mut parts = inner.split(':').map(|p| (!p.is_empty()).then(|| p.parse::<f64>().unwrap_or(f64::NAN)));
        return Ok(Step::Slice(parts.next().flatten(), parts.next().flatten(), parts.next().flatten()));
    }
    if INT.is_match(inner) {
        return Ok(Step::Index(int(inner)));
    }
    let mut members = Vec::new();
    for p in COMMA.split(inner) {
        if p.len() >= 2 && p.starts_with(['\'', '"']) && p.ends_with(&p[..1]) {
            members.push(Member::Named(p[1..p.len() - 1].to_string()));
        } else if INT.is_match(p) {
            members.push(Member::At(int(p)));
        } else {
            return Err(format!("Cannot read [{inner}] in {query}"));
        }
    }
    Ok(match members.as_slice() {
        [Member::Named(name)] => Step::Key(name.clone()),
        _ => Step::Union(members),
    })
}

// ---------------------------------------------------------------- filters: @.a.b OP literal, joined by && / ||, with !, parens

enum Tok {
    Op(&'static str),
    Path(String),
    Val(J),
    Re(Regex),
}

enum Operand {
    Val(J),
    Re(Regex),
    Path(Vec<Step>),
    Item,
}

enum Pred {
    Not(Box<Pred>),
    And(Box<Pred>, Box<Pred>),
    Or(Box<Pred>, Box<Pred>),
    Cmp(Operand, &'static str, Operand),
    /// Bare @.x: present and not null/false (0 and "" count as present).
    Present(Operand),
}

/// What an operand comes to for one item. JS has `undefined` for a missing field, and `.length` is not in the data.
#[derive(Clone)]
enum Val<'a> {
    Undefined,
    Ref(&'a J),
    Num(f64),
    Re(&'a Regex),
}

pattern!(REGEX_LITERAL, r"^/((?:\\.|[^/])*)/([gimsuy]*)");
pattern!(NUMBER, r"(?i)^-?[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?");
pattern!(WORD, r"^(true|false|null)(?-u:\b)");
pattern!(DECIMAL, r"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$");

fn tokenize(expr: &str) -> Result<Vec<Tok>, String> {
    const OPS: [&str; 12] = ["==", "!=", "<=", ">=", "&&", "||", "=~", "<", ">", "(", ")", "!"];
    let mut toks = Vec::new();
    let mut i = 0;
    while i < expr.len() {
        let rest = &expr[i..];
        let c = rest.chars().next().unwrap_or(' ');
        if space(c) {
            i += c.len_utf8();
        } else if let Some(op) = OPS.iter().find(|op| rest.starts_with(**op)) {
            toks.push(Tok::Op(*op));
            i += op.len();
        } else if c == '@' {
            let mut chars = rest.char_indices().skip(1);
            let mut end = rest.len();
            while let Some((j, ch)) = chars.next() {
                if !(ch.is_ascii_alphanumeric() || "_$.[]'\"-".contains(ch) || ch >= '\u{c0}') {
                    end = j;
                    break;
                }
                if ch == '\'' || ch == '"' {
                    chars.by_ref().find(|(_, inner)| *inner == ch);
                }
            }
            toks.push(Tok::Path(rest[1..end].to_string()));
            i += end;
        } else if c == '\'' || c == '"' {
            let (mut text, mut chars, mut end) = (String::new(), rest.char_indices().skip(1), rest.len());
            while let Some((j, ch)) = chars.next() {
                if ch == c {
                    end = j + 1;
                    break;
                }
                text.extend(if ch == '\\' { chars.next().map(|(_, escaped)| escaped) } else { Some(ch) });
            }
            toks.push(Tok::Val(J::Str(text)));
            i += end;
        } else if c == '/' && let Some(m) = REGEX_LITERAL.captures(rest) {
            // ponytail: the pattern is compiled by Rust's regex: no lookaround or backreferences, and \w \d \s are
            // Unicode-aware. The web hands it to JS.
            let flags = &m[2];
            let built = regex::RegexBuilder::new(&m[1]).case_insensitive(flags.contains('i')).multi_line(flags.contains('m')).dot_matches_new_line(flags.contains('s')).build();
            toks.push(Tok::Re(built.map_err(|e| format!("Invalid regular expression: /{}/{flags}: {}", &m[1], e.to_string().lines().last().unwrap_or("").trim_start_matches("error: ")))?));
            i += m[0].len();
        } else if let Some(m) = NUMBER.find(rest) {
            toks.push(Tok::Val(J::Num(m.as_str().parse().unwrap_or(f64::NAN))));
            i += m.len();
        } else if let Some(m) = WORD.captures(rest) {
            toks.push(Tok::Val(match &m[1] {
                "true" => J::Bool(true),
                "false" => J::Bool(false),
                _ => J::Null,
            }));
            i += m[1].len();
        } else {
            return Err(format!("Cannot read filter near \"{}\"", clip_utf16(rest, 12)));
        }
    }
    Ok(toks)
}

type Toks = std::iter::Peekable<std::vec::IntoIter<Tok>>;

/// Compiled once: a 150k-item scan must not re-tokenize per item.
fn compile_filter(expr: &str) -> Result<Pred, String> {
    let mut toks = tokenize(expr)?.into_iter().peekable();
    let pred = parse_or(&mut toks)?;
    match toks.next() {
        None => Ok(pred),
        Some(Tok::Op(op)) => Err(format!("Unexpected \"{op}\" in filter")),
        Some(Tok::Path(_)) => Err("Unexpected \"path\" in filter".into()),
        Some(_) => Err("Unexpected \"lit\" in filter".into()),
    }
}

fn parse_or(toks: &mut Toks) -> Result<Pred, String> {
    let mut left = parse_and(toks)?;
    while matches!(toks.peek(), Some(Tok::Op("||"))) {
        toks.next();
        left = Pred::Or(Box::new(left), Box::new(parse_and(toks)?));
    }
    Ok(left)
}

fn parse_and(toks: &mut Toks) -> Result<Pred, String> {
    let mut left = parse_primary(toks)?;
    while matches!(toks.peek(), Some(Tok::Op("&&"))) {
        toks.next();
        left = Pred::And(Box::new(left), Box::new(parse_primary(toks)?));
    }
    Ok(left)
}

fn parse_primary(toks: &mut Toks) -> Result<Pred, String> {
    match toks.next().ok_or("Filter ended early")? {
        Tok::Op("!") => Ok(Pred::Not(Box::new(parse_primary(toks)?))),
        Tok::Op("(") => {
            let inner = parse_or(toks)?;
            if !matches!(toks.next(), Some(Tok::Op(")"))) {
                return Err("Missing ) in filter".into());
            }
            Ok(inner)
        }
        tok => {
            let left = operand(tok)?;
            let op = match toks.peek() {
                Some(Tok::Op(op)) if ["==", "!=", "<", "<=", ">", ">=", "=~"].contains(op) => *op,
                _ => return Ok(Pred::Present(left)),
            };
            toks.next();
            Ok(Pred::Cmp(left, op, operand(toks.next().ok_or("Filter ended after an operator")?)?))
        }
    }
}

fn operand(tok: Tok) -> Result<Operand, String> {
    match tok {
        Tok::Val(v) => Ok(Operand::Val(v)),
        Tok::Re(re) => Ok(Operand::Re(re)),
        Tok::Path(rel) if rel.is_empty() => Ok(Operand::Item),
        Tok::Path(rel) => Ok(Operand::Path(parse_path(&format!("${}{rel}", if rel.starts_with(['[', '.']) { "" } else { "." }))?)),
        Tok::Op(op) => Err(format!("Unexpected {op} in filter")),
    }
}

/// JS `Number(text)`: decimal or hex, Infinity; None for anything else.
fn js_number(s: &str) -> Option<f64> {
    let t = trim(s);
    if t.is_empty() {
        return Some(0.0);
    }
    if let Some(hex) = t.strip_prefix("0x").or(t.strip_prefix("0X")) {
        return u64::from_str_radix(hex, 16).ok().map(|n| n as f64);
    }
    match t {
        "Infinity" | "+Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        _ if DECIMAL.is_match(t) => t.parse().ok(),
        _ => None,
    }
}

impl<'a> Val<'a> {
    fn is_number(&self) -> bool {
        matches!(self, Val::Num(_) | Val::Ref(J::Num(_)))
    }

    /// The web's `num`: a number, or a string that reads as one.
    fn number(&self) -> Option<f64> {
        match self {
            Val::Num(n) | Val::Ref(J::Num(n)) => Some(*n),
            Val::Ref(J::Str(s)) if !trim(s).is_empty() => js_number(s).filter(|n| !n.is_nan()),
            _ => None,
        }
    }

    /// What JS turns a value into for `<` and `>` when the two sides are not both strings. Arrays and objects
    /// come to NaN here (JS would first join an array into text): nothing compares with them.
    fn to_number(&self) -> f64 {
        match self {
            Val::Num(n) | Val::Ref(J::Num(n)) => *n,
            Val::Ref(J::Null) => 0.0,
            Val::Ref(J::Bool(b)) => *b as u8 as f64,
            Val::Ref(J::Str(s)) => js_number(s).unwrap_or(f64::NAN),
            _ => f64::NAN,
        }
    }

    /// JS `===`: an array or object equals only itself.
    fn same(&self, other: &Val) -> bool {
        match (self, other) {
            (Val::Undefined, Val::Undefined) => true,
            (Val::Ref(a), Val::Ref(b)) => {
                if matches!(a, J::Arr(_) | J::Obj(_)) {
                    std::ptr::eq(*a, *b)
                } else {
                    a == b
                }
            }
            (Val::Num(a), Val::Num(b)) => a == b,
            (Val::Num(a), Val::Ref(J::Num(b))) | (Val::Ref(J::Num(b)), Val::Num(a)) => a == b,
            _ => false,
        }
    }
}

fn compare(a: &Val, op: &str, b: &Val) -> bool {
    if op == "=~" {
        return matches!((a, b), (Val::Ref(J::Str(s)), Val::Re(re)) if re.is_match(s));
    }
    // Numbers compare as numbers when either side is one and both read as one ("12" == 12).
    let (x, y) = match (a.number(), b.number()) {
        (Some(x), Some(y)) if a.is_number() || b.is_number() => (Val::Num(x), Val::Num(y)),
        _ => (a.clone(), b.clone()),
    };
    let order = match (&x, &y) {
        (Val::Ref(J::Str(s)), Val::Ref(J::Str(t))) => Some(s.encode_utf16().cmp(t.encode_utf16())),
        _ => x.to_number().partial_cmp(&y.to_number()),
    };
    match (op, order) {
        ("==", _) => x.same(&y),
        ("!=", _) => !x.same(&y),
        ("<", Some(o)) => o.is_lt(),
        ("<=", Some(o)) => o.is_le(),
        (">", Some(o)) => o.is_gt(),
        (">=", Some(o)) => o.is_ge(),
        _ => false,
    }
}

impl Operand {
    fn eval<'a>(&'a self, item: &'a J) -> Result<Val<'a>, String> {
        let steps = match self {
            Operand::Val(v) => return Ok(Val::Ref(v)),
            Operand::Re(re) => return Ok(Val::Re(re)),
            Operand::Item => return Ok(Val::Ref(item)),
            Operand::Path(steps) => steps,
        };
        // Plain @.a.b[0] lookups walk the value directly: no match objects.
        if steps.iter().all(|s| matches!(s, Step::Key(_) | Step::Index(_))) {
            let mut v = item;
            for step in steps {
                let next = match (step, v) {
                    (Step::Key(name), J::Arr(items)) => return Ok(if name == "length" { Val::Num(items.len() as f64) } else { Val::Undefined }),
                    (Step::Key(name), J::Obj(_)) => v.get(name),
                    (Step::Index(i), J::Arr(items)) => index(items.len(), *i).map(|at| &items[at]),
                    _ => None,
                };
                let Some(next) = next else { return Ok(Val::Undefined) };
                v = next;
            }
            return Ok(Val::Ref(v));
        }
        Ok(match run(steps, vec![Match { path: "@".into(), value: Cow::Borrowed(item) }])?.into_iter().next().map(|m| m.value) {
            Some(Cow::Borrowed(v)) => Val::Ref(v),
            Some(Cow::Owned(J::Num(n))) => Val::Num(n),
            _ => Val::Undefined,
        })
    }
}

impl Pred {
    fn test(&self, item: &J) -> Result<bool, String> {
        Ok(match self {
            Pred::Not(inner) => !inner.test(item)?,
            Pred::And(a, b) => a.test(item)? && b.test(item)?,
            Pred::Or(a, b) => a.test(item)? || b.test(item)?,
            Pred::Present(operand) => !matches!(operand.eval(item)?, Val::Undefined | Val::Ref(J::Null) | Val::Ref(J::Bool(false))),
            Pred::Cmp(left, op, right) => compare(&left.eval(item)?, op, &right.eval(item)?),
        })
    }
}

// ---------------------------------------------------------------- running a path

struct Match<'a> {
    path: String,
    /// A value in the data, or a number the path made (`.length`).
    value: Cow<'a, J>,
}

/// The value in the data a match points at; None for a made number.
fn node<'a>(m: &Match<'a>) -> Option<&'a J> {
    match &m.value {
        Cow::Borrowed(v) => Some(*v),
        Cow::Owned(_) => None,
    }
}

fn children<'a>(m: &Match<'a>) -> Vec<Match<'a>> {
    match node(m) {
        Some(J::Arr(items)) => items.iter().enumerate().map(|(i, v)| Match { path: format!("{}[{i}]", m.path), value: Cow::Borrowed(v) }).collect(),
        Some(J::Obj(entries)) => entries.iter().map(|(k, v)| Match { path: key_path(&m.path, k), value: Cow::Borrowed(v) }).collect(),
        _ => Vec::new(),
    }
}

/// A JS index into `len` items: negative counts from the end, None when out of range.
fn index(len: usize, i: i64) -> Option<usize> {
    let at = if i < 0 { len as i64 + i } else { i };
    (at >= 0 && (at as usize) < len).then_some(at as usize)
}

fn run<'a>(steps: &[Step], start: Vec<Match<'a>>) -> Result<Vec<Match<'a>>, String> {
    let mut current = start;
    for step in steps {
        let mut next: Vec<Match<'a>> = Vec::new();
        for m in &current {
            if next.len() >= MAX_MATCHES {
                break;
            }
            let Some(v) = node(m) else { continue };
            let child = |key: &str, value: &'a J| Match { path: key_path(&m.path, key), value: Cow::Borrowed(value) };
            let at = |i: usize, items: &'a [J]| Match { path: format!("{}[{i}]", m.path), value: Cow::Borrowed(&items[i]) };
            match (step, v) {
                (Step::Key(name), J::Obj(_)) => next.extend(v.get(name).map(|found| child(name, found))),
                (Step::Key(name), J::Arr(items)) if name == "length" => next.push(Match { path: format!("{}.length", m.path), value: Cow::Owned(J::Num(items.len() as f64)) }),
                (Step::Index(i), J::Arr(items)) => next.extend(index(items.len(), *i).map(|i| at(i, items))),
                (Step::Slice(from, to, by), J::Arr(items)) => {
                    // A lone "-" reads as not-a-number in JS, and nothing is in a slice that starts or ends there.
                    if from.is_some_and(f64::is_nan) || to.is_some_and(f64::is_nan) {
                        continue;
                    }
                    let len = items.len() as f64;
                    let norm = |x: Option<f64>, default: f64| x.map_or(default, |x| if x < 0.0 { (len + x).max(0.0) } else { len.min(x) });
                    let (mut i, end, by) = (norm(*from, 0.0), norm(*to, len), by.filter(|b| *b > 0.0).unwrap_or(1.0));
                    while i < end {
                        next.push(at(i as usize, items));
                        i += by;
                    }
                }
                (Step::Wild, _) => next.extend(children(m)),
                (Step::Union(members), _) => {
                    for member in members {
                        match (member, v) {
                            (Member::At(i), J::Arr(items)) => next.extend(index(items.len(), *i).map(|i| at(i, items))),
                            (Member::Named(key), J::Obj(_)) => next.extend(v.get(key).map(|found| child(key, found))),
                            _ => {}
                        }
                    }
                }
                (Step::Filter(expr, compiled), _) => {
                    let pred = match compiled.get() {
                        Some(pred) => pred,
                        None => {
                            let pred = compile_filter(expr)?;
                            compiled.get_or_init(|| pred)
                        }
                    };
                    for c in children(m) {
                        if let Some(value) = node(&c) && pred.test(value)? {
                            next.push(c);
                        }
                    }
                }
                (Step::Descend(name), _) => {
                    // Every node below, parents before children, in file order.
                    let mut stack = vec![Match { path: m.path.clone(), value: Cow::Borrowed(v) }];
                    let mut top = true;
                    while let Some(n) = stack.pop() {
                        if next.len() >= MAX_MATCHES {
                            break;
                        }
                        stack.extend(children(&n).into_iter().rev());
                        match name {
                            Some(name) => next.extend(node(&n).filter(|v| matches!(v, J::Obj(_))).and_then(|v| v.get(name)).map(|found| Match { path: key_path(&n.path, name), value: Cow::Borrowed(found) })),
                            None if !top => next.push(n),
                            None => {}
                        }
                        top = false;
                    }
                }
                _ => {}
            }
        }
        next.truncate(MAX_MATCHES);
        current = next;
    }
    Ok(current)
}

/// A value with long arrays and strings elided, so one match cannot flood the result.
fn preview(v: &J, depth: usize) -> J {
    match v {
        J::Str(s) if len16(s) > 2000 => J::Str(format!("{}…[+{} chars]", clip_utf16(s, 2000), len16(s) - 2000)),
        J::Arr(items) => {
            let mut shown: Vec<J> = items.iter().take(20).map(|v| preview(v, depth + 1)).collect();
            if items.len() > 20 {
                shown.push(J::Str(format!("…[{} more items]", items.len() - 20)));
            }
            J::Arr(shown)
        }
        J::Obj(_) if depth > 12 => J::Str("{…}".into()),
        J::Obj(entries) => {
            let mut shown: Vec<(String, J)> = entries.iter().take(200).map(|(k, v)| (k.clone(), preview(v, depth + 1))).collect();
            if entries.len() > 200 {
                shown.push(("…".into(), J::Str(format!("{} more keys", entries.len() - 200))));
            }
            J::Obj(shown)
        }
        other => other.clone(),
    }
}

/// Writes text into the workspace the way the web's writeFile does: never into a protected folder, and what was
/// there before is kept for undo.
fn write_workspace(root: &Path, rel: &str, text: &str) -> Result<(), String> {
    if is_protected_path(rel) {
        return Err(format!("{rel} is inside a protected folder (.git, .history or .snapshots) and cannot be written, moved or deleted by the file tools"));
    }
    let path = inside(root, rel)?;
    if let Ok(old) = std::fs::read(&path) {
        record_previous(root, rel, &old);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }
    std::fs::write(&path, text).map_err(|e| format!("Cannot write {rel}: {e}"))
}

/// Looks inside a JSON, JSON Lines, CSV or TSV file without reading it whole. Without `query` it returns the
/// structure; with one (JSONPath) the matches, paged.
pub fn query_data(root: &Path, args: &Value) -> Output {
    let path = str_arg(args, "path");
    if path.is_empty() {
        return bad("Error: path is required.", "No path given");
    }
    query(root, path, args).unwrap_or_else(|e| {
        let summary = if e.starts_with("ENOENT") { e.clone() } else { clip_utf16(&e, 80) };
        // A condition written bare ("price > 10") is the usual slip: said once, with the form that works.
        let asked = str_arg(args, "query").trim();
        let hint = if asked.is_empty() || asked.starts_with('$') { String::new() } else { format!("\n\nThe query is JSONPath and starts with $. To keep the rows that pass a test: $[?(@.{})]", asked.trim_start_matches('@').trim_start_matches('.')) };
        bad(format!("Error: {e}{hint}"), summary)
    })
}

/// The whole file as the one match every path starts from.
fn whole(value: &J) -> Vec<Match<'_>> {
    vec![Match { path: "$".into(), value: Cow::Borrowed(value) }]
}

fn query(root: &Path, path: &str, args: &Value) -> Result<Output, String> {
    let data = load(root, path)?;
    let q = str_arg(args, "query");
    // A count with no query counts what the file holds at the top.
    let q = if q.is_empty() && args["count"].as_bool() == Some(true) && matches!(data.value, J::Arr(_)) { "$[*]" } else { q };
    if q.is_empty() {
        let example = if matches!(data.value, J::Arr(_)) { "[0:5]" } else { ".<key>" };
        return Ok(Output::ok(format!("{path}\n{}\n\nQuery it with JSONPath, e.g. query \"${example}\".", describe(&data)), format!("Structure of {path}")));
    }
    let matches = run(&parse_path(q)?, whole(&data.value))?;
    let total = matches.len();

    let save_as = str_arg(args, "save_as");
    if !save_as.is_empty() {
        // `JSON.stringify(all, null, 2)`, written match by match.
        let mut text = String::from(if total == 0 { "[]" } else { "[" });
        for (i, m) in matches.iter().enumerate() {
            text.push_str(if i > 0 { ",\n  " } else { "\n  " });
            m.value.write(&mut text, Some(2), 1);
        }
        if total > 0 {
            text.push_str("\n]");
        }
        write_workspace(root, save_as, &text)?;
        return Ok(Output::ok(format!("Wrote {} match(es) for {q} to {save_as} ({}KB).", commas(total as u64), to_fixed(len16(&text) as f64 / 1024.0, 0)), format!("Saved {total} matches to {save_as}")).changed(save_as));
    }

    let summary = format!("{} match(es) in {path}", commas(total as u64));
    if args["count"].as_bool() == Some(true) {
        return Ok(Output::ok(format!("{} match(es) for {q}", commas(total as u64)), summary));
    }
    let offset = int_arg(args, "offset").unwrap_or(0).max(0) as usize;
    let limit = int_arg(args, "limit").unwrap_or(50).clamp(1, 10_000) as usize;
    let fields: Vec<String> = args["fields"].as_array().map(|a| a.iter().map(js_string).collect()).unwrap_or_default();
    let (mut lines, mut used) = (Vec::new(), 0);
    for m in matches.iter().skip(offset).take(limit) {
        let shown = match &*m.value {
            // Only these fields of each matched object; one that is not there is left out.
            value @ J::Obj(_) if !fields.is_empty() => {
                let mut picked = Vec::new();
                for field in &fields {
                    let steps = parse_path(&if field.starts_with('$') { field.clone() } else { format!("$.{field}") })?;
                    if let Some(hit) = run(&steps, whole(value))?.into_iter().next() {
                        picked.push((field.clone(), hit.value.into_owned()));
                    }
                }
                preview(&object(picked), 0)
            }
            value => preview(value, 0),
        };
        let mut line = format!("{} = ", m.path);
        shown.write(&mut line, None, 0);
        let len = len16(&line);
        if used + len > RESULT_CHARS && !lines.is_empty() {
            break;
        }
        lines.push(if len > RESULT_CHARS { format!("{}…", clip_utf16(&line, RESULT_CHARS)) } else { line });
        used += len + 1;
    }
    let shown = lines.len();
    let mut text = format!("{} match(es) for {q}", commas(total as u64));
    if total > 0 {
        text += &format!(" — showing {}–{}", offset + 1, offset + shown);
    }
    text += &format!("\n{}", lines.join("\n"));
    if total > offset + shown {
        text += &format!("\n…{} more. Use offset:{} for the next page, fields to pick columns, or save_as to write all matches to a file.", commas((total - offset - shown) as u64), offset + shown);
    }
    Ok(Output::ok(text, summary))
}

// ================================================================ extract_archive
//
// ponytail: the web runs 7-Zip (as WebAssembly) and so opens rar, 7z, xz, bzip2, zstd, cab, iso and encrypted
// archives too. Here: zip (stored and deflated, zip64, legacy code pages), tar, gzip and tar.gz, with flate2 alone.
// Everything else gets the web's "could not be read … unsupported variant" wording. Add sevenz-rust, lzma-rs,
// bzip2-rs or ruzstd behind `unpack` when those formats are wanted. File times and Unix modes are not restored.
//
// Safe by construction: this module writes every file itself. Each path segment is sanitised, `..` entries and
// links are never written, sizes and counts are checked as bytes land, and the output goes to a temporary sibling
// folder that is renamed into place only when everything came out.

const MAX_UNPACKED_BYTES: u64 = 4 << 30;
const MAX_UNPACKED_FILES: usize = 100_000;
const MAX_LISTED_ENTRIES: usize = 5000;
/// Enough of the head to see ISO 9660's "CD001" at 0x8001.
const HEAD_BYTES: usize = 0x8006;
const TEMP_PREFIX: &str = ".apim-extract-";

/// Zip- and gzip-based formats that are documents or packages, not folders: never listed as nested archives.
const CONTAINER_EXTS: &[&str] = &[
    "docx", "docm", "dotx", "dotm", "xlsx", "xlsm", "xltx", "xltm", "xlsb", "pptx", "pptm", "potx", "ppsx", "ppsm", "odt", "ods", "odp", "odg", "odf", "ott", "ots", "otp", "epub", "jar", "war", "ear", "aar", "apk", "apks", "aab", "xapk",
    "ipa", "xpi", "crx", "vsix", "nupkg", "whl", "egg", "appx", "appxbundle", "msix", "msixbundle", "xps", "oxps", "kmz", "3mf", "sketch", "pages", "numbers", "key", "pbix", "usdz", "mcpack", "mcaddon", "mcworld", "ora", "svgz", "emz", "wmz",
    "fig", "xd", "vsdx", "one",
];

const EXT_KIND: &[(&str, &str)] = &[
    ("zip", "zip"), ("zipx", "zip"), ("7z", "7z"), ("rar", "rar"), ("tar", "tar"), ("gz", "gzip"), ("gzip", "gzip"), ("tgz", "gzip"), ("tpz", "gzip"), ("bz2", "bzip2"), ("bzip2", "bzip2"), ("tbz", "bzip2"), ("tbz2", "bzip2"), ("xz", "xz"),
    ("txz", "xz"), ("zst", "zstd"), ("zstd", "zstd"), ("tzst", "zstd"), ("lzma", "lzma"), ("z", "compress"), ("taz", "compress"), ("cab", "cab"), ("iso", "iso"), ("udf", "iso"), ("wim", "wim"), ("swm", "wim"), ("esd", "wim"),
    ("cpio", "cpio"), ("deb", "ar"), ("udeb", "ar"), ("ar", "ar"), ("rpm", "rpm"), ("xar", "xar"), ("lzh", "lzh"), ("lha", "lzh"), ("arj", "arj"), ("001", "split"),
];

const NOTABLE_NAMES: &[&str] = &[
    "package.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "pipfile", "cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "cmakelists.txt", "makefile", "dockerfile", "docker-compose.yml",
    "docker-compose.yaml", "compose.yaml", "composer.json", "gemfile", "project.godot", "tsconfig.json", "vite.config.ts", "vite.config.js", "next.config.js", "next.config.ts", "index.html", "main.py", "__main__.py", "app.py", "manage.py",
    "index.js", "index.ts", "main.js", "main.ts", "server.js", "app.js", "main.go", "main.rs", "lib.rs", "program.cs", "main.c", "main.cpp", "main.java", "main.kt", "build.sh", "install.sh", "run.sh", "start.bat", "run.bat",
];
const NOTABLE_EXTS: &[&str] = &["sln", "csproj", "vcxproj", "fsproj", "uproject", "xcodeproj", "exe", "dll", "so", "dylib", "msi", "sys", "apk", "ipa", "jar", "ps1"];

pattern!(COMPOUND_EXT, r"(?i)\.(part0*1\.rar|7z\.0*1|zip\.0*1|tar\.[a-z0-9]{1,5}|t[gbx]z2?|tzst|taz|tpz)$");
pattern!(SIMPLE_EXT, r"\.[A-Za-z0-9]{1,6}$");
pattern!(COMPRESSOR_EXT, r"(?i)\.(gz|gzip|bz2|bzip2|xz|zst|zstd|lzma|z|001)$");
pattern!(TAR_BY_NAME, r"(?i)\.(tgz|tbz2?|txz|tzst|taz|tpz)$");
pattern!(RESERVED, r"(?i)^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)");
pattern!(ABSOLUTE, r"^([\\/]|[A-Za-z]:)");

fn ext_of(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    base.rfind('.').filter(|&dot| dot > 0).map_or(String::new(), |dot| base[dot + 1..].to_lowercase())
}

/// What kind of archive this is, if any. Magic bytes decide first; the extension is the fallback for formats with
/// weak or missing magic. Documents built on zip (docx, jar, apk…) are not archives unless `force`d.
fn sniff(head: &[u8], name: &str, force: bool) -> Option<&'static str> {
    const MAGIC: &[(usize, &[u8], &str)] = &[
        (0, b"PK\x03\x04", "zip"), (0, b"PK\x05\x06", "zip"), (0, b"PK\x07\x08", "zip"), (0, b"7z\xbc\xaf\x27\x1c", "7z"), (0, b"Rar!\x1a\x07", "rar"), (0, b"\x1f\x8b", "gzip"), (0, b"BZh", "bzip2"), (0, b"\xfd7zXZ\x00", "xz"),
        (0, b"\x28\xb5\x2f\xfd", "zstd"), (0, b"\x1f\x9d", "compress"), (0, b"MSCF\0\0\0\0", "cab"), (0, b"MSWIM\0\0\0", "wim"), (257, b"ustar", "tar"), (0x8001, b"CD001", "iso"), (0x8001, b"BEA01", "iso"), (0, b"!<arch>\n", "ar"),
        (0, b"\xed\xab\xee\xdb", "rpm"), (0, b"xar!", "xar"), (0, b"070707", "cpio"), (0, b"070701", "cpio"), (0, b"070702", "cpio"), (0, b"\xc7\x71", "cpio"), (0, b"\x71\xc7", "cpio"), (2, b"-lh", "lzh"), (0, b"\x60\xea", "arj"),
    ];
    let ext = ext_of(name);
    if !force && CONTAINER_EXTS.contains(&ext.as_str()) {
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
    // With enough bytes to judge, an extension whose magic is absent is only believed for formats that have no
    // reliable magic of their own.
    let weak = ["tar", "lzma", "split", "iso"].contains(&by_ext);
    if !force && ((head.len() >= 512 && !weak) || (by_ext == "iso" && head.len() >= HEAD_BYTES)) {
        return None;
    }
    Some(by_ext)
}

/// "game.tar.gz" → "game", "x.part1.rar" → "x", "a.7z.001" → "a".
fn strip_archive_ext(name: &str) -> String {
    let full = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let mut base = COMPOUND_EXT.replace(full, "").into_owned();
    if base == full {
        base = SIMPLE_EXT.replace(full, "").into_owned();
    }
    let base = base.trim_end_matches(['.', ' ']);
    if base.is_empty() { "archive".into() } else { base.into() }
}

fn fmt_bytes(n: u64) -> String {
    if n < 1024 {
        return format!("{n} B");
    }
    let (mut v, mut unit) = (n as f64 / 1024.0, 0);
    while v >= 1024.0 && unit < 3 {
        v /= 1024.0;
        unit += 1;
    }
    format!("{} {}", to_fixed(v, if v >= 100.0 { 0 } else { 1 }), ["KB", "MB", "GB", "TB"][unit])
}

/// One path segment made safe to create on any platform (Windows is the strict one).
fn sanitize_segment(seg: &str) -> String {
    let mut s: String = seg.chars().map(|c| if c < ' ' || "<>:\"|?*\\".contains(c) { '_' } else { c }).collect();
    if matches!(s.as_str(), "" | "." | "..") {
        return "_".into();
    }
    let kept = s.trim_end_matches(['.', ' ']).len();
    s = format!("{}{}", &s[..kept], "_".repeat(s.len() - kept));
    if RESERVED.is_match(&s) {
        s.insert(0, '_');
    }
    if len16(&s) > 240 {
        let ext = s.rfind('.').filter(|&dot| dot > 0 && len16(&s[dot..]) <= 16).map_or(String::new(), |dot| s[dot..].to_string());
        s = format!("{}~{ext}", clip_utf16(&s, 240 - len16(&ext)));
    }
    s
}

/// An archive path as the workspace-relative path it lands on.
fn map_path(name: &str) -> String {
    let parts: Vec<String> = name.split(['/', '\\']).filter(|s| !s.is_empty() && *s != ".").map(sanitize_segment).collect();
    if parts.is_empty() { "_".into() } else { parts.join("/") }
}

fn join_rel(parts: &[&str]) -> String {
    let joined: Vec<String> = parts.iter().flat_map(|p| p.split(['/', '\\'])).filter(|s| !s.is_empty() && *s != ".").map(str::to_string).collect();
    if joined.is_empty() { ".".into() } else { joined.join("/") }
}

/// The web sorts names in a listing with localeCompare. For ASCII names that is: punctuation in ICU's own
/// sequence, then digits, then letters, with case only breaking ties (lowercase first). Same rule as the private
/// `web_order` in snapshots.rs.
// ponytail: other alphabets sort by code point after all of that, not where ICU puts them.
fn locale_order(a: &str, b: &str) -> std::cmp::Ordering {
    const BEFORE_LETTERS: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789";
    let rank = |c: char| BEFORE_LETTERS.find(c).map_or(if c.is_ascii_alphabetic() { 100 + c.to_ascii_lowercase() as u32 } else { 1000 + c as u32 }, |at| at as u32);
    a.chars().map(rank).cmp(b.chars().map(rank)).then_with(|| b.cmp(a))
}

// ---------------------------------------------------------------- names in legacy code pages

/// One byte from 0x80 up in a DOS/Windows code page. Old zips from Windows store names this way.
fn code_page_char(page: &str, b: u8) -> char {
    const CP437: &str = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u{a0}";
    let from = |table: &str, at: u8| table.chars().nth(at as usize).unwrap_or('?');
    let cyrillic = |at: u8| char::from_u32(0x410 + at as u32).unwrap_or('?');
    match (page, b) {
        ("cp437", _) => from(CP437, b - 0x80),
        ("ibm866", 0x80..=0xaf) => cyrillic(b - 0x80),
        ("ibm866", 0xb0..=0xdf) => from(CP437, b - 0x80),
        ("ibm866", 0xe0..=0xef) => cyrillic(b - 0xe0 + 0x30),
        ("ibm866", _) => from("ЁёЄєЇїЎў°∙·√№¤■\u{a0}", b - 0xf0),
        ("windows-1251", 0xc0..=0xff) => cyrillic(b - 0xc0),
        ("windows-1251", _) => from("ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u{98}™љ›њќћџ\u{a0}ЎўЈ¤Ґ¦§Ё©Є«¬\u{ad}®Ї°±Ііґµ¶·ё№є»јЅѕї", b - 0x80),
        (_, 0x80..=0x9f) => from("€\u{81}‚ƒ„…†‡ˆ‰Š‹Œ\u{8d}Ž\u{8f}\u{90}‘’“”•–—˜™š›œ\u{9d}žŸ", b - 0x80),
        _ => b as char,
    }
}

fn decode_with(raw: &[u8], page: &str) -> String {
    raw.iter().map(|&b| if b < 0x80 { b as char } else { code_page_char(page, b) }).collect()
}

/// Scores a decoded name: real words in a real script beat symbol soup.
fn score_text(s: &str) -> i64 {
    let latin = |c: char| c.is_ascii_alphabetic() || ('\u{c0}'..='\u{24f}').contains(&c);
    let cyrillic = |c: char| ('\u{400}'..='\u{4ff}').contains(&c);
    let mut score = 0;
    for c in s.chars().map(|c| c as u32).filter(|&c| c >= 0x80) {
        score += match c {
            0x410..=0x44f | 0x401 | 0x451 => 2,
            0xc0..=0xff if c != 0xd7 && c != 0xf7 => 1,
            0x400..=0x4ff => 0,
            0x2500..=0x25ff | 0x80..=0x9f | 0xfffd => -3,
            _ => -1,
        };
    }
    // A word mixing Latin and Cyrillic letters is mojibake.
    score - 3 * s.split(|c: char| !(latin(c) || cyrillic(c))).filter(|w| w.chars().any(latin) && w.chars().any(cyrillic)).count() as i64
}

/// The code page for names that are not valid UTF-8: each candidate decodes every such name and the most plausible
/// text wins. Ties go to CP866, what Russian Windows writes into zips.
fn detect_code_page<'a>(names: impl Iterator<Item = &'a [u8]>) -> Option<&'static str> {
    let raw: Vec<&[u8]> = names.filter(|n| std::str::from_utf8(n).is_err()).take(2000).collect();
    if raw.is_empty() {
        return None;
    }
    let mut best = ("ibm866", i64::MIN);
    for page in ["ibm866", "windows-1251", "cp437", "windows-1252"] {
        let score: i64 = raw.iter().map(|n| score_text(&decode_with(n, page))).sum();
        if score > best.1 {
            best = (page, score);
        }
    }
    Some(best.0)
}

/// The `encoding` argument as one of the code pages known here.
// ponytail: four code pages, not every WHATWG label; any other label falls back to detection.
fn code_page(label: &str) -> Option<&'static str> {
    match trim(label).to_lowercase().as_str() {
        "ibm866" | "cp866" | "866" => Some("ibm866"),
        "windows-1251" | "cp1251" | "1251" => Some("windows-1251"),
        "cp437" | "ibm437" | "437" => Some("cp437"),
        "windows-1252" | "cp1252" | "latin1" => Some("windows-1252"),
        _ => None,
    }
}

// ---------------------------------------------------------------- writing what comes out

/// The one writer every format goes through, and what it noticed on the way.
#[derive(Default)]
struct Unpack {
    out: PathBuf,
    bytes: u64,
    files: usize,
    dirs: usize,
    absolute: usize,
    decoded: Option<&'static str>,
    renamed: Vec<(String, String)>,
    /// Hard links to materialise as copies: (link, target), as mapped paths.
    links: Vec<(String, String)>,
    skipped: Vec<(String, String)>,
    warnings: Vec<String>,
}

impl Unpack {
    fn skip(&mut self, path: &str, reason: impl Into<String>) {
        if self.skipped.len() < 1000 {
            self.skipped.push((path.to_string(), reason.into()));
        }
    }

    /// A stored name as text: UTF-8 when it is, else the given or likeliest legacy code page.
    fn decode(&mut self, raw: &[u8], page: Option<&'static str>) -> String {
        match (std::str::from_utf8(raw), page.or_else(|| detect_code_page(std::iter::once(raw)))) {
            (Ok(text), _) => text.to_string(),
            (Err(_), Some(page)) => {
                self.decoded = Some(page);
                decode_with(raw, page)
            }
            (Err(_), None) => String::from_utf8_lossy(raw).into_owned(),
        }
    }

    /// Where an archive path lands under the output folder, or None when it must not be written at all.
    fn place(&mut self, name: &str) -> Option<PathBuf> {
        if name.split(['/', '\\']).any(|s| s == "..") {
            self.skip(name, "unsafe path ('..' would escape the destination)");
            return None;
        }
        self.absolute += ABSOLUTE.is_match(name) as usize;
        let mut path = self.out.clone();
        for seg in name.split(['/', '\\']).filter(|s| !s.is_empty() && *s != ".") {
            let safe = sanitize_segment(seg);
            if safe != seg && self.renamed.len() < 500 && !self.renamed.iter().any(|r| r.0 == seg) {
                self.renamed.push((seg.to_string(), safe.clone()));
            }
            path.push(safe);
        }
        (path != self.out).then_some(path)
    }

    fn dir(&mut self, name: &str) -> Result<(), String> {
        let Some(path) = self.place(name) else { return Ok(()) };
        if !path.is_dir() {
            self.dirs += 1;
            if self.dirs > MAX_UNPACKED_FILES {
                return Err(format!("Extraction stopped: the archive contains more than {} folders", commas(MAX_UNPACKED_FILES as u64)));
            }
        }
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())
    }

    /// Writes one file, counting every byte against the limit as it lands. False when the entry was refused.
    fn file(&mut self, name: &str, data: &mut dyn Read) -> Result<bool, String> {
        let Some(wanted) = self.place(name) else { return Ok(false) };
        self.files += 1;
        if self.files > MAX_UNPACKED_FILES {
            return Err(format!("Extraction stopped: the archive contains more than {} files", commas(MAX_UNPACKED_FILES as u64)));
        }
        if let Some(parent) = wanted.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // Two entries that land on one name (case, sanitising): the later one gets a number, as 7-Zip's -aou does.
        let (mut path, mut n) = (wanted.clone(), 0);
        while path.symlink_metadata().is_ok() {
            n += 1;
            let ext = wanted.extension().map_or(String::new(), |e| format!(".{}", e.to_string_lossy()));
            path = wanted.with_file_name(format!("{}_{n}{ext}", wanted.file_stem().unwrap_or_default().to_string_lossy()));
        }
        let mut file = File::create(&path).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = data.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                return Ok(true);
            }
            self.bytes += n as u64;
            if self.bytes > MAX_UNPACKED_BYTES {
                return Err(format!("Extraction stopped: the archive unpacks to more than {}", fmt_bytes(MAX_UNPACKED_BYTES)));
            }
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        }
    }
}

fn unreadable(display: &str) -> String {
    format!("{display} could not be read: the archive is damaged or in an unsupported variant.")
}

// ---------------------------------------------------------------- zip

struct ZipEntry {
    name: Vec<u8>,
    flags: u64,
    method: u64,
    crc: u64,
    packed: u64,
    size: u64,
    offset: u64,
    /// Unix mode bits when the entry was made on Unix, else 0.
    unix_mode: u64,
}

/// A little-endian number of `n` bytes at `at`; 0 past the end.
fn le(b: &[u8], at: usize, n: usize) -> u64 {
    b.get(at..at + n).map_or(0, |s| s.iter().rev().fold(0, |acc, &x| acc << 8 | x as u64))
}

/// Every entry of a zip, read from its central directory: the one authoritative list (local headers lie when a
/// streaming writer left the sizes for later).
fn zip_entries(file: &mut File) -> Option<Vec<ZipEntry>> {
    let size = file.metadata().ok()?.len();
    let tail_at = size.saturating_sub(65_557);
    let mut tail = Vec::new();
    file.seek(SeekFrom::Start(tail_at)).ok()?;
    file.read_to_end(&mut tail).ok()?;
    let eocd = tail.windows(4).rposition(|w| w == b"PK\x05\x06")?;
    let (mut count, mut cd_size, cd_offset) = (le(&tail, eocd + 10, 2), le(&tail, eocd + 12, 4), le(&tail, eocd + 16, 4));
    // Bytes glued on in front (a self-extractor) shift every stored offset by the same amount.
    let mut cd_start = (tail_at + eocd as u64).checked_sub(cd_size)?;
    let mut shift = cd_start.wrapping_sub(cd_offset);
    if eocd >= 20 && &tail[eocd - 20..eocd - 16] == b"PK\x06\x07" {
        // Zip64: the real numbers live in their own record.
        let mut record = [0u8; 56];
        file.seek(SeekFrom::Start(le(&tail, eocd - 12, 8))).ok()?;
        file.read_exact(&mut record).ok()?;
        if &record[..4] != b"PK\x06\x06" {
            return None;
        }
        (count, cd_size, cd_start, shift) = (le(&record, 32, 8), le(&record, 40, 8), le(&record, 48, 8), 0);
    }
    if cd_size > size {
        return None;
    }
    let mut cd = vec![0u8; cd_size as usize];
    file.seek(SeekFrom::Start(cd_start)).ok()?;
    file.read_exact(&mut cd).ok()?;
    let (mut entries, mut at) = (Vec::new(), 0usize);
    while (entries.len() as u64) < count && cd.get(at..at + 4) == Some(&b"PK\x01\x02"[..]) {
        let (name_len, extra_len, comment_len) = (le(&cd, at + 28, 2) as usize, le(&cd, at + 30, 2) as usize, le(&cd, at + 32, 2) as usize);
        let mut entry = ZipEntry {
            name: cd.get(at + 46..at + 46 + name_len)?.to_vec(),
            flags: le(&cd, at + 8, 2),
            method: le(&cd, at + 10, 2),
            crc: le(&cd, at + 16, 4),
            packed: le(&cd, at + 20, 4),
            size: le(&cd, at + 24, 4),
            offset: le(&cd, at + 42, 4),
            unix_mode: if le(&cd, at + 5, 1) == 3 { le(&cd, at + 40, 2) } else { 0 },
        };
        // Zip64 extra field: the sizes and offset that did not fit in 32 bits, in this order.
        let extra = cd.get(at + 46 + name_len..at + 46 + name_len + extra_len)?;
        let mut x = 0;
        while x + 4 <= extra.len() {
            if le(extra, x, 2) == 1 {
                let mut p = x + 4;
                for field in [&mut entry.size, &mut entry.packed, &mut entry.offset] {
                    if *field == 0xffff_ffff {
                        *field = le(extra, p, 8);
                        p += 8;
                    }
                }
            }
            x += 4 + le(extra, x + 2, 2) as usize;
        }
        entry.offset = entry.offset.wrapping_add(shift);
        entries.push(entry);
        at += 46 + name_len + extra_len + comment_len;
    }
    Some(entries)
}

fn unzip(file: &mut File, display: &str, encoding: Option<&'static str>, sink: &mut Unpack) -> Result<(), String> {
    let physical = file.metadata().map_or(1, |m| m.len().max(1));
    let entries = zip_entries(file).ok_or_else(|| unreadable(display))?;
    // Encrypted entries cannot be opened here, with or without the password.
    if entries.iter().any(|e| e.flags & 1 != 0) {
        return Err(unreadable(display));
    }
    let page = encoding.or_else(|| detect_code_page(entries.iter().map(|e| e.name.as_slice())));
    let names: Vec<String> = entries.iter().map(|e| sink.decode(&e.name, page)).collect();
    let is_dir = |name: &str| name.ends_with(['/', '\\']);

    // Declared size, file count and compression ratio are checked before a byte is written.
    let files = names.iter().filter(|n| !is_dir(n)).count();
    let dirs = names.len() - files;
    let declared: u64 = entries.iter().zip(&names).filter(|(_, n)| !is_dir(n)).map(|(e, _)| e.size).sum();
    if files > MAX_UNPACKED_FILES || dirs > MAX_UNPACKED_FILES {
        return Err(format!("{display} contains {} files and {} folders, over the limit of {}.", commas(files as u64), commas(dirs as u64), commas(MAX_UNPACKED_FILES as u64)));
    }
    if declared > MAX_UNPACKED_BYTES {
        return Err(format!("{display} would unpack to {}, over the limit of {}.", fmt_bytes(declared), fmt_bytes(MAX_UNPACKED_BYTES)));
    }
    if declared > 1 << 30 && declared / physical > 1000 {
        return Err(format!("{display} declares {} from {} (over 1000:1). Refusing it as a likely zip bomb.", fmt_bytes(declared), fmt_bytes(physical)));
    }

    for (entry, name) in entries.iter().zip(&names) {
        if is_dir(name) {
            sink.dir(name)?;
        } else if entry.unix_mode & 0o170000 == 0o120000 {
            sink.skip(name, "symbolic link (links are not created)");
        } else if entry.method != 0 && entry.method != 8 {
            // ponytail: stored and deflated entries only; deflate64, bzip2, lzma and zstd members are left out.
            sink.skip(name, format!("compression method {} is not supported here", entry.method));
        } else {
            let mut header = [0u8; 30];
            file.seek(SeekFrom::Start(entry.offset)).and_then(|_| file.read_exact(&mut header)).map_err(|_| unreadable(display))?;
            if &header[..4] != b"PK\x03\x04" {
                return Err(unreadable(display));
            }
            // The local header repeats the name and extra fields, and its extra length can differ from the central one.
            file.seek(SeekFrom::Current((le(&header, 26, 2) + le(&header, 28, 2)) as i64)).map_err(|e| e.to_string())?;
            let packed = (&mut *file).take(entry.packed);
            let inner: Box<dyn Read + '_> = if entry.method == 8 { Box::new(flate2::read::DeflateDecoder::new(packed)) } else { Box::new(packed) };
            let mut data = flate2::CrcReader::new(inner);
            if sink.file(name, &mut data)? && data.crc().sum() as u64 != entry.crc {
                return Err(format!("CRC failed in {name}"));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- tar

fn octal(field: &[u8]) -> u64 {
    field.iter().filter(|b| (b'0'..=b'7').contains(*b)).fold(0, |acc, b| acc * 8 + (b - b'0') as u64)
}

/// The records of a pax header: "<length> key=value\n", repeated.
fn pax_records(meta: &[u8]) -> Vec<(&[u8], &[u8])> {
    let (mut out, mut rest) = (Vec::new(), meta);
    while let Some(space) = rest.iter().position(|&b| b == b' ') {
        let Some(len) = std::str::from_utf8(&rest[..space]).ok().and_then(|n| n.parse::<usize>().ok()).filter(|&n| n > space && n <= rest.len()) else { break };
        let record = &rest[space + 1..len];
        let record = record.strip_suffix(b"\n").unwrap_or(record);
        if let Some(eq) = record.iter().position(|&b| b == b'=') {
            out.push((&record[..eq], &record[eq + 1..]));
        }
        rest = &rest[len..];
    }
    out
}

/// Reads a tar from the front: 512-byte headers, each followed by the file rounded up to 512. Long names arrive
/// in a GNU "L" entry or a pax "x" header before the entry they name.
fn untar(input: &mut dyn Read, display: &str, encoding: Option<&'static str>, sink: &mut Unpack) -> Result<(), String> {
    let text = |field: &[u8]| field.split(|&b| b == 0).next().unwrap_or(&[]).to_vec();
    let (mut block, mut long_name, mut long_link, mut first) = ([0u8; 512], None::<Vec<u8>>, None::<Vec<u8>>, true);
    loop {
        // Two zero blocks mark the end; one is enough to stop.
        if input.read_exact(&mut block).is_err() || block.iter().all(|&b| b == 0) {
            return if first { Err(unreadable(display)) } else { Ok(()) };
        }
        // The checksum is the sum of the header's bytes with its own field read as spaces.
        let sum: u64 = block.iter().enumerate().map(|(i, &b)| if (148..156).contains(&i) { 32 } else { b as u64 }).sum();
        if octal(&block[148..156]) != sum {
            return Err(if first { unreadable(display) } else { "damaged tar header".into() });
        }
        first = false;
        let size = if block[124] & 0x80 != 0 { block[125..136].iter().fold(0u64, |acc, &b| acc << 8 | b as u64) } else { octal(&block[124..136]) };
        let kind = block[156];
        let mut data = (&mut *input).take(size);
        if matches!(kind, b'L' | b'K' | b'x' | b'g') {
            if size > 1 << 20 {
                return Err("damaged tar header".into());
            }
            let mut meta = Vec::new();
            data.read_to_end(&mut meta).map_err(|e| e.to_string())?;
            match kind {
                b'L' => long_name = Some(text(&meta)),
                b'K' => long_link = Some(text(&meta)),
                b'x' => {
                    for (key, value) in pax_records(&meta) {
                        match key {
                            b"path" => long_name = Some(value.to_vec()),
                            b"linkpath" => long_link = Some(value.to_vec()),
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        } else {
            let raw_name = long_name.take().unwrap_or_else(|| {
                let (name, prefix) = (text(&block[..100]), if &block[257..262] == b"ustar" { text(&block[345..500]) } else { Vec::new() });
                if prefix.is_empty() { name } else { [prefix.as_slice(), b"/", name.as_slice()].concat() }
            });
            let raw_link = long_link.take().unwrap_or_else(|| text(&block[157..257]));
            let (name, link) = (sink.decode(&raw_name, encoding), sink.decode(&raw_link, encoding));
            match kind {
                b'5' => sink.dir(&name)?,
                b'0' | 0 | b'7' if name.ends_with('/') => sink.dir(&name)?,
                b'0' | 0 | b'7' => {
                    sink.file(&name, &mut data)?;
                }
                b'2' => sink.skip(&name, format!("symbolic link → {link} (links are not created)")),
                b'1' => sink.links.push((map_path(&name), map_path(&link))),
                _ => sink.skip(&name, "special file (device/fifo/socket, not created)"),
            }
        }
        std::io::copy(&mut data, &mut std::io::sink()).map_err(|e| e.to_string())?;
        if data.limit() > 0 {
            return Err("unexpected end of archive".into());
        }
        std::io::copy(&mut (&mut *input).take((512 - size % 512) % 512), &mut std::io::sink()).map_err(|e| e.to_string())?;
    }
}

// ---------------------------------------------------------------- one pass: open, check, write

/// Unpacks one archive into `sink.out`. For gzip the one stream inside is written as a file named after the archive.
fn unpack(abs: &Path, display: &str, kind: &str, encoding: Option<&'static str>, sink: &mut Unpack) -> Result<(), String> {
    let mut file = File::open(abs).map_err(|e| format!("Extraction failed: {e}"))?;
    let done = match kind {
        "zip" => unzip(&mut file, display, encoding, sink),
        "tar" => untar(&mut std::io::BufReader::new(file), display, encoding, sink),
        "gzip" => {
            // ponytail: named after the archive ("x.tgz" → "x.tar"); 7-Zip prefers the name stored in the gzip header.
            let name = abs.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let lower = name.to_lowercase();
            let produced = match lower.rsplit_once('.') {
                Some((_, "gz" | "gzip")) => name[..name.rfind('.').unwrap_or(name.len())].to_string(),
                Some((_, "tgz" | "tpz")) => format!("{}.tar", &name[..name.rfind('.').unwrap_or(name.len())]),
                _ => name,
            };
            sink.file(&produced, &mut flate2::read::MultiGzDecoder::new(std::io::BufReader::new(file))).map(|_| ())
        }
        _ => return Err(unreadable(display)),
    };
    done.map_err(|e| if e.starts_with("Extraction stopped") || e.starts_with(display) { e } else { format!("{display} could not be fully extracted: {e}. Nothing was written.") })?;
    if sink.absolute > 0 {
        let n = std::mem::take(&mut sink.absolute);
        sink.warnings.push(format!("{n} entr{} an absolute path; extracted relative to the destination instead.", if n == 1 { "y has" } else { "ies have" }));
    }
    if let Some(page) = sink.decoded.take() {
        sink.warnings.push(format!("Some names were stored in a legacy code page, not UTF-8; decoded them as {page}."));
    }
    if !sink.renamed.is_empty() {
        let renamed = std::mem::take(&mut sink.renamed);
        let sample: Vec<String> = renamed.iter().take(3).map(|(a, b)| format!("'{a}' → '{b}'")).collect();
        sink.warnings.push(format!("Renamed {}{} name{} that are not valid on Windows (e.g. {}).", renamed.len(), if renamed.len() >= 500 { "+" } else { "" }, plural(renamed.len()), sample.join(", ")));
    }
    Ok(())
}

// ---------------------------------------------------------------- placing the output

struct Extracted {
    /// Workspace-relative folder the files landed in ("." for the root).
    dest: String,
    files: usize,
    dirs: usize,
    bytes: u64,
    /// Workspace-relative files, shallowest first, capped at MAX_LISTED_ENTRIES.
    entries: Vec<(String, u64)>,
    /// Archives found inside (not extracted).
    nested: Vec<String>,
    skipped: Vec<(String, String)>,
    warnings: Vec<String>,
    /// Exact per-folder totals from the full walk, for folders up to three levels below dest: (path, files, bytes).
    folders: Vec<(String, usize, u64)>,
    /// Exact file-type histogram from the full walk, most common first.
    file_types: Vec<(String, usize, u64)>,
}

/// rename() that waits out Windows' transient "access denied" (indexers, antivirus) on a folder just written.
fn rename_retry(from: &Path, to: &Path) -> Result<(), String> {
    let mut attempt = 0;
    loop {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            // Windows reports a taken destination as access denied too; that will not clear.
            Err(e) if attempt < 6 && e.kind() == std::io::ErrorKind::PermissionDenied && to.symlink_metadata().is_err() => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(80 * attempt));
            }
            Err(e) => return Err(format!("Extraction failed: {e}")),
        }
    }
}

fn make_temp(parent: &Path) -> Result<PathBuf, String> {
    use std::hash::{BuildHasher, Hasher};
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let dir = parent.join(format!("{TEMP_PREFIX}{now:x}-{:08x}", std::collections::hash_map::RandomState::new().build_hasher().finish() as u32));
    std::fs::create_dir_all(parent).and_then(|_| std::fs::create_dir(&dir)).map_err(|e| format!("Extraction failed: {e}"))?;
    Ok(dir)
}

fn is_empty_dir(path: &Path) -> bool {
    std::fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_none())
}

/// Pick `base`, `base-2`, …: the first that is missing or an empty folder.
fn unique_dir(root: &Path, parent: &str, base: &str) -> Result<String, String> {
    (1..10_000)
        .map(|n| join_rel(&[parent, &if n == 1 { base.to_string() } else { format!("{base}-{n}") }]))
        .find(|rel| resolve(root, rel).is_ok_and(|abs| abs.symlink_metadata().map_or(true, |st| st.is_dir() && is_empty_dir(&abs))))
        .ok_or_else(|| format!("No free folder name for {base}"))
}

fn unique_file(root: &Path, dir: &str, name: &str) -> Result<String, String> {
    let (stem, ext) = name.rfind('.').filter(|&dot| dot > 0).map_or((name, ""), |dot| name.split_at(dot));
    (1..10_000)
        .map(|n| join_rel(&[dir, &if n == 1 { name.to_string() } else { format!("{stem}-{n}{ext}") }]))
        .find(|rel| resolve(root, rel).is_ok_and(|abs| abs.symlink_metadata().is_err()))
        .ok_or_else(|| format!("No free file name for {name}"))
}

/// Merges `src` into an existing, non-empty destination. Never overwrites a file, never writes into the app's own
/// folders or into a .git. `not_moved` collects the source-relative paths left behind.
fn merge_into(root: &Path, src: &Path, rel: &str, dest: &str, not_moved: &mut Vec<String>, sink: &mut Unpack) -> Result<(), String> {
    let dir = if rel.is_empty() { src.to_path_buf() } else { src.join(rel) };
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("Extraction failed: {e}"))?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let child = if rel.is_empty() { name } else { format!("{rel}/{name}") };
        let ws_rel = join_rel(&[dest, &child]);
        let target = resolve(root, &ws_rel)?;
        if is_protected_path(&ws_rel) {
            sink.skip(&child, format!("would write {ws_rel}, a protected path (.git, .history, .snapshots)"));
            not_moved.push(child);
            continue;
        }
        match target.symlink_metadata() {
            Err(_) => rename_retry(&entry.path(), &target)?,
            Ok(there) if there.is_dir() && entry.path().is_dir() => merge_into(root, src, &child, dest, not_moved, sink)?,
            Ok(_) => {
                sink.skip(&child, format!("{ws_rel} already exists (kept the existing one)"));
                not_moved.push(child);
            }
        }
    }
    Ok(())
}

/// Every file and folder of the unpacked tree, in the order the web walks it: (files with sizes, folders).
fn walk_output(root: &Path) -> Result<(Vec<(String, u64)>, Vec<String>), String> {
    let (mut files, mut dirs, mut stack) = (Vec::new(), Vec::new(), vec![String::new()]);
    while let Some(rel) = stack.pop() {
        let abs = if rel.is_empty() { root.to_path_buf() } else { root.join(&rel) };
        for entry in std::fs::read_dir(&abs).map_err(|e| format!("Extraction failed: {e}"))?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let child = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => {
                    dirs.push(child.clone());
                    stack.push(child);
                }
                Ok(kind) if kind.is_file() => files.push((child, entry.metadata().map_or(0, |m| m.len()))),
                _ => {}
            }
        }
    }
    Ok((files, dirs))
}

/// Shallowest first, then by name.
fn by_depth(a: &str, b: &str) -> std::cmp::Ordering {
    a.split('/').count().cmp(&b.split('/').count()).then_with(|| a.cmp(b))
}

/// Unpacks an archive that is already in the workspace. Folders land next to the archive in a folder named after
/// it (`uploads/game.zip` → `uploads/game/`, or `game-2/` if that is taken); when the archive holds a single
/// top-level folder of that same name its contents are hoisted, so the result is not `game/game/`. A lone gzip
/// (`data.json.gz`) produces the file itself; a compressed tar is unpacked fully. An explicit `dest` folder that
/// already has files is merged into without overwriting anything.
fn extract(root: &Path, archive: &str, dest: &str, encoding: Option<&'static str>, temps: &mut Vec<PathBuf>) -> Result<Extracted, String> {
    let rel = trim(archive).replace('\\', "/");
    let rel = rel.strip_prefix("./").unwrap_or(&rel).to_string();
    let abs = inside(root, &rel)?;
    let meta = abs.symlink_metadata().map_err(|_| format!("{rel} does not exist in the workspace"))?;
    if !meta.is_file() {
        return Err(format!("{rel} is not a file"));
    }
    let name = abs.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let head_of = |path: &Path| {
        let mut head = Vec::new();
        File::open(path).and_then(|f| f.take(HEAD_BYTES as u64).read_to_end(&mut head)).map(|_| head).map_err(|e| format!("Extraction failed: {e}"))
    };
    let kind = sniff(&head_of(&abs)?, &name, true).ok_or_else(|| format!("{rel} is not a recognised archive"))?;
    let parent_of = |path: &str| path.rsplit_once('/').map_or(String::new(), |(dir, _)| dir.to_string());
    let archive_dir = parent_of(&rel);
    let dest = trim(dest).replace('\\', "/");
    if dest.is_empty() && is_protected_path(&archive_dir) {
        return Err(format!("{rel} is inside a protected folder; pass a destination folder to extract it elsewhere."));
    }
    let explicit = if dest.is_empty() {
        None
    } else {
        let clean = if dest.trim_end_matches('/').is_empty() { "." } else { dest.trim_end_matches('/') };
        if clean != "." && is_protected_path(clean) {
            return Err(format!("{clean} is a protected folder; choose another destination."));
        }
        resolve(root, clean).map_err(|e| format!("Invalid destination {clean}: {e}"))?;
        Some(clean.to_string())
    };

    // Temp folders are siblings of where the output will land, so the final move is a rename on the same volume.
    let temp_parent = match explicit.as_deref().map_or(archive_dir.clone(), parent_of) {
        dir if dir.is_empty() => root.to_path_buf(),
        dir => resolve(root, &dir)?,
    };
    // Temp folders left behind by a crash: a finished run always removes its own.
    for stale in std::fs::read_dir(&temp_parent).into_iter().flatten().flatten().filter(|e| e.file_name().to_string_lossy().starts_with(TEMP_PREFIX)) {
        if stale.metadata().is_ok_and(|m| m.is_dir() && m.modified().is_ok_and(|t| t.elapsed().is_ok_and(|age| age.as_secs() > 24 * 3600))) {
            let _ = std::fs::remove_dir_all(stale.path());
        }
    }

    let mut out_root = make_temp(&temp_parent)?;
    temps.push(out_root.clone());
    let mut sink = Unpack { out: out_root.clone(), ..Default::default() };
    unpack(&abs, &rel, kind, encoding, &mut sink)?;

    if kind == "gzip" {
        // gzip holds one stream: a tar to unpack further, or the result itself.
        let produced: Vec<PathBuf> = std::fs::read_dir(&out_root).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
        let [inner] = produced.as_slice() else { return Err(format!("{rel} did not decompress to a single file")) };
        let inner_name = inner.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let inner_kind = sniff(&head_of(inner)?, &inner_name, true);
        match inner_kind.filter(|k| *k == "tar" || TAR_BY_NAME.is_match(&name) || inner_name.to_lowercase().ends_with(".tar")) {
            Some(inner_kind) => {
                out_root = make_temp(&temp_parent)?;
                temps.push(out_root.clone());
                sink = Unpack { out: out_root.clone(), skipped: sink.skipped, warnings: sink.warnings, ..Default::default() };
                unpack(inner, &format!("{rel} (inner {inner_name})"), inner_kind, encoding, &mut sink)?;
            }
            None => {
                let stripped = COMPRESSOR_EXT.replace(&name, "").into_owned();
                let file_name = if !stripped.is_empty() && stripped != name { stripped } else if inner_name != name { inner_name } else { format!("{name}.out") };
                let dir = explicit.unwrap_or(if archive_dir.is_empty() { ".".into() } else { archive_dir });
                let dir_abs = if dir == "." { root.to_path_buf() } else { resolve(root, &dir)? };
                std::fs::create_dir_all(&dir_abs).map_err(|e| format!("Extraction failed: {e}"))?;
                let final_rel = unique_file(root, &dir, &map_path(&file_name))?;
                rename_retry(inner, &resolve(root, &final_rel)?)?;
                let nested = if sniff(&[], &final_rel, false).is_some() { vec![final_rel.clone()] } else { Vec::new() };
                return Ok(Extracted { dest: dir, files: 1, dirs: 0, bytes: sink.bytes, entries: vec![(final_rel, sink.bytes)], nested, skipped: sink.skipped, warnings: sink.warnings, folders: Vec::new(), file_types: Vec::new() });
            }
        }
    }

    // Hard links become ordinary copies of their target, when it was extracted.
    let links = std::mem::take(&mut sink.links);
    for (link, target) in &links {
        let (from, to) = (out_root.join(target), out_root.join(link));
        if !from.is_file() || to.symlink_metadata().is_ok() {
            sink.skip(link, format!("hard link to {target} (target not extracted)"));
        } else if let Some(parent) = to.parent() {
            let _ = std::fs::create_dir_all(parent).and_then(|_| std::fs::copy(&from, &to));
        }
    }
    if !links.is_empty() {
        sink.warnings.push(format!("{} hard link{} extracted as a copy of the linked file.", links.len(), if links.len() == 1 { " was" } else { "s were" }));
    }
    let (walked_files, walked_dirs) = walk_output(&out_root)?;

    // Choose the destination and move the tree into place.
    let base = map_path(&strip_archive_ext(&name));
    let (mut src, mut prefix, mut not_moved) = (out_root.clone(), String::new(), Vec::new());
    let dest_rel = match explicit {
        Some(dest_rel) => {
            let dest_abs = if dest_rel == "." { root.to_path_buf() } else { resolve(root, &dest_rel)? };
            let there = dest_abs.symlink_metadata().ok();
            if there.as_ref().is_some_and(|st| !st.is_dir()) {
                return Err(format!("{dest_rel} exists and is not a folder"));
            }
            if there.is_none() || is_empty_dir(&dest_abs) {
                let _ = std::fs::remove_dir(&dest_abs);
                dest_abs.parent().map(std::fs::create_dir_all).transpose().map_err(|e| format!("Extraction failed: {e}"))?;
                rename_retry(&src, &dest_abs)?;
            } else {
                merge_into(root, &src, "", &dest_rel, &mut not_moved, &mut sink)?;
            }
            dest_rel
        }
        None => {
            let top: Vec<PathBuf> = std::fs::read_dir(&out_root).into_iter().flatten().flatten().map(|e| e.path()).collect();
            if let [only] = top.as_slice() && only.is_dir() && only.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase() == base.to_lowercase()) {
                prefix = format!("{}/", only.file_name().unwrap_or_default().to_string_lossy());
                src = only.clone();
            }
            // A default destination is always a fresh folder.
            let dest_rel = unique_dir(root, &archive_dir, &base)?;
            let dest_abs = resolve(root, &dest_rel)?;
            let _ = std::fs::remove_dir(&dest_abs);
            dest_abs.parent().map(std::fs::create_dir_all).transpose().map_err(|e| format!("Extraction failed: {e}"))?;
            rename_retry(&src, &dest_abs)?;
            dest_rel
        }
    };

    // Report what is really there now.
    let moved = |rel: &str| !not_moved.iter().any(|left: &String| rel == left || rel.strip_prefix(left.as_str()).is_some_and(|rest| rest.starts_with('/')));
    let (mut entries, mut bytes) = (Vec::new(), 0);
    let mut folder_totals: HashMap<String, (usize, u64)> = HashMap::new();
    let mut file_types: Vec<(String, usize, u64)> = Vec::new();
    let moved_dirs: Vec<&str> = walked_dirs.iter().filter_map(|d| d.strip_prefix(prefix.as_str())).filter(|d| moved(d)).collect();
    for dir in moved_dirs.iter().filter(|d| d.split('/').count() <= 3) {
        folder_totals.insert(dir.to_string(), (0, 0));
    }
    for (path, size) in &walked_files {
        let Some(rel) = path.strip_prefix(prefix.as_str()).filter(|rel| moved(rel)) else { continue };
        entries.push((join_rel(&[&dest_rel, rel]), *size));
        bytes += size;
        let parts: Vec<&str> = rel.split('/').collect();
        for depth in 1..parts.len().min(4) {
            let total = folder_totals.entry(parts[..depth].join("/")).or_default();
            *total = (total.0 + 1, total.1 + size);
        }
        let ext = ext_of(rel);
        let key = if ext.is_empty() { "(no ext)".to_string() } else { format!(".{ext}") };
        match file_types.iter_mut().find(|t| t.0 == key) {
            Some(t) => (t.1, t.2) = (t.1 + 1, t.2 + size),
            None => file_types.push((key, 1, *size)),
        }
    }
    let files = entries.len();
    entries.sort_by(|a, b| by_depth(&a.0, &b.0));
    let nested: Vec<String> = entries.iter().map(|e| &e.0).filter(|p| sniff(&[], p, false).is_some()).take(200).cloned().collect();
    let mut folders: Vec<(String, usize, u64)> = folder_totals.into_iter().map(|(dir, (files, bytes))| (join_rel(&[&dest_rel, &dir]), files, bytes)).collect();
    folders.sort_by(|a, b| by_depth(&a.0, &b.0));
    folders.truncate(2000);
    file_types.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)));
    entries.truncate(MAX_LISTED_ENTRIES);
    Ok(Extracted { dest: dest_rel, files, dirs: moved_dirs.len(), bytes, entries, nested, skipped: sink.skipped, warnings: sink.warnings, folders, file_types })
}

// ---------------------------------------------------------------- the map of what came out

#[derive(Default)]
struct Node {
    name: String,
    dirs: Vec<Node>,
    files: Vec<(String, u64)>,
    count: usize,
    bytes: u64,
    /// The true totals from the full walk, when the listing under this folder was capped.
    exact: Option<(usize, u64)>,
}

impl Node {
    fn child(&mut self, name: &str) -> &mut Node {
        let at = self.dirs.iter().position(|d| d.name == name).unwrap_or_else(|| {
            self.dirs.push(Node { name: name.to_string(), ..Default::default() });
            self.dirs.len() - 1
        });
        &mut self.dirs[at]
    }

    fn total(&self) -> (usize, u64) {
        self.exact.unwrap_or((self.count, self.bytes))
    }
}

fn render(node: &Node, depth: usize, indent: &str, max_depth: usize, caps: (usize, usize), out: &mut Vec<String>) {
    let count = |n: usize, word: &str| format!("{} {word}{}", commas(n as u64), plural(n));
    let mut dirs: Vec<&Node> = node.dirs.iter().collect();
    dirs.sort_by(|a, b| locale_order(&a.name, &b.name));
    for dir in dirs.iter().take(caps.0) {
        // Collapse chains of single-folder directories: a/b/c/
        let (mut cur, mut label) = (*dir, dir.name.clone());
        while cur.files.is_empty() && cur.dirs.len() == 1 && cur.dirs[0].total().0 == cur.total().0 {
            cur = &cur.dirs[0];
            label = format!("{label}/{}", cur.name);
        }
        let (files, bytes) = cur.total();
        out.push(format!("{indent}{label}/  ({})", if files > 0 { format!("{}, {}", count(files, "file"), fmt_bytes(bytes)) } else { "empty".into() }));
        if depth + 1 < max_depth {
            render(cur, depth + 1, &format!("{indent}  "), max_depth, caps, out);
        }
    }
    if dirs.len() > caps.0 {
        let rest = &dirs[caps.0..];
        out.push(format!("{indent}… {} ({}, {})", count(rest.len(), "more folder"), count(rest.iter().map(|d| d.total().0).sum(), "file"), fmt_bytes(rest.iter().map(|d| d.total().1).sum())));
    }
    let mut files: Vec<&(String, u64)> = node.files.iter().collect();
    files.sort_by(|a, b| locale_order(&a.0, &b.0));
    files.truncate(caps.1);
    for (name, bytes) in &files {
        out.push(format!("{indent}{name}  ({})", fmt_bytes(*bytes)));
    }
    // Everything under this folder not accounted for by a line above.
    let (all_files, all_bytes) = node.total();
    let more = all_files as i64 - files.len() as i64 - dirs.iter().map(|d| d.total().0 as i64).sum::<i64>();
    let more_bytes = all_bytes as i64 - files.iter().map(|f| f.1 as i64).sum::<i64>() - dirs.iter().map(|d| d.total().1 as i64).sum::<i64>();
    if more > 0 {
        out.push(format!("{indent}… {} ({})", count(more as usize, "more file"), fmt_bytes(more_bytes.max(0) as u64)));
    }
}

/// A compact, model-facing manifest of an extraction: counts, a directory tree (collapsed to fit), a file-type
/// histogram, notable files, nested archives, and anything skipped or worth a warning.
fn summary(r: &Extracted) -> String {
    const MAX_TREE: usize = 60;
    const CAPS: [(usize, usize); 5] = [(12, 8), (8, 5), (5, 3), (3, 2), (1, 1)];
    let shown_dest = if r.dest == "." { "./".to_string() } else { format!("{}/", r.dest) };
    let mut lines = vec![format!(
        "Extracted {} file{}{} ({}) to {}",
        commas(r.files as u64),
        plural(r.files),
        if r.dirs > 0 { format!(" in {} folder{}", commas(r.dirs as u64), plural(r.dirs)) } else { String::new() },
        fmt_bytes(r.bytes),
        if r.dest == "." { "the workspace root" } else { shown_dest.as_str() }
    )];

    // Tree, relative to dest.
    let prefix = if r.dest == "." { String::new() } else { shown_dest.clone() };
    let mut root = Node { name: ".".into(), exact: Some((r.files, r.bytes)), ..Default::default() };
    for (path, bytes) in &r.entries {
        let mut parts: Vec<&str> = path.strip_prefix(prefix.as_str()).unwrap_or(path).split('/').collect();
        let file = parts.pop().unwrap_or("");
        let mut node = &mut root;
        (node.count, node.bytes) = (node.count + 1, node.bytes + bytes);
        for part in parts {
            node = node.child(part);
            (node.count, node.bytes) = (node.count + 1, node.bytes + bytes);
        }
        node.files.push((file.to_string(), *bytes));
    }
    for (path, files, bytes) in &r.folders {
        let mut node = &mut root;
        for part in path.strip_prefix(prefix.as_str()).unwrap_or(path).split('/').filter(|p| !p.is_empty()) {
            node = node.child(part);
        }
        node.exact = Some((*files, *bytes));
    }
    // Widest listing that fits at the top level, then as deep as still fits.
    let tree_at = |depth: usize, caps: (usize, usize)| {
        let mut out = Vec::new();
        render(&root, 0, "  ", depth, caps, &mut out);
        out
    };
    let caps = CAPS.into_iter().find(|&caps| tree_at(1, caps).len() <= MAX_TREE).unwrap_or(CAPS[4]);
    let mut tree = tree_at(1, caps);
    for depth in 2..=8 {
        let next = tree_at(depth, caps);
        if next.len() > MAX_TREE || next.len() == tree.len() {
            break;
        }
        tree = next;
    }
    if tree.len() > MAX_TREE {
        let hidden = tree.len() - MAX_TREE + 1;
        tree.truncate(MAX_TREE - 1);
        tree.push(format!("  … {hidden} more lines"));
    }
    if r.files > 0 || r.dirs > 0 {
        lines.push(String::new());
        lines.push(shown_dest);
        lines.extend(tree);
    }

    if r.file_types.len() > 1 {
        let mut shown: Vec<String> = r.file_types.iter().take(10).map(|(ext, n, bytes)| format!("{ext} {} ({})", commas(*n as u64), fmt_bytes(*bytes))).collect();
        if r.file_types.len() > 10 {
            shown.push(format!("{} other types", r.file_types.len() - 10));
        }
        lines.push(String::new());
        lines.push(format!("File types: {}", shown.join(" · ")));
    }
    let notable = |path: &str| {
        let base = path.rsplit('/').next().unwrap_or("").to_lowercase();
        base == "readme" || base.starts_with("readme.") || NOTABLE_NAMES.contains(&base.as_str()) || NOTABLE_EXTS.contains(&ext_of(&base).as_str())
    };
    let notable: Vec<String> = r.entries.iter().filter(|e| notable(&e.0)).take(15).map(|(path, bytes)| format!("  {path}  ({})", fmt_bytes(*bytes))).collect();
    if !notable.is_empty() {
        lines.push(String::new());
        lines.push("Notable files:".into());
        lines.extend(notable);
    }
    if !r.nested.is_empty() {
        lines.push(String::new());
        lines.push(format!("Nested archives ({}, NOT extracted — call extract_archive on one if you need its contents):", r.nested.len()));
        for path in r.nested.iter().take(20) {
            lines.push(format!("  {path}{}", r.entries.iter().find(|e| &e.0 == path).map_or(String::new(), |e| format!("  ({})", fmt_bytes(e.1)))));
        }
        if r.nested.len() > 20 {
            lines.push(format!("  … {} more", r.nested.len() - 20));
        }
    }
    if !r.skipped.is_empty() {
        lines.push(String::new());
        lines.push(format!("Skipped {}:", r.skipped.len()));
        lines.extend(r.skipped.iter().take(15).map(|(path, reason)| format!("  {path} — {reason}")));
        if r.skipped.len() > 15 {
            lines.push(format!("  … {} more", r.skipped.len() - 15));
        }
    }
    if !r.warnings.is_empty() {
        lines.push(String::new());
        lines.push("Warnings:".into());
        lines.extend(r.warnings.iter().take(10).map(|w| format!("  {w}")));
    }
    lines.join("\n")
}

/// Unpacks an archive that is in the workspace, fully and byte-exact, with its folders, and returns a map of what
/// came out. Nothing is written outside the destination, links are not created, nothing is executed.
pub fn extract_archive(root: &Path, args: &Value) -> Output {
    let archive = str_arg(args, "path");
    if archive.is_empty() {
        return bad("Error: path is required.", "No path given");
    }
    let mut temps = Vec::new();
    let result = extract(root, archive, str_arg(args, "dest"), code_page(str_arg(args, "encoding")), &mut temps);
    // Any failure removes the temporary folder, so nothing half-written is ever visible.
    for temp in &temps {
        let _ = std::fs::remove_dir_all(temp);
    }
    match result {
        Ok(r) => Output::ok(format!("Unpacked {archive}.\n{}", summary(&r)), format!("Unpacked {} file{} into {}", commas(r.files as u64), plural(r.files), r.dest)).changed(&r.dest),
        Err(e) => bad(format!("Error: {e}"), clip_utf16(&e, 80)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn workspace(name: &str, files: &[(&str, &[u8])]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("apim-data-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (rel, bytes) in files {
            std::fs::write(dir.join(rel), bytes).unwrap();
        }
        dir
    }

    /// A zip of stored entries, built by hand.
    fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let (mut out, mut cd) = (Vec::new(), Vec::new());
        for &(name, data) in entries {
            let mut crc = flate2::Crc::new();
            crc.update(data);
            let (offset, size, name_len) = (out.len() as u32, (data.len() as u32).to_le_bytes(), (name.len() as u16).to_le_bytes());
            // version, flags (UTF-8 names), method, time, date; then crc, sizes, name and extra lengths
            let common = [&[20, 0, 0, 8, 0, 0, 0, 0, 0, 0][..], &crc.sum().to_le_bytes(), &size, &size, &name_len, &[0, 0]].concat();
            out.extend([&b"PK\x03\x04"[..], common.as_slice(), name.as_bytes(), data].concat());
            cd.extend([&b"PK\x01\x02"[..], &[20, 0], common.as_slice(), &[0; 10], &offset.to_le_bytes(), name.as_bytes()].concat());
        }
        let (count, cd_size, cd_at) = ((entries.len() as u16).to_le_bytes(), (cd.len() as u32).to_le_bytes(), (out.len() as u32).to_le_bytes());
        out.extend(cd);
        out.extend([&b"PK\x05\x06"[..], &[0; 4], &count, &count, &cd_size, &cd_at, &[0, 0]].concat());
        out
    }

    fn tar(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        for (name, data) in entries {
            let mut header = [0u8; 512];
            header[..name.len()].copy_from_slice(name.as_bytes());
            header[124..136].copy_from_slice(format!("{:011o}\0", data.len()).as_bytes());
            header[148..156].copy_from_slice(b"        ");
            header[156] = b'0';
            header[257..262].copy_from_slice(b"ustar");
            let sum: u32 = header.iter().map(|&b| b as u32).sum();
            header[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
            out.extend(header);
            out.extend(*data);
            out.resize(out.len().div_ceil(512) * 512, 0);
        }
        out.resize(out.len() + 1024, 0);
        out
    }

    fn gz(data: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn query_data_describes_and_queries() {
        let json = br#"{"items":[{"id":1,"price":5,"tags":["a"]},{"id":2,"price":15,"name":"x"},{"id":3,"price":"20"}],"total":3}"#;
        let ws = workspace("query", &[("d.json", json), ("t.csv", b"name,qty\nbolt,4\nnut,10\n")]);
        let shape = query_data(&ws, &json!({ "path": "d.json" })).text;
        assert!(
            shape.starts_with("d.json\nJSON · 0.0MB\nStructure (sampled; ranges and examples are from the sample):\n$: object\n  .items: array [3]\n    [*]: object\n      .id: number 1..3\n      .price: number 67% | string 33% 5..15 (numeric text) 20..20\n      .tags (in 33%): array [1]\n        [*]: string e.g. \"a\"\n      .name (in 33%): string e.g. \"x\"\n  .total: number = 3\n\nQuery it with JSONPath, e.g. query \"$.<key>\"."),
            "{shape}"
        );
        let out = query_data(&ws, &json!({ "path": "d.json", "query": "$.items[?(@.price > 10)].id" }));
        assert_eq!(out.text, "2 match(es) for $.items[?(@.price > 10)].id — showing 1–2\n$.items[1].id = 2\n$.items[2].id = 3");
        assert_eq!(query_data(&ws, &json!({ "path": "d.json", "query": "$..id", "count": true })).text, "3 match(es) for $..id");
        assert_eq!(query_data(&ws, &json!({ "path": "d.json", "query": "$.items[-1]", "fields": ["id", "nope"] })).text, "1 match(es) for $.items[-1] — showing 1–1\n$.items[2] = {\"id\":3}");
        assert_eq!(query_data(&ws, &json!({ "path": "d.json", "query": "$.items[?(@.name =~ /^X/i || @.tags.length == 1)].id", "limit": 1 })).text.lines().last().unwrap(), "…1 more. Use offset:1 for the next page, fields to pick columns, or save_as to write all matches to a file.");
        assert_eq!(query_data(&ws, &json!({ "path": "t.csv", "query": "$[?(@.qty >= 10)]" })).text, "1 match(es) for $[?(@.qty >= 10)] — showing 1–1\n$[1] = {\"name\":\"nut\",\"qty\":\"10\"}");
        assert!(query_data(&ws, &json!({ "path": "t.csv" })).text.starts_with("t.csv\nCSV · 0.0MB · 2 rows · columns: name, qty\n"));

        let saved = query_data(&ws, &json!({ "path": "d.json", "query": "$.items[0:2]", "save_as": "out/sub.json" }));
        assert_eq!((saved.text.as_str(), saved.changed.as_deref()), ("Wrote 2 match(es) for $.items[0:2] to out/sub.json (0KB).", Some("out/sub.json")));
        assert!(std::fs::read_to_string(ws.join("out/sub.json")).unwrap().starts_with("[\n  {\n    \"id\": 1,\n    \"price\": 5,\n    \"tags\": [\n      \"a\"\n    ]\n  },\n  {"));
        assert_eq!(query_data(&ws, &json!({ "path": "d.json", "query": "$.items[" })).text, "Error: Unclosed [ in $.items[");
        assert!(query_data(&ws, &json!({ "path": "nope.json" })).text.starts_with("Error: ENOENT: no such file or directory, stat '"));
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn extract_archive_unpacks_zip_tar_and_gzip() {
        let project = zip(&[("proj/README.md", b"hi"), ("proj/src/main.rs", b"fn main() {}"), ("proj/../evil.txt", b"x"), ("proj/inner.zip", b"PK")]);
        let ws = workspace("extract", &[("proj.zip", &project), ("pack.tar.gz", &gz(&tar(&[("a/b.txt", b"hello")]))), ("notes.txt.gz", &gz(b"hello")), ("x.7z", b"7z\xbc\xaf\x27\x1c\0\0"), ("x.txt", b"plain")]);

        // A single top folder named like the archive is hoisted: proj/, not proj/proj/.
        let out = extract_archive(&ws, &json!({ "path": "proj.zip" }));
        assert!(out.ok && out.text.starts_with("Unpacked proj.zip.\nExtracted 3 files in 1 folder (16 B) to proj/\n\nproj/\n  src/  (1 file, 12 B)\n    main.rs  (12 B)\n  inner.zip  (2 B)\n  README.md  (2 B)\n\nFile types: "), "{}", out.text);
        assert!(out.text.contains("\n\nNotable files:\n  proj/README.md  (2 B)\n  proj/src/main.rs  (12 B)\n\nNested archives (1, NOT extracted — call extract_archive on one if you need its contents):\n  proj/inner.zip  (2 B)\n\nSkipped 1:\n  proj/../evil.txt — unsafe path ('..' would escape the destination)"), "{}", out.text);
        assert_eq!((out.summary.as_str(), out.changed.as_deref()), ("Unpacked 3 files into proj", Some("proj")));
        assert_eq!(std::fs::read_to_string(ws.join("proj/src/main.rs")).unwrap(), "fn main() {}");
        assert_eq!(extract_archive(&ws, &json!({ "path": "proj.zip" })).summary, "Unpacked 3 files into proj-2");
        // Into a folder that has files: merged, nothing overwritten.
        let merged = extract_archive(&ws, &json!({ "path": "proj.zip", "dest": "." }));
        assert!(merged.text.contains("Extracted 0 files in 2 folders (0 B) to the workspace root") && merged.text.contains("  proj/src/main.rs — proj/src/main.rs already exists (kept the existing one)"), "{}", merged.text);

        let out = extract_archive(&ws, &json!({ "path": "pack.tar.gz" }));
        assert!(out.text.starts_with("Unpacked pack.tar.gz.\nExtracted 1 file in 1 folder (5 B) to pack/\n\npack/\n  a/  (1 file, 5 B)\n    b.txt  (5 B)"), "{}", out.text);
        assert_eq!(std::fs::read_to_string(ws.join("pack/a/b.txt")).unwrap(), "hello");
        let out = extract_archive(&ws, &json!({ "path": "notes.txt.gz" }));
        assert_eq!((out.text.as_str(), out.summary.as_str()), ("Unpacked notes.txt.gz.\nExtracted 1 file (5 B) to the workspace root\n\n./\n  notes.txt  (5 B)", "Unpacked 1 file into ."));

        assert_eq!(extract_archive(&ws, &json!({ "path": "x.7z" })).text, "Error: x.7z could not be read: the archive is damaged or in an unsupported variant.");
        assert_eq!(extract_archive(&ws, &json!({ "path": "x.txt" })).text, "Error: x.txt is not a recognised archive");
        assert_eq!(extract_archive(&ws, &json!({ "path": "gone.zip" })).text, "Error: gone.zip does not exist in the workspace");
        // No temp folder survives, and nothing escaped.
        assert!(!std::fs::read_dir(&ws).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with(TEMP_PREFIX)) && !ws.join("evil.txt").exists() && !ws.parent().unwrap().join("evil.txt").exists());
        assert_eq!((sanitize_segment("con.txt"), sanitize_segment("a:b. "), map_path("/x\\..\\y"), decode_with(&[0x8f, 0xe0, 0xa8], "ibm866"), fmt_bytes(1536)), ("_con.txt".into(), "a_b__".into(), "x/_/y".into(), "При".into(), "1.5 KB".into()));
        let _ = std::fs::remove_dir_all(&ws);
    }
}

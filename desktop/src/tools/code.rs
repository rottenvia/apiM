//! Code tools: apply_patch, verify_file, read_symbol, find_references and analyze_log, ported from the web app
//! (src/lib/patch.ts, markers.ts, symbols.ts, code-index.ts, logs.ts, syntax-check.ts and their cases in
//! src/lib/tools.ts). The text handed back is the web's, word for word: the model reads it.

use crate::snapshots::{MAX_FILE_BYTES, clip_utf16, is_protected_path, list_files, record_previous};
use crate::tools::files::resolve;
use crate::tools::{Output, str_arg};
use regex::Regex;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

// ---------------------------------------------------------------- what JavaScript would do

/// What JS's `trim` and `\s` call whitespace: Rust's set without NEL, with the BOM.
pub(super) fn space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

pub(super) fn trim(s: &str) -> &str {
    s.trim_matches(space)
}

/// `text.length`: JS counts UTF-16 units.
pub(super) fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Compiles a pattern written the way the web writes it: `\s`, `\w`, `\d` and `\b` mean what JS means by them
/// (its whitespace, ASCII words), and `<ID>` stands for `id`, an already escaped name.
fn js(src: &str, id: &str) -> Result<Regex, regex::Error> {
    let mut out = String::with_capacity(src.len() * 2);
    let mut chars = src.chars();
    while let Some(c) = chars.next() {
        match (c, if c == '\\' { chars.next() } else { None }) {
            ('\\', Some('s')) => out.push_str(r"[[\s--\x{85}]\x{feff}]"),
            ('\\', Some('S')) => out.push_str(r"[^[\s--\x{85}]\x{feff}]"),
            ('\\', Some('w')) => out.push_str("[A-Za-z0-9_]"),
            ('\\', Some('d')) => out.push_str("[0-9]"),
            ('\\', Some('b')) => out.push_str(r"(?-u:\b)"),
            ('\\', Some(other)) => out.extend(['\\', other]),
            _ => out.push(c),
        }
    }
    Regex::new(&out.replace("<ID>", id))
}

fn fixed(src: &str) -> Regex {
    js(src, "").expect("a fixed pattern")
}

macro_rules! pattern {
    ($name:ident, $src:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| fixed($src));
    };
}

/// `JSON.stringify` of a string.
pub(super) fn quote(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

/// `n.toLocaleString()` as the web prints it: 1,234,567.
pub(super) fn commas(n: u64) -> String {
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

/// A number as JS prints it: no trailing ".0", exponent form from 1e21 up and below 1e-6.
pub(super) fn js_num(v: f64) -> String {
    if v == 0.0 {
        return "0".into();
    }
    if !v.is_finite() {
        return if v.is_nan() { "NaN" } else if v > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if v.abs() >= 1e21 || v.abs() < 1e-6 {
        let s = format!("{v:e}");
        return match s.split_once('e') {
            Some((mantissa, exp)) if !exp.starts_with('-') => format!("{mantissa}e+{exp}"),
            _ => s,
        };
    }
    format!("{v}")
}

/// `v.toFixed(digits)`: JS rounds an exact tie away from zero, Rust to even. Only odd/2^(digits+1) is a tie.
pub(super) fn to_fixed(v: f64, digits: usize) -> String {
    let scaled = v.abs() * (1u64 << (digits + 1)) as f64;
    let tie = scaled.fract() == 0.0 && scaled % 2.0 == 1.0;
    format!("{:.digits$}", if tie { v * (1.0 + f64::EPSILON) } else { v })
}

/// `String(value)` for what a model puts in a list of literals.
pub(super) fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => js_num(n.as_f64().unwrap_or(0.0)),
        other => other.to_string(),
    }
}

/// The web's `num`: a number or numeric string, cut to a whole number. None when absent or not a number.
pub(super) fn int_arg(args: &Value, key: &str) -> Option<i64> {
    let n = match &args[key] {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => trim(s).parse::<f64>().ok()?,
        _ => return None,
    };
    n.is_finite().then(|| n.trunc() as i64)
}

pub(super) fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

// ---------------------------------------------------------------- shared by the tools

/// A failed call with its own one-line summary.
pub(super) fn bad(text: impl Into<String>, summary: impl Into<String>) -> Output {
    Output { ok: false, text: text.into(), summary: summary.into(), ..Default::default() }
}

/// A failure the way the web's tool runner reports one. A wrong path used to be a dead end, so a file that was not
/// found comes back with the nearest real paths.
fn error(root: &Path, args: &Value, message: &str) -> Output {
    let hint = if message.starts_with("No such file") { suggest_paths(root, args["path"].as_str().unwrap_or("")) } else { String::new() };
    bad(if hint.is_empty() { format!("Error: {message}") } else { format!("Error: {message}\n\n{hint}") }, message)
}

/// `resolve`, plus the web's refusal of an empty path (`resolve` would hand back the workspace itself).
pub(super) fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if trim(rel).is_empty() {
        return Err("Path is required".into());
    }
    resolve(root, rel)
}

/// The whole file, never a capped read. `verb` is the web's word for what the caller is about to do with it.
fn read_file(root: &Path, rel: &str, verb: &str) -> Result<(PathBuf, Vec<u8>), String> {
    let path = inside(root, rel)?;
    let meta = std::fs::metadata(&path).map_err(|_| format!("No such file: {rel}"))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {rel}"));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!("{rel} is too large to {verb} ({}KB)", (meta.len() as f64 / 1024.0).round()));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Cannot read {rel}: {e}"))?;
    Ok((path, bytes))
}

/// Nearest real paths to one the model got wrong. The basename is matched first: that is the part it almost
/// always has right, the folder prefix is where a remembered path drifts.
pub(crate) fn suggest_paths(root: &Path, wanted: &str) -> String {
    let files = list_files(root);
    if wanted.is_empty() || files.is_empty() {
        return String::new();
    }
    let simplify = |s: &str| s.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect::<String>();
    let base = wanted.rsplit('/').next().unwrap_or("").to_lowercase();
    let wanted_simple = simplify(wanted);
    let exact = files.iter().filter(|f| f.0.rsplit('/').next().unwrap_or("").to_lowercase() == base);
    let fuzzy = files.iter().filter(|f| {
        let s = simplify(&f.0);
        s.contains(&wanted_simple) || wanted_simple.contains(&s)
    });
    let mut candidates: Vec<&str> = Vec::new();
    for f in exact.chain(fuzzy) {
        if !candidates.contains(&f.0.as_str()) {
            candidates.push(&f.0);
        }
    }
    if candidates.is_empty() {
        return format!("The workspace has {} file(s) but none match that path. Call list_files to see them, and use a path exactly as listed.", files.len());
    }
    let listed: Vec<String> = candidates.iter().take(10).map(|p| format!("  {p}")).collect();
    format!("Did you mean one of these? Paths must match exactly, including punctuation:\n{}\nRetry with the correct path — do not tell the user the file is missing.", listed.join("\n"))
}

// ---------------------------------------------------------------- apply_patch

struct Hunk<'a> {
    /// Line the hunk claims to start at, 1-based. A hint, not a requirement.
    starts_at: usize,
    /// Context and removed lines, in order: what must be present.
    expected: Vec<&'a str>,
    /// Context and added lines: what replaces them.
    replacement: Vec<&'a str>,
}

/// What happened to one hunk: the 1-based line it matched at, or why it did not match.
struct Placed {
    at: Option<usize>,
    /// False when it only matched with indentation ignored.
    exact: bool,
    /// First expected line, so a report names the hunk in the model's terms.
    head: String,
    reason: String,
}

pattern!(FENCE_OPEN, r"(?i)^\s*```[a-z]*\s*\n");
pattern!(FENCE_CLOSE, r"\n```\s*$");
// The numbers may be missing: a bare `@@` (some tools write no others) starts a hunk that is found by its lines alone.
pattern!(HUNK_HEADER, r"^@@(?:\s*-(\d+)(?:,\d+)?\s+\+\d+(?:,\d+)?\s*@@)?");
pattern!(PATCH_TARGET, r"(?m)^\+\+\+ (?:b/)?(\S+)");

/// A unified diff as hunks. Tolerates what a model wraps around one: `diff --git` lines, `---`/`+++` headers.
fn parse_patch(text: &str) -> Vec<Hunk<'_>> {
    let mut hunks: Vec<Hunk> = Vec::new();
    for line in text.split('\n') {
        if ["diff --git", "index ", "--- ", "+++ "].iter().any(|header| line.starts_with(header)) {
            continue;
        }
        if let Some(header) = HUNK_HEADER.captures(line) {
            // With no line stated the search starts at the top.
            hunks.push(Hunk { starts_at: header.get(1).map_or(1, |n| n.as_str().parse().unwrap_or(usize::MAX / 4)), expected: Vec::new(), replacement: Vec::new() });
            continue;
        }
        let Some(hunk) = hunks.last_mut() else { continue };
        if let Some(added) = line.strip_prefix('+') {
            hunk.replacement.push(added);
        } else if let Some(removed) = line.strip_prefix('-') {
            hunk.expected.push(removed);
        } else if let Some(context) = line.strip_prefix(' ') {
            hunk.expected.push(context);
            hunk.replacement.push(context);
        } else if line.is_empty() {
            // A blank line in a diff is context with its leading space stripped by an editor or by the model.
            // Treating it as a terminator instead would silently truncate the hunk.
            hunk.expected.push("");
            hunk.replacement.push("");
        }
        // "\ No newline at end of file" is metadata, not content.
    }
    hunks
}

/// Where a hunk's expected lines sit. Exact content first; then ignoring indentation, because a hunk hand-built
/// from a numbered read is routinely off by a tab/space conversion. The stated line first, then outward from it,
/// so the nearest candidate wins when a file contains the same few lines more than once.
fn locate(file: &[&str], expected: &[&str], hint: usize) -> Option<(usize, bool)> {
    if expected.is_empty() {
        return None;
    }
    let matches_at = |index: isize, loose: bool| {
        index >= 0 && index as usize + expected.len() <= file.len() && expected.iter().enumerate().all(|(i, want)| {
            let have = file[index as usize + i];
            if loose { trim(have) == trim(want) } else { have == *want }
        })
    };
    let hinted = hint.min(isize::MAX as usize / 2) as isize - 1;
    for loose in [false, true] {
        if matches_at(hinted, loose) {
            return Some((hinted as usize, !loose));
        }
        for distance in 1..=file.len() as isize {
            for at in [hinted - distance, hinted + distance] {
                if matches_at(at, loose) {
                    return Some((at as usize, !loose));
                }
            }
        }
    }
    None
}

/// The closest thing to a hunk in the file, for the failure report: (1-based line, lines that agree, first line that differs).
fn nearest(file: &[&str], expected: &[&str]) -> Option<(usize, usize, String)> {
    let norm = |v: &str| v.split(space).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    let target: Vec<String> = expected.iter().map(|l| norm(l)).collect();
    let have: Vec<String> = file.iter().map(|l| norm(l)).collect();
    let (mut best_score, mut best_at) = (0, 0);
    for i in 0..(have.len() + 1).saturating_sub(target.len()) {
        let score = target.iter().enumerate().filter(|(j, want)| have[i + j] == **want).count();
        if score > best_score {
            (best_score, best_at) = (score, i);
        }
    }
    if best_score == 0 {
        return None;
    }
    let first_diff = (0..target.len()).find(|&j| have.get(best_at + j) != Some(&target[j])).unwrap_or(target.len());
    Some((best_at + 1, best_score, trim(file.get(best_at + first_diff).copied().unwrap_or("<end of file>")).to_string()))
}

/// The per-hunk table. This is what the model actually reads.
fn hunk_report(results: &[Placed]) -> String {
    let total = results.len();
    let line = |(i, h): (usize, &Placed)| {
        let head = if h.head.is_empty() { String::new() } else { format!(" {}", quote(&clip_utf16(&h.head, 60))) };
        match h.at {
            Some(at) => format!("  hunk {}/{total}: applied at line {at}{}{head}", i + 1, if h.exact { "" } else { " (matched ignoring indentation)" }),
            None => format!("  hunk {}/{total}: NOT applied — expected to find{}; {}", i + 1, if head.is_empty() { " its context" } else { head.as_str() }, h.reason),
        }
    };
    results.iter().enumerate().map(line).collect::<Vec<_>>().join("\n")
}

/// Applies a unified diff to one file. Atomic by default: every hunk must find its place or nothing is written,
/// and every hunk is reported either way. `partial` writes the hunks that matched and reports the rest.
pub fn apply_patch(root: &Path, args: &Value) -> Output {
    let (rel, patch) = (str_arg(args, "path"), str_arg(args, "patch"));
    let partial = args["partial"].as_bool() == Some(true);
    // The WHOLE file: what is read here is written back, and a capped read would delete everything past the cap.
    let (path, old) = match read_file(root, rel, "edit") {
        Ok(found) => found,
        Err(e) => return error(root, args, &e),
    };
    let original = String::from_utf8_lossy(&old);
    let unfenced = FENCE_OPEN.replace(patch, "");
    let text = FENCE_CLOSE.replace(&unfenced, "");
    // The newline a patch ends with is not one more blank line of the file: read as one, it made every hunk
    // that is not at the very end of its file miss.
    let hunks = parse_patch(text.trim_end_matches(['\n', '\r']));
    if hunks.is_empty() {
        return bad("Error: No @@ hunks found. A unified diff needs at least one hunk header like `@@ -10,6 +10,7 @@`, followed by lines prefixed with ' ', '-' or '+'.", format!("Patch did not apply to {rel}"));
    }

    // Locate everything before changing anything, so the report describes the file as the model last saw it.
    let file: Vec<&str> = original.split('\n').collect();
    let mut placed: Vec<(usize, &Hunk)> = Vec::new();
    let mut results: Vec<Placed> = Vec::new();
    for hunk in &hunks {
        let head = hunk.expected.iter().find(|l| !trim(l).is_empty()).copied().unwrap_or("").to_string();
        match locate(&file, &hunk.expected, hunk.starts_at) {
            Some((at, exact)) => {
                placed.push((at, hunk));
                results.push(Placed { at: Some(at + 1), exact, head, reason: String::new() });
            }
            None => {
                let reason = match nearest(&file, &hunk.expected) {
                    Some((line, matched, found)) => format!("closest match is line {line} where {matched} of {} lines agree; first difference there is {}", hunk.expected.len(), quote(&clip_utf16(&found, 60))),
                    None => "nothing in the file resembles this hunk — check the path and re-read the region".into(),
                };
                results.push(Placed { at: None, exact: false, head, reason });
            }
        }
    }
    let report = hunk_report(&results);
    let failed = results.iter().filter(|r| r.at.is_none()).count();
    let (applied, total) = (placed.len(), hunks.len());

    // Overlapping hunks would corrupt each other.
    placed.sort_by_key(|p| p.0);
    if let Some(pair) = placed.windows(2).find(|w| w[0].0 + w[0].1.expected.len() > w[1].0) {
        return bad(format!("Error: Two hunks overlap the same lines (around line {}). Combine them into one hunk.\n\n{report}", pair[1].0 + 1), format!("{failed} hunk(s) did not match"));
    }
    if failed > 0 && !partial {
        return bad(
            format!("Error: {failed} of {total} hunk(s) did not match, so nothing was written. Full report:\n{report}\n\nFix only the hunk(s) marked NOT applied and send the patch again, or set partial to true to land the ones that do match."),
            format!("{failed} hunk(s) did not match"),
        );
    }
    if applied == 0 {
        return bad(format!("No hunk matched {rel}, so nothing was written.\n\n{report}"), format!("No hunk matched {rel}"));
    }

    let mut lines = file.clone();
    for (at, hunk) in placed.iter().rev() {
        lines.splice(*at..at + hunk.expected.len(), hunk.replacement.iter().copied());
    }
    if is_protected_path(rel) {
        return error(root, args, &format!("{rel} is inside a protected folder (.git, .history or .snapshots) and cannot be written, moved or deleted by the file tools"));
    }
    record_previous(root, rel, &old);
    if let Err(e) = std::fs::write(&path, lines.join("\n")) {
        return error(root, args, &format!("Cannot write {rel}: {e}"));
    }

    let mut text = format!("Applied {applied} of {total} hunk{} to {rel}.\n\n{report}", plural(total));
    let mut summary = if failed == 0 { format!("Patched {rel} ({applied} hunks)") } else { format!("Patched {rel} — {applied}/{total} hunks") };
    if failed > 0 {
        text += &format!("\n\nThe file now holds the {applied} hunk(s) that matched. Re-send ONLY the {failed} marked NOT applied, rebuilt against the file as it is now.");
    } else {
        // The language-server feedback a CLI agent gets from its editor: a parse check on what the patch wrote.
        let mut written: Vec<String> = Vec::new();
        for target in PATCH_TARGET.captures_iter(patch).map(|m| m[1].to_string()).filter(|p| p != "/dev/null").chain(Some(trim(rel).to_string())) {
            if !target.is_empty() && !written.contains(&target) {
                written.push(target);
            }
        }
        let problems = check_syntax(root, &written);
        if !problems.is_empty() {
            text += &format_syntax_problems(&problems);
            summary += &format!(" · {} syntax error{}", problems.len(), plural(problems.len()));
        }
    }
    Output { ok: failed == 0, text, summary, changed: Some(rel.to_string()), ..Default::default() }
}

// ---------------------------------------------------------------- syntax check after an edit

/// Beyond this a file is generated or vendored; parsing it says nothing.
const SYNTAX_MAX_BYTES: u64 = 2 * 1024 * 1024;
const SYNTAX_MAX_FILES: usize = 12;
const SYNTAX_MAX_REPORTED: usize = 20;
const SYNTAX_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

#[derive(serde::Deserialize)]
pub struct SyntaxProblem {
    pub path: String,
    pub line: u64,
    pub column: u64,
    pub message: String,
}

/// Files whose tools read JSON with comments and trailing commas.
const JSONC_NAMES: &str = r"(?i)(?:^|/)(?:\.eslintrc(?:\.[\w-]+)?\.json|\.babelrc(?:\.json)?|deno\.jsonc?|\.devcontainer\.json|settings\.json|launch\.json|tasks\.json|extensions\.json|[^/]+\.code-workspace|\.swcrc|api-extractor\.json|turbo\.json|biome\.json)$";

/// Parses each JS/TS file with the TypeScript parser when one is installed beside the app; prints JSON problems.
const TS_CHECKER: &str = r#"
let ts;
try { ts = require(require.resolve("typescript", { paths: [process.cwd()] })); }
catch { process.stdout.write("NO_TS"); process.exit(0); }
const fs = require("fs");
const files = JSON.parse(require("fs").readFileSync(0, "utf8"));
const out = [];
for (const f of files) {
  let text;
  try { text = fs.readFileSync(f.abs, "utf8"); } catch { continue; }
  const r = ts.transpileModule(text, {
    fileName: f.abs,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true, noEmit: false },
  });
  for (const d of r.diagnostics || []) {
    if (d.category !== ts.DiagnosticCategory.Error || !d.file || d.start === undefined) continue;
    const p = d.file.getLineAndCharacterOfPosition(d.start);
    out.push({ path: f.rel, line: p.line + 1, column: p.character + 1,
      message: ts.flattenDiagnosticMessageText(d.messageText, " ") });
  }
}
process.stdout.write(JSON.stringify(out));
"#;

const PY_CHECKER: &str = r#"
import ast, json, sys
out = []
for f in json.load(sys.stdin):
    try:
        with open(f["abs"], encoding="utf-8-sig") as h:
            src = h.read()
    except Exception:
        continue
    try:
        ast.parse(src, filename=f["rel"])
    except SyntaxError as e:
        out.append({"path": f["rel"], "line": e.lineno or 1, "column": e.offset or 1,
                    "message": e.msg + " (parsed with Python %d.%d)" % sys.version_info[:2]})
print(json.dumps(out))
"#;

/// Runs one of our own checker scripts (never workspace code) with nothing secret in its environment. None when
/// the program is not installed. Returns (exit code, stdout, stderr); the code is None when it had to be killed.
fn run_checker(program: &str, args: &[&str], input: Option<&str>) -> Option<(Option<i32>, String, String)> {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    let mut command = Command::new(program);
    command.args(args).env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for name in ["PATH", "SYSTEMROOT"] {
        command.env(name, std::env::var_os(name).unwrap_or_default());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
    }
    let mut child = command.spawn().ok()?;
    if let (Some(mut stdin), Some(text)) = (child.stdin.take(), input) {
        let _ = stdin.write_all(text.as_bytes());
    }
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            String::from_utf8_lossy(&bytes).into_owned()
        })
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let started = std::time::Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if started.elapsed() < SYNTAX_TIMEOUT => std::thread::sleep(std::time::Duration::from_millis(15)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    Some((code, stdout.join().unwrap_or_default(), stderr.join().unwrap_or_default()))
}

/// Parses as JSON once comments and trailing commas are removed outside strings. Only for a known JSONC file, or
/// one that really has comments: a trailing comma alone in package.json is a real error (npm refuses it).
fn parses_as_jsonc(text: &str, known: bool) -> bool {
    let (mut out, mut had_comment, mut quoted) = (String::new(), false, false);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            out.push(c);
            if c == '\\' {
                out.extend(chars.next());
            } else if c == '"' {
                quoted = false;
            }
        } else if c == '"' {
            quoted = true;
            out.push(c);
        } else if c == '/' && chars.peek() == Some(&'/') {
            had_comment = true;
            while chars.peek().is_some_and(|c| *c != '\n') {
                chars.next();
            }
        } else if c == '/' && chars.peek() == Some(&'*') {
            had_comment = true;
            chars.next();
            let mut last = ' ';
            for c in chars.by_ref() {
                if last == '*' && c == '/' {
                    break;
                }
                last = c;
            }
        } else {
            out.push(c);
        }
    }
    (known || had_comment) && serde_json::from_str::<serde::de::IgnoredAny>(&fixed(r",(\s*[}\]])").replace_all(&out, "$1")).is_ok()
}

/// A fast PARSE (not a type check, not a build) of files an edit just wrote, so a missing brace is fixed in the
/// very next round. JSON parses here, Python through `ast.parse`, JavaScript/TypeScript through the TypeScript
/// parser (`node --check` for plain JS without it). A checker that is not installed is skipped, never reported:
/// a missing Python is not the model's syntax mistake.
pub fn check_syntax(root: &Path, rels: &[String]) -> Vec<SyntaxProblem> {
    let is = |pattern: &str, text: &str| fixed(pattern).is_match(text);
    let read = |abs: &Path| std::fs::read(abs).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let files: Vec<(String, PathBuf)> = rels
        .iter()
        .take(SYNTAX_MAX_FILES)
        .filter_map(|rel| {
            let abs = inside(root, rel).ok()?;
            let meta = std::fs::metadata(&abs).ok()?;
            (meta.is_file() && meta.len() <= SYNTAX_MAX_BYTES).then(|| (rel.replace('\\', "/"), abs))
        })
        .collect();
    let list = |files: &[&(String, PathBuf)]| serde_json::to_string(&files.iter().map(|(rel, abs)| serde_json::json!({ "rel": rel, "abs": abs.to_string_lossy() })).collect::<Vec<_>>()).unwrap_or_default();
    let mut problems = Vec::new();

    for (rel, abs) in &files {
        // tsconfig and friends are a JSON dialect with comments: never checked.
        if !is(r"(?i)\.json$", rel) || is(r"(?i)(?:^|/)(?:tsconfig[^/]*|jsconfig[^/]*|\.vscode/[^/]*|devcontainer)\.json$", rel) {
            continue;
        }
        // A byte-order mark is legal in a file and fatal to a JSON parser.
        let text = read(abs);
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        let Err(e) = serde_json::from_str::<serde::de::IgnoredAny>(text) else { continue };
        if parses_as_jsonc(text, is(JSONC_NAMES, rel)) {
            continue;
        }
        // ponytail: the message is serde_json's wording, not V8's "Unexpected token …". Same place, same meaning.
        let message = e.to_string();
        problems.push(SyntaxProblem { path: rel.clone(), line: e.line() as u64, column: e.column() as u64, message: message.rsplit_once(" at line ").map_or(message.clone(), |(m, _)| m.to_string()) });
    }

    // Flow-typed JavaScript is not TypeScript: its annotations would all be reported as errors. Skipped, not guessed at.
    let js_ts: Vec<&(String, PathBuf)> = files.iter().filter(|(rel, abs)| is(r"(?i)\.(?:[cm]?[jt]sx?)$", rel) && !(is(r"(?i)\.[cm]?jsx?$", rel) && is(r"@flow\b", &clip_utf16(&read(abs), 2048)))).collect();
    if !js_ts.is_empty() && let Some((_, stdout, _)) = run_checker("node", &["-e", TS_CHECKER], Some(&list(&js_ts))) {
        if trim(&stdout) != "NO_TS" {
            problems.extend(serde_json::from_str::<Vec<SyntaxProblem>>(&stdout).unwrap_or_default());
        } else {
            // No TypeScript: plain JS still gets node's own parser, which knows no JSX.
            for (rel, abs) in js_ts.iter().filter(|(rel, abs)| is(r"(?i)\.[cm]?js$", rel) && !is(r"<[A-Za-z][\w.]*(?:\s[^<>]*)?/?>", &read(abs))) {
                let Some((code, _, stderr)) = run_checker("node", &["--check", abs.to_string_lossy().as_ref()], None) else { continue };
                if code == Some(0) {
                    continue;
                }
                let found = fixed(r":(\d+)\n(?s:.*?)\n\n?(SyntaxError: [^\n\r]+)").captures(&stderr).map(|m| (m[1].parse().unwrap_or(1), m[2].to_string()));
                let (line, message) = found.unwrap_or_else(|| (1, trim(&stderr).rsplit('\n').next().unwrap_or("Syntax error").to_string()));
                problems.push(SyntaxProblem { path: rel.clone(), line, column: 1, message });
            }
        }
    }

    let py: Vec<&(String, PathBuf)> = files.iter().filter(|(rel, _)| is(r"(?i)\.pyw?$", rel)).collect();
    if !py.is_empty() {
        for program in if cfg!(windows) { ["python", "py"] } else { ["python3", "python"] } {
            // The Windows Store "python" stub answers with a message instead of JSON: try the next one.
            let Some((_, stdout, _)) = run_checker(program, &["-c", PY_CHECKER], Some(&list(&py))) else { continue };
            if !stdout.trim_start().starts_with('[') {
                continue;
            }
            problems.extend(serde_json::from_str::<Vec<SyntaxProblem>>(&stdout).unwrap_or_default());
            break;
        }
    }
    problems
}

/// The note appended to a tool result, or "" when every file parsed.
pub fn format_syntax_problems(problems: &[SyntaxProblem]) -> String {
    if problems.is_empty() {
        return String::new();
    }
    let mut files: Vec<&str> = problems.iter().map(|p| p.path.as_str()).collect();
    files.sort();
    files.dedup();
    let shown: Vec<String> = problems.iter().take(SYNTAX_MAX_REPORTED).map(|p| format!("  {}:{}:{} — {}", p.path, p.line, p.column, p.message)).collect();
    let more = problems.len().saturating_sub(SYNTAX_MAX_REPORTED);
    format!(
        "\n\n⚠ Syntax check: this edit left {} parse error{} in {} file{} — the file will not run until they are fixed:\n{}{}\nFix these next, before building on this file. (Parse check only: type errors are not checked here.)",
        problems.len(),
        plural(problems.len()),
        files.len(),
        plural(files.len()),
        shown.join("\n"),
        if more > 0 { format!("\n  …and {more} more") } else { String::new() }
    )
}

// ---------------------------------------------------------------- verify_file

/// Proves a built artifact is the one you think it is: required and absent literals searched as UTF-8 AND
/// UTF-16LE (a wide string literal is the usual reason a marker looks missing), plus size and sha256.
pub fn verify_file(root: &Path, args: &Value) -> Output {
    let target = str_arg(args, "path");
    if target.is_empty() {
        return bad("Error: path is required.", "No path given");
    }
    let read = || -> Result<Vec<u8>, String> {
        let path = inside(root, target)?;
        let meta = std::fs::metadata(&path).map_err(|_| format!("No such file: {target}"))?;
        if !meta.is_file() {
            return Err(format!("{target} is not a file"));
        }
        if meta.len() > MAX_FILE_BYTES {
            return Err(format!("{target} is too large to read"));
        }
        std::fs::read(&path).map_err(|e| format!("Cannot read {target}: {e}"))
    };
    let bytes = match read() {
        Ok(bytes) => bytes,
        Err(e) => return error(root, args, &e),
    };
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let size = bytes.len() as i64;
    // Where a literal sits, per encoding: "utf8@12".
    let find = |marker: &str| -> Vec<String> {
        let wide: Vec<u8> = marker.encode_utf16().flat_map(u16::to_le_bytes).collect();
        [("utf8", marker.as_bytes()), ("utf16le", wide.as_slice())]
            .into_iter()
            .filter(|(_, needle)| !needle.is_empty() && needle.len() <= bytes.len())
            .filter_map(|(encoding, needle)| bytes.windows(needle.len()).position(|w| w == needle).map(|at| format!("{encoding}@{at}")))
            .collect()
    };
    let literals = |key: &str| args[key].as_array().map(|a| a.iter().map(js_string).collect::<Vec<_>>()).unwrap_or_default();
    let (mut hits, mut checks, mut passed, mut total) = (Vec::new(), Vec::new(), 0usize, 0usize);

    // Present in EITHER encoding is present: a UTF-8 literal is not expected to also exist as a wide string.
    for marker in literals("required") {
        let found = find(&marker);
        total += 1;
        passed += !found.is_empty() as usize;
        hits.push(if found.is_empty() {
            format!("  MISSING required: {} — not found as UTF-8 or UTF-16LE. Either the build did not pick up your change, or the literal is spelled differently in the source.", quote(&marker))
        } else {
            format!("  OK      present: {} ({})", quote(&marker), found.join(", "))
        });
    }
    // Absent means absent in every encoding checked.
    for marker in literals("absent") {
        let found = find(&marker);
        total += 1;
        passed += found.is_empty() as usize;
        hits.push(if found.is_empty() {
            format!("  OK      absent: {}", quote(&marker))
        } else {
            format!("  STILL THERE: {} at {} — the old text survived the build, so this binary is not the one you think it is.", quote(&marker), found.join(", "))
        });
    }
    let mut check = |label: &str, ok: bool, detail: String| {
        total += 1;
        passed += ok as usize;
        checks.push(format!("  {} {label}: {detail}", if ok { "OK     " } else { "FAILED " }));
    };
    if let Some(want) = args["sha256"].as_str().filter(|s| !s.is_empty()) {
        // A prefix is accepted because that is how humans quote a hash.
        let want = trim(want).to_lowercase();
        let ok = hash.starts_with(&want);
        check("sha256", ok, if ok { format!("{hash} matches") } else { format!("expected {want}, got {hash}") });
    }
    if let Some(n) = int_arg(args, "bytes") {
        check("size", size == n, if size == n { format!("{size} bytes as expected") } else { format!("expected {n} bytes, got {size} ({}{})", if size > n { "+" } else { "" }, size - n) });
    }
    if let Some(n) = int_arg(args, "min_bytes") {
        check("min size", size >= n, format!("{size} bytes vs minimum {n}"));
    }
    if let Some(n) = int_arg(args, "max_bytes") {
        check("max size", size <= n, format!("{size} bytes vs maximum {n}"));
    }

    let ok = passed == total;
    let verdict = if total == 0 {
        "No markers were requested, so nothing was verified — this is a size and hash reading only.".to_string()
    } else if ok {
        format!("ALL MARKERS OK {passed}/{total}")
    } else {
        format!("MARKER CHECK FAILED — {passed}/{total} passed")
    };
    let mut lines = vec![format!("{target} — {} bytes, sha256 {hash}", commas(bytes.len() as u64)), String::new(), verdict];
    for group in [hits, checks] {
        if !group.is_empty() {
            lines.push(String::new());
            lines.extend(group);
        }
    }
    if !ok {
        lines.push("\nThis binary is not the one you were about to describe to the user. Find out why before you report anything about it — a stale artifact links cleanly and exits 0.".into());
    }
    let summary = if total == 0 {
        format!("{target}: {} bytes", commas(bytes.len() as u64))
    } else if ok {
        format!("Verified {target} ({passed}/{total})")
    } else {
        format!("{target} FAILED verification ({passed}/{total})")
    };
    // A failed verification is a successful CALL: it answered the question truthfully.
    Output::ok(lines.join("\n"), summary)
}

// ---------------------------------------------------------------- symbols (read_symbol)

/// One definition: a 1-based inclusive line span, chosen by the code's own structure.
struct Symbol {
    kind: String,
    start: usize,
    end: usize,
    text: String,
    /// The declaration line, trimmed: a one-line "which one is this".
    signature: String,
    /// False when the closing brace was never found (truncated or odd source).
    complete: bool,
}

/// Lines longer than this are generated data, not declarations.
const LONG_LINE: usize = 2000;

// What stands before a name on its line when it is being CALLED, not defined: an assignment, a keyword that takes
// an expression, an open paren or comma, or member access. `Foo::bar` stays a definition.
pattern!(CALL_PREFIX, r"(?:^|[^=!<>])=(?:[^=]|$)|\b(?:return|await|new|yield|throw|typeof|case|else|if|while|for|switch|raise|defer|go|puts|print|echo|delete|in|of)\s*$|\bexport\s+default\s+$|(?:[(,!?|&+\-*/%]|(?:^|[^:]):|\.)\s*$");
pattern!(QUALIFIER, r"(?:[\w<>]+::)$");
pattern!(CALL_ABOVE, r"(?:[(,=+\-*/?&|\[]|(?:^|[^:]):)$");
pattern!(PYTHON, r"(?i)\.(py|pyi)$");

/// JS `text.lastIndexOf("\n", from) + 1`: where the line holding `from` starts (a newline AT `from` counts).
fn line_start(text: &str, from: isize) -> usize {
    let end = (from.max(0) as usize + 1).min(text.len());
    text.as_bytes()[..end].iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1)
}

/// The index just past the brace matching the one at `open`, or None. A scanner, not a pattern: a `}` inside a
/// string literal or a comment is exactly the case that makes pattern-based extraction quietly wrong.
fn match_brace(text: &str, open: usize) -> Option<usize> {
    let b = text.as_bytes();
    let (mut depth, mut i, mut in_line, mut in_block, mut quote) = (0usize, open, false, false, 0u8);
    while i < b.len() {
        let (c, next) = (b[i], b.get(i + 1).copied());
        if in_line {
            in_line = c != b'\n';
        } else if in_block {
            if c == b'*' && next == Some(b'/') {
                in_block = false;
                i += 1;
            }
        } else if quote != 0 {
            if c == b'\\' {
                i += 1;
            } else if c == quote {
                quote = 0;
            }
        } else if c == b'/' && next == Some(b'/') {
            in_line = true;
            i += 1;
        } else if c == b'/' && next == Some(b'*') {
            in_block = true;
            i += 1;
        } else if matches!(c, b'"' | b'\'' | b'`') {
            quote = c;
        } else if c == b'{' {
            depth += 1;
        } else if c == b'}' {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Some(i + 1);
            }
        }
        i += 1;
    }
    None
}

/// The same text with the identifier characters of every overlong line blanked, offset for offset. A declaration
/// inside a minified line is not one anybody wants to jump to.
fn scan_copy(source: &str) -> std::borrow::Cow<'_, str> {
    if !source.split('\n').any(|l| len16(l) > LONG_LINE) {
        return source.into();
    }
    let blank = |l: &str| if len16(l) > LONG_LINE { l.chars().map(|c| if c.is_ascii_alphanumeric() || "_:<>,*&~$".contains(c) { '#' } else { c }).collect() } else { l.to_string() };
    source.split('\n').map(blank).collect::<Vec<String>>().join("\n").into()
}

/// Every definition of `name` in `text`; overloads all come back. A lightweight structural scan, not a parser:
/// braces, strings and comments for the brace languages, indentation for Python.
fn find_symbols(text: &str, name: &str, path: &str) -> Vec<Symbol> {
    let name = trim(name);
    if name.is_empty() {
        Vec::new()
    } else if PYTHON.is_match(path) {
        python_symbols(text, name)
    } else {
        brace_symbols(text, name)
    }
}

fn brace_symbols(source: &str, name: &str) -> Vec<Symbol> {
    let id = regex::escape(name);
    let scan = scan_copy(source);
    // Three shapes, deliberately narrow. A bare mention of the name is NOT a definition, which is the difference
    // between this and search_files. Qualified method names (Foo::bar) match on the last segment.
    let shapes = [
        // class/struct/enum/interface NAME: a type definition
        r"\b(class|struct|enum|interface|union|namespace)\s+<ID>\b",
        // … NAME ( … ) … {: a function or method. The prefix may not cross a line.
        r"(?m)(^|[^\w:])(?:[\w:<>,*&~][^\S\n]*)*?(?:[\w<>]+::)?<ID>[^\S\n]*\(",
        // const name = (…) => {…}, const name = function (…) {…}, and the async forms
        r"\b(?:const|let|var)\s+<ID>\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:function\b|\([^)\n]*\)\s*(?::[^=\n]+)?=>|[\w$]+\s*=>)",
    ];
    let mut out: Vec<Symbol> = Vec::new();
    let mut seen: Vec<usize> = Vec::new();
    for (shape, pattern) in shapes.iter().enumerate() {
        let Ok(re) = js(pattern, &id) else { continue };
        for hit in re.captures_iter(&scan) {
            let Some(whole) = hit.get(0) else { continue };
            let name_at = whole.start() + whole.as_str().rfind(name).unwrap_or(0);
            if shape == 1 {
                // A call with a block after it (`await run(x, {`) is not a definition…
                let this_line = line_start(source, name_at as isize - 1);
                let prefix = &source[this_line..name_at];
                if CALL_PREFIX.is_match(&QUALIFIER.replace(prefix, "")) {
                    continue;
                }
                // …nor is an argument of a call that began on the line above.
                if trim(prefix).is_empty() {
                    let prev_start = line_start(source, this_line as isize - 2);
                    if CALL_ABOVE.is_match(trim(source.get(prev_start..this_line.saturating_sub(1)).unwrap_or(""))) {
                        continue;
                    }
                }
            }
            // Anchor on the NAME, back up to the start of ITS line, then over at most three lines that plainly
            // continue the signature (a return type on its own line): non-empty, not ended by ; { or }, not a
            // comment or a preprocessor line.
            let mut start = line_start(source, name_at as isize);
            for _ in 0..3 {
                if start == 0 {
                    break;
                }
                let prev_start = line_start(source, start as isize - 2);
                let prev = trim(source.get(prev_start..start - 1).unwrap_or(""));
                if prev.is_empty() || prev.ends_with([';', '{', '}']) || ["//", "*", "/*", "#"].iter().any(|p| prev.starts_with(p)) {
                    break;
                }
                start = prev_start;
            }
            if seen.contains(&start) {
                continue;
            }
            // The body's opening brace must come before the next semicolon, or this is a prototype, not a definition.
            let Some(brace) = source[name_at..].find('{').map(|i| i + name_at) else { continue };
            if source[name_at..brace].contains(';') {
                continue;
            }
            let end = match_brace(source, brace);
            seen.push(start);
            let body = &source[start..end.unwrap_or(source.len())];
            let first = source[..start].matches('\n').count() + 1;
            out.push(Symbol {
                kind: if shape == 0 { hit[1].to_string() } else { "function".into() },
                start: first,
                end: first + body.matches('\n').count(),
                text: body.to_string(),
                signature: clip_utf16(trim(&source[start..brace]), 200),
                complete: end.is_some(),
            });
        }
    }
    out.sort_by_key(|s| s.start);
    out
}

fn python_symbols(source: &str, name: &str) -> Vec<Symbol> {
    let lines: Vec<&str> = source.split('\n').collect();
    let Ok(decl) = js(r"^(\s*)(?:async\s+)?(def|class)\s+<ID>\b", &regex::escape(name)) else { return Vec::new() };
    let indent_of = |line: &str| line.chars().count() - line.trim_start_matches(space).chars().count();
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let Some(hit) = decl.captures(line) else { continue };
        let indent = hit[1].chars().count();
        // The body runs until a non-blank line indented no further than the declaration: Python's own rule.
        let mut end = lines.len() - 1;
        for j in i + 1..lines.len() {
            if trim(lines[j]).is_empty() {
                continue;
            }
            if indent_of(lines[j]) <= indent {
                end = j - 1;
                break;
            }
            end = j;
        }
        // Trailing blank lines belong to the file, not the function.
        while end > i && trim(lines[end]).is_empty() {
            end -= 1;
        }
        out.push(Symbol { kind: if &hit[2] == "class" { "class" } else { "function" }.into(), start: i + 1, end: end + 1, text: lines[i..=end].join("\n"), signature: clip_utf16(trim(line), 200), complete: true });
    }
    out
}

/// The receipt: exact span, exact lines with their real numbers, ready to hand to edit_file.
fn format_symbol(symbol: &Symbol, name: &str, path: &str) -> String {
    let lines: Vec<&str> = symbol.text.split('\n').collect();
    let width = (symbol.start + lines.len() - 1).to_string().len();
    let numbered: Vec<String> = lines.iter().enumerate().map(|(i, line)| format!("{:>width$} | {line}", symbol.start + i)).collect();
    format!(
        "{path} — {} {}, lines {}-{} ({} lines){}.\n\nThis is the EXACT span, byte for byte. To change it, call edit_file with start_line={} and end_line={} — no whitespace to copy and no anchor to guess.\n\n{}",
        symbol.kind,
        trim(name),
        symbol.start,
        symbol.end,
        symbol.end - symbol.start + 1,
        if symbol.complete { "" } else { " — WARNING: no closing brace found, so this runs to end of file" },
        symbol.start,
        symbol.end,
        numbered.join("\n")
    )
}

// ---------------------------------------------------------------- source files (go to definition, find references)

pattern!(CODE_FILE, r"(?i)\.(?:[cm]?[jt]sx?|py|pyi|go|rs|java|kt|kts|scala|c|h|cc|cpp|cxx|hpp|hh|cs|rb|php|swift|lua|vue|svelte|m|mm|sh|bash|ps1|dart|ex|exs|zig)$");
pattern!(MINIFIED, r"(?i)\.min\.[cm]?js$");
pattern!(IDENTIFIER, r"^[A-Za-z_$][\w$]*$");
pattern!(NAME_SEPARATOR, r"::|\.|#");
// A declaration keyword on the signature: the strongest "this is it".
pattern!(KEYWORD_DECL, r"^(?:export\s+)?(?:default\s+)?(?:(?:public|private|protected|static|abstract|async|override|pub(?:\(\w+\))?|unsafe|inline|virtual)\s+)*(?:function\*?|class|interface|type|enum|struct|trait|impl|def|fn|func|fun|module|namespace|const|let|var)\b");
pattern!(TESTISH, r"(?i)(?:^|/)(?:tests?|__tests__|spec|scripts|examples?)/|\.(?:test|spec)\.[^/]+$");
pattern!(IMPORT_LINE, r"^(?:import\b|from\s+\S+\s+import\b|export\s+\{|export\s+\*|#include\b|use\s)");
pattern!(REQUIRE, r"\brequire\(");
pattern!(DECLARED, r"^(?:const|let|var)\b");
pattern!(STATEMENT, r"^(?:return|await|new|throw|yield|else|case|typeof|delete|void|if|while|for|switch|echo|print|raise|defer|go|puts|export\s+default)\b");

/// Past this a file is generated or minified: its hits are noise.
const SOURCE_FILE_BYTES: u64 = 1024 * 1024;
/// Total source read per query, so a monorepo cannot stall a round.
const SOURCE_TOTAL_BYTES: u64 = 40 * 1024 * 1024;
const MAX_REFERENCES: usize = 200;
const DEFINITIONS_LISTED: usize = 12;

/// The last segment of `Foo::bar`, `foo.bar` or `Foo#bar`.
fn bare_name(name: &str) -> &str {
    NAME_SEPARATOR.split(trim(name)).last().unwrap_or("")
}

/// Every source file under `within` (the whole workspace when empty) as (path, text), and how many were left out
/// for size.
fn source_files(root: &Path, within: &str) -> Result<(Vec<(String, String)>, usize), String> {
    let within = trim(within);
    let mut prefix = String::new();
    if !matches!(within, "" | "." | "./") {
        let dir = resolve(root, within)?;
        prefix = dir.strip_prefix(root).unwrap_or(&dir).to_string_lossy().replace('\\', "/");
        if !prefix.is_empty() {
            prefix.push('/');
        }
    }
    // ponytail: a `within` inside a top-level dist/ or build/ finds nothing (the listing hides those at the top);
    // the web scans it. Walk from the folder itself if build output ever needs searching.
    let under = |path: &str| path.get(..prefix.len()).is_some_and(|head| if cfg!(windows) { head.eq_ignore_ascii_case(&prefix) } else { head == prefix });
    let (mut files, mut total, mut skipped) = (Vec::new(), 0u64, 0usize);
    for (path, size, _) in list_files(root) {
        if !under(&path) || !CODE_FILE.is_match(&path) || size > SOURCE_FILE_BYTES || MINIFIED.is_match(&path) {
            continue;
        }
        if total + size > SOURCE_TOTAL_BYTES {
            skipped += 1;
            continue;
        }
        match std::fs::read(root.join(&path)) {
            Ok(bytes) => {
                files.push((path, String::from_utf8_lossy(&bytes).into_owned()));
                total += size;
            }
            Err(_) => skipped += 1,
        }
    }
    Ok((files, skipped))
}

/// Reads ONE function, class or struct by name, with its exact line range. Without `path` it goes to the
/// definition wherever it is in the workspace.
pub fn read_symbol(root: &Path, args: &Value) -> Output {
    let (path, name) = (str_arg(args, "path"), str_arg(args, "name"));
    if name.is_empty() {
        return bad("Error: name is required.", "Missing name");
    }
    let pick = int_arg(args, "index").filter(|&p| p >= 1).map(|p| p as usize);

    if path.is_empty() {
        // Go to definition: every source file, not one.
        let files = match source_files(root, "") {
            Ok((files, _)) => files,
            Err(e) => return error(root, args, &e),
        };
        let mut defs: Vec<(usize, &str, Symbol)> = Vec::new();
        for (file, content) in files.iter().filter(|(_, content)| content.contains(bare_name(name))) {
            for symbol in find_symbols(content, name, file) {
                // Declared with a keyword first, then source over tests and scripts: the definition a person
                // means is rarely a test helper of the same name.
                let rank = (if KEYWORD_DECL.is_match(&symbol.signature) { 0 } else { 2 }) + TESTISH.is_match(file) as usize;
                defs.push((rank, file.as_str(), symbol));
            }
        }
        defs.sort_by_key(|d| d.0);
        if defs.is_empty() {
            return bad(
                format!("No definition of \"{name}\" in {} source files. It may be defined by a dependency, generated, or spelled differently — find_references shows every place the name appears.", files.len()),
                format!("No definition of {name}"),
            );
        }
        let chosen = pick.filter(|&p| p <= defs.len()).unwrap_or(1) - 1;
        let mut text = String::new();
        if defs.len() > 1 {
            let listed: Vec<String> = defs.iter().take(DEFINITIONS_LISTED).enumerate().map(|(i, (_, file, s))| format!("  {}. {file}:{}-{} — {}", i + 1, s.start, s.end, s.signature)).collect();
            text = format!(
                "{} definitions of \"{name}\"{}:\n{}\n\nShowing #{}; pass index (or path) to see another.\n\n",
                defs.len(),
                if defs.len() > DEFINITIONS_LISTED { format!(" (first {DEFINITIONS_LISTED}; pass path to narrow)") } else { String::new() },
                listed.join("\n"),
                chosen + 1
            );
        }
        let (_, file, symbol) = &defs[chosen];
        return Output::ok(text + &format_symbol(symbol, name, file), format!("Read {name} from {file}:{}-{}", symbol.start, symbol.end));
    }

    // The WHOLE file, uncapped: a symbol read that searched a truncated copy would report "not found" for a
    // function that is right there.
    let content = match read_file(root, path, "edit") {
        Ok((_, bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) => return error(root, args, &e),
    };
    let matches = find_symbols(&content, name, path);
    if matches.is_empty() {
        return bad(
            format!("No definition of \"{name}\" in {path} ({} lines searched, whole file, nothing truncated).\n\nThis looks for DEFINITIONS — a declaration or a call site is not one. Use search_files to find every mention.", content.split('\n').count()),
            format!("No {name} in {path}"),
        );
    }
    let chosen = pick.filter(|&p| p <= matches.len()).unwrap_or(1) - 1;
    let mut text = String::new();
    if matches.len() > 1 {
        let listed: Vec<String> = matches.iter().enumerate().map(|(i, m)| format!("  {}. lines {}-{} — {}", i + 1, m.start, m.end, m.signature)).collect();
        text = format!("{} definitions of \"{name}\":\n{}\n\nShowing #{}; pass index to see another.\n\n", matches.len(), listed.join("\n"), chosen + 1);
    }
    let symbol = &matches[chosen];
    Output::ok(text + &format_symbol(symbol, name, path), format!("Read {name} from {path}:{}-{}", symbol.start, symbol.end))
}

// ---------------------------------------------------------------- find_references

const KINDS: [&str; 3] = ["definition", "import", "use"];

/// Every place an identifier is used across the source files: whole-identifier matches only (`save` does not
/// match `autosave` or `save_as`), each labelled definition, import or use, definitions first.
pub fn find_references(root: &Path, args: &Value) -> Output {
    let name = str_arg(args, "name");
    let bare = bare_name(name);
    if name.is_empty() || !IDENTIFIER.is_match(bare) {
        return bad("Error: name must be an identifier, e.g. loadConfig.", "No identifier given");
    }
    let (files, skipped) = match source_files(root, str_arg(args, "path")) {
        Ok(found) => found,
        Err(e) => return error(root, args, &e),
    };
    let id = regex::escape(bare);
    let patterns = (
        // A module-level assignment (Python constants, JS globals): column 0.
        js(r"^<ID>\s*(?::[^=]*)?=", &id),
        js(
            concat!(
                // function/class/type declarations across the common languages
                r"\b(?:function\*?|class|interface|type|enum|struct|trait|impl|def|fn|func|fun|module|namespace)\s+<ID>\b",
                // Go methods: func (s *Server) Handle(
                r"|\bfunc\s*\([^)]*\)\s*<ID>\s*\(",
                // const foo = …, let foo: T = …, var foo = …
                r"|\b(?:const|let|var|val)\s+<ID>\b",
                // object/class member: foo(…) {  or  foo = (…) =>  or  foo: function
                r"|^(?:(?:public|private|protected|static|async|override|readonly)\s+)*<ID>\s*(?:=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>|:\s*(?:async\s+)?function\b|\([^)]*\)\s*(?::[^{]+)?\{)",
            ),
            &id,
        ),
        // C-family: returnType name(…) {. A type word is required, and a statement keyword is not one
        // ("return foo(x)" is a use): STATEMENT rules those out.
        js(r"^[\w:<>,*&\[\]]+(?:\s+[\w:<>,*&\[\]]+)*\s+[*&]*<ID>\s*\([^;]*\)\s*(?:const\s*)?(?:->[^{;]*)?\{?\s*$", &id),
    );
    let (Ok(assign), Ok(def), Ok(c_family)) = patterns else { return bad("Error: name must be an identifier, e.g. loadConfig.", "No identifier given") };
    let classify = |line: &str| -> usize {
        let t = trim(line);
        // Signatures are short. A long line is data or minified code.
        if len16(t) > 600 {
            2
        } else if assign.find(line).is_some_and(|m| !line[m.end()..].starts_with('=')) {
            0
        } else if IMPORT_LINE.is_match(t) || (REQUIRE.is_match(t) && DECLARED.is_match(t)) {
            1
        } else if def.is_match(t) || (!STATEMENT.is_match(t) && c_family.is_match(t)) {
            0
        } else {
            2
        }
    };
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '$';
    let mentions = |line: &str| line.match_indices(bare).any(|(at, _)| !line[..at].chars().next_back().is_some_and(word) && !line[at + bare.len()..].chars().next().is_some_and(word));

    // (kind, path, line, text)
    let mut refs: Vec<(usize, &str, usize, String)> = Vec::new();
    for (path, content) in files.iter().filter(|(_, content)| content.contains(bare)) {
        for (i, line) in content.split('\n').enumerate().filter(|(_, line)| mentions(line)) {
            refs.push((classify(line), path.as_str(), i + 1, clip_utf16(trim(line), 200)));
        }
    }
    refs.sort_by_key(|r| r.0);
    let total = refs.len();
    refs.truncate(MAX_REFERENCES);
    if refs.is_empty() {
        return Output::ok(
            format!("No references to \"{name}\" in {} source files (whole-identifier match).{}", files.len(), if skipped > 0 { format!(" {skipped} large files were not scanned.") } else { String::new() }),
            format!("No references to {name}"),
        );
    }
    let mut in_files: Vec<&str> = refs.iter().map(|r| r.1).collect();
    in_files.sort();
    in_files.dedup();
    let of_kind = |kind: usize| refs.iter().filter(|r| r.0 == kind).count();
    let mut lines = vec![format!(
        "{total} reference{} to \"{name}\" in {} file{} ({} definition, {} import, {} use{}):",
        plural(total),
        in_files.len(),
        plural(in_files.len()),
        of_kind(0),
        of_kind(1),
        of_kind(2),
        if total > refs.len() { format!("; first {} shown", refs.len()) } else { String::new() }
    )];
    let mut current = "";
    for (kind, path, line, text) in &refs {
        if *path != current {
            current = *path;
            lines.push(format!("\n{path}"));
        }
        lines.push(format!("  {line:>5} [{}] {text}", KINDS[*kind]));
    }
    if skipped > 0 {
        lines.push(format!("\n({skipped} files over the size limit were not scanned.)"));
    }
    Output::ok(lines.join("\n"), format!("{total} reference{} to {name} in {} file{}", plural(total), in_files.len(), plural(in_files.len())))
}

// ---------------------------------------------------------------- analyze_log

/// What a log read is cut to, as the web's default read budget does. The report says which lines it covers.
const LOG_READ_CHARS: usize = 400_000;
const MAX_FAULTS: usize = 40;

static LEVELS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    [("FATAL", r"\b(?:FATAL|PANIC|CRITICAL)\b"), ("ERROR", r"\b(?:ERROR|ERR|FAIL(?:ED|URE)?)\b"), ("WARN", r"\b(?:WARN(?:ING)?)\b"), ("INFO", r"\b(?:INFO|NOTICE)\b"), ("DEBUG", r"\b(?:DEBUG|TRACE|VERBOSE)\b")]
        .into_iter()
        .map(|(label, src)| (label, fixed(src)))
        .collect()
});

/// Fault signatures, most specific first: the first one a line matches names it.
static FAULTS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    [
        ("access violation", r"(?i)access violation|0xc0000005"),
        ("segfault", r"(?i)segmentation fault|SIGSEGV|SIGABRT|SIGBUS"),
        ("exception", r"(?i)unhandled exception|\bexception\b.*(thrown|at )|Traceback \(most recent call last\)"),
        ("assert", r"(?i)assertion failed|\bassert\b.*fail"),
        ("stack overflow", r"(?i)stack overflow|0xc00000fd"),
        ("abort", r"(?i)\babort(?:ed|ing)?\b|terminate called"),
        ("crash", r"(?i)\bcrash(?:ed|ing)?\b|has stopped working|faulting module"),
        // The code is captured so a plain "exit code 0" can be told apart below.
        ("nonzero exit", r"(?i)(?:exit(?:ed with)? code |exited with status )(-?\d+)"),
        ("timeout", r"(?i)\btimed out\b|\btimeout\b"),
    ]
    .into_iter()
    .map(|(kind, src)| (kind, fixed(src)))
    .collect()
});

/// The variable parts of a line, in the order they are collapsed so repeats group together.
static SKELETON: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r"0x[0-9a-fA-F]+", "<hex>"),
        (r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b", "<guid>"),
        (r"\b\d{1,3}(?:\.\d{1,3}){3}\b", "<ip>"),
        (r"\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b", "<time>"),
        (r"\b\d{4}-\d{2}-\d{2}\b", "<date>"),
        (r#"[A-Za-z]:\\[^\s"']+|/(?:[\w.-]+/)+[\w.-]+"#, "<path>"),
        (r"-?\b\d+\.\d+\b", "<num>"),
        (r"-?\b\d+\b", "<num>"),
        (r"\s+", " "),
    ]
    .into_iter()
    .map(|(src, with)| (fixed(src), with))
    .collect()
});

// Numeric fields: key=value, key: value.
pattern!(PAIR, r"([A-Za-z_][\w.\-]{0,40})\s*[=:]\s*(-?\d+(?:\.\d+)?)");

fn fault_hit(kind: &str, re: &Regex, line: &str) -> bool {
    if kind != "nonzero exit" {
        return re.is_match(line);
    }
    // Any code but a plain 0.
    re.captures_iter(line).any(|m| {
        let code = &line[m.get(1).map_or(0, |g| g.start())..];
        !(code.starts_with('0') && !code[1..].chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_'))
    })
}

/// The receipt a human would have written by hand: counts, clusters, distributions and the fault sequence.
/// Format-agnostic on purpose: it works on shapes every console log has. Returns (report, non-empty lines, faults).
fn log_report(text: &str, count: &[String]) -> (String, usize, usize) {
    let all: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let lines: Vec<&str> = all.iter().copied().filter(|l| !trim(l).is_empty()).collect();
    let counted = lines.len();
    let pct = |part: usize, whole: usize| if whole == 0 { 0 } else { (part as f64 / whole as f64 * 100.0).round() as usize };
    let mut out: Vec<String> = Vec::new();

    let mut numbers: Vec<(String, Vec<f64>)> = Vec::new();
    let mut slot: HashMap<String, usize> = HashMap::new();
    for line in &lines {
        for m in PAIR.captures_iter(line) {
            let Some(value) = m[2].parse::<f64>().ok().filter(|v| v.is_finite()) else { continue };
            let at = *slot.entry(m[1].to_string()).or_insert_with(|| {
                numbers.push((m[1].to_string(), Vec::new()));
                numbers.len() - 1
            });
            numbers[at].1.push(value);
        }
    }

    // The run counter, if there is one: which slice of a run this text is. An explicitly named counter beats a
    // lucky monotone field, and a field only qualifies when it never decreases across the log.
    let monotone = |v: &[f64]| v.len() >= 2 && v.windows(2).all(|w| w[1] >= w[0]);
    let distinct = |v: &[f64]| {
        let mut sorted = v.to_vec();
        sorted.sort_by(f64::total_cmp);
        sorted.dedup();
        sorted.len()
    };
    let named = ["tick", "frame", "seq", "iter", "step", "sample"].iter().find_map(|name| numbers.iter().find(|(key, _)| key.to_lowercase() == *name).filter(|(_, v)| monotone(v) && distinct(v) >= 2));
    // A counter is not just "goes up": `ground=0 … ground=1` is a flag that flipped once. A real one takes many
    // distinct whole values spanning more than the sample count itself.
    let span = named.or_else(|| numbers.iter().find(|(_, v)| v.len() >= 8 && distinct(v) as f64 >= v.len() as f64 * 0.8 && v.iter().all(|x| x.fract() == 0.0) && v[v.len() - 1] - v[0] >= v.len() as f64 && monotone(v)));
    out.push(format!(
        "{} line(s), {counted} non-empty.{}",
        all.len(),
        span.map_or(String::new(), |(key, v)| format!(" Run counter: {key} {} → {} across {} line(s).", js_num(v[0]), js_num(v[v.len() - 1]), v.len()))
    ));

    // The share is of LEVELLED lines: one error in a log with no other levels really is 100% of them, so the
    // denominator is stated and the share of the whole file is given alongside it.
    let levels: Vec<(&str, usize)> = LEVELS.iter().map(|(label, re)| (*label, lines.iter().filter(|l| re.is_match(l)).count())).filter(|l| l.1 > 0).collect();
    if !levels.is_empty() {
        let levelled: usize = levels.iter().map(|l| l.1).sum();
        let each: Vec<String> = levels.iter().map(|(label, n)| format!("{label} {n} ({}% of levelled, {}% of all)", pct(*n, levelled), pct(*n, counted))).collect();
        out.push(String::new());
        out.push(format!("Levels (share of the {levelled} levelled line(s), {}% of the log): {}", pct(levelled, counted), each.join(" · ")));
    }

    // Requested tokens: case-insensitive, as whole words where the token looks like a word, so "phase" does not
    // match "phaseshift".
    let requested: Vec<(&str, usize)> = count
        .iter()
        .map(|token| trim(token))
        .filter(|token| !token.is_empty())
        .map(|token| {
            let wordy = token.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            let re = js(if wordy { r"(?i)\b<ID>\b" } else { "(?i)<ID>" }, &regex::escape(token));
            (token, re.map_or(0, |re| lines.iter().filter(|l| re.is_match(l)).count()))
        })
        .collect();
    if !requested.is_empty() {
        let all_counted: usize = requested.iter().map(|r| r.1).sum();
        let each: Vec<String> = requested.iter().map(|(label, n)| format!("{label} {n} ({}%)", pct(*n, all_counted))).collect();
        out.push(String::new());
        out.push(format!("Counted: {}", each.join(" · ")));
        if let [a, b] = requested.as_slice() && b.1 > 0 {
            out.push(format!("Ratio {}:{} = {}:1", a.0, b.0, to_fixed(a.1 as f64 / b.1 as f64, 2)));
        }
    }

    let mut numerics: Vec<&(String, Vec<f64>)> = numbers.iter().filter(|(_, v)| v.len() >= 2).collect();
    numerics.sort_by_key(|(_, v)| std::cmp::Reverse(v.len()));
    if !numerics.is_empty() {
        out.push(String::new());
        out.push("Numeric fields:".into());
        for (key, values) in numerics.iter().take(10) {
            let mut sorted = values.clone();
            sorted.sort_by(f64::total_cmp);
            let quantile = |q: f64| {
                let pos = (sorted.len() - 1) as f64 * q;
                let base = pos.floor() as usize;
                sorted.get(base + 1).map_or(sorted[base], |next| sorted[base] + (pos - base as f64) * (next - sorted[base]))
            };
            let round = |v: f64| js_num(if v.fract() == 0.0 { v } else { to_fixed(v, 4).parse().unwrap_or(v) });
            let mean = sorted.iter().sum::<f64>() / sorted.len() as f64;
            out.push(format!("  {key}: n={} min={} median={} mean={} p95={} max={}", sorted.len(), round(sorted[0]), round(quantile(0.5)), round(mean), round(quantile(0.95)), round(sorted[sorted.len() - 1])));
        }
    }

    // Clusters: the shape of the log, without reading every line of it. (count, first line, last line, sample)
    let mut clusters: Vec<(usize, usize, usize, &str)> = Vec::new();
    let mut cluster_of: HashMap<String, usize> = HashMap::new();
    for (i, line) in all.iter().enumerate().filter(|(_, l)| !trim(l).is_empty()) {
        let key = SKELETON.iter().fold(trim(line).to_string(), |s, (re, with)| re.replace_all(&s, *with).into_owned());
        match cluster_of.get(&key) {
            Some(&at) => {
                clusters[at].0 += 1;
                clusters[at].2 = i + 1;
            }
            None => {
                cluster_of.insert(key, clusters.len());
                clusters.push((1, i + 1, i + 1, trim(line)));
            }
        }
    }
    clusters.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    if !clusters.is_empty() {
        out.push(String::new());
        out.push("Repeated lines (most frequent first):".into());
        for (n, first, last, sample) in clusters.iter().take(12) {
            out.push(format!("  {n:>4}x  lines {first}-{last}  {}", clip_utf16(sample, 200)));
        }
    }

    // Faults, in the order they happened: the sequence is the story.
    let faults: Vec<(usize, &str, &str)> = all.iter().enumerate().filter(|(_, l)| !trim(l).is_empty()).filter_map(|(i, line)| FAULTS.iter().find(|(kind, re)| fault_hit(kind, re, line)).map(|(kind, _)| (i + 1, *kind, trim(line)))).collect();
    out.push(String::new());
    if faults.is_empty() {
        out.push("No fault signature found (no exception, crash or non-zero exit).".into());
    } else {
        out.push(format!("Fault sequence ({}{}):", faults.len().min(MAX_FAULTS), if faults.len() > MAX_FAULTS { "+" } else { "" }));
        for (line, kind, text) in faults.iter().take(MAX_FAULTS) {
            out.push(format!("  line {line}: [{kind}] {}", clip_utf16(text, 200)));
        }
        let at = faults[0].0 - 1;
        out.push(String::new());
        out.push("Around the first fault:".into());
        for i in at.saturating_sub(3)..(at + 8).min(all.len()) {
            out.push(format!("{:>5}{} {}", i + 1, if i == at { " >" } else { "  " }, all[i]));
        }
    }
    (out.join("\n"), counted, faults.len().min(MAX_FAULTS))
}

/// Turns a wall of console output into receipts: pasted `text`, or a log file in the workspace.
pub fn analyze_log(root: &Path, args: &Value) -> Output {
    let mut text = args["text"].as_str().unwrap_or("").to_string();
    let log_path = trim(args["path"].as_str().unwrap_or(""));
    if text.is_empty() && !log_path.is_empty() {
        let raw = match read_file(root, log_path, "read") {
            Ok((_, bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(e) => return error(root, args, &e),
        };
        // Cut on a line boundary, never mid-line. Analysing 40% of a log and reporting ratios from it would be a
        // confident lie, so the report says which part was analysed.
        let lines: Vec<&str> = raw.split('\n').collect();
        let (mut used, mut kept) = (0, lines.len());
        for (i, line) in lines.iter().enumerate() {
            let cost = len16(line) + (i > 0) as usize;
            if used + cost > LOG_READ_CHARS && i > 0 {
                kept = i;
                break;
            }
            used += cost;
        }
        text = lines[..kept].join("\n");
        let mut cut = kept < lines.len();
        if kept == 1 && len16(lines[0]) > LOG_READ_CHARS {
            text = clip_utf16(lines[0], LOG_READ_CHARS);
            cut = true;
        }
        if cut {
            text += &format!("\n[analysis covers lines 1-{kept} of {}]", lines.len());
        }
    }
    if trim(&text).is_empty() {
        return bad("Error: give text (the pasted log) or path (a log file in the workspace).", "No log given");
    }
    let count: Vec<String> = args["count"].as_array().map(|a| a.iter().map(js_string).collect()).unwrap_or_default();
    let (report, counted, faults) = log_report(&text, &count);
    Output::ok(report, format!("Analysed {counted} log line(s){}", if faults > 0 { format!(" — {faults} fault(s)") } else { " — no faults".into() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A fresh workspace under the temp folder, removed when dropped.
    struct Ws(PathBuf);
    impl Ws {
        fn new(name: &str, files: &[(&str, &[u8])]) -> Ws {
            let dir = std::env::temp_dir().join(format!("apim-code-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            for (rel, bytes) in files {
                let path = dir.join(rel);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, bytes).unwrap();
            }
            Ws(dir)
        }
    }
    impl Drop for Ws {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn apply_patch_lands_reports_and_keeps_history() {
        let ws = Ws::new("patch", &[("a.txt", b"one\ntwo\nthree\nfour\n"), ("c.json", b"{\"a\": 1}\n")]);
        let patch = "```diff\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n@@ -9,1 +9,1 @@\n-  four\n+4\n```";
        let out = apply_patch(&ws.0, &json!({ "path": "a.txt", "patch": patch }));
        assert!(out.ok, "{}", out.text);
        assert_eq!(std::fs::read_to_string(ws.0.join("a.txt")).unwrap(), "one\nTWO\nthree\n4\n");
        assert_eq!(out.text, "Applied 2 of 2 hunks to a.txt.\n\n  hunk 1/2: applied at line 1 \"one\"\n  hunk 2/2: applied at line 4 (matched ignoring indentation) \"  four\"");
        assert_eq!((out.summary.as_str(), out.changed.as_deref()), ("Patched a.txt (2 hunks)", Some("a.txt")));
        assert_eq!(crate::snapshots::previous_version_bytes(&ws.0, "a.txt", 1).as_deref(), Some(&b"one\ntwo\nthree\nfour\n"[..]));

        // One drifted hunk: nothing is written, and the report says where the nearest candidate differs.
        let out = apply_patch(&ws.0, &json!({ "path": "a.txt", "patch": "@@ -1,2 +1,2 @@\n one\n-TWO!\n+x" }));
        assert!(!out.ok && out.text.contains("1 of 1 hunk(s) did not match, so nothing was written"), "{}", out.text);
        assert!(out.text.contains("closest match is line 1 where 1 of 2 lines agree; first difference there is \"TWO\""), "{}", out.text);
        assert_eq!(out.summary, "1 hunk(s) did not match");
        let out = apply_patch(&ws.0, &json!({ "path": "a.txt", "partial": true, "patch": "@@ -1 +1 @@\n-one\n+1\n@@ -3 +3 @@\n-nope\n+x\n" }));
        assert!(!out.ok && out.summary == "Patched a.txt — 1/2 hunks" && std::fs::read_to_string(ws.0.join("a.txt")).unwrap().starts_with("1\nTWO"), "{}", out.text);

        // A patch that leaves a parse error says so in the same result.
        let out = apply_patch(&ws.0, &json!({ "path": "c.json", "patch": "@@ -1 +1 @@\n-{\"a\": 1}\n+{\"a\": 1,}\n" }));
        assert!(out.ok && out.text.contains("⚠ Syntax check: this edit left 1 parse error in 1 file") && out.text.contains("  c.json:1:") && out.summary.ends_with(" · 1 syntax error"), "{}", out.text);
        assert!(apply_patch(&ws.0, &json!({ "path": "gone.txt", "patch": "x" })).text.starts_with("Error: No such file: gone.txt\n\nThe workspace has 2 file(s)"));
        assert!(parses_as_jsonc("{ // why\n \"a\": 1, }", false) && parses_as_jsonc("{\"a\": 1,}", true) && !parses_as_jsonc("{\"a\": 1,}", false));
    }

    #[test]
    fn verify_file_searches_both_encodings() {
        let mut bytes = b"v17 build\0".to_vec();
        bytes.extend("wide marker".encode_utf16().flat_map(u16::to_le_bytes));
        let ws = Ws::new("verify", &[("app.bin", bytes.as_slice())]);
        let sha = format!("{:x}", Sha256::digest(&bytes));
        let out = verify_file(&ws.0, &json!({ "path": "app.bin", "required": ["v17", "wide marker", "gone"], "absent": ["v16"], "sha256": &sha[..12], "bytes": bytes.len() }));
        assert!(out.ok && out.text.starts_with(&format!("app.bin — 32 bytes, sha256 {sha}\n\nMARKER CHECK FAILED — 5/6 passed\n\n  OK      present: \"v17\" (utf8@0)\n  OK      present: \"wide marker\" (utf16le@10)\n  MISSING required: \"gone\"")), "{}", out.text);
        assert!(out.text.contains("\n  OK      absent: \"v16\"\n\n  OK      sha256: ") && out.text.contains("\n  OK      size: 32 bytes as expected") && out.text.contains("This binary is not the one"), "{}", out.text);
        assert_eq!(out.summary, "app.bin FAILED verification (5/6)");
        assert_eq!(verify_file(&ws.0, &json!({ "path": "app.bin" })).summary, "app.bin: 32 bytes");
    }

    const CPP: &str = "int helper(int a);\n\nvoid\nWidget::OnPaint(HDC dc)\n{\n    if (dc) { draw(\"}\"); }\n}\n\nint helper(int a) {\n    return a;\n}\n";

    #[test]
    fn read_symbol_returns_the_exact_span() {
        let ws = Ws::new(
            "symbol",
            &[
                ("w.cpp", CPP.as_bytes()),
                ("tool.py", b"class A:\n    def run(self):\n        return 1\n\n    def stop(self):\n        pass\n"),
                ("src/a.ts", b"export function load() {\n  return 1;\n}\nawait load({\n});\n"),
                ("tests/a.test.ts", b"function load() {\n  return 2;\n}\n"),
            ],
        );
        // The return type on its own line belongs to the span; the brace inside the string does not end it.
        let out = read_symbol(&ws.0, &json!({ "path": "w.cpp", "name": "OnPaint" }));
        assert!(out.text.starts_with("w.cpp — function OnPaint, lines 3-7 (5 lines).\n\nThis is the EXACT span") && out.text.ends_with("3 | void\n4 | Widget::OnPaint(HDC dc)\n5 | {\n6 |     if (dc) { draw(\"}\"); }\n7 | }"), "{}", out.text);
        // A prototype is not a definition.
        let out = read_symbol(&ws.0, &json!({ "path": "w.cpp", "name": "helper" }));
        assert!(out.text.starts_with("w.cpp — function helper, lines 9-11 (3 lines).") && out.text.contains("\n 9 | int helper(int a) {\n"), "{}", out.text);
        assert_eq!(read_symbol(&ws.0, &json!({ "path": "tool.py", "name": "run" })).summary, "Read run from tool.py:2-3");
        assert_eq!(read_symbol(&ws.0, &json!({ "path": "tool.py", "name": "A" })).summary, "Read A from tool.py:1-6");

        // Go to definition: source before tests, the call site is not listed.
        let out = read_symbol(&ws.0, &json!({ "name": "load" }));
        assert!(out.text.starts_with("2 definitions of \"load\":\n  1. src/a.ts:1-3 — export function load()\n  2. tests/a.test.ts:1-3 — function load()\n\nShowing #1; pass index (or path) to see another.\n\nsrc/a.ts — function load, lines 1-3 (3 lines)."), "{}", out.text);
        assert_eq!(read_symbol(&ws.0, &json!({ "name": "load", "index": "2" })).summary, "Read load from tests/a.test.ts:1-3");
        let missing = read_symbol(&ws.0, &json!({ "path": "w.cpp", "name": "nope" }));
        assert!(!missing.ok && missing.text.starts_with("No definition of \"nope\" in w.cpp (12 lines searched"), "{}", missing.text);
    }

    #[test]
    fn find_references_labels_whole_identifiers() {
        let ws = Ws::new(
            "refs",
            &[("lib.ts", b"export function save(x: number) {\n  return x;\n}\nconst autosave = 1;\n"), ("use.ts", b"import { save } from \"./lib\";\nsave(2);\nconst y = save_as + autosave;\n"), ("notes.txt", b"save me")],
        );
        let out = find_references(&ws.0, &json!({ "name": "Store.save" }));
        assert_eq!(
            out.text,
            "3 references to \"Store.save\" in 2 files (1 definition, 1 import, 1 use):\n\nlib.ts\n      1 [definition] export function save(x: number) {\n\nuse.ts\n      1 [import] import { save } from \"./lib\";\n      2 [use] save(2);"
        );
        assert_eq!(out.summary, "3 references to Store.save in 2 files");
        assert_eq!(find_references(&ws.0, &json!({ "name": "zzz" })).text, "No references to \"zzz\" in 2 source files (whole-identifier match).");
        assert!(!find_references(&ws.0, &json!({ "name": "a b" })).ok);
    }

    #[test]
    fn analyze_log_counts_and_finds_faults() {
        let log = "tick=1 phase gain=0.5\r\ntick=2 phase gain=0.7\ntick=3 backstop gain=0.9\nERROR access violation at 0xC0000005\nexit code 0\n";
        let out = analyze_log(Path::new("."), &json!({ "text": log, "count": ["phase", "backstop"] }));
        for expected in [
            "6 line(s), 5 non-empty. Run counter: tick 1 → 3 across 3 line(s).",
            "Levels (share of the 1 levelled line(s), 20% of the log): ERROR 1 (100% of levelled, 20% of all)",
            "Counted: phase 2 (67%) · backstop 1 (33%)\nRatio phase:backstop = 2.00:1",
            "  tick: n=3 min=1 median=2 mean=2 p95=2.9 max=3\n  gain: n=3 min=0.5 median=0.7 mean=0.7 p95=0.88 max=0.9",
            "Fault sequence (1):\n  line 4: [access violation] ERROR access violation at 0xC0000005\n\nAround the first fault:\n    1   tick=1 phase gain=0.5\n",
            "\n    4 > ERROR access violation at 0xC0000005\n    5   exit code 0\n    6   ",
        ] {
            assert!(out.text.contains(expected), "missing {expected:?} in:\n{}", out.text);
        }
        assert_eq!(out.summary, "Analysed 5 log line(s) — 1 fault(s)");
        assert!(log_report("exited with status 3", &[]).0.contains("[nonzero exit]") && !analyze_log(Path::new("."), &json!({})).ok);
        assert_eq!((to_fixed(0.125, 2), to_fixed(2.5, 0), js_num(1e21), js_num(0.1 + 0.2), commas(1234567)), ("0.13".into(), "3".into(), "1e+21".into(), "0.30000000000000004".into(), "1,234,567".into()));
    }
}

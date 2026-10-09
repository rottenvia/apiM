//! File tools: list, read, write, edit, search. Everything stays inside the
//! chat's workspace folder; a path that climbs out is refused.

use super::{Ctx, Output, bool_arg, num_arg, str_arg};
use globset::{Glob, GlobMatcher};
use regex::{Regex, RegexBuilder};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

const IGNORED: &[&str] = &[".history", ".snapshots", ".packages", ".analysis", "node_modules", ".git", ".next", "__pycache__", ".venv", "venv", "target"];
/// Build output, hidden only at the top of the workspace: a `build` folder deeper in is as likely to be source.
const IGNORED_AT_ROOT: &[&str] = &["dist", "build"];
const MAX_WALK: usize = 50_000;
const MAX_LISTED: usize = 2_000;
use crate::snapshots::MAX_HISTORY_VERSIONS;

/// Turns a model-supplied path into a real one inside `root`, or says why not.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().replace('\\', "/");
    let given = Path::new(&rel);
    let given = if given.is_absolute() {
        given.strip_prefix(root).map_err(|_| format!("Path escapes the workspace: {rel}. Use a path relative to the workspace root."))?
    } else {
        given
    };
    let mut out = root.to_path_buf();
    let mut depth = 0usize;
    for part in given.components() {
        match part {
            Component::Normal(p) => {
                out.push(p);
                depth += 1;
            }
            Component::CurDir => {}
            Component::ParentDir if depth > 0 => {
                out.pop();
                depth -= 1;
            }
            _ => return Err(format!("Path escapes the workspace: {rel}")),
        }
    }
    // A link inside the workspace must not lead out of it: check the deepest part that exists.
    let mut existing = out.as_path();
    while !existing.exists() {
        match existing.parent() {
            Some(p) => existing = p,
            None => break,
        }
    }
    if let (Ok(real), Ok(real_root)) = (existing.canonicalize(), root.canonicalize()) {
        if !real.starts_with(&real_root) {
            return Err(format!("Path escapes the workspace: {rel}"));
        }
    }
    Ok(out)
}

fn rel_of(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

/// Every file under `dir` as (workspace-relative path, size), sorted.
pub fn walk(root: &Path, dir: &Path) -> Vec<(String, u64)> {
    let mut out = Vec::new();
    let entries = walkdir::WalkDir::new(dir).follow_links(false).into_iter().filter_entry(|e| {
        let name = e.file_name().to_string_lossy();
        !(e.depth() > 0 && e.file_type().is_dir() && (IGNORED.contains(&name.as_ref()) || (e.path().parent() == Some(root) && IGNORED_AT_ROOT.contains(&name.as_ref()))))
    });
    for entry in entries.flatten() {
        if entry.file_type().is_file() {
            out.push((rel_of(root, entry.path()), entry.metadata().map_or(0, |m| m.len())));
            if out.len() >= MAX_WALK {
                break;
            }
        }
    }
    out.sort();
    out
}

fn human(size: u64) -> String {
    match size {
        s if s >= 1 << 20 => format!("{:.1} MB", s as f64 / (1u64 << 20) as f64),
        s if s >= 1024 => format!("{:.1} KB", s as f64 / 1024.0),
        s => format!("{s} B"),
    }
}

pub fn list_files(ctx: &Ctx, args: &Value) -> Output {
    let dir = match resolve(&ctx.root, str_arg(args, "path")) {
        Ok(d) => d,
        Err(e) => return Output::fail(e),
    };
    let files = walk(&ctx.root, &dir);
    if files.is_empty() {
        return Output::ok("No files here yet.", "0 files");
    }
    let mut text: String = files.iter().take(MAX_LISTED).map(|(p, s)| format!("{p}  ({})\n", human(*s))).collect();
    if files.len() > MAX_LISTED {
        text.push_str(&format!("… and {} more. Pass path to list one subdirectory.\n", files.len() - MAX_LISTED));
    }
    Output::ok(text, format!("{} files", files.len()))
}

/// Reads a text file. Binary files are refused with their size, UTF-16 is decoded.
pub fn read_text(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return Ok(String::from_utf16_lossy(&units));
    }
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err(format!("{} is a binary file ({}). read_file only reads text.", path.display(), human(bytes.len() as u64)));
    }
    let text = String::from_utf8_lossy(&bytes);
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

/// One file as the model sees it: a header saying which lines of how many, then the text.
fn render_read(rel: &str, text: &str, start: Option<u64>, end: Option<u64>, numbered: bool, budget: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    let first = (start.unwrap_or(1).max(1) as usize).min(total.max(1));
    let last = (end.unwrap_or(total as u64) as usize).clamp(first.min(total), total);
    let width = total.to_string().len();
    let mut body = String::new();
    let mut shown_to = first.saturating_sub(1);
    for (i, line) in lines.iter().enumerate().take(last).skip(first - 1) {
        if body.len() + line.len() > budget && i + 1 > first {
            break;
        }
        if numbered {
            body.push_str(&format!("{:>width$} | ", i + 1));
        }
        body.push_str(line);
        body.push('\n');
        shown_to = i + 1;
    }
    if total == 0 {
        return format!("{rel}: empty file");
    }
    let whole = first == 1 && shown_to == total;
    let header = if whole {
        format!("{rel}: EXACT, all {total} lines, {} chars", text.len())
    } else {
        format!("{rel}: lines {first}-{shown_to} of {total}")
    };
    let notice = if shown_to < last {
        format!(
            "\n[CUT SHORT: you have lines {first}-{shown_to} of {total}. Continue with read_file {{\"path\":\"{rel}\",\"start_line\":{}}}]",
            shown_to + 1
        )
    } else {
        String::new()
    };
    format!("{header}\n{body}{notice}")
}

pub fn read_file(ctx: &Ctx, args: &Value) -> Output {
    let rel = str_arg(args, "path");
    let path = match resolve(&ctx.root, rel) {
        Ok(p) => p,
        Err(e) => return Output::fail(e),
    };
    let (start, end) = (num_arg(args, "start_line"), num_arg(args, "end_line"));
    let ranged = start.is_some() || end.is_some();
    match read_text(&path) {
        Ok(text) => {
            // A whole-file read of something this reply just wrote is answered from the run's memory. The memory is a
            // shortcut, never a second source of truth: the bytes are checked against the disk first, so an edit, a
            // command or the user's editor cannot make it lie.
            let written = if ranged { None } else { ctx.memory.get(rel) };
            let recalled = written.as_deref() == Some(text.as_str());
            if written.is_some() && !recalled {
                ctx.memory.invalidate(rel);
            }
            let mut out = render_read(rel, &text, start, end, bool_arg(args, "line_numbers"), if recalled { usize::MAX } else { ctx.read_chars });
            let header = out.find('\n').unwrap_or(out.len());
            // ponytail: nothing reads this back yet. The web uses it to hand a small file over whole on its first range read
            // and only then (tools.ts SMALL_FILE_LINES); port that with `already_served_whole` when slice-walking costs rounds.
            if !ranged && (out[..header].contains(": EXACT, all ") || text.is_empty()) {
                ctx.memory.record_whole_read(rel, &text);
            }
            if recalled {
                out.insert_str(header, " — served from the run's own write (you wrote these exact bytes in this reply; no re-read was needed)");
                return Output::ok(out, format!("Have {rel} — already written this reply"));
            }
            let summary = out[..header].to_string();
            Output::ok(out, summary)
        }
        Err(e) => Output::fail(e),
    }
}

fn glob(pattern: &str) -> Option<GlobMatcher> {
    Glob::new(pattern.trim().trim_start_matches("./")).ok().map(|g| g.compile_matcher())
}

pub fn read_files(ctx: &Ctx, args: &Value) -> Output {
    let Some(patterns) = args["paths"].as_array() else { return Output::fail("paths must be a list of file paths.") };
    let cap = ctx.limits.read_files as usize;
    let all = walk(&ctx.root, &ctx.root);
    let mut paths: Vec<String> = Vec::new();
    for p in patterns.iter().filter_map(Value::as_str) {
        if p.contains(['*', '?', '[']) {
            match glob(p) {
                Some(g) => paths.extend(all.iter().filter(|(f, _)| g.is_match(f)).map(|(f, _)| f.clone())),
                None => return Output::fail(format!("Bad glob: {p}")),
            }
        } else {
            paths.push(p.to_string());
        }
    }
    paths.dedup();
    let skipped = paths.len().saturating_sub(cap);
    paths.truncate(cap);
    if paths.is_empty() {
        return Output::fail("No files matched.");
    }
    let mut out = String::new();
    let mut budget = ctx.read_chars;
    let mut read = 0;
    for rel in &paths {
        let piece = match resolve(&ctx.root, rel).and_then(|p| read_text(&p)) {
            Ok(text) => {
                read += 1;
                render_read(rel, &text, None, None, false, budget.max(2_000))
            }
            Err(e) => format!("{rel}: ERROR {e}"),
        };
        budget = budget.saturating_sub(piece.len());
        out.push_str(&piece);
        out.push_str("\n\n");
        if budget == 0 {
            out.push_str("[Read budget for this call is spent. Ask for the remaining files in another read_files call.]\n");
            break;
        }
    }
    if skipped > 0 {
        out.push_str(&format!("[{skipped} more files matched; only {cap} are read per call.]\n"));
    }
    Output::ok(out, format!("Read {read} of {} files", paths.len()))
}

/// Why the file tools will not write here, if they will not.
fn protected(rel: &str) -> Result<(), String> {
    if crate::snapshots::is_protected_path(rel) {
        return Err(format!("{rel} is inside a protected folder (.git, .history or .snapshots) and cannot be written, moved or deleted by the file tools"));
    }
    Ok(())
}

/// Keeps the file as it is now, so undo_file can put it back. The history is the web app's: <workspace>/.history.
fn backup(ctx: &Ctx, rel: &str, path: &Path) {
    if let Ok(old) = std::fs::read(path) {
        crate::snapshots::record_previous(&ctx.root, rel, &old);
    }
}

/// Writes a file, keeping the previous version for undo. Errors are parse-checked where that is cheap.
fn write_checked(ctx: &Ctx, rel: &str, content: &str) -> Result<String, String> {
    let path = resolve(&ctx.root, rel)?;
    if path == ctx.root {
        return Err("path is required.".into());
    }
    protected(rel)?;
    backup(ctx, rel, &path);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("Cannot write {rel}: {e}"))?;
    // ponytail: only JSON is parse-checked. Add per-language checks (python -m py_compile, node --check) when wrong syntax costs rounds.
    let warning = if rel.ends_with(".json") {
        serde_json::from_str::<Value>(content).err().map(|e| format!(" SYNTAX ERROR in {rel}: {e}. Fix it before anything else.")).unwrap_or_default()
    } else {
        String::new()
    };
    Ok(warning)
}

pub fn write_file(ctx: &Ctx, args: &Value) -> Output {
    let rel = str_arg(args, "path");
    let Some(content) = args["content"].as_str() else { return Output::fail("content is required.") };
    match write_checked(ctx, rel, content) {
        Ok(warning) => {
            ctx.memory.record_write(rel, content);
            ctx.memory.record_whole_read(rel, content);
            let summary = format!("Wrote {rel} ({} lines)", content.lines().count());
            Output::ok(format!("{summary}.{warning}"), summary).changed(rel)
        }
        Err(e) => Output::fail(e),
    }
}

pub fn write_files(ctx: &Ctx, args: &Value) -> Output {
    let Some(files) = args["files"].as_array() else { return Output::fail("files must be a list of {path, content}.") };
    let cap = ctx.limits.write_files as usize;
    let mut report = String::new();
    let mut written = 0;
    for f in files.iter().take(cap) {
        let rel = str_arg(f, "path");
        match f["content"].as_str().ok_or_else(|| "content is required.".to_string()).and_then(|c| write_checked(ctx, rel, c).map(|w| (c, w))) {
            Ok((c, warning)) => {
                written += 1;
                ctx.memory.record_write(rel, c);
                ctx.memory.record_whole_read(rel, c);
                report.push_str(&format!("Wrote {rel} ({} lines).{warning}\n", c.lines().count()));
            }
            Err(e) => report.push_str(&format!("FAILED {rel}: {e}\n")),
        }
    }
    if files.len() > cap {
        report.push_str(&format!("[{} files were not written: only {cap} per call. Send the rest in another call.]\n", files.len() - cap));
    }
    let summary = format!("Wrote {written} of {} files", files.len());
    Output { ok: written > 0, ..Output::ok(report, summary) }
}

pub fn delete_file(ctx: &Ctx, args: &Value) -> Output {
    let rel = str_arg(args, "path");
    let path = match resolve(&ctx.root, rel) {
        Ok(p) if p.is_file() => p,
        Ok(_) => return Output::fail(format!("{rel} is not a file in the workspace.")),
        Err(e) => return Output::fail(e),
    };
    if let Err(e) = protected(rel) {
        return Output::fail(e);
    }
    backup(ctx, rel, &path);
    match std::fs::remove_file(&path) {
        Ok(()) => Output::ok(format!("Deleted {rel}. undo_file brings it back."), format!("Deleted {rel}")).changed(rel),
        Err(e) => Output::fail(format!("Cannot delete {rel}: {e}")),
    }
}

pub fn move_file(ctx: &Ctx, args: &Value) -> Output {
    let (from, to) = (str_arg(args, "from"), str_arg(args, "to"));
    let (src, dst) = match (resolve(&ctx.root, from), resolve(&ctx.root, to)) {
        (Ok(s), Ok(d)) => (s, d),
        (Err(e), _) | (_, Err(e)) => return Output::fail(e),
    };
    if let Err(e) = protected(from).and(protected(to)) {
        return Output::fail(e);
    }
    if !src.is_file() {
        return Output::fail(format!("{from} does not exist."));
    }
    if dst.exists() {
        return Output::fail(format!("{to} already exists. Delete it first or pick another name."));
    }
    if let Some(dir) = dst.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match std::fs::rename(&src, &dst) {
        Ok(()) => Output::ok(format!("Moved {from} to {to}."), format!("Moved {from} → {to}")).changed(to),
        Err(e) => Output::fail(format!("Cannot move {from}: {e}")),
    }
}

pub fn undo_file(ctx: &Ctx, args: &Value) -> Output {
    let rel = str_arg(args, "path");
    let path = match resolve(&ctx.root, rel) {
        Ok(p) => p,
        Err(e) => return Output::fail(e),
    };
    let steps = num_arg(args, "steps").unwrap_or(1).max(1) as usize;
    let Some(previous) = crate::snapshots::previous_version_bytes(&ctx.root, rel, steps) else {
        let depth = crate::snapshots::history_depth(&ctx.root, rel);
        let text = if depth > 0 {
            let cap = if steps > MAX_HISTORY_VERSIONS { format!(" (at most {MAX_HISTORY_VERSIONS} are ever kept)") } else { String::new() };
            format!("Cannot go back {steps} writes: only {depth} previous version{} kept for {rel}{cap}. Try a smaller number.", if depth == 1 { " is" } else { "s are" })
        } else {
            format!("No previous version of {rel} is kept — it has not been overwritten since it was created. Fix it forward with edit_file instead.")
        };
        return Output { ok: false, text, summary: format!("No history for {rel}"), ..Default::default() };
    };
    // Reverting is itself a write, so it goes into history too: undoing an undo falls out for free.
    backup(ctx, rel, &path);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&path, &previous) {
        return Output::fail(format!("Cannot restore {rel}: {e}"));
    }
    Output::ok(format!("Reverted {rel} to how it was {steps} write{} ago ({} bytes).", if steps == 1 { "" } else { "s" }, previous.len()), format!("Reverted {rel}")).changed(rel)
}

// ---------------------------------------------------------------- editing

#[derive(Default)]
pub struct EditSpec {
    pub old_text: Option<String>,
    pub start_anchor: Option<String>,
    pub end_anchor: Option<String>,
    pub include_anchors: bool,
    pub start_line: Option<usize>,
    pub end_line: Option<usize>,
    pub new_text: String,
}

impl EditSpec {
    pub fn from_args(a: &Value) -> EditSpec {
        let text = |k: &str| a[k].as_str().filter(|s| !s.is_empty()).map(|s| s.replace("\r\n", "\n"));
        EditSpec {
            old_text: text("old_text"),
            start_anchor: text("start_anchor"),
            end_anchor: text("end_anchor"),
            include_anchors: a["include_anchors"].as_bool().unwrap_or(true),
            start_line: num_arg(a, "start_line").map(|n| n as usize),
            end_line: num_arg(a, "end_line").map(|n| n as usize),
            new_text: a["new_text"].as_str().unwrap_or("").replace("\r\n", "\n"),
        }
    }
}

/// Where an edit landed: the new content and the 1-based line range it replaced.
#[derive(Debug)]
pub struct Applied {
    pub content: String,
    pub first: usize,
    pub last: usize,
    pub new_lines: usize,
}

fn squash(line: &str) -> String {
    line.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A pasted 'NNN | ' gutter is display only; strip it so a copy-paste cannot silently fail.
fn strip_gutter(text: &str) -> String {
    static GUTTER: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| Regex::new(r"^\s*\d+ \| ?").unwrap());
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.iter().filter(|l| !l.trim().is_empty()).all(|l| GUTTER.is_match(l)) && lines.iter().any(|l| !l.trim().is_empty()) {
        lines.iter().map(|l| GUTTER.replace(l, "").into_owned()).collect::<Vec<_>>().join("\n")
    } else {
        text.to_string()
    }
}

fn indent_of(line: &str) -> &str {
    &line[..line.len() - line.trim_start().len()]
}

/// Replaces lines `first..=last` (1-based) with `new_text`.
fn splice(lines: &[&str], first: usize, last: usize, new_text: &str) -> Applied {
    let mut out: Vec<&str> = lines[..first - 1].to_vec();
    let new: Vec<&str> = if new_text.is_empty() { Vec::new() } else { new_text.trim_end_matches('\n').split('\n').collect() };
    out.extend(&new);
    out.extend(&lines[last..]);
    Applied { content: out.join("\n"), first, last, new_lines: new.len() }
}

/// Applies one edit to `content` (already normalised to `\n`).
pub fn apply_edit(content: &str, spec: &EditSpec) -> Result<Applied, String> {
    let lines: Vec<&str> = content.split('\n').collect();
    let total = lines.len();

    // An end with no start, next to an anchor: a model that meant a range and dropped half of it. Replacing the one
    // line it did name is how a block ends up doubled, so it is told what to send instead.
    if spec.start_line.is_none() && spec.start_anchor.is_none() && spec.old_text.is_none() && spec.end_anchor.is_some() {
        let at = spec.end_line.map(|n| format!(" (you passed end_line {n})")).unwrap_or_default();
        return Err(format!("The region has an end but no start{at}. To replace lines A to B send start_line A and end_line B and no anchors; to delete them send the same with new_text \"\". For one line, send start_line and end_line with the same number."));
    }
    // A lone end_line means that one line.
    if let Some(start) = spec.start_line.or(spec.end_line) {
        let end = spec.end_line.unwrap_or(start);
        if start < 1 || end < start || end > total {
            return Err(format!("Lines {start}-{end} are out of range: the file has {total} lines."));
        }
        return Ok(splice(&lines, start, end, &spec.new_text));
    }

    if let Some(anchor) = &spec.start_anchor {
        let find = |needle: &str, from: usize| -> Result<usize, String> {
            let want = squash(needle);
            let exact: Vec<usize> = (from..total).filter(|&i| squash(lines[i]) == want).collect();
            let hits = if exact.is_empty() { (from..total).filter(|&i| squash(lines[i]).contains(&want)).collect() } else { exact };
            match hits.as_slice() {
                [one] => Ok(*one),
                [] => Err(format!("Anchor not found: `{}`", needle.trim())),
                many => Err(format!(
                    "Anchor `{}` matches {} lines ({}). Use a line that appears once.",
                    needle.trim(),
                    many.len(),
                    many.iter().take(6).map(|i| (i + 1).to_string()).collect::<Vec<_>>().join(", ")
                )),
            }
        };
        let s = find(anchor, 0)?;
        let e = match &spec.end_anchor {
            // The end anchor may repeat (a closing brace): the first one after the start is meant.
            Some(end) => {
                let want = squash(end);
                (s + 1..total).find(|&i| squash(lines[i]) == want).or_else(|| (s + 1..total).find(|&i| squash(lines[i]).contains(&want))).ok_or_else(|| format!("end_anchor not found after line {}: `{}`", s + 1, end.trim()))?
            }
            None => s,
        };
        return if spec.include_anchors {
            Ok(splice(&lines, s + 1, e + 1, &spec.new_text))
        } else if e > s + 1 {
            Ok(splice(&lines, s + 2, e, &spec.new_text))
        } else {
            // Nothing between the anchors: insert there.
            let mut out = lines[..=s].to_vec();
            let new: Vec<&str> = spec.new_text.trim_end_matches('\n').split('\n').collect();
            out.extend(&new);
            out.extend(&lines[s + 1..]);
            Ok(Applied { content: out.join("\n"), first: s + 2, last: s + 1, new_lines: new.len() })
        };
    }

    let Some(old) = &spec.old_text else {
        return Err("Name the region: old_text, start_anchor (+ end_anchor), or start_line (+ end_line).".into());
    };
    let old = strip_gutter(old);

    // 1. Exact text, which may sit inside a line.
    let exact: Vec<usize> = content.match_indices(old.as_str()).map(|(i, _)| i).collect();
    if exact.len() == 1 {
        let at = exact[0];
        let first = content[..at].matches('\n').count() + 1;
        let last = first + old.matches('\n').count();
        let new_content = format!("{}{}{}", &content[..at], spec.new_text, &content[at + old.len()..]);
        return Ok(Applied { content: new_content, first, last, new_lines: spec.new_text.split('\n').count() });
    }
    if exact.len() > 1 {
        let at: Vec<String> = exact.iter().take(6).map(|i| (content[..*i].matches('\n').count() + 1).to_string()).collect();
        return Err(format!("old_text matches {} places (lines {}). Include a neighbouring line so it identifies one.", exact.len(), at.join(", ")));
    }

    // 2. Whole lines, ignoring indentation and inner spacing.
    let want: Vec<String> = old.trim_matches('\n').split('\n').map(squash).collect();
    let have: Vec<String> = lines.iter().map(|l| squash(l)).collect();
    let hits: Vec<usize> = (0..=total.saturating_sub(want.len())).filter(|&i| want.len() <= total && have[i..i + want.len()] == want[..]).collect();
    match hits.as_slice() {
        [at] => {
            // Carry the file's indentation over to the replacement when the snippet was pasted at another depth.
            let file_indent = indent_of(lines[*at]);
            let old_indent = indent_of(old.trim_matches('\n').split('\n').next().unwrap_or(""));
            let new_text = if file_indent != old_indent {
                spec.new_text.split('\n').map(|l| if l.trim().is_empty() { l.to_string() } else { format!("{file_indent}{}", l.strip_prefix(old_indent).unwrap_or(l)) }).collect::<Vec<_>>().join("\n")
            } else {
                spec.new_text.clone()
            };
            Ok(splice(&lines, at + 1, at + want.len(), &new_text))
        }
        [] => Err(nearest_miss(&lines, &have, &want)),
        many => Err(format!(
            "old_text matches {} places (lines {}). Include a neighbouring line so it identifies one.",
            many.len(),
            many.iter().take(6).map(|i| (i + 1).to_string()).collect::<Vec<_>>().join(", ")
        )),
    }
}

/// Says where the closest candidate is and which line stops matching, so the next try needs no re-read.
fn nearest_miss(lines: &[&str], have: &[String], want: &[String]) -> String {
    let mut best = (0usize, 0usize); // (matching lines, start index)
    for (i, line) in have.iter().enumerate() {
        if *line != want[0] {
            continue;
        }
        let run = want.iter().zip(&have[i..]).take_while(|(a, b)| a == b).count();
        if run > best.0 {
            best = (run, i);
        }
    }
    if best.0 == 0 {
        return format!("old_text not found: no line matches its first line `{}`. Read the file (line_numbers: true) and copy the text exactly, or use start_line/end_line.", want[0]);
    }
    let miss = best.1 + best.0;
    format!(
        "old_text not found. The nearest candidate starts at line {} and matches {} line(s), then differs at line {}: expected `{}` but the file has `{}`.",
        best.1 + 1,
        best.0,
        miss + 1,
        want.get(best.0).map_or("", String::as_str),
        lines.get(miss).map_or("(end of file)", |l| l.trim())
    )
}

/// A few numbered lines around what changed, so the model can check its edit without another read.
fn snippet(content: &str, first: usize, new_lines: usize) -> String {
    let lines: Vec<&str> = content.split('\n').collect();
    let from = first.saturating_sub(3);
    let to = (first + new_lines + 2).min(lines.len()).min(from + 40);
    let width = lines.len().to_string().len();
    (from..to).map(|i| format!("{:>width$} | {}\n", i + 1, lines[i])).collect()
}

fn describe(rel: &str, content: &str, a: &Applied, preview: bool) -> String {
    let old: Vec<&str> = content.split('\n').collect();
    if preview {
        let shown: String = (a.first..=a.last.min(a.first + 39)).filter_map(|n| old.get(n - 1).map(|l| format!("{n} | {l}\n"))).collect();
        format!("PREVIEW, nothing written. {rel}: lines {}-{} would be replaced by {} line(s):\n{shown}", a.first, a.last, a.new_lines)
    } else {
        // What went, as well as what is there now: an edit by line numbers that are a few lines off replaces
        // the wrong text and looks like a success, and the model finds out rounds later, if at all.
        let gone: Vec<&str> = (a.first..=a.last).filter_map(|n| old.get(n - 1).copied()).collect();
        let was = if gone.is_empty() {
            String::new()
        } else if gone.iter().all(|l| l.trim().is_empty()) {
            " They were blank: if you meant other lines, undo_file puts this back.".to_string()
        } else {
            let shown: String = gone.iter().take(4).map(|l| format!("  - {}\n", l.trim_end().chars().take(120).collect::<String>())).collect();
            format!(" They read:\n{shown}{}", if gone.len() > 4 { format!("  … and {} more\n", gone.len() - 4) } else { String::new() })
        };
        format!("{rel}: replaced lines {}-{} with {} line(s).{was}{}Now:\n{}", a.first, a.last, a.new_lines, if was.ends_with('\n') || was.is_empty() { if was.is_empty() { " " } else { "" } } else { "\n" }, snippet(&a.content, a.first, a.new_lines))
    }
}

/// Reads, edits and (unless previewing) writes one file, keeping its line endings.
fn edit_one(ctx: &Ctx, rel: &str, specs: &[&EditSpec], preview: bool) -> Vec<Result<String, String>> {
    let loaded = resolve(&ctx.root, rel).and_then(|p| read_text(&p));
    let Ok(original) = loaded else {
        let e = loaded.unwrap_err();
        return specs.iter().map(|_| Err(e.clone())).collect();
    };
    let crlf = original.contains("\r\n");
    let mut content = original.replace("\r\n", "\n");
    let mut changed = false;
    let results = specs
        .iter()
        .map(|spec| {
            apply_edit(&content, spec).and_then(|applied| {
                if applied.content == content {
                    // Reported as done, this sends a model round in circles: it reads "Edited" and the file is as it was.
                    return Err(format!(
                        "Nothing changed: lines {}-{} already read exactly as new_text. If lines around them are wrong (a doubled line, a leftover), name the whole range with start_line and end_line; new_text \"\" deletes it. The file now:\n{}",
                        applied.first,
                        applied.last,
                        snippet(&content, applied.first, applied.new_lines)
                    ));
                }
                let text = describe(rel, &content, &applied, preview);
                content = applied.content;
                changed = true;
                Ok(text)
            })
        })
        .collect();
    if changed && !preview {
        let out = if crlf { content.replace('\n', "\r\n") } else { content };
        if let Err(e) = write_checked(ctx, rel, &out) {
            return specs.iter().map(|_| Err(e.clone())).collect();
        }
    }
    results
}

pub fn edit_file(ctx: &Ctx, args: &Value) -> Output {
    let rel = str_arg(args, "path");
    let spec = EditSpec::from_args(args);
    let preview = bool_arg(args, "preview");
    match edit_one(ctx, rel, &[&spec], preview).remove(0) {
        Ok(text) => {
            let out = Output::ok(text, if preview { format!("Previewed edit to {rel}") } else { format!("Edited {rel}") });
            if preview { out } else { out.changed(rel) }
        }
        Err(e) => Output::fail(format!("{rel}: {e}")),
    }
}

pub fn edit_files(ctx: &Ctx, args: &Value) -> Output {
    let cap = ctx.limits.batch_edits as usize;
    // Accepts flat edits, a single top-level path, and {path, edits:[…]} groups.
    let top = str_arg(args, "path");
    let mut flat: Vec<(String, EditSpec)> = Vec::new();
    for e in args["edits"].as_array().map(Vec::as_slice).unwrap_or_default() {
        let path = if str_arg(e, "path").is_empty() { top } else { str_arg(e, "path") };
        match e["edits"].as_array() {
            Some(group) => flat.extend(group.iter().map(|g| (path.to_string(), EditSpec::from_args(g)))),
            None => flat.push((path.to_string(), EditSpec::from_args(e))),
        }
    }
    if flat.is_empty() {
        return Output::fail("edits must be a list of {path, old_text|anchors|lines, new_text}.");
    }
    let dropped = flat.len().saturating_sub(cap);
    flat.truncate(cap);
    let preview = bool_arg(args, "preview");

    // Edits to one file apply in order against the same evolving content.
    let mut order: Vec<&str> = Vec::new();
    for (p, _) in &flat {
        if !order.contains(&p.as_str()) {
            order.push(p);
        }
    }
    let mut report = vec![String::new(); flat.len()];
    let mut landed = 0;
    for path in order {
        let idx: Vec<usize> = (0..flat.len()).filter(|&i| flat[i].0 == path).collect();
        let specs: Vec<&EditSpec> = idx.iter().map(|&i| &flat[i].1).collect();
        for (i, r) in idx.iter().zip(edit_one(ctx, path, &specs, preview)) {
            report[*i] = match r {
                Ok(t) => {
                    landed += 1;
                    format!("#{} OK {t}", i + 1)
                }
                Err(e) => format!("#{} FAILED {path}: {e}", i + 1),
            };
        }
    }
    let mut text = report.join("\n");
    if dropped > 0 {
        text.push_str(&format!("\n[{dropped} edits were not applied: only {cap} per call. Send the rest in another call.]"));
    }
    let summary = format!("{landed} of {} edits {}", flat.len(), if preview { "previewed" } else { "applied" });
    Output { ok: landed > 0, ..Output::ok(text, summary) }
}

// ---------------------------------------------------------------- searching

fn pattern(query: &str, regex: bool, case_sensitive: bool) -> Result<Regex, String> {
    let source = if regex { query.to_string() } else { regex::escape(query) };
    RegexBuilder::new(&source)
        .case_insensitive(!case_sensitive)
        .multi_line(true)
        .build()
        .map_err(|e| format!("Bad regular expression: {e}. Leave regex off to search for plain text."))
}

/// Files a search or bulk replace should look at: text, not huge, matching the glob.
fn searchable(ctx: &Ctx, filter: &str) -> Result<Vec<String>, String> {
    let matcher = if filter.is_empty() { None } else { Some(glob(filter).ok_or_else(|| format!("Bad glob: {filter}"))?) };
    Ok(walk(&ctx.root, &ctx.root).into_iter().filter(|(p, size)| *size <= ctx.limits.searchable_bytes && matcher.as_ref().is_none_or(|g| g.is_match(p))).map(|(p, _)| p).collect())
}

pub fn search_files(ctx: &Ctx, args: &Value) -> Output {
    let cap = ctx.limits.search_hits as usize;
    let query = str_arg(args, "query");
    if query.is_empty() {
        return Output::fail("query is required.");
    }
    let re = match pattern(query, bool_arg(args, "regex"), bool_arg(args, "case_sensitive")) {
        Ok(r) => r,
        Err(e) => return Output::fail(e),
    };
    let files = match searchable(ctx, str_arg(args, "glob")) {
        Ok(f) => f,
        Err(e) => return Output::fail(e),
    };
    let context = num_arg(args, "context").unwrap_or(0).min(ctx.limits.search_context) as usize;
    let mut out = String::new();
    let (mut hits, mut in_files) = (0, 0);
    'files: for rel in &files {
        let Ok(text) = read_text(&ctx.root.join(rel)) else { continue };
        let lines: Vec<&str> = text.lines().collect();
        let mut found = false;
        let mut printed_to = 0;
        for (i, line) in lines.iter().enumerate() {
            if !re.is_match(line) {
                continue;
            }
            if hits >= cap {
                out.push_str(&format!("[Stopped at {cap} matches. Narrow the query or add a glob.]\n"));
                break 'files;
            }
            hits += 1;
            found = true;
            let from = i.saturating_sub(context).max(printed_to);
            let to = (i + context + 1).min(lines.len());
            for (n, l) in lines.iter().enumerate().take(to).skip(from) {
                let mark = if n == i { ':' } else { '-' };
                let shown: String = l.chars().take(400).collect();
                out.push_str(&format!("{rel}{mark}{}{mark} {shown}\n", n + 1));
            }
            printed_to = to;
            if context > 0 {
                out.push_str("--\n");
            }
        }
        in_files += found as usize;
    }
    if hits == 0 {
        return Output::ok(format!("No matches for `{query}` in {} files.", files.len()), "0 matches");
    }
    let summary = format!("{hits} matches in {in_files} files");
    Output::ok(format!("{summary}\n{out}"), summary)
}

pub fn replace_in_files(ctx: &Ctx, args: &Value) -> Output {
    let find = str_arg(args, "find");
    let Some(replace) = args["replace"].as_str() else { return Output::fail("replace is required (use an empty string to delete).") };
    if find.is_empty() {
        return Output::fail("find is required.");
    }
    let is_regex = bool_arg(args, "regex");
    let re = match pattern(find, is_regex, true) {
        Ok(r) => r,
        Err(e) => return Output::fail(e),
    };
    let files = match searchable(ctx, str_arg(args, "glob")) {
        Ok(f) => f,
        Err(e) => return Output::fail(e),
    };
    let preview = bool_arg(args, "preview");
    let mut report = String::new();
    let (mut total, mut touched) = (0, 0);
    for rel in &files {
        let Ok(text) = read_text(&ctx.root.join(rel)) else { continue };
        let count = re.find_iter(&text).count();
        if count == 0 {
            continue;
        }
        if !preview {
            // A literal replacement must not expand `$1`; a regex one should.
            let new = if is_regex { re.replace_all(&text, replace) } else { re.replace_all(&text, regex::NoExpand(replace)) };
            if let Err(e) = write_checked(ctx, rel, &new) {
                report.push_str(&format!("FAILED {rel}: {e}\n"));
                continue;
            }
        }
        total += count;
        touched += 1;
        report.push_str(&format!("{rel}: {count}\n"));
    }
    if total == 0 {
        return Output::ok(format!("`{find}` does not appear in {} files. Nothing changed.", files.len()), "0 replacements");
    }
    let summary = format!("{}{total} replacements in {touched} files", if preview { "PREVIEW: " } else { "" });
    Output::ok(format!("{summary}\n{report}"), summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(f: impl FnOnce(&mut EditSpec)) -> EditSpec {
        let mut s = EditSpec { include_anchors: true, ..Default::default() };
        f(&mut s);
        s
    }

    #[test]
    fn paths_cannot_escape() {
        let root = std::env::temp_dir();
        assert!(resolve(&root, "a/b.txt").is_ok());
        assert!(resolve(&root, "a/../b.txt").is_ok());
        assert!(resolve(&root, "../x").is_err());
        assert!(resolve(&root, "a/../../x").is_err());
        assert!(resolve(&root, if cfg!(windows) { "C:\\Windows\\win.ini" } else { "/etc/passwd" }).is_err());
    }

    #[test]
    fn edit_exact_and_tolerant() {
        let src = "fn a() {\n    let x = 1;\n    let y = 2;\n}\n";
        let a = apply_edit(src, &spec(|s| { s.old_text = Some("let x = 1;".into()); s.new_text = "let x = 9;".into() })).unwrap();
        assert_eq!(a.content, src.replace("x = 1", "x = 9"));
        assert_eq!((a.first, a.last), (2, 2));

        // Pasted with the wrong indentation and a line-number gutter.
        let a = apply_edit(src, &spec(|s| { s.old_text = Some("2 | let x = 1;\n3 | let y = 2;".into()); s.new_text = "let z = 3;".into() })).unwrap();
        assert_eq!(a.content, "fn a() {\n    let z = 3;\n}\n");
    }

    #[test]
    fn edit_reports_ambiguity_and_misses() {
        let src = "a\nb\na\nc\n";
        assert!(apply_edit(src, &spec(|s| { s.old_text = Some("a".into()); })).unwrap_err().contains("matches 2 places"));
        let err = apply_edit("one\ntwo\nthree\n", &spec(|s| { s.old_text = Some("one\ntwo\nfour".into()); })).unwrap_err();
        assert!(err.contains("differs at line 3") && err.contains("three"), "{err}");
    }

    #[test]
    fn edit_anchors_and_lines() {
        let src = "start\nx\ny\nend\ntail";
        let a = apply_edit(src, &spec(|s| { s.start_anchor = Some("  start".into()); s.end_anchor = Some("end".into()); s.new_text = "Z".into() })).unwrap();
        assert_eq!(a.content, "Z\ntail");
        let a = apply_edit(src, &spec(|s| { s.start_anchor = Some("start".into()); s.end_anchor = Some("end".into()); s.include_anchors = false; s.new_text = "Z".into() })).unwrap();
        assert_eq!(a.content, "start\nZ\nend\ntail");
        let a = apply_edit(src, &spec(|s| { s.start_line = Some(2); s.end_line = Some(3); s.new_text = String::new() })).unwrap();
        assert_eq!(a.content, "start\nend\ntail");
        assert!(apply_edit(src, &spec(|s| { s.start_line = Some(9); })).is_err());
        // The result names what was replaced, and says so when that was nothing but blank lines.
        let told = describe("f", "a\n\nb", &apply_edit("a\n\nb", &spec(|s| { s.start_line = Some(2); s.new_text = "x".into() })).unwrap(), false);
        assert!(told.starts_with("f: replaced lines 2-2 with 1 line(s). They were blank: if you meant other lines, undo_file puts this back.\nNow:\n1 | a\n2 | x"), "{told}");
        let told = describe("f", "a\nb", &apply_edit("a\nb", &spec(|s| { s.old_text = Some("b".into()); s.new_text = "c".into() })).unwrap(), false);
        assert!(told.starts_with("f: replaced lines 2-2 with 1 line(s). They read:\n  - b\nNow:\n1 | a\n2 | c"), "{told}");
        // Half a range (an end, no start) is refused rather than taken for one line.
        let half = apply_edit(src, &spec(|s| { s.end_line = Some(3); s.end_anchor = Some("end".into()); s.new_text = "Z".into() })).unwrap_err();
        assert!(half.contains("end but no start") && half.contains("end_line 3"), "{half}");
    }

    #[test]
    fn read_is_honest_about_cuts() {
        let text = "l1\nl2\nl3\nl4\n";
        assert!(render_read("f", text, None, None, false, 1000).starts_with("f: EXACT, all 4 lines"));
        let cut = render_read("f", text, None, None, true, 10);
        assert!(cut.contains("lines 1-2 of 4") && cut.contains("\"start_line\":3"), "{cut}");
        assert!(render_read("f", text, Some(3), Some(4), true, 1000).contains("3 | l3"));
    }
}

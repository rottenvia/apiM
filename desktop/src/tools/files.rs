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
/// The largest file read as text.
const MAX_TEXT: u64 = 64 << 20;
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

/// `~`, `%NAME%` and `$env:NAME` at the start of a path, as a person types them.
pub fn expand(path: &str) -> String {
    static NAMED: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| Regex::new(r"^(?:%([A-Za-z_()0-9]+)%|\$env:([A-Za-z_()0-9]+))").unwrap());
    let path = path.trim();
    if let Some(rest) = path.strip_prefix('~').filter(|rest| rest.is_empty() || rest.starts_with(['/', '\\'])) {
        return format!("{}{rest}", std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default());
    }
    let Some(found) = NAMED.captures(path) else { return path.to_string() };
    let name = found.get(1).or(found.get(2)).map_or("", |m| m.as_str());
    std::env::var(name).map_or_else(|_| path.to_string(), |value| format!("{value}{}", &path[found[0].len()..]))
}

/// Places that keep sign-ins and keys. They are not read for a model in any approval mode: what a tool reads goes
/// to the model's provider, and a page the model was shown can ask it to go and fetch one.
// ponytail: the common places, matched on the path alone. A program the model writes and runs is not held by it.
const CLOSED: &[&str] = &["/.ssh", "/.gnupg", "/.aws", "/user data", "/firefox/profiles", "/microsoft/credentials", "/microsoft/protect", "/system32/config"];
const CLOSED_FILES: &[&str] = &[".env", ".netrc", "_netrc", ".git-credentials", ".npmrc", ".pypirc"];
pub const CLOSED_WHY: &str = "that place keeps sign-ins or keys, and apiM does not read it for a model. If the task needs one file from it, ask the user to copy that file into the workspace.";

/// The same search over a command's text.
pub fn closed_text(text: &str) -> bool {
    let text = text.replace('\\', "/").to_lowercase();
    CLOSED.iter().any(|part| text.contains(part)) || CLOSED_FILES.iter().any(|file| text.contains(&format!("/{file}")))
}

fn closed(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let own = [crate::store::config_dir(), crate::store::data_dir()].iter().any(|dir| path == dir.join("settings.json"));
    own || closed_text(&format!("{}/", path.display())) || CLOSED_FILES.iter().any(|file| name == *file || name.starts_with(&format!("{file}."))) || name.ends_with(".kdbx")
}

/// A path to look at: inside the workspace as `resolve` has it, or anywhere on the computer when written in full.
/// Writing stays with `resolve`: nothing outside the workspace is changed by a file tool.
pub fn resolve_look(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let full = expand(rel).replace('\\', "/");
    let given = Path::new(&full);
    if !given.is_absolute() || given.starts_with(root) {
        return resolve(root, &full);
    }
    if given.components().any(|part| matches!(part, Component::ParentDir)) {
        return Err(format!("Write the path in full, without `..`: {rel}"));
    }
    // A link must not lead into a closed place either.
    if closed(given) || given.canonicalize().is_ok_and(|real| closed(&real)) {
        return Err(format!("{rel} is not read: {CLOSED_WHY}"));
    }
    Ok(given.to_path_buf())
}

/// With "Ask me first", the user allows each folder outside the workspace before it is looked into: once, or for the chat.
pub async fn may_look(ctx: &Ctx, args: &Value) -> Result<(), String> {
    if ctx.settings.approval != crate::store::Approval::Manual {
        return Ok(());
    }
    let mut allowed: Vec<PathBuf> = Vec::new();
    for rel in std::iter::once(str_arg(args, "path").to_string()).chain(super::list_arg(args, "paths")) {
        let Some(path) = resolve_look(&ctx.root, &rel).ok().filter(|path| !path.starts_with(&ctx.root)) else { continue };
        let folder = if path.is_dir() { path } else { path.parent().map_or(path.clone(), Path::to_path_buf) };
        if allowed.contains(&folder) {
            continue;
        }
        let shown = folder.display().to_string().replace('/', std::path::MAIN_SEPARATOR_STR);
        if !ctx.emit.approve_keyed(&shown, "To look at files outside this chat's folder. Nothing there is changed.", &format!("look:{}", shown.to_lowercase())).await {
            return Err(format!("The user did not allow looking in {shown}. Do not retry it: say what you wanted from there, or ask them for the file."));
        }
        allowed.push(folder);
    }
    Ok(())
}

/// Entries shown of one folder outside the workspace.
const MAX_OUTSIDE: usize = 400;

/// One folder outside the workspace, a level at a time: its folders, then its files with their size and when they
/// last changed, newest first. The newest log or crash dump is what a look outside is usually after.
fn list_outside(dir: &Path) -> Output {
    let Ok(entries) = std::fs::read_dir(dir) else { return Output::fail(format!("Cannot list {}: there is no such folder, or it may not be read.", dir.display())) };
    let (mut folders, mut files) = (Vec::new(), Vec::new());
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        match entry.metadata() {
            Ok(meta) if meta.is_dir() => folders.push(name),
            Ok(meta) => files.push((meta.modified().ok(), name, meta.len())),
            Err(_) => {}
        }
    }
    folders.sort_by_key(|name| name.to_lowercase());
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let mut text = format!("{} (outside the workspace: this folder only, newest files first)\n", dir.display());
    text.extend(folders.iter().take(MAX_OUTSIDE).map(|name| format!("{name}/\n")));
    for (when, name, size) in files.iter().take(MAX_OUTSIDE.saturating_sub(folders.len())) {
        let when = when.map_or(String::new(), |at| chrono::DateTime::<chrono::Local>::from(at).format(", %Y-%m-%d %H:%M").to_string());
        text.push_str(&format!("{name}  ({}{when})\n", human(*size)));
    }
    match folders.len() + files.len() {
        0 => text.push_str("Nothing in it.\n"),
        total if total > MAX_OUTSIDE => text.push_str(&format!("… and {} more.\n", total - MAX_OUTSIDE)),
        _ => {}
    }
    Output::ok(text, format!("{} folders, {} files", folders.len(), files.len()))
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
    let dir = match resolve_look(&ctx.root, str_arg(args, "path")) {
        Ok(d) => d,
        Err(e) => return Output::fail(e),
    };
    if !dir.starts_with(&ctx.root) {
        return list_outside(&dir);
    }
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
    decode(path).map(|(text, _)| text)
}

/// For a file about to be changed and written back: one that is not UTF-8 is refused. Its other bytes come out
/// of `read_text` as "\u{fffd}", and writing that back is what destroys a file in an older encoding.
pub fn read_text_exact(path: &Path) -> Result<String, String> {
    match decode(path)? {
        (_, true) => Err(format!("{} is not UTF-8 text (it holds bytes in an older encoding), so changing it here would damage it. Change it with a script that reads and writes it in its own encoding.", path.file_name().unwrap_or(path.as_os_str()).to_string_lossy())),
        (text, false) => Ok(text),
    }
}

/// The text of a file, and whether bytes that are not UTF-8 had to be replaced to show it.
fn decode(path: &Path) -> Result<(String, bool), String> {
    // The file's name, not where the workspace sits on the disk: the whole path filled the step's line and cut the reason off.
    let name = path.file_name().unwrap_or(path.as_os_str()).to_string_lossy();
    if path.is_dir() {
        return Err(format!("{name} is a folder, not a file: list_files shows what is in it."));
    }
    // A crash dump or a disk image is not text, and reading one whole to find that out would fill the memory.
    if let Some(size) = path.metadata().ok().map(|meta| meta.len()).filter(|size| *size > MAX_TEXT) {
        return Err(format!("{} is {}: too large to read as text. Take the part you need with a command, or inspect_binary if it is a program.", name, human(size)));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read {name}: {e}"))?;
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return Ok((String::from_utf16_lossy(&units), false));
    }
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Err(format!("{name} is a binary file ({}). read_file only reads text.", human(bytes.len() as u64)));
    }
    let text = String::from_utf8_lossy(&bytes);
    Ok((text.strip_prefix('\u{feff}').unwrap_or(&text).to_string(), matches!(text, std::borrow::Cow::Owned(_))))
}

/// What to say of a file that is not there: where files of that name are, when there are any. A reply asked three
/// times for a file under the wrong folder, the right one two folders away.
fn missing(ctx: &Ctx, rel: &str) -> String {
    let wanted = rel.replace('\\', "/").rsplit('/').next().unwrap_or(rel).to_lowercase();
    let same: Vec<String> = walk(&ctx.root, &ctx.root).into_iter().map(|(path, _)| path).filter(|path| path.rsplit('/').next().is_some_and(|name| name.to_lowercase() == wanted)).take(3).collect();
    match same.is_empty() {
        true => format!("{rel} does not exist. list_files shows what is there."),
        false => format!("{rel} does not exist. A file of that name is at: {}.", same.join(", ")),
    }
}

/// A line longer than this is shown by its start. A read that asked for the first five lines of a one-line file
/// got all 217,000 characters of it, and they rode in every request of the 218 rounds that followed.
pub const READ_LINE_CHARS: usize = 8_000;

/// `text` with every line over `READ_LINE_CHARS` cut to its start and what is missing said at its end; None when no line is that long.
pub fn cut_long_lines(text: &str) -> Option<String> {
    if !text.lines().any(|line| line.len() > READ_LINE_CHARS) {
        return None;
    }
    let cut = |line: &str| match line.len() > READ_LINE_CHARS {
        true => {
            let end = line.floor_char_boundary(READ_LINE_CHARS);
            format!("{} [… {} more characters of this line are not shown]", &line[..end], line.len() - end)
        }
        false => line.to_string(),
    };
    Some(text.split('\n').map(cut).collect::<Vec<_>>().join("\n"))
}

/// One file as the model sees it: a header saying which lines of how many, then the text.
fn render_read(rel: &str, text: &str, start: Option<u64>, end: Option<u64>, numbered: bool, budget: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    let first = (start.unwrap_or(1).max(1) as usize).min(total.max(1));
    let last = (end.unwrap_or(total as u64) as usize).clamp(first.min(total), total);
    let width = total.to_string().len();
    let mut body = String::new();
    let (mut shown_to, mut long) = (first.saturating_sub(1), 0);
    for (i, line) in lines.iter().enumerate().take(last).skip(first - 1) {
        let cut = cut_long_lines(line);
        let line = cut.as_deref().unwrap_or(line);
        if body.len() + line.len() > budget && i + 1 > first {
            break;
        }
        if numbered {
            body.push_str(&format!("{:>width$} | ", i + 1));
        }
        body.push_str(line);
        body.push('\n');
        shown_to = i + 1;
        long += cut.is_some() as usize;
    }
    if total == 0 {
        return format!("{rel}: empty file");
    }
    let whole = first == 1 && shown_to == total;
    let header = if whole && long > 0 {
        format!("{rel}: all {total} lines, {} chars, long lines cut", text.len())
    } else if whole {
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
    let cut = match long {
        0 => String::new(),
        n => format!(
            "\n[LONG LINES: {n} of these lines {} over {READ_LINE_CHARS} characters and show only {} start. To find text inside one, call search_files with \"path\":\"{rel}\": it shows what surrounds each match. To work on the whole line, run a script over the file. edit_file cannot match text that is not shown.]",
            if n == 1 { "is" } else { "are" },
            if n == 1 { "its" } else { "their" }
        ),
    };
    format!("{header}\n{body}{notice}{cut}")
}

pub fn read_file(ctx: &Ctx, args: &Value) -> Output {
    let rel = str_arg(args, "path");
    let path = match resolve_look(&ctx.root, rel) {
        Ok(p) => p,
        Err(e) => return Output::fail(e),
    };
    let (start, end) = (num_arg(args, "start_line"), num_arg(args, "end_line"));
    let ranged = start.is_some() || end.is_some();
    if rel.trim().is_empty() {
        return Output::fail("path is required.");
    }
    if !path.exists() {
        return Output::fail(missing(ctx, rel));
    }
    match decode(&path) {
        Ok((text, lossy)) => {
            // A whole-file read of something this reply just wrote is answered from the run's memory. The memory is a
            // shortcut, never a second source of truth: the bytes are checked against the disk first, so an edit, a
            // command or the user's editor cannot make it lie.
            let written = if ranged { None } else { ctx.memory.get(rel) };
            let recalled = written.as_deref() == Some(text.as_str());
            if written.is_some() && !recalled {
                ctx.memory.invalidate(rel);
            }
            let mut out = render_read(rel, &text, start, end, bool_arg(args, "line_numbers"), if recalled { usize::MAX } else { ctx.read_chars });
            if lossy {
                // Not the file's exact text, and said so: "EXACT" over a line of "caf\u{fffd}" invited an edit that would have written the \u{fffd} back.
                out = format!("{}\n[NOT UTF-8: this file is in an older encoding, and its bytes that are not valid UTF-8 show as \u{fffd}. edit_file refuses it: change it with a script that reads and writes it in its own encoding.]", out.replacen(": EXACT, all ", ": all ", 1));
            }
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
        let piece = match resolve_look(&ctx.root, rel).and_then(|p| read_text(&p)) {
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
    if path.is_dir() {
        return Err(format!("{rel} is a folder. Name a file inside it."));
    }
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
        Ok(p) if p.is_dir() && p != ctx.root => return delete_folder(ctx, rel, &p),
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

/// A folder goes with everything in it: a model cleaning up after itself otherwise deleted file by file, or
/// reached for a script to do it. Each file is kept first, so undo_file brings any of them back.
fn delete_folder(ctx: &Ctx, rel: &str, dir: &Path) -> Output {
    let inside = walk(&ctx.root, dir);
    if inside.len() > 500 {
        return Output::fail(format!("{rel} holds {} files: too many to delete in one step. Delete the parts of it you made, by name.", inside.len()));
    }
    if let Some(e) = std::iter::once(rel).chain(inside.iter().map(|(file, _)| file.as_str())).find_map(|file| protected(file).err()) {
        return Output::fail(e);
    }
    for (file, _) in &inside {
        backup(ctx, file, &ctx.root.join(file));
    }
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Output::ok(format!("Deleted the folder {rel} with the {} file(s) in it. undo_file brings a file back by its path.", inside.len()), format!("Deleted {}/", rel.trim_end_matches(['/', '\\']))).changed(rel),
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
        return Err(format!("old_text matches {} places (lines {}). Include a neighbouring line so it identifies one, or change every one of them with replace_in_files.", exact.len(), at.join(", ")));
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
            "old_text matches {} places (lines {}). Include a neighbouring line so it identifies one, or change every one of them with replace_in_files.",
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
    let told = if preview {
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
    };
    // The lines around an edit are shown as a read shows them. A file holding a 600,000-character line came back whole
    // with each of two edits, and the request after them was more than the provider would take: the reply ended there.
    cut_long_lines(&told).unwrap_or(told)
}

/// Reads, edits and (unless previewing) writes one file, keeping its line endings.
fn edit_one(ctx: &Ctx, rel: &str, specs: &[&EditSpec], preview: bool) -> Vec<Result<String, String>> {
    let loaded = resolve(&ctx.root, rel).and_then(|p| read_text_exact(&p));
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
    let filter = str_arg(args, "glob");
    let Some(matcher) = (if filter.is_empty() { Some(None) } else { glob(filter).map(Some) }) else { return Output::fail(format!("Bad glob: {filter}")) };
    // `path` keeps the search to one file or folder. A model that knows the file names it there, and was told
    // "no matches" for text the file held: the argument was not read, and the file was over the size to search.
    let scope = str_arg(args, "path").replace('\\', "/");
    let scope = scope.trim().trim_start_matches("./").trim_matches('/');
    let inside: Vec<(String, u64)> = walk(&ctx.root, &ctx.root).into_iter().filter(|(p, _)| scope.is_empty() || p == scope || p.strip_prefix(scope).is_some_and(|rest| rest.starts_with('/'))).collect();
    if inside.is_empty() && !scope.is_empty() {
        return Output::fail(format!("Nothing at {scope} to search: path is a file or a folder of the workspace."));
    }
    // A file asked for by name is searched whatever its size.
    let named = inside.len() == 1 && inside[0].0 == scope;
    let (files, big): (Vec<_>, Vec<_>) = inside.into_iter().filter(|(p, _)| matcher.as_ref().is_none_or(|g| g.is_match(p))).partition(|(_, size)| named || *size <= ctx.limits.searchable_bytes);
    let left_out = match big.as_slice() {
        [] => String::new(),
        big => format!(
            "\n[Not searched, over {}: {}{}. Name one in path to search it.]",
            human(ctx.limits.searchable_bytes),
            big.iter().take(5).map(|(p, size)| format!("{p} ({})", human(*size))).collect::<Vec<_>>().join(", "),
            if big.len() > 5 { format!(" and {} more", big.len() - 5) } else { String::new() }
        ),
    };
    let context = num_arg(args, "context").unwrap_or(0).min(ctx.limits.search_context) as usize;
    let mut out = String::new();
    let (mut hits, mut in_files) = (0, 0);
    'files: for (rel, _) in &files {
        let Ok(text) = read_text(&ctx.root.join(rel)) else { continue };
        let lines: Vec<&str> = text.lines().collect();
        let mut found = false;
        let mut printed_to = 0;
        for (i, line) in lines.iter().enumerate() {
            // A line too long to show (minified code, a packed payload) gives each match with the text round it.
            let long = line.len() > SHOWN_LINE_CHARS;
            let mut next = 0;
            for m in re.find_iter(line).take(if long { usize::MAX } else { 1 }) {
                if m.start() < next {
                    continue;
                }
                if hits >= cap {
                    out.push_str(&format!("[Stopped at {cap} matches. Narrow the query or add a glob.]\n"));
                    break 'files;
                }
                hits += 1;
                // Counted at its first match: one the search stopped in was left out, and 60 matches were "in 0 files".
                in_files += !found as usize;
                found = true;
                if long {
                    let (shown, end) = around(line, m.start());
                    out.push_str(&format!("{rel}:{}: [byte {} of a {}-byte line] {shown}\n", i + 1, m.start() + 1, line.len()));
                    next = end;
                    continue;
                }
                let from = i.saturating_sub(context).max(printed_to);
                let to = (i + context + 1).min(lines.len());
                for (n, l) in lines.iter().enumerate().take(to).skip(from) {
                    let mark = if n == i { ':' } else { '-' };
                    let shown: String = l.chars().take(SHOWN_LINE_CHARS).collect();
                    out.push_str(&format!("{rel}{mark}{}{mark} {shown}\n", n + 1));
                }
                printed_to = to;
                if context > 0 {
                    out.push_str("--\n");
                }
            }
        }
    }
    let s = |n: usize| if n == 1 { "" } else { "s" };
    if hits == 0 {
        return Output::ok(format!("No matches for `{query}` in {} file{}.{left_out}", files.len(), s(files.len())), "0 matches");
    }
    let summary = format!("{hits} match{} in {in_files} file{}", if hits == 1 { "" } else { "es" }, s(in_files));
    Output::ok(format!("{summary}\n{out}{}", left_out.trim_start()), summary)
}

/// Characters of one line a search shows.
const SHOWN_LINE_CHARS: usize = 400;

/// That much of a long line around byte `at`, and the byte it ends at.
fn around(line: &str, at: usize) -> (String, usize) {
    let start = line[..at].char_indices().rev().nth(119).map_or(0, |(i, _)| i);
    let end = line[start..].char_indices().nth(SHOWN_LINE_CHARS).map_or(line.len(), |(i, _)| start + i);
    (format!("{}{}{}", if start > 0 { "…" } else { "" }, &line[start..end], if end < line.len() { "…" } else { "" }), end)
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
    let mut skipped: Vec<&str> = Vec::new();
    for rel in &files {
        let text = match read_text_exact(&ctx.root.join(rel)) {
            Ok(text) => text,
            // Left alone and named: skipped in silence, a file that held the text read as "does not appear".
            Err(e) if e.contains("not UTF-8") => {
                skipped.push(rel.as_str());
                continue;
            }
            Err(_) => continue,
        };
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
    let left = if skipped.is_empty() { String::new() } else { format!("\n[Left alone, not UTF-8 text: {}. Change these with a script that keeps their encoding.]", skipped.join(", ")) };
    if total == 0 {
        return Output::ok(format!("`{find}` does not appear in {} files. Nothing changed.{left}", files.len() - skipped.len()), "0 replacements");
    }
    let summary = format!("{}{total} replacements in {touched} files", if preview { "PREVIEW: " } else { "" });
    Output::ok(format!("{summary}\n{report}{}", left.trim_start()), summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What an odd-input run of every tool turned up: none of these crashed, each said the wrong thing.
    #[test]
    fn a_folder_a_missing_file_and_an_old_encoding_are_named_for_what_they_are() {
        let root = crate::tools::scratch("odd");
        std::fs::create_dir_all(root.join("sub/deep")).unwrap();
        std::fs::write(root.join("sub/deep/a b.txt"), "x\n").unwrap();
        std::fs::write(root.join("latin1.txt"), b"caf\xe9 na\xefve\n").unwrap();
        std::fs::write(root.join("line.txt"), format!("{}\n", "ab".repeat(40_000))).unwrap();
        let ctx = crate::tools::test_ctx(&root, crate::store::Approval::Auto);
        let read = |path: &str| read_file(&ctx, &serde_json::json!({ "path": path })).text;
        assert!(read("sub").starts_with("sub is a folder, not a file") && read("") == "path is required.", "{}", read("sub"));
        assert_eq!(read("wrong/a b.txt"), "wrong/a b.txt does not exist. A file of that name is at: sub/deep/a b.txt.");
        assert_eq!(read("gone.txt"), "gone.txt does not exist. list_files shows what is there.");
        // Shown, never called exact, and never written back: its other bytes would come back as U+FFFD.
        let old = read("latin1.txt");
        assert!(old.starts_with("latin1.txt: all 1 lines") && old.contains("[NOT UTF-8:"), "{old}");
        let edit = edit_file(&ctx, &serde_json::json!({ "path": "latin1.txt", "old_text": "caf", "new_text": "tea" }));
        let swept = replace_in_files(&ctx, &serde_json::json!({ "find": "caf", "replace": "tea", "glob": "*.txt" })).text;
        assert!(!edit.ok && edit.text.contains("not UTF-8 text") && swept.contains("Left alone, not UTF-8 text: latin1.txt"), "{} / {swept}", edit.text);
        assert_eq!(std::fs::read(root.join("latin1.txt")).unwrap(), b"caf\xe9 na\xefve\n");
        assert!(!write_file(&ctx, &serde_json::json!({ "path": "sub", "content": "x" })).ok);
        // A search stopped at its cap inside a file still counts that file.
        let capped = search_files(&ctx, &serde_json::json!({ "query": "ab", "path": "line.txt" })).text;
        assert!(capped.starts_with("60 matches in 1 file\n"), "{}", &capped[..60]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_search_reads_a_named_file_of_any_size_and_shows_what_it_found_in_a_long_line() {
        let root = crate::tools::scratch("search");
        std::fs::create_dir_all(root.join("analysis")).unwrap();
        // One line, over the size a search reads unasked, with the word far inside it twice.
        let packed = format!("{}KG=function(I){}KG_end", "a;".repeat(300_000), "b;".repeat(400));
        std::fs::write(root.join("analysis/payload.lua"), &packed).unwrap();
        std::fs::write(root.join("notes.txt"), "nothing here\n").unwrap();
        let ctx = crate::tools::test_ctx(&root, crate::store::Approval::Auto);
        let all = search_files(&ctx, &serde_json::json!({ "query": "KG" })).text;
        assert!(all.starts_with("No matches for `KG` in 1 file.") && all.contains("Not searched, over 512.0 KB: analysis/payload.lua (586.7 KB)") && all.contains("Name one in path"), "{all}");
        let named = search_files(&ctx, &serde_json::json!({ "query": "KG", "path": "analysis/payload.lua", "case_sensitive": true })).text;
        assert!(named.starts_with("2 matches in 1 file\n") && named.contains("a;KG=function(I)b;") && named.contains("b;KG_end") && named.len() < 1500, "{named}");
        let folder = search_files(&ctx, &serde_json::json!({ "query": "nothing", "path": "analysis" })).text;
        assert!(folder.starts_with("No matches") && search_files(&ctx, &serde_json::json!({ "query": "nothing" })).text.contains("notes.txt:1: nothing here"), "{folder}");
        assert!(!search_files(&ctx, &serde_json::json!({ "query": "x", "path": "gone" })).ok);
    }

    fn spec(f: impl FnOnce(&mut EditSpec)) -> EditSpec {
        let mut s = EditSpec { include_anchors: true, ..Default::default() };
        f(&mut s);
        s
    }

    #[test]
    fn the_computer_can_be_looked_at_and_its_keys_cannot() {
        let dir = crate::tools::scratch("look");
        let (root, out) = (dir.join("ws"), dir.join("elsewhere"));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(out.join("logs")).unwrap();
        std::fs::write(out.join("crash.log"), "boom\n").unwrap();
        std::fs::write(out.join(".env"), "KEY=1\n").unwrap();
        let full = |name: &str| out.join(name).to_string_lossy().into_owned();
        // A full path reaches outside to look; a relative one still cannot climb out, and nothing is written there.
        assert_eq!(resolve_look(&root, &full("crash.log")).unwrap(), out.join("crash.log"));
        assert!(resolve_look(&root, "../elsewhere/crash.log").is_err() && resolve(&root, &full("crash.log")).is_err());
        assert!(resolve_look(&root, &full(".env")).unwrap_err().contains("keeps sign-ins or keys"));
        assert!(closed(Path::new("C:/Users/x/.ssh/id_ed25519")) && closed(Path::new("C:/Users/x/AppData/Local/Vendor/Browser/User Data/Default/Cookies")) && !closed(Path::new("C:/Users/x/AppData/Local/Game/logs/a.log")));
        assert!(closed_text(r"Get-Content C:\Users\x\.ssh\id_rsa") && !closed_text("Get-Process | Sort-Object CPU"));
        unsafe { std::env::set_var("APIM_TEST_PLACE", &out) };
        assert_eq!(Path::new(&expand("%APIM_TEST_PLACE%/crash.log")), out.join("crash.log"));
        assert_eq!(Path::new(&expand("$env:APIM_TEST_PLACE/crash.log")), out.join("crash.log"));
        // A folder inside the workspace is deleted whole; the workspace itself and anything outside are not.
        std::fs::create_dir_all(root.join("gone/deep")).unwrap();
        std::fs::write(root.join("gone/deep/a.txt"), "a").unwrap();
        let ws = crate::tools::test_ctx(&root, crate::store::Approval::Auto);
        let deleted = delete_file(&ws, &serde_json::json!({ "path": "gone" }));
        assert!(deleted.ok && deleted.summary == "Deleted gone/" && !root.join("gone").exists(), "{}", deleted.text);
        assert!(!delete_file(&ws, &serde_json::json!({ "path": "." })).ok && !delete_file(&ws, &serde_json::json!({ "path": out.to_string_lossy() })).ok && out.exists());
        // Outside, one folder is listed at a time, folders first; and the file reads as any other.
        let ctx = crate::tools::test_ctx(&root, crate::store::Approval::Auto);
        let listed = list_files(&ctx, &serde_json::json!({ "path": out.to_string_lossy() }));
        assert!(listed.ok && listed.text.contains("logs/\n") && listed.text.contains("crash.log  (5 B, 20") && listed.summary == "1 folders, 2 files", "{}", listed.text);
        assert!(read_file(&ctx, &serde_json::json!({ "path": full("crash.log") })).text.contains("boom"));
    }

    /// With "Ask me first" a look outside waits for the user; here nobody answers, so it is declined.
    #[tokio::test]
    async fn a_look_outside_is_asked_about_first() {
        let dir = crate::tools::scratch("ask");
        let (root, out) = (dir.join("ws"), dir.join("elsewhere"));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        let outside = serde_json::json!({ "path": out.to_string_lossy() });
        let ask = crate::tools::test_ctx(&root, crate::store::Approval::Manual);
        assert!(may_look(&ask, &outside).await.unwrap_err().starts_with("The user did not allow looking in "));
        assert!(may_look(&ask, &serde_json::json!({ "path": "notes.txt", "paths": ["a.rs"] })).await.is_ok());
        assert!(may_look(&crate::tools::test_ctx(&root, crate::store::Approval::Auto), &outside).await.is_ok());
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
        // A line too long to read is cut beside an edit as it is in a read.
        let wide = format!("a\n{}\nb", "x".repeat(30_000));
        let told = describe("f", &wide, &apply_edit(&wide, &spec(|s| { s.old_text = Some("a".into()); s.new_text = "c".into() })).unwrap(), false);
        assert!(told.len() < READ_LINE_CHARS + 500 && told.contains("more characters of this line are not shown"), "{}", told.len());
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
        // The peek at a one-line dump: its start, how much is missing and how to reach it. Never the word EXACT.
        let dump = format!("{}\nshort\n", "9,".repeat(100_000));
        let peek = render_read("d.json", &dump, None, Some(5), false, 400_000);
        assert!(peek.len() < READ_LINE_CHARS + 600 && peek.starts_with("d.json: all 2 lines, 200007 chars, long lines cut") && peek.contains("192000 more characters") && peek.contains("[LONG LINES: 1 of these lines is over 8000"), "{}", &peek[peek.len() - 400..]);
        assert!(cut_long_lines("short\nlines").is_none() && cut_long_lines(&dump).unwrap().ends_with("not shown]\nshort\n"));
    }
}

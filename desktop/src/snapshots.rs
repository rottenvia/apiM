//! Restore points, per-file undo, rewind and the workspace download, stored the way the web app
//! stores them (src/lib/snapshots.ts, rewind.ts, workspace.ts, zip.ts). Both apps open the same
//! workspace folder, so every name and every byte of a manifest written here is one the web reads.
//!
//! On disk, all inside the workspace folder:
//!   .snapshots/<id>/manifest.json                { id, label, createdAt, files: [{ path, size, hash, mtime }] }, 2-space JSON
//!   .snapshots/objects/<sha256 hex>              file contents, shared by every snapshot that names them
//!   .snapshots/<id>/<encodeURIComponent(path)>   old snapshots (no `hash`) keep their own copies; restore reads both
//!   .history/<path, % as %25, / as %2F>.prev     the file before its last write; .prev.1 to .prev.9 are older
//! and on the question's message in chat.json: `restorePoint: { snapshotId: string | null, at: ISO time }`.
//!
//! Sending a message, in the web chat route's order (only with the workspace on):
//!   1. Store the question: append it (new send) or cut the chat back to it (regenerate). A resume does neither.
//!   2. `create(workspace, &clip_utf16(question.trim(), 80), &[])`, before the model is called. An Err is logged,
//!      the reply runs anyway and step 3 is skipped.
//!   3. `link_restore_point(workspace, &mut question.other, snapshot.as_ref())`, then save the chat. Only when the
//!      newest stored message is that question (a user message, not a note) and this is not a resume.
//!   4. Run the reply. A tool that overwrites or deletes a file calls `record_previous` first with the old bytes,
//!      once per file per tool call.
//!
//! Rewinding to a question, as the web's rewindChat does it:
//!   1. Refuse while a reply is running in the chat ("A reply is still running in this chat. Stop it or wait for
//!      it to finish, then rewind.").
//!   2. `locate_question`; None is "That message is not in the saved chat — reload it and try again."
//!   3. `find_restore_point(workspace, question.other.get("restorePoint"), ...)`. A dry run reports it and stops.
//!   4. With "restore files": `rewind_files` FIRST, so an Err leaves the chat as it was. Its `safety` snapshot
//!      holds the files from before the rewind; restoring that one undoes the rewind.
//!   5. Cut the chat at that index (the question goes too) and save.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------- workspace files

/// The web app's guard rails: generous, they only stop a runaway loop.
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_FILES_PER_WORKSPACE: usize = 100_000;

/// Names the web's listing skips at any depth, files and folders alike: its own bookkeeping and installed packages.
const IGNORED: &[&str] = &[".history", ".snapshots", ".packages", ".analysis", ".workspace-id", "node_modules", ".git", ".next", "__pycache__", ".venv", "venv"];
/// Build output, hidden only at the top of the workspace: a `build` folder deeper in is as likely to be source.
const IGNORED_AT_ROOT: &[&str] = &["dist", "build"];

fn hidden(name: &str, at_root: bool) -> bool {
    // The last two are uploads and archive extractions still in flight: never half a file.
    IGNORED.contains(&name) || (at_root && IGNORED_AT_ROOT.contains(&name)) || name.starts_with(".apim-extract-") || (name.starts_with(".upload-") && name.ends_with(".tmp"))
}

/// Every real file in the workspace as (path with forward slashes, size, modified ms), the web's `listFiles`.
/// Links are not followed and a folder that does not exist yet is simply empty.
// ponytail: the web also moves pre-2026 sibling folders (`<ws>.history`, `<ws>.snapshots`) inside on first touch.
// Not done here: the ones left on disk belong to deleted chats. Port migrateLayout if old installs matter.
pub fn list_files(workspace: &Path) -> Vec<(String, u64, u64)> {
    let mut out = Vec::new();
    let entries = walkdir::WalkDir::new(workspace).follow_links(false).into_iter().filter_entry(|e| e.depth() == 0 || !hidden(&e.file_name().to_string_lossy(), e.depth() == 1));
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES_PER_WORKSPACE {
            break;
        }
        if entry.depth() == 0 || !entry.file_type().is_file() {
            continue;
        }
        // Gone between the listing and the look: skipped, not an error.
        let Ok(meta) = entry.metadata() else { continue };
        let rel = entry.path().strip_prefix(workspace).unwrap_or(entry.path()).to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
        out.push((rel, meta.len(), modified_ms(&meta)));
    }
    out.sort_by(|a, b| web_order(&a.0, &b.0));
    out
}

/// The web sorts a listing with localeCompare, and a manifest keeps that order. For ASCII names it is: punctuation
/// in ICU's own sequence, then digits, then letters, with case only breaking ties (lowercase first).
// ponytail: other alphabets and accents sort by code point after all of that, not where ICU puts them (é beside e).
// Nothing reads the order, so only the look of a listing differs; use icu_collator if it must match there too.
fn web_order(a: &str, b: &str) -> std::cmp::Ordering {
    const BEFORE_LETTERS: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789";
    let rank = |c: char| BEFORE_LETTERS.find(c).map_or(if c.is_ascii_alphabetic() { 100 + c.to_ascii_lowercase() as u32 } else { 1000 + c as u32 }, |at| at as u32);
    a.chars().map(rank).cmp(b.chars().map(rank)).then_with(|| b.cmp(a))
}

/// Node rounds a file's time to the nearest millisecond. Rounding the same way keeps "unchanged since the last
/// snapshot" true whichever app took that snapshot.
fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| ((d.as_nanos() + 500_000) / 1_000_000) as u64)
}

/// Paths the file tools may read but never write: a `.git` anywhere (its config can name programs git runs), and
/// this app's own undo state at the top, where a forged manifest or history slot would restore anything.
pub fn is_protected_path(rel: &str) -> bool {
    let posix = rel.replace('\\', "/");
    let parts: Vec<String> = posix.split('/').filter(|p| !p.is_empty() && *p != ".").map(|p| if cfg!(windows) { p.to_lowercase() } else { p.to_string() }).collect();
    parts.iter().any(|p| p == ".git") || parts.first().is_some_and(|p| [".history", ".snapshots", ".workspace-id"].contains(&p.as_str()))
}

/// A path from the model or from a manifest as a real one inside the workspace, or the web app's reason why not.
pub fn resolve_inside(workspace: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.trim().is_empty() {
        return Err("Path is required".into());
    }
    // Backslashes are separators on every platform, so "..\..\x" cannot pass on one and climb out on another.
    let posix = rel.replace('\\', "/");
    if posix.starts_with('/') || Path::new(&posix).is_absolute() || rel.contains('\0') {
        return Err("Path must be relative to the workspace".into());
    }
    if posix.split('/').any(|part| part == "..") {
        return Err("Path must not contain '..'".into());
    }
    let target = workspace.join(&posix);
    // A drive-relative "C:x" replaces the whole path when joined.
    if !target.starts_with(workspace) {
        return Err("Path escapes the workspace".into());
    }
    // None of that can see links: the deepest part that exists must really sit inside the workspace.
    let Ok(real_root) = workspace.canonicalize() else { return Ok(target) };
    let mut probe = target.as_path();
    while probe.symlink_metadata().is_err() {
        match probe.parent() {
            Some(parent) if parent.starts_with(workspace) => probe = parent,
            _ => return Ok(target),
        }
    }
    // ponytail: a dangling link is refused outright; the web judges it by where it points. Resolve the link's
    // target by hand if a workspace ever keeps broken links it needs written through.
    match probe.canonicalize() {
        Ok(real) if real.starts_with(&real_root) => Ok(target),
        Ok(_) => Err("Path escapes the workspace through a symbolic link".into()),
        Err(_) => Err("Path could not be resolved safely".into()),
    }
}

/// Writes through a temp file and renames it into place: a crash never leaves half a file, a link sitting at the
/// target is replaced instead of written through, and the replaced file's permission bits carry over.
fn write_atomic(target: &Path, data: &[u8]) -> std::io::Result<()> {
    let mut tmp = target.as_os_str().to_owned();
    tmp.push(format!(".{}.{}.tmp", std::process::id(), random36()));
    let tmp = PathBuf::from(tmp);
    let done = std::fs::write(&tmp, data).and_then(|()| {
        if let Ok(old) = std::fs::symlink_metadata(target) && old.is_file() {
            let _ = std::fs::set_permissions(&tmp, old.permissions());
        }
        std::fs::rename(&tmp, target)
    });
    if done.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    done
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// JavaScript's `toISOString()`: UTC with milliseconds and a Z.
fn iso(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64).unwrap_or_default().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn from_iso(text: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(text).ok().map(|d| d.timestamp_millis().max(0) as u64)
}

fn base36(mut n: u64) -> String {
    let mut digits = Vec::new();
    loop {
        digits.push(char::from_digit((n % 36) as u32, 36).unwrap_or('0'));
        n /= 36;
        if n == 0 {
            break;
        }
    }
    digits.iter().rev().collect()
}

/// Six random base-36 characters, the web's `Math.random().toString(36).slice(2, 8)`. Std has no random numbers,
/// but every new hasher gets a random key.
fn random36() -> String {
    use std::hash::{BuildHasher, Hasher};
    base36(std::collections::hash_map::RandomState::new().build_hasher().finish()).chars().rev().take(6).collect()
}

/// JavaScript's `text.slice(0, units)`. Lengths there count UTF-16 units, and a label has to be cut where the web
/// cuts it: old restore points are found again by label.
pub fn clip_utf16(text: &str, units: usize) -> String {
    let mut used = 0;
    text.chars().take_while(|c| { used += c.len_utf16(); used <= units }).collect()
}

/// JavaScript's `encodeURIComponent`, which names the copies inside old snapshots.
fn encode_uri_component(text: &str) -> String {
    text.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

// ---------------------------------------------------------------- snapshots
//
// Point-in-time copies of a whole workspace. Per-file undo is useless when a reply refactored four files and got it
// wrong; a snapshot before each reply gives "return to how it was before that message".

/// Enough to undo a bad session without growing without limit.
pub const MAX_SNAPSHOTS: usize = 20;

#[derive(Clone, Debug, PartialEq)]
pub struct SnapshotInfo {
    pub id: String,
    pub label: String,
    /// ISO time. Sorts as text, which is how the newest is found.
    pub created_at: String,
    pub file_count: usize,
    pub total_bytes: u64,
}

/// What a restore did. `safety` is the snapshot of the files as they were just before it, so it can be undone.
#[derive(Clone, Debug, PartialEq)]
pub struct Restored {
    pub restored: usize,
    pub removed: usize,
    pub safety: Option<SnapshotInfo>,
}

#[derive(Serialize, Deserialize)]
struct ManifestFile {
    path: String,
    size: u64,
    /// Absent on snapshots from before content-addressed storage: those keep a copy inside the snapshot folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mtime: Option<String>,
}

/// Field order is the web's: `serde_json::to_string_pretty` of this is byte for byte its `JSON.stringify(manifest, null, 2)`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    id: String,
    label: String,
    created_at: String,
    files: Vec<ManifestFile>,
}

fn info(m: &Manifest) -> SnapshotInfo {
    SnapshotInfo { id: m.id.clone(), label: m.label.clone(), created_at: m.created_at.clone(), file_count: m.files.len(), total_bytes: m.files.iter().map(|f| f.size).sum() }
}

fn snapshot_root(workspace: &Path) -> PathBuf {
    workspace.join(".snapshots")
}

/// An id becomes a folder name, so it is checked like input. `objects` passes the web's pattern but is the shared
/// store, not a snapshot: deleting "it" would empty every restore point.
fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') && id != "objects"
}

/// sha256 hex, exactly as `create` writes it. Anything else in a manifest would be joined onto a path.
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn read_manifest(dir: &Path) -> Option<Manifest> {
    serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).ok()?).ok()
}

/// Every snapshot's manifest, newest first. A folder without a readable manifest is not a snapshot.
fn manifests(workspace: &Path) -> Vec<Manifest> {
    let mut out: Vec<Manifest> = std::fs::read_dir(snapshot_root(workspace)).into_iter().flatten().flatten().filter_map(|e| read_manifest(&e.path())).collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

/// Copies the current state of the workspace. Ok(None) when there is nothing to save (the web says "Nothing to
/// save — the workspace is empty"): a snapshot of no files before the very first message would only be clutter.
/// `protect` names snapshots the prune after this one must keep: a restore saves the current files first, and at
/// the cap that prune would otherwise delete the oldest snapshot, which is the one being restored after a long rewind.
pub fn create(workspace: &Path, label: &str, protect: &[String]) -> Result<Option<SnapshotInfo>, String> {
    let files = list_files(workspace);
    if files.is_empty() {
        return Ok(None);
    }
    let fail = |e: std::io::Error| format!("Could not save a restore point: {e}");
    let now = now_ms();
    let mut manifest = Manifest { id: format!("{}-{}", base36(now), random36()), label: clip_utf16(label, 120), created_at: iso(now), files: Vec::new() };
    let dir = snapshot_root(workspace).join(&manifest.id);
    let objects = snapshot_root(workspace).join("objects");

    // What the newest snapshot recorded. A file with the same size and time is not read again: almost nothing
    // changes between two messages, and hashing a whole project before every reply was the slow part.
    let previous: HashMap<String, ManifestFile> = manifests(workspace).into_iter().next().map(|m| m.files).unwrap_or_default().into_iter().map(|f| (f.path.clone(), f)).collect();
    std::fs::create_dir_all(&dir).map_err(fail)?;
    std::fs::create_dir_all(&objects).map_err(fail)?;

    for (path, size, modified) in files {
        let mtime = iso(modified);
        let known = previous.get(&path).filter(|old| old.size == size && old.mtime.as_deref() == Some(mtime.as_str())).and_then(|old| old.hash.clone());
        // Reused only while the content is still in the store; a swept or lost object is written again.
        if let Some(hash) = known.filter(|hash| valid_hash(hash) && objects.join(hash).exists()) {
            manifest.files.push(ManifestFile { path, size, hash: Some(hash), mtime: Some(mtime) });
            continue;
        }
        // Anything unreadable is skipped rather than abandoning the whole snapshot.
        let Ok(data) = std::fs::read(workspace.join(&path)) else { continue };
        let hash = format!("{:x}", Sha256::digest(&data));
        // Stored once per content, however many files and snapshots share it.
        let stored = objects.join(&hash);
        if !stored.exists() && write_atomic(&stored, &data).is_err() {
            continue;
        }
        manifest.files.push(ManifestFile { path, size: data.len() as u64, hash: Some(hash), mtime: Some(mtime) });
    }
    if manifest.files.is_empty() {
        let _ = std::fs::remove_dir_all(&dir);
        return Ok(None);
    }
    std::fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?).map_err(fail)?;
    prune(workspace, protect);
    Ok(Some(info(&manifest)))
}

/// Newest first: the one wanted back is almost always the most recent.
pub fn list(workspace: &Path) -> Vec<SnapshotInfo> {
    manifests(workspace).iter().map(info).collect()
}

/// One snapshot's summary, or None when it does not exist (pruned, bad id).
pub fn get(workspace: &Path, id: &str) -> Option<SnapshotInfo> {
    if !valid_id(id) {
        return None;
    }
    read_manifest(&snapshot_root(workspace).join(id)).map(|m| info(&m))
}

/// Puts the workspace back to a snapshot. The current state is saved first (labelled `safety_label`, or "Before
/// restoring"), so a mistaken restore does not destroy work with no way back.
pub fn restore(workspace: &Path, id: &str, safety_label: Option<&str>) -> Result<Restored, String> {
    if !valid_id(id) {
        return Err("Invalid snapshot id".into());
    }
    let dir = snapshot_root(workspace).join(id);
    let manifest = read_manifest(&dir).ok_or("That save point could not be used")?;
    let safety = create(workspace, safety_label.unwrap_or("Before restoring"), &[id.to_string()])?;

    // Files created since the snapshot go: leaving them would not be "how it was".
    let wanted: HashSet<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    let removed = remove_files_except(workspace, &wanted);

    let mut restored = 0;
    for file in &manifest.files {
        // The manifest is data on disk, so it is checked like input: a hash is only ever sha256 hex, and a path
        // into .git or the undo folders is never written.
        if file.hash.as_deref().is_some_and(|hash| !valid_hash(hash)) || is_protected_path(&file.path) {
            continue;
        }
        let source = match &file.hash {
            Some(hash) => snapshot_root(workspace).join("objects").join(hash),
            None => dir.join(encode_uri_component(&file.path)),
        };
        // One file that cannot be put back is skipped rather than abandoning the rest.
        let (Ok(data), Ok(target)) = (std::fs::read(source), resolve_inside(workspace, &file.path)) else { continue };
        if target.parent().is_some_and(|parent| std::fs::create_dir_all(parent).is_ok()) && write_atomic(&target, &data).is_ok() {
            restored += 1;
        }
    }
    Ok(Restored { restored, removed, safety })
}

fn remove_files_except(workspace: &Path, wanted: &HashSet<&str>) -> usize {
    list_files(workspace).iter().filter(|file| !wanted.contains(file.0.as_str()) && std::fs::remove_file(workspace.join(&file.0)).is_ok()).count()
}

/// Puts the workspace back to "no files at all": the state before a chat's first message, which `create` never
/// saves and which is the most common place to rewind to. The current files are saved first, as in `restore`.
pub fn restore_empty(workspace: &Path, safety_label: Option<&str>) -> Result<Restored, String> {
    let safety = create(workspace, safety_label.unwrap_or("Before restoring"), &[])?;
    Ok(Restored { restored: 0, removed: remove_files_except(workspace, &HashSet::new()), safety })
}

/// True when the snapshot is gone afterwards. Its file contents stay until `prune` finds nothing else using them.
pub fn delete(workspace: &Path, id: &str) -> bool {
    let dir = snapshot_root(workspace).join(id);
    valid_id(id) && (std::fs::remove_dir_all(&dir).is_ok() || !dir.exists())
}

/// Drops the oldest snapshots once there are more than MAX_SNAPSHOTS, then the file contents nothing refers to.
/// `protect` survives this pass even when it is among the oldest.
pub fn prune(workspace: &Path, protect: &[String]) {
    for old in manifests(workspace).iter().skip(MAX_SNAPSHOTS).filter(|m| !protect.contains(&m.id)) {
        delete(workspace, &old.id);
    }
    // Shared contents outlive the snapshot that wrote them, so deleting a snapshot cannot delete its files. What is
    // still needed is read from the surviving manifests each time: a stored count would drift after an interrupted
    // write and free something a snapshot still needs. Leftover .tmp files go the same way.
    let objects = snapshot_root(workspace).join("objects");
    let Ok(stored) = std::fs::read_dir(&objects) else { return };
    let live: HashSet<String> = manifests(workspace).into_iter().flat_map(|m| m.files).filter_map(|f| f.hash).collect();
    for entry in stored.flatten() {
        if !live.contains(&*entry.file_name().to_string_lossy()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Removes every snapshot, for when a chat is deleted.
pub fn delete_all(workspace: &Path) {
    let _ = std::fs::remove_dir_all(snapshot_root(workspace));
}

// ---------------------------------------------------------------- rewind (the file side)
//
// Each question records the restore point its first reply started from, so "rewind to this message" can put the
// files back along with the chat.

/// The files as they were just before a question's reply started.
#[derive(Clone, Debug, PartialEq)]
pub enum RestorePoint {
    /// A snapshot of the files as they were.
    Snapshot(SnapshotInfo),
    /// The workspace had no files yet.
    Empty,
    /// Recorded, but pruned since: only the newest MAX_SNAPSHOTS are kept.
    Missing,
    /// Nothing recorded and nothing found.
    None,
}

/// Where a question sits in the chat. `messages` holds (id, is_user, is_note) per stored message. The question's
/// own id, else the id of the reply right under it.
// ponytail: the web also matches by position and text, for browser ids the store never saw. The desktop always
// knows the stored id; add that fallback (and the text) if it ever does not. Never a guess: the wrong question loses real work.
pub fn locate_question(messages: &[(&str, bool, bool)], message_id: Option<&str>, reply_id: Option<&str>) -> Option<usize> {
    let at = |id: Option<&str>| id.and_then(|id| messages.iter().position(|m| m.0 == id));
    if let Some(i) = at(message_id).filter(|&i| messages[i].1) {
        return Some(i);
    }
    at(reply_id).filter(|&i| i > 0 && !messages[i].1 && messages[i - 1].1).map(|i| i - 1)
}

/// The next real question after `index`. Its time is where the search for an unrecorded restore point stops.
pub fn next_question(messages: &[(&str, bool, bool)], index: usize) -> Option<usize> {
    (index + 1..messages.len()).find(|&i| messages[i].1 && !messages[i].2)
}

/// The restore point for a question. `recorded` is the question's `restorePoint` field as stored (its
/// `other.get("restorePoint")`), `asked_ms` when it was sent and `next_asked_ms` when the next question was.
pub fn find_restore_point(workspace: &Path, recorded: Option<&serde_json::Value>, question: &str, asked_ms: u64, next_asked_ms: Option<u64>) -> RestorePoint {
    if let Some(point) = recorded.filter(|v| v.is_object()) {
        return match point.get("snapshotId") {
            Some(serde_json::Value::Null) => RestorePoint::Empty,
            Some(serde_json::Value::String(id)) => get(workspace, id).map_or(RestorePoint::Missing, RestorePoint::Snapshot),
            // A broken record is never read as "empty": that would delete every file.
            _ => RestorePoint::Missing,
        };
    }
    // Questions from before points were recorded are matched the way the snapshot was taken: labelled with the
    // start of the question, created after it was stored and before the next one. The earliest wins, as a later
    // one belongs to a retry that started from the first reply's files.
    let (text, until) = (question.trim(), next_asked_ms.unwrap_or(u64::MAX));
    if asked_ms == 0 {
        return RestorePoint::None;
    }
    list(workspace)
        .into_iter()
        .filter(|s| from_iso(&s.created_at).is_some_and(|at| at >= asked_ms && at < until) && !s.label.trim().is_empty() && text.starts_with(s.label.trim()))
        .min_by(|a, b| a.created_at.cmp(&b.created_at))
        .map_or(RestorePoint::None, RestorePoint::Snapshot)
}

/// Records on the question which restore point precedes its reply, as the web stores it: `restorePoint:
/// { snapshotId, at }` among the message's fields. `snapshot` is what `create` returned. False when nothing was
/// recorded: the question already has a point (a regenerate starts from what the earlier reply left behind, and
/// rewinding means before any of it), or the snapshot failed, where no files option is better than a wrong one.
pub fn link_restore_point(workspace: &Path, question_fields: &mut serde_json::Map<String, serde_json::Value>, snapshot: Option<&SnapshotInfo>) -> bool {
    if question_fields.get("restorePoint").is_some_and(|v| !v.is_null()) {
        return false;
    }
    // No snapshot of an empty workspace is still worth recording: rewinding there means "no files".
    if snapshot.is_none() && !list_files(workspace).is_empty() {
        return false;
    }
    question_fields.insert("restorePoint".into(), serde_json::json!({ "snapshotId": snapshot.map(|s| s.id.as_str()), "at": iso(now_ms()) }));
    true
}

/// The file half of a rewind: the workspace goes back to `point`, after the current files are saved under a label
/// naming the question. Call it before cutting the chat, so an error leaves the chat as it was.
pub fn rewind_files(workspace: &Path, point: &RestorePoint, question: &str) -> Result<Restored, String> {
    let label = clip_utf16(&format!("Before rewinding to: {}", question.trim()), 120);
    match point {
        RestorePoint::Snapshot(snapshot) => restore(workspace, &snapshot.id, Some(&label)),
        RestorePoint::Empty => restore_empty(workspace, Some(&label)),
        RestorePoint::Missing => Err("The restore point for that message has been pruned — only the newest ones are kept. Nothing was changed.".into()),
        RestorePoint::None => Err("There is no restore point for that message, so its files cannot be put back. Nothing was changed.".into()),
    }
}

// ---------------------------------------------------------------- per-file history
//
// The versions a file had before its last writes. A model overwriting a file is normal and often wrong, so what it
// replaced has to survive somewhere.

/// Ten is far more than one reply writes to one file. With a single version, a wrong edit followed by a wrong fix
/// had already lost the version the user wanted back.
pub const MAX_HISTORY_VERSIONS: usize = 10;

/// The canonical spelling of a workspace path (forward slashes, no `./`), so `./p.ts` and `p.ts` share one history.
pub fn history_key(rel_path: &str) -> String {
    let posix = rel_path.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for part in posix.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|last| *last != "..") => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    // A leading slash stays, so an absolute path is still refused instead of quietly read as a relative one.
    format!("{}{}", if posix.starts_with('/') { "/" } else { "" }, parts.join("/"))
}

/// Where the Nth previous version of `key` lives; 0 is the most recent. The path is escaped, not flattened, so
/// `src/util.ts` and `src__util.ts` never share a file.
fn history_slot(workspace: &Path, key: &str, slot: usize) -> PathBuf {
    let flat = key.replace('%', "%25").replace('/', "%2F");
    workspace.join(".history").join(if slot == 0 { format!("{flat}.prev") } else { format!("{flat}.prev.{slot}") })
}

/// Keeps `old_bytes`, the contents about to be overwritten or deleted. Older versions shift down a slot, so
/// `.prev` is always the latest and the oldest falls off the end. Call it once per file per tool call, so undo
/// means "before that tool call". Never fails: losing history must not block the write.
pub fn record_previous(workspace: &Path, rel_path: &str, old_bytes: &[u8]) {
    let key = history_key(rel_path);
    if resolve_inside(workspace, &key).is_err() || std::fs::create_dir_all(workspace.join(".history")).is_err() {
        return;
    }
    // Oldest first, so nothing is overwritten before it has been moved. A slot that does not exist yet is normal.
    for slot in (0..MAX_HISTORY_VERSIONS).rev() {
        let _ = std::fs::rename(history_slot(workspace, &key, slot), history_slot(workspace, &key, slot + 1));
    }
    let _ = std::fs::write(history_slot(workspace, &key, 0), old_bytes);
    let _ = std::fs::remove_file(history_slot(workspace, &key, MAX_HISTORY_VERSIONS));
}

/// Bytes of a previous version: `steps` 1 is before the last write, 2 the one before that. None when that far back
/// is not kept, never a silently nearer version.
pub fn previous_version_bytes(workspace: &Path, rel_path: &str, steps: usize) -> Option<Vec<u8>> {
    let key = history_key(rel_path);
    resolve_inside(workspace, &key).ok()?;
    if !(1..=MAX_HISTORY_VERSIONS).contains(&steps) {
        return None;
    }
    std::fs::read(history_slot(workspace, &key, steps - 1)).ok()
}

/// The version before the last write, as text.
pub fn previous_version(workspace: &Path, rel_path: &str) -> Option<String> {
    previous_version_bytes(workspace, rel_path, 1).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// How many previous versions of a file are kept.
pub fn history_depth(workspace: &Path, rel_path: &str) -> usize {
    let key = history_key(rel_path);
    if resolve_inside(workspace, &key).is_err() {
        return 0;
    }
    (0..MAX_HISTORY_VERSIONS).take_while(|&slot| history_slot(workspace, &key, slot).exists()).count()
}

/// Puts the previous version back. What was there becomes the newest history entry, so the undo can itself be
/// undone. Works for a deleted file too.
pub fn restore_previous(workspace: &Path, rel_path: &str) -> Result<(), String> {
    let key = history_key(rel_path);
    let target = resolve_inside(workspace, &key)?;
    let previous = std::fs::read(history_slot(workspace, &key, 0)).map_err(|_| "No previous version of that file".to_string())?;
    if is_protected_path(&key) {
        return Err(format!("{rel_path} is inside a protected folder (.git, .history or .snapshots) and cannot be written, moved or deleted by the file tools"));
    }
    if previous.len() as u64 > MAX_FILE_BYTES {
        return Err("File is too large to write".into());
    }
    if let Ok(current) = std::fs::read(&target) {
        record_previous(workspace, &key, &current);
    }
    let fail = |e: std::io::Error| format!("Could not restore {rel_path}: {e}");
    std::fs::create_dir_all(target.parent().unwrap_or(workspace)).map_err(fail)?;
    write_atomic(&target, &previous).map_err(fail)
}

// ---------------------------------------------------------------- zip download

/// A ZIP archive in memory, every entry stamped with the current time. Names get forward slashes whatever the
/// platform: a backslash in a ZIP path extracts as a file literally named "src\app.js".
pub fn zip(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
    let now = now_ms();
    zip_dated(entries.iter().map(|(path, data)| (path.as_str(), data.as_slice(), now)))
}

/// The same, each entry with its own modified time in ms.
// ponytail: no ZIP64, like the web: past 65,535 entries or 4 GB the header fields wrap and the archive is
// corrupt. zip_workspace refuses those instead; write ZIP64 records if a workspace that large must download.
fn zip_dated<'a>(entries: impl Iterator<Item = (&'a str, &'a [u8], u64)>) -> Vec<u8> {
    use chrono::{Datelike, Timelike};
    use std::io::Write;
    let (mut out, mut central, mut count) = (Vec::new(), Vec::new(), 0u16);
    for (path, data, modified) in entries {
        let name = path.replace('\\', "/");
        let mut crc = flate2::Crc::new();
        crc.update(data);
        // Deflate can grow data that is already compressed. Such a file is stored as it is, or the archive
        // would be larger than the files.
        let mut deflater = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        let packed = deflater.write_all(data).and_then(|()| deflater.finish()).ok().filter(|packed| packed.len() < data.len());
        let (method, body) = packed.as_deref().map_or((0u16, data), |packed| (8, packed));

        // ZIP keeps local time in the MS-DOS format, which starts at 1980 and counts seconds in twos.
        let at = chrono::DateTime::from_timestamp_millis(modified as i64).unwrap_or_default().with_timezone(&chrono::Local);
        let time = (at.hour() << 11 | at.minute() << 5 | at.second() / 2) as u16;
        let date = ((at.year().max(1980) as u32 - 1980) << 9 | at.month() << 5 | at.day()) as u16;

        // These 26 bytes are the same in the local header and in the central directory.
        let mut head = Vec::with_capacity(26);
        for field in [20, 0x0800, method, time, date] {
            head.extend(field.to_le_bytes()); // version needed, UTF-8 names, method, time, date
        }
        for field in [crc.sum(), body.len() as u32, data.len() as u32] {
            head.extend(field.to_le_bytes());
        }
        for field in [name.len() as u16, 0] {
            head.extend(field.to_le_bytes()); // name length, no extra field
        }
        let offset = out.len() as u32;
        out.extend(0x04034b50u32.to_le_bytes());
        out.extend(&head);
        out.extend(name.as_bytes());
        out.extend(body);
        central.extend(0x02014b50u32.to_le_bytes());
        central.extend(20u16.to_le_bytes()); // version made by
        central.extend(&head);
        central.extend([0u8; 10]); // no comment, disk 0, no attributes
        central.extend(offset.to_le_bytes());
        central.extend(name.as_bytes());
        count = count.wrapping_add(1);
    }
    let (directory_at, directory_len) = (out.len() as u32, central.len() as u32);
    out.extend(central);
    out.extend(0x06054b50u32.to_le_bytes());
    out.extend([0u8; 4]); // one disk
    out.extend(count.to_le_bytes());
    out.extend(count.to_le_bytes());
    out.extend(directory_len.to_le_bytes());
    out.extend(directory_at.to_le_bytes());
    out.extend([0u8; 2]); // no comment
    out
}

/// A filename-safe version of the folder name, for the download.
fn archive_name(workspace: &Path) -> String {
    let folder = workspace.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    // Each run of other characters becomes one dash; dashes already there stay.
    let (mut clean, mut in_run) = (String::new(), false);
    for c in folder.chars() {
        let keep = c.is_ascii_alphanumeric() || c == '_' || c == '-';
        if keep {
            clean.push(c);
        } else if !in_run {
            clean.push('-');
        }
        in_run = !keep;
    }
    let clean = clean.trim_matches('-');
    format!("{}.zip", if clean.is_empty() { "workspace" } else { clean })
}

/// Every file in the workspace as one archive, with the name the download should have. Read as bytes: pictures
/// and other binaries would not survive a round trip through text.
pub fn zip_workspace(workspace: &Path) -> Result<(String, Vec<u8>), String> {
    let files = list_files(workspace);
    if files.is_empty() {
        return Err("This workspace is empty".into());
    }
    // A file that vanished or cannot be read is skipped rather than failing the whole download.
    let entries: Vec<(String, Vec<u8>, u64)> =
        files.into_iter().filter_map(|(path, _, modified)| std::fs::read(workspace.join(&path)).ok().map(|data| (path, data, modified))).collect();
    if entries.is_empty() {
        return Err("Nothing in this workspace could be read".into());
    }
    let bytes: u64 = entries.iter().map(|(path, data, _)| (data.len() + 2 * path.len() + 76) as u64).sum();
    if entries.len() > u16::MAX as usize || bytes + 22 > u32::MAX as u64 {
        return Err("Could not build the archive".into());
    }
    Ok((archive_name(workspace), zip_dated(entries.iter().map(|(path, data, modified)| (path.as_str(), data.as_slice(), *modified)))))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// sha256("abc"), the textbook vector.
    const ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    fn workspace(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("apim-snap-{name}-{}", random36()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(ws: &Path, rel: &str, text: &str) {
        let path = ws.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn text(ws: &Path, rel: &str) -> String {
        std::fs::read_to_string(ws.join(rel)).unwrap_or_default()
    }

    /// Snapshots are ordered by their millisecond timestamp.
    fn tick() {
        std::thread::sleep(std::time::Duration::from_millis(3));
    }

    #[test]
    fn snapshot_round_trip() {
        let ws = workspace("round");
        for unlisted in ["node_modules/m.js", ".git/config", ".workspace-id", "dist/out.js", ".upload-1.tmp", ".apim-extract-9/f.txt", ".history/a.txt.prev"] {
            put(&ws, unlisted, "x");
        }
        put(&ws, "a.txt", "abc");
        put(&ws, "B.txt", "bee");
        put(&ws, "src/dist/keep.js", "k");
        let files = list_files(&ws);
        assert_eq!(files.iter().map(|f| f.0.as_str()).collect::<Vec<_>>(), ["a.txt", "B.txt", "src/dist/keep.js"]);
        // What Node's localeCompare gives for these.
        let mut names = ["x9", "test/app.js", "TEST_REPORT.md", "a.txt", "a_b.txt", "A.txt", "a1", "a-b", "B.txt", "src/a.ts", "src-old/a.ts", "x10"];
        names.sort_by(|a, b| web_order(a, b));
        assert_eq!(names, ["a_b.txt", "a-b", "a.txt", "A.txt", "a1", "B.txt", "src-old/a.ts", "src/a.ts", "TEST_REPORT.md", "test/app.js", "x10", "x9"]);

        let first = create(&ws, "first", &[]).unwrap().unwrap();
        assert_eq!((first.file_count, first.total_bytes), (3, 7));
        assert!(ws.join(".snapshots/objects").join(ABC).is_file());
        // The manifest is the web's, byte for byte: JSON.stringify(manifest, null, 2), no newline at the end.
        let raw = text(&ws, &format!(".snapshots/{}/manifest.json", first.id));
        let head = format!(
            "{{\n  \"id\": \"{}\",\n  \"label\": \"first\",\n  \"createdAt\": \"{}\",\n  \"files\": [\n    {{\n      \"path\": \"a.txt\",\n      \"size\": 3,\n      \
             \"hash\": \"{ABC}\",\n      \"mtime\": \"{}\"\n    }},\n",
            first.id,
            first.created_at,
            iso(files[0].2)
        );
        assert!(raw.starts_with(&head) && raw.ends_with("\"\n    }\n  ]\n}"), "{raw}");
        let (stamp, random) = first.id.split_once('-').unwrap();
        assert!(stamp.len() == 8 && random.len() <= 6 && first.created_at.len() == 24 && first.created_at.ends_with('Z'), "{first:?}");
        // Labels are cut in UTF-16 units like the web's slice(), never through a character.
        assert_eq!((clip_utf16("aé😀b", 4), clip_utf16("a😀", 2)), ("aé😀".into(), "a".into()));

        put(&ws, "a.txt", "changed");
        put(&ws, "new.txt", "n");
        std::fs::remove_file(ws.join("B.txt")).unwrap();
        tick();
        let done = restore(&ws, &first.id, None).unwrap();
        assert_eq!((done.restored, done.removed), (3, 1));
        assert_eq!((text(&ws, "a.txt"), text(&ws, "B.txt"), ws.join("new.txt").exists()), ("abc".into(), "bee".into(), false));
        // The files as they were before the restore were saved first, so the restore can be undone.
        let safety = done.safety.unwrap();
        assert_eq!(safety.label, "Before restoring");
        assert_eq!(list(&ws), [safety.clone(), first.clone()]);
        tick();
        restore(&ws, &safety.id, None).unwrap();
        assert_eq!((text(&ws, "a.txt"), text(&ws, "new.txt"), ws.join("B.txt").exists()), ("changed".into(), "n".into(), false));
        // The hidden folders are neither saved nor swept away by a restore.
        assert_eq!(text(&ws, "node_modules/m.js"), "x");

        assert_eq!(get(&ws, &first.id), Some(first.clone()));
        assert_eq!(restore(&ws, "../x", None).unwrap_err(), "Invalid snapshot id");
        assert!(delete(&ws, &first.id) && get(&ws, &first.id).is_none() && !delete(&ws, "objects"));
        delete_all(&ws);
        assert!(!ws.join(".snapshots").exists());
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn unchanged_files_are_not_read_again() {
        let ws = workspace("same");
        put(&ws, "a.txt", "abc");
        create(&ws, "one", &[]).unwrap();
        let stamp = std::fs::metadata(ws.join("a.txt")).unwrap().modified().unwrap();
        // Same size and time is the rule for "unchanged", so the stored hash is reused without a read.
        put(&ws, "a.txt", "xyz");
        std::fs::File::options().write(true).open(ws.join("a.txt")).unwrap().set_modified(stamp).unwrap();
        tick();
        create(&ws, "two", &[]).unwrap();
        assert_eq!(manifests(&ws)[0].files[0].hash.as_deref(), Some(ABC));
        // An object that was lost is written again rather than trusted.
        std::fs::remove_file(ws.join(".snapshots/objects").join(ABC)).unwrap();
        tick();
        create(&ws, "three", &[]).unwrap();
        let hash = manifests(&ws)[0].files[0].hash.clone().unwrap();
        assert!(hash != ABC && text(&ws, &format!(".snapshots/objects/{hash}")) == "xyz");
        // A file's time is rounded to the millisecond the way Node rounds it, not cut: 0.6 ms is 1.
        let late = std::time::UNIX_EPOCH + std::time::Duration::from_micros(1_700_000_000_000_600);
        std::fs::File::options().write(true).open(ws.join("a.txt")).unwrap().set_modified(late).unwrap();
        assert_eq!((list_files(&ws)[0].2, iso(list_files(&ws)[0].2)), (1_700_000_000_001, "2023-11-14T22:13:20.001Z".into()));
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn restores_what_the_web_wrote() {
        let outer = workspace("web");
        let ws = outer.join("ws");
        // As snapshots.ts writes them today: contents by hash in the shared store. Three entries a forged manifest
        // might carry follow the real one: a hash that climbs out of the store, a path into .git, a path out of the workspace.
        put(&ws, &format!(".snapshots/objects/{ABC}"), "abc");
        put(
            &ws,
            ".snapshots/mslneyet-4zcoe8/manifest.json",
            r#"{
  "id": "mslneyet-4zcoe8",
  "label": "no, do not build \"zero dependency\" resume from where you tried to run npm instal",
  "createdAt": "2026-08-09T10:17:14.166Z",
  "files": [
    {
      "path": "nohomolyzer/backend/.env.example",
      "size": 3,
      "hash": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      "mtime": "2026-08-09T09:56:12.059Z"
    },
    {
      "path": "evil.txt",
      "size": 3,
      "hash": "../mslneyet-4zcoe8/manifest.json"
    },
    {
      "path": ".git/config",
      "size": 3,
      "hash": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    },
    {
      "path": "../escape.txt",
      "size": 3,
      "hash": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    }
  ]
}"#,
        );
        // From before content-addressed storage: no hash, a copy beside the manifest named encodeURIComponent(path).
        put(
            &ws,
            ".snapshots/msghqutj-0tbzcy/manifest.json",
            r#"{
  "id": "msghqutj-0tbzcy",
  "label": "смотри гайд это такое себе",
  "createdAt": "2026-08-05T19:39:40.808Z",
  "files": [
    {
      "path": "docs/OSINT guide.md",
      "size": 5
    }
  ]
}"#,
        );
        put(&ws, ".snapshots/msghqutj-0tbzcy/docs%2FOSINT%20guide.md", "guide");
        let listed = list(&ws);
        assert_eq!(listed.iter().map(|s| (s.id.as_str(), s.file_count, s.total_bytes)).collect::<Vec<_>>(), [("mslneyet-4zcoe8", 4, 12), ("msghqutj-0tbzcy", 1, 5)]);
        assert_eq!(listed[1].label, "смотри гайд это такое себе");

        put(&ws, "stale.txt", "s");
        let done = restore(&ws, "mslneyet-4zcoe8", None).unwrap();
        assert_eq!((done.restored, done.removed), (1, 1));
        assert_eq!(text(&ws, "nohomolyzer/backend/.env.example"), "abc");
        assert!(!ws.join("evil.txt").exists() && !ws.join(".git").exists() && !outer.join("escape.txt").exists());

        let done = restore(&ws, "msghqutj-0tbzcy", None).unwrap();
        assert_eq!((done.restored, done.removed), (1, 1));
        assert_eq!(text(&ws, "docs/OSINT guide.md"), "guide");
        let _ = std::fs::remove_dir_all(outer);
    }

    #[test]
    fn prune_keeps_the_newest_and_sweeps_orphans() {
        let ws = workspace("prune");
        for n in 0..MAX_SNAPSHOTS + 2 {
            put(&ws, &format!(".snapshots/objects/{n:064x}"), "o");
            let manifest = format!(r#"{{"id":"s{n:02}","label":"","createdAt":"2026-01-01T00:00:{n:02}.000Z","files":[{{"path":"f","size":1,"hash":"{n:064x}"}}]}}"#);
            put(&ws, &format!(".snapshots/s{n:02}/manifest.json"), &manifest);
        }
        put(&ws, ".snapshots/objects/half.123.tmp", "junk");
        prune(&ws, &["s00".to_string()]);
        // The oldest is protected (a restore is about to read it), so the next oldest goes, and its contents with it.
        let left: Vec<String> = list(&ws).into_iter().map(|s| s.id).collect();
        assert_eq!((left.len(), left.first().map(String::as_str), left.last().map(String::as_str)), (MAX_SNAPSHOTS + 1, Some("s21"), Some("s00")));
        let object = |n: usize| ws.join(format!(".snapshots/objects/{n:064x}")).exists();
        assert!(!left.contains(&"s01".to_string()) && object(0) && !object(1) && object(2) && !ws.join(".snapshots/objects/half.123.tmp").exists());
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn rewind_finds_and_links_points() {
        let ws = workspace("rewind");
        let chat = [("q1", true, false), ("a1", false, false), ("note", true, true), ("q2", true, false), ("a2", false, false)];
        assert_eq!(locate_question(&chat, Some("q2"), None), Some(3));
        assert_eq!(locate_question(&chat, Some("temp-9"), Some("a1")), Some(0));
        assert_eq!(locate_question(&chat, Some("a1"), Some("q2")), None);
        assert_eq!((next_question(&chat, 0), next_question(&chat, 3)), (Some(3), None));

        // An empty workspace is worth recording: rewinding there means "no files".
        let mut q1 = serde_json::Map::new();
        assert!(link_restore_point(&ws, &mut q1, None));
        assert!(q1["restorePoint"]["snapshotId"].is_null() && q1["restorePoint"]["at"].as_str().is_some_and(|at| from_iso(at).is_some()));
        assert_eq!(find_restore_point(&ws, q1.get("restorePoint"), "first", 1, None), RestorePoint::Empty);

        put(&ws, "a.txt", "abc");
        let snapshot = create(&ws, "second question", &[]).unwrap().unwrap();
        let mut q2 = serde_json::Map::new();
        // A failed snapshot of a workspace with files records nothing, and a regenerate keeps the first reply's point.
        assert!(!link_restore_point(&ws, &mut q2, None));
        assert!(link_restore_point(&ws, &mut q2, Some(&snapshot)) && !link_restore_point(&ws, &mut q2, None));
        assert_eq!(q2["restorePoint"]["snapshotId"], snapshot.id.as_str());
        assert_eq!(find_restore_point(&ws, q2.get("restorePoint"), "", 1, None), RestorePoint::Snapshot(snapshot.clone()));

        // A question from before points were recorded is matched by the snapshot's label and time.
        let at = from_iso(&snapshot.created_at).unwrap();
        assert_eq!(find_restore_point(&ws, None, " second question, in full ", at - 5, None), RestorePoint::Snapshot(snapshot.clone()));
        assert_eq!(find_restore_point(&ws, None, "second question", at - 5, Some(at)), RestorePoint::None);
        assert_eq!(find_restore_point(&ws, None, "another question", at - 5, None), RestorePoint::None);

        let done = rewind_files(&ws, &RestorePoint::Empty, " first ").unwrap();
        assert_eq!((done.removed, done.safety.unwrap().label.as_str(), list_files(&ws).len()), (1, "Before rewinding to: first", 0));
        assert!(rewind_files(&ws, &RestorePoint::Missing, "").unwrap_err().contains("has been pruned"));

        // Pruned since, or a record that lost its id: missing, never "empty", which would delete every file.
        delete(&ws, &snapshot.id);
        assert_eq!(find_restore_point(&ws, q2.get("restorePoint"), "", 1, None), RestorePoint::Missing);
        assert_eq!(find_restore_point(&ws, Some(&serde_json::json!({ "at": "x" })), "", 1, None), RestorePoint::Missing);
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn history_like_the_web() {
        let ws = workspace("history");
        assert_eq!((history_key(".\\src//a.ts"), history_key("a/../b/"), history_key("/abs/x")), ("src/a.ts".into(), "b".into(), "/abs/x".into()));
        put(&ws, "src/50%.ts", "v3");
        record_previous(&ws, "src/50%.ts", b"v1");
        record_previous(&ws, "./src\\50%.ts", b"v2");
        // The web's file names: the path with % and / escaped, the newest version in .prev.
        assert_eq!((text(&ws, ".history/src%2F50%25.ts.prev"), text(&ws, ".history/src%2F50%25.ts.prev.1")), ("v2".into(), "v1".into()));
        assert_eq!(previous_version(&ws, "src/50%.ts").as_deref(), Some("v2"));
        assert_eq!(previous_version_bytes(&ws, "src/50%.ts", 2).as_deref(), Some(&b"v1"[..]));
        assert_eq!((history_depth(&ws, "src/50%.ts"), previous_version_bytes(&ws, "src/50%.ts", 3)), (2, None));

        // Undo: v2 comes back and v3 becomes the undo point, so undoing again returns to v3.
        restore_previous(&ws, "src/50%.ts").unwrap();
        assert_eq!((text(&ws, "src/50%.ts"), previous_version(&ws, "src/50%.ts").as_deref()), ("v2".into(), Some("v3")));
        restore_previous(&ws, "src/50%.ts").unwrap();
        assert_eq!((text(&ws, "src/50%.ts"), history_depth(&ws, "src/50%.ts")), ("v3".into(), 4));

        // Only ten are kept, and the eleventh is never left behind.
        for n in 0..12 {
            record_previous(&ws, "b.txt", n.to_string().as_bytes());
        }
        assert_eq!((history_depth(&ws, "b.txt"), ws.join(".history/b.txt.prev.10").exists()), (MAX_HISTORY_VERSIONS, false));
        assert_eq!(previous_version_bytes(&ws, "b.txt", 10).as_deref(), Some(&b"2"[..]));
        // A deleted file comes back too.
        restore_previous(&ws, "b.txt").unwrap();
        assert_eq!(text(&ws, "b.txt"), "11");

        assert_eq!(restore_previous(&ws, "none.txt").unwrap_err(), "No previous version of that file");
        assert_eq!(restore_previous(&ws, "../x").unwrap_err(), "Path must not contain '..'");
        assert_eq!(restore_previous(&ws, "/etc/passwd").unwrap_err(), "Path must be relative to the workspace");
        assert!(is_protected_path("src\\.git/config") && is_protected_path("./.snapshots/x") && !is_protected_path("src/.history/x"));
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn zip_reads_back() {
        let big = "hello workspace ".repeat(200).into_bytes();
        let out = zip(&[("src\\app.js".to_string(), big.clone()), ("x".to_string(), b"hi".to_vec())]);
        let u16_at = |i: usize| u16::from_le_bytes([out[i], out[i + 1]]) as usize;
        let u32_at = |i: usize| u32::from_le_bytes([out[i], out[i + 1], out[i + 2], out[i + 3]]) as usize;

        // The first entry compresses, so it is deflated; its name has forward slashes and the UTF-8 flag.
        assert_eq!((u32_at(0), u16_at(6), u16_at(8), u32_at(22)), (0x04034b50, 0x0800, 8, big.len()));
        let (packed, name) = (u32_at(18), u16_at(26));
        assert_eq!(&out[30..30 + name], b"src/app.js");
        let mut back = Vec::new();
        std::io::Read::read_to_end(&mut flate2::read::DeflateDecoder::new(&out[30 + name..30 + name + packed]), &mut back).unwrap();
        let mut crc = flate2::Crc::new();
        crc.update(&big);
        assert!(back == big && packed < big.len() && u32_at(14) == crc.sum() as usize);

        // The second would only grow, so it is stored as it is.
        let second = 30 + name + packed;
        assert_eq!((u32_at(second), u16_at(second + 8), &out[second + 31..second + 33]), (0x04034b50, 0, &b"hi"[..]));

        // The directory at the end lists both and points back at them.
        let end = out.len() - 22;
        let directory = u32_at(end + 16);
        assert_eq!((u32_at(end), u16_at(end + 8), u16_at(end + 10), directory + u32_at(end + 12)), (0x06054b50, 2, 2, end));
        assert_eq!((u32_at(directory), u32_at(directory + 42), u32_at(directory + 46 + name), u32_at(directory + 46 + name + 42)), (0x02014b50, 0, 0x02014b50, second));

        assert_eq!(archive_name(Path::new("data/workspaces/my chat (v2) - draft")), "my-chat-v2---draft.zip");
        assert_eq!(archive_name(Path::new("data/workspaces/привет")), "workspace.zip");
        let ws = workspace("zip");
        assert_eq!(zip_workspace(&ws).unwrap_err(), "This workspace is empty");
        put(&ws, "a/b.txt", "abc");
        let (name, bytes) = zip_workspace(&ws).unwrap();
        assert!(name.starts_with("apim-snap-zip-") && name.ends_with(".zip") && bytes.starts_with(b"PK\x03\x04") && bytes.windows(7).any(|w| w == b"a/b.txt"));
        let _ = std::fs::remove_dir_all(ws);
    }
}

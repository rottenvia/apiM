//! binary-ledger.ts: the durable record of which executables were already inspected or decompiled, and what the
//! agent concluded about each (`note_binary`). Lives in `<workspace>/.analysis/binaries.json`, the file the web
//! app uses, so both apps share one record. Writes go through a temp file and a rename, never half a file.

use serde::de::{Deserializer, MapAccess, Visitor};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const LEDGER_DIR: &str = ".analysis";
pub const LEDGER_FILE: &str = "binaries.json";
pub const BINARY_LEDGER_MARKER_OPEN: &str = "<binary-analysis-ledger>";
pub const BINARY_LEDGER_MARKER_CLOSE: &str = "</binary-analysis-ledger>";

/// One executable's cumulative analysis state. Field order is the web's JSON key order.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BinaryLedgerEntry {
    /// Workspace-relative path, using forward slashes.
    pub path: String,
    pub sha256: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub architecture: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_dll: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub managed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub static_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deep_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deep_engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deep_cached: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deep_focus_terms: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capa_status: Option<String>,
    pub outputs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analysis_root: Option<String>,
    pub inspect_count: u32,
    pub deep_runs: u32,
    pub last_inspected_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_deep_at: Option<String>,
    /// The verdict, set by `note_binary`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub noted_at: Option<String>,
}

/// The entries in file order (a JavaScript object keeps insertion order).
#[derive(Clone, Debug, Default)]
pub struct BinaryLedger {
    pub entries: Vec<(String, BinaryLedgerEntry)>,
}

struct Entries(Vec<(String, BinaryLedgerEntry)>);

impl<'de> Deserialize<'de> for Entries {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Entries;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a map of ledger entries")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Entries, A::Error> {
                let mut out = Vec::new();
                while let Some((k, v)) = map.next_entry::<String, BinaryLedgerEntry>()? {
                    out.push((k, v));
                }
                Ok(Entries(out))
            }
        }
        d.deserialize_map(V)
    }
}

#[derive(Deserialize)]
struct LedgerFile {
    version: Option<serde_json::Value>,
    entries: Option<Entries>,
}

struct EntriesOut<'a>(&'a [(String, BinaryLedgerEntry)]);

impl Serialize for EntriesOut<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in self.0 {
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}

#[derive(Serialize)]
struct LedgerOut<'a> {
    version: u32,
    entries: EntriesOut<'a>,
}

fn ledger_path(root: &Path) -> PathBuf {
    root.join(LEDGER_DIR).join(LEDGER_FILE)
}

/// Same path + hash is one executable; a rebuilt DLL gets a new key.
fn key_for(path: &str, sha256: &str) -> String {
    format!("{path}::{}", sha256.chars().take(16).collect::<String>())
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// A missing or unreadable ledger is an empty one.
pub fn read_binary_ledger(root: &Path) -> BinaryLedger {
    let Ok(raw) = fs::read_to_string(ledger_path(root)) else { return BinaryLedger::default() };
    match serde_json::from_str::<LedgerFile>(&raw) {
        Ok(LedgerFile { version: Some(v), entries }) if v == 1 => BinaryLedger { entries: entries.map(|e| e.0).unwrap_or_default() },
        _ => BinaryLedger::default(),
    }
}

fn write_ledger(root: &Path, ledger: &BinaryLedger) -> Result<(), String> {
    let target = ledger_path(root);
    fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&LedgerOut { version: 1, entries: EntriesOut(&ledger.entries) }).map_err(|e| e.to_string())?;
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let tmp = target.with_file_name(format!("{LEDGER_FILE}.{}.{nonce:x}.tmp", std::process::id()));
    let result = fs::write(&tmp, text).and_then(|_| fs::rename(&tmp, &target));
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// What one inspection tells the ledger.
#[derive(Clone, Debug, Default)]
pub struct InspectionRecord {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub architecture: Option<String>,
    pub is_dll: Option<bool>,
    pub managed: Option<bool>,
    pub static_status: Option<String>,
    pub deep_status: Option<String>,
    pub deep_engine: Option<String>,
    pub deep_cached: Option<bool>,
    pub deep_focus_terms: Option<Vec<String>>,
    pub capa_status: Option<String>,
    pub outputs: Vec<String>,
    pub analysis_root: Option<String>,
    /// A deep run was actually attempted this call (cache miss or force).
    pub deep_ran: bool,
}

/// Folds one inspection into the ledger. A cache hit still counts as an inspection but not as a deep run; a changed
/// hash starts a fresh entry so a rebuilt DLL never inherits the old verdict. A disk error never fails the inspection.
pub fn record_binary_inspection(root: &Path, rec: InspectionRecord) {
    if let Err(e) = try_record(root, rec) {
        eprintln!("binary ledger record failed: {e}");
    }
}

fn try_record(root: &Path, rec: InspectionRecord) -> Result<(), String> {
    let mut ledger = read_binary_ledger(root);
    let key = key_for(&rec.path, &rec.sha256);
    let now = now_iso();
    let slot = ledger.entries.iter().position(|(k, _)| *k == key);
    let previous = slot.map(|i| ledger.entries[i].1.clone()).unwrap_or_default();
    let mut outputs: Vec<String> = previous.outputs.iter().chain(rec.outputs.iter()).cloned().collect();
    outputs.sort();
    outputs.dedup();
    let entry = BinaryLedgerEntry {
        path: rec.path,
        sha256: rec.sha256,
        size: rec.size,
        architecture: rec.architecture.or(previous.architecture),
        is_dll: rec.is_dll.or(previous.is_dll),
        managed: rec.managed.or(previous.managed),
        static_status: rec.static_status.or(previous.static_status),
        deep_engine: rec.deep_engine.or(previous.deep_engine),
        deep_cached: rec.deep_cached.or(previous.deep_cached),
        deep_focus_terms: rec.deep_focus_terms.or(previous.deep_focus_terms),
        capa_status: rec.capa_status.or(previous.capa_status),
        outputs,
        analysis_root: rec.analysis_root.or(previous.analysis_root),
        inspect_count: previous.inspect_count + 1,
        deep_runs: previous.deep_runs + u32::from(rec.deep_ran),
        last_inspected_at: now.clone(),
        last_deep_at: if rec.deep_ran || rec.deep_status.as_deref().is_some_and(|s| !s.is_empty()) { Some(now) } else { previous.last_deep_at },
        deep_status: rec.deep_status.or(previous.deep_status),
        // A verdict is about an executable's bytes: carried forward for the same hash, never copied to another build.
        note: previous.note,
        noted_at: previous.noted_at,
    };
    match slot {
        Some(i) => ledger.entries[i].1 = entry,
        None => ledger.entries.push((key, entry)),
    }
    write_ledger(root, &ledger)
}

/// Attaches (or replaces) the verdict for an executable. With a sha256 (any prefix) only that build is annotated;
/// otherwise the most recent entry for the path, or a stub so a note can be recorded before the first inspection.
/// Returns how many entries were updated (0 when the note is blank).
pub fn note_binary_inspection(root: &Path, path: &str, sha256: Option<&str>, note: &str) -> Result<usize, String> {
    let mut ledger = read_binary_ledger(root);
    let now = now_iso();
    let text = super::types::slice_units(&js_trim(note), 500);
    if text.is_empty() {
        return Ok(0);
    }
    let sha256 = sha256.filter(|s| !s.is_empty());
    let mut found: Option<usize> = None;
    if let Some(sha) = sha256 {
        // The ledger keys on a 16-char prefix; a full hash or any prefix the model copied resolves to the entry.
        let needle = sha.to_lowercase();
        let mut best: Option<(usize, String)> = None;
        for (i, (_, e)) in ledger.entries.iter().enumerate() {
            let have = e.sha256.to_lowercase();
            if e.path == path && (have.starts_with(&needle) || needle.starts_with(&have)) {
                let stamp = e.noted_at.clone().unwrap_or_else(|| e.last_inspected_at.clone());
                if best.as_ref().is_none_or(|(_, b)| stamp > *b) {
                    best = Some((i, stamp));
                }
            }
        }
        found = best.map(|b| b.0);
    } else {
        for (i, (_, e)) in ledger.entries.iter().enumerate() {
            if e.path == path && found.is_none_or(|f| e.last_inspected_at > ledger.entries[f].1.last_inspected_at) {
                found = Some(i);
            }
        }
    }
    match found {
        Some(i) => {
            let e = &mut ledger.entries[i].1;
            e.note = Some(text);
            e.noted_at = Some(now);
        }
        None => {
            let stub = BinaryLedgerEntry { path: path.into(), sha256: sha256.unwrap_or("pending").into(), last_inspected_at: now.clone(), note: Some(text), noted_at: Some(now), ..Default::default() };
            ledger.entries.push((key_for(&stub.path, &stub.sha256), stub));
        }
    }
    write_ledger(root, &ledger)?;
    Ok(1)
}

fn js_trim(s: &str) -> String {
    s.trim_matches(|c: char| super::types::is_js_space(c as u32 as u16) && (c as u32) < 0x10000).to_string()
}

fn relative_time(iso: Option<&str>) -> String {
    let Some(iso) = iso.filter(|s| !s.is_empty()) else { return "never".into() };
    let Ok(then) = chrono::DateTime::parse_from_rfc3339(iso) else { return iso.to_string() };
    let seconds = ((chrono::Utc::now().timestamp_millis() - then.timestamp_millis()) as f64 / 1000.0 + 0.5).floor().max(0.0);
    if seconds < 60.0 {
        return format!("{seconds}s ago");
    }
    let minutes = (seconds / 60.0 + 0.5).floor();
    if minutes < 60.0 {
        return format!("{minutes}m ago");
    }
    let hours = (minutes / 60.0 + 0.5).floor();
    if hours < 48.0 {
        return format!("{hours}h ago");
    }
    then.format("%Y-%m-%d").to_string()
}

/// The ledger as a compact block for the system prompt (empty when there is nothing to say), most recent first.
/// Inject it into the model's context every turn; `replace_binary_ledger` refreshes a stale copy in place.
pub fn format_binary_ledger_for_prompt(ledger: &BinaryLedger) -> String {
    let mut entries: Vec<&BinaryLedgerEntry> = ledger.entries.iter().map(|(_, e)| e).filter(|e| e.inspect_count > 0 || e.note.is_some()).collect();
    if entries.is_empty() {
        return String::new();
    }
    entries.sort_by(|a, b| {
        let sa = a.noted_at.as_deref().unwrap_or(&a.last_inspected_at);
        let sb = b.noted_at.as_deref().unwrap_or(&b.last_inspected_at);
        super::types::locale_cmp(sb, sa)
    });
    let mut lines: Vec<String> = vec!["Executables already analyzed in this workspace (do NOT re-decompile/re-inspect a matching hash — read the listed artifacts instead):".into()];
    for e in entries.iter().take(30) {
        let mut tags: Vec<String> = Vec::new();
        if let Some(s) = e.deep_status.as_deref().filter(|s| !s.is_empty()) {
            tags.push(format!("decompile:{s}{}", if e.deep_cached == Some(true) { "(cached)" } else { "" }));
        }
        if e.deep_runs > 0 {
            tags.push(format!("{} deep run{}", e.deep_runs, if e.deep_runs == 1 { "" } else { "s" }));
        }
        if let Some(s) = e.capa_status.as_deref().filter(|s| !s.is_empty()) {
            tags.push(format!("capa:{s}"));
        }
        if e.managed == Some(true) {
            tags.push("managed".into());
        }
        lines.push(format!(
            "- {} [{}{}] sha256:{} — inspected {}×, {}{}",
            e.path,
            e.architecture.as_deref().unwrap_or("?"),
            if e.is_dll == Some(true) { ", dll" } else { "" },
            e.sha256.chars().take(12).collect::<String>(),
            e.inspect_count,
            relative_time(Some(&e.last_inspected_at)),
            if tags.is_empty() { String::new() } else { format!(" ({})", tags.join(", ")) }
        ));
        if !e.outputs.is_empty() {
            let shown: Vec<&str> = e.outputs.iter().take(6).map(String::as_str).collect();
            lines.push(format!("    artifacts: {}{}", shown.join(", "), if e.outputs.len() > 6 { format!(", … +{} more", e.outputs.len() - 6) } else { String::new() }));
        }
        if let Some(note) = &e.note {
            lines.push(format!("    VERDICT: {note}"));
        }
    }
    if entries.len() > 30 {
        lines.push(format!("  … {} more (use list_analysis to see them)", entries.len() - 30));
    }
    lines.push("If these files match what the user is asking about, read the existing artifacts with read_file and update the verdict via note_binary instead of re-running inspect_binary/decompilation.".into());
    // Bounded by markers so a stale copy in a saved or resumed transcript can be found and replaced in place.
    format!("\n\n{BINARY_LEDGER_MARKER_OPEN}\n{}\n{BINARY_LEDGER_MARKER_CLOSE}\n", lines.join("\n"))
}

/// Replaces the ledger block already in `content` with `replacement`, or appends it when there is none.
pub fn replace_binary_ledger(content: &str, replacement: &str) -> String {
    let Some(start) = content.find(BINARY_LEDGER_MARKER_OPEN) else { return format!("{content}{replacement}") };
    let Some(end) = content[start..].find(BINARY_LEDGER_MARKER_CLOSE).map(|e| e + start) else { return format!("{content}{replacement}") };
    format!("{}{}{}", &content[..start], replacement.trim(), &content[end + BINARY_LEDGER_MARKER_CLOSE.len()..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binary::types::test_dir;

    fn rec(path: &str, sha: &str) -> InspectionRecord {
        InspectionRecord { path: path.into(), sha256: sha.into(), size: 10, architecture: Some("x86-64".into()), is_dll: Some(true), managed: Some(false), static_status: Some("ok".into()), deep_status: Some("disabled".into()), deep_engine: Some("none".into()), deep_cached: Some(false), deep_focus_terms: Some(vec![]), capa_status: Some("disabled".into()), outputs: vec!["b.txt".into(), "a.txt".into()], analysis_root: Some("analysis/x-1".into()), deep_ran: false }
    }

    #[test]
    fn records_counts_and_keeps_verdicts_per_hash() {
        let root = test_dir("ledger");
        record_binary_inspection(&root, rec("a.dll", "aaaaaaaaaaaaaaaaaaaaaaaa"));
        record_binary_inspection(&root, rec("a.dll", "aaaaaaaaaaaaaaaaaaaaaaaa"));
        assert_eq!(note_binary_inspection(&root, "a.dll", Some("AAAAAAAAAAAA"), "  works, but flawed  ").unwrap(), 1);
        std::thread::sleep(std::time::Duration::from_millis(5)); // "most recent" needs distinct millisecond stamps
        record_binary_inspection(&root, rec("a.dll", "bbbbbbbbbbbbbbbbbbbbbbbb"));
        let ledger = read_binary_ledger(&root);
        assert_eq!(ledger.entries.len(), 2);
        let (k, a) = &ledger.entries[0];
        assert_eq!(k, "a.dll::aaaaaaaaaaaaaaaa");
        assert_eq!((a.inspect_count, a.note.as_deref(), a.outputs.clone()), (2, Some("works, but flawed"), vec!["a.txt".to_string(), "b.txt".to_string()]));
        assert!(ledger.entries[1].1.note.is_none() && a.last_deep_at.is_some());
        let text = fs::read_to_string(root.join(".analysis/binaries.json")).unwrap();
        assert!(text.starts_with("{\n  \"version\": 1,\n  \"entries\": {\n    \"a.dll::aaaaaaaaaaaaaaaa\": {\n      \"path\": \"a.dll\",\n      \"sha256\""), "{text}");
        assert_eq!(note_binary_inspection(&root, "a.dll", None, "   ").unwrap(), 0);
        // no sha: the most recently inspected entry for the path
        note_binary_inspection(&root, "a.dll", None, "newest").unwrap();
        assert_eq!(read_binary_ledger(&root).entries[1].1.note.as_deref(), Some("newest"));
        // a note before any inspection leaves a stub
        note_binary_inspection(&root, "later.exe", None, "seen in chat").unwrap();
        let stub = read_binary_ledger(&root).entries.pop().unwrap();
        assert_eq!((stub.0.as_str(), stub.1.sha256.as_str(), stub.1.inspect_count), ("later.exe::pending", "pending", 0));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn long_notes_are_cut_at_500() {
        let root = test_dir("ledger-long");
        note_binary_inspection(&root, "x.exe", None, &"y".repeat(900)).unwrap();
        assert_eq!(read_binary_ledger(&root).entries[0].1.note.as_ref().unwrap().len(), 500);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn prompt_block_lists_artifacts_and_verdicts() {
        let root = test_dir("ledger-prompt");
        assert_eq!(format_binary_ledger_for_prompt(&read_binary_ledger(&root)), "");
        let mut r = rec("lib/foo.dll", "0123456789abcdef0123");
        r.outputs = (1..=8).map(|i| format!("o{i}.txt")).collect();
        r.deep_ran = true;
        record_binary_inspection(&root, r);
        note_binary_inspection(&root, "lib/foo.dll", None, "CreateMove reads a stale pointer").unwrap();
        let block = format_binary_ledger_for_prompt(&read_binary_ledger(&root));
        assert!(block.starts_with("\n\n<binary-analysis-ledger>\nExecutables already analyzed"), "{block}");
        assert!(block.contains("- lib/foo.dll [x86-64, dll] sha256:0123456789ab — inspected 1×, "), "{block}");
        assert!(block.contains("s ago (decompile:disabled, 1 deep run, capa:disabled)\n    artifacts: o1.txt, o2.txt, o3.txt, o4.txt, o5.txt, o6.txt, … +2 more\n    VERDICT: CreateMove reads a stale pointer\n"), "{block}");
        assert!(block.ends_with("</binary-analysis-ledger>\n"));
        let replaced = replace_binary_ledger(&format!("system text{block}tail"), "\n\n<binary-analysis-ledger>\nnew\n</binary-analysis-ledger>\n");
        assert_eq!(replaced, "system text\n\n<binary-analysis-ledger>\nnew\n</binary-analysis-ledger>\ntail");
        assert_eq!(replace_binary_ledger("abc", "X"), "abcX");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unreadable_ledger_is_empty() {
        let root = test_dir("ledger-bad");
        fs::create_dir_all(root.join(".analysis")).unwrap();
        fs::write(root.join(".analysis/binaries.json"), "{\"version\":2,\"entries\":{}}").unwrap();
        assert!(read_binary_ledger(&root).entries.is_empty());
        fs::write(root.join(".analysis/binaries.json"), "not json").unwrap();
        assert!(read_binary_ledger(&root).entries.is_empty());
        fs::remove_dir_all(&root).ok();
    }
}

//! Durable findings: conclusions the agent reached, kept across messages, Stop and compaction. Port of src/lib/findings.ts.
//! A finding is short, source-cited and falsifiable. The store is the web's own file, `<workspace>/.analysis/findings.json`
//! (`{"version":1,"findings":[...]}`, written atomically), so the web and desktop apps read each other's. Active findings
//! ride the system prompt; a wrong one is superseded or disproved, never deleted. Best effort like the web: callers should
//! log a write failure and carry on rather than break a reply.
//! Every function that needs the clock has an `_at(…, now_ms)` twin for tests.

use super::{iso_ms, js_head, js_str, js_trim, js_truthy, locale_cmp, now_ms, radix36, JS_SPACE};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

const FINDINGS_DIR: &str = ".analysis";
const FINDINGS_FILE: &str = "findings.json";
/// The store id for facts about THIS MACHINE rather than one project (`machine-findings.json` in the data folder).
pub const MACHINE_SCOPE: &str = "__machine__";
/// Most machine findings shown per prompt: facts, not a diary.
pub const MAX_MACHINE_FINDINGS_SHOWN: usize = 15;
pub const FINDINGS_MARKER_OPEN: &str = "<workspace-findings>";
pub const FINDINGS_MARKER_CLOSE: &str = "</workspace-findings>";

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Active,
    Superseded,
    Disproved,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    /// One-line conclusion, specific and factual.
    pub claim: String,
    /// Files, paths, addresses or identifiers this is about.
    pub refs: Vec<String>,
    /// What established it: a command, a file read, a decompiled function.
    pub evidence: String,
    pub status: Status,
    /// Id of the finding that replaced or disproved this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Store {
    pub version: u8,
    pub findings: Vec<Finding>,
}

impl Store {
    /// A fresh empty store every time, never a shared one (the web once leaked findings between chats that way).
    pub fn empty() -> Store {
        Store { version: 1, findings: Vec::new() }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct NewFinding {
    pub claim: String,
    #[serde(default)]
    pub refs: Vec<String>,
    #[serde(default)]
    pub evidence: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Revision {
    pub id: String,
    /// Why it is wrong, or what replaces it.
    pub reason: String,
    /// "superseded" (default) or "disproved".
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revised {
    pub updated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement: Option<Finding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub already_retired: Option<bool>,
}

/// Whether findings may be shared between chats at all. Off by default (reported as a cross-chat memory leak);
/// APIM_SHARED_FINDINGS=1 brings the machine-wide store back, and even then only for notes filed as machine-wide.
pub fn shared_findings_enabled() -> bool {
    std::env::var("APIM_SHARED_FINDINGS").is_ok_and(|v| v == "1")
}

/// A workspace's findings file.
pub fn store_path(workspace_dir: &Path) -> PathBuf {
    workspace_dir.join(FINDINGS_DIR).join(FINDINGS_FILE)
}

/// The machine-wide findings file, in the data root (`store::data_dir()`).
pub fn machine_store_path(data_root: &Path) -> PathBuf {
    data_root.join("machine-findings.json")
}

/// Distinct, trimmed, non-empty, at most 12.
fn normalise_refs<I: IntoIterator<Item = String>>(refs: I) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for r in refs {
        let r = js_trim(&r).to_string();
        if !r.is_empty() && !out.contains(&r) {
            out.push(r);
        }
    }
    out.truncate(12);
    out
}

fn text_of(v: &Value, cap: usize) -> String {
    js_head(js_trim(&if v.is_null() { String::new() } else { js_str(v) }), cap).to_string()
}

/// Reads the store, sanitising whatever sits on disk: findings written before the size caps existed can carry
/// megabytes inside claim/evidence, and this store rides the system prompt on EVERY request. Unreadable means empty.
pub fn read_store_at(path: &Path, now: u64) -> Store {
    let Ok(parsed) = std::fs::read_to_string(path).map_err(|_| ()).and_then(|t| serde_json::from_str::<Value>(&t).map_err(|_| ())) else { return Store::empty() };
    let (Some(1.0), Some(list)) = (parsed["version"].as_f64(), parsed["findings"].as_array()) else { return Store::empty() };
    let now = iso_ms(now);
    let mut findings: Vec<Finding> = Vec::new();
    for rec in list.iter().filter(|f| f.is_object()) {
        let claim = text_of(&rec["claim"], 400);
        if claim.is_empty() {
            continue;
        }
        let str_or = |v: &Value, default: &str| if v.is_null() { default.to_string() } else { js_str(v) };
        findings.push(Finding {
            id: str_or(&rec["id"], &format!("f{}-{now}", findings.len())),
            claim,
            refs: rec["refs"].as_array().map_or_else(Vec::new, |a| normalise_refs(a.iter().map(js_str))),
            evidence: text_of(&rec["evidence"], 300),
            // Every terminal status is kept: collapsing "superseded" back to "active" resurrects finished work.
            status: match rec["status"].as_str() {
                Some("disproved") => Status::Disproved,
                Some("superseded") => Status::Superseded,
                _ => Status::Active,
            },
            superseded_by: js_truthy(&rec["supersededBy"]).then(|| js_str(&rec["supersededBy"])),
            created_at: str_or(&rec["createdAt"], &now),
            updated_at: str_or(if rec["updatedAt"].is_null() { &rec["createdAt"] } else { &rec["updatedAt"] }, &now),
        });
    }
    Store { version: 1, findings }
}

pub fn read_store(path: &Path) -> Store {
    read_store_at(path, now_ms())
}

/// Atomic: a temp file beside the target, then a rename.
fn write_store(path: &Path, store: &Store) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).map_err(|e| e.to_string())?;
    let tmp = PathBuf::from(format!("{}.{}.{:x}.tmp", path.display(), std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos())));
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, path)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Lower-cased with every run of non-alphanumerics as one space: two claims that differ only in punctuation or case are the same claim.
fn claim_key(claim: &str) -> String {
    let mut key = String::new();
    for c in claim.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            key.push(c);
        } else if !key.ends_with(' ') {
            key.push(' ');
        }
    }
    key.trim().to_string()
}

/// Adds a finding; one with nearly the same claim is updated instead of duplicated.
pub fn add_finding_at(path: &Path, input: &NewFinding, now: u64) -> Result<Finding, String> {
    let claim = js_head(js_trim(&input.claim), 400).to_string();
    if claim.is_empty() {
        return Err("A finding needs a claim.".to_string());
    }
    let mut store = read_store_at(path, now);
    let evidence = js_head(js_trim(&input.evidence), 300).to_string();
    let refs = normalise_refs(input.refs.clone());
    let stamp = iso_ms(now);
    let key = claim_key(&claim);
    if let Some(i) = store.findings.iter().position(|f| f.status == Status::Active && claim_key(&f.claim) == key) {
        let existing = &mut store.findings[i];
        if !evidence.is_empty() {
            existing.evidence = evidence;
        }
        if !refs.is_empty() {
            existing.refs = normalise_refs(existing.refs.iter().cloned().chain(refs));
        }
        existing.updated_at = stamp;
        let out = existing.clone();
        write_store(path, &store)?;
        return Ok(out);
    }
    let finding = Finding { id: format!("f{}{}", radix36(now), store.findings.len()), claim, refs, evidence, status: Status::Active, superseded_by: None, created_at: stamp.clone(), updated_at: stamp };
    store.findings.push(finding.clone());
    write_store(path, &store)?;
    Ok(finding)
}

pub fn add_finding(path: &Path, input: &NewFinding) -> Result<Finding, String> {
    add_finding_at(path, input, now_ms())
}

/// Is this "claim" a retirement note rather than a corrected conclusion? The prompt tells the model to retire finished
/// work with "done — shipped in abc123"; filing that as a NEW active finding put a clutter line on every later prompt.
pub fn is_retirement_claim(claim: &str) -> bool {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"^[{JS_SPACE}]*(?i-u:(?:done|fixed|resolved|shipped|retired|completed?|obsolete|no longer (?:needed|relevant|applies|true)|n/a)\b)")).unwrap());
    RE.is_match(claim)
}

/// Marks a prior finding wrong, with the reason, and optionally files its replacement.
pub fn revise_finding_at(path: &Path, rev: &Revision, replacement: Option<&NewFinding>, now: u64) -> Result<Revised, String> {
    let mut store = read_store_at(path, now);
    let Some(i) = store.findings.iter().position(|f| f.id == rev.id) else { return Ok(Revised::default()) };
    // Retiring twice is refused: a second "disproved" used to add yet another active replacement for a finding already gone.
    if store.findings[i].status != Status::Active {
        return Ok(Revised { already_retired: Some(true), ..Default::default() });
    }
    let stamp = iso_ms(now);
    store.findings[i].status = if rev.status.as_deref() == Some("disproved") { Status::Disproved } else { Status::Superseded };
    store.findings[i].updated_at = stamp.clone();
    let mut made = None;
    if let Some(r) = replacement.filter(|r| !js_trim(&r.claim).is_empty() && !is_retirement_claim(&r.claim)) {
        let f = Finding {
            id: format!("f{}{}", radix36(now), store.findings.len()),
            claim: js_head(js_trim(&r.claim), 400).to_string(),
            refs: normalise_refs(r.refs.clone()),
            evidence: js_head(js_trim(&format!("{} {}", rev.reason, r.evidence)), 300).to_string(),
            status: Status::Active,
            superseded_by: None,
            created_at: stamp.clone(),
            updated_at: stamp,
        };
        store.findings[i].superseded_by = Some(f.id.clone());
        store.findings.push(f.clone());
        made = Some(f);
    }
    write_store(path, &store)?;
    Ok(Revised { updated: true, replacement: made, already_retired: None })
}

pub fn revise_finding(path: &Path, rev: &Revision, replacement: Option<&NewFinding>) -> Result<Revised, String> {
    revise_finding_at(path, rev, replacement, now_ms())
}

fn active_newest_first(store: &Store) -> Vec<&Finding> {
    let mut active: Vec<&Finding> = store.findings.iter().filter(|f| f.status == Status::Active).collect();
    active.sort_by(|a, b| locale_cmp(&b.updated_at, &a.updated_at));
    active
}

/// The active-findings block for the system prompt ("" when there is nothing to say). Bounded so a long investigation
/// cannot crowd out the answer: the oldest active findings drop from the prompt first (they stay on disk).
pub fn format_findings_for_prompt(store: &Store) -> String {
    let active = active_newest_first(store);
    if active.is_empty() {
        return String::new();
    }
    let shown = &active[..active.len().min(25)];
    let mut lines: Vec<String> = shown
        .iter()
        .map(|f| {
            let place = if f.refs.is_empty() { String::new() } else { format!(" ({})", f.refs.iter().take(4).cloned().collect::<Vec<_>>().join(", ")) };
            let why = if f.evidence.is_empty() { String::new() } else { format!(" — {}", js_head(&f.evidence, 300)) };
            format!("- [{}] {}{place}{why}", f.id, js_head(&f.claim, 400))
        })
        .collect();
    if active.len() > shown.len() {
        lines.push(format!("  … {} more established findings.", active.len() - shown.len()));
    }
    format!("\n\n{FINDINGS_MARKER_OPEN}\nFindings already established in this workspace (your own prior conclusions — use the ones RELEVANT to the current request, do not re-derive them; a finding this request does not need is background: never mention, cite, or act on it, leave it out of your reply entirely; if one is wrong, correct it with note_finding; when the work a finding describes is DONE and shipped, retire it — note_finding with that id, status 'disproved', and claim 'done — shipped in <commit/fix>' — so finished items stop riding every prompt):\n\n{}\n{FINDINGS_MARKER_CLOSE}\n", lines.join("\n"))
}

/// Machine-wide findings block for the system prompt ("" when none).
pub fn format_machine_findings_for_prompt(store: &Store) -> String {
    let active = active_newest_first(store);
    if active.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = active
        .iter()
        .take(MAX_MACHINE_FINDINGS_SHOWN)
        .map(|f| format!("- [{}] {}{}", f.id, js_head(&f.claim, 300), if f.evidence.is_empty() { String::new() } else { format!(" — {}", js_head(&f.evidence, 200)) }))
        .collect();
    format!("\n\n<machine-findings>\nFacts about THIS machine and its tools, proven in earlier chats (not about any project). Trust them instead of re-probing; if one turns out wrong here, correct it with note_finding (that id, status 'disproved'):\n\n{}\n</machine-findings>\n", lines.join("\n"))
}

/// Replaces an existing findings block, or appends; used on resume to refresh the first system message.
pub fn replace_findings(content: &str, replacement: &str) -> String {
    let Some(start) = content.find(FINDINGS_MARKER_OPEN) else { return format!("{content}{replacement}") };
    let Some(end) = content[start..].find(FINDINGS_MARKER_CLOSE).map(|e| start + e) else { return format!("{content}{replacement}") };
    format!("{}{}{}", &content[..start], js_trim(replacement), &content[end + FINDINGS_MARKER_CLOSE.len()..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::testkit::check;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn store_of(v: &Value) -> Store {
        serde_json::from_value(v.clone()).unwrap()
    }

    #[test]
    fn replays_the_prompt_formats() {
        check("findings.format", |s| {
            let store = store_of(s);
            json!({ "prompt": format_findings_for_prompt(&store), "machine": format_machine_findings_for_prompt(&store) })
        });
        check("findings.isRetirementClaim", |c| json!(is_retirement_claim(c.as_str().unwrap())));
        check("findings.replaceFindings", |a| json!(replace_findings(a[0].as_str().unwrap(), a[1].as_str().unwrap())));
    }

    #[test]
    fn replays_add_revise_read_against_a_real_file() {
        static N: AtomicUsize = AtomicUsize::new(0);
        check("findings.ops", |spec| {
            let dir = std::env::temp_dir().join(format!("actx-findings-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
            let _ = std::fs::remove_dir_all(&dir);
            let path = store_path(&dir);
            if let Some(seed) = spec["seed"].as_str() {
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(&path, seed).unwrap();
            }
            let out: Vec<Value> = spec["ops"]
                .as_array()
                .unwrap()
                .iter()
                .map(|o| {
                    let t = o["t"].as_u64().unwrap();
                    let res = match o["op"].as_str().unwrap() {
                        "add" => add_finding_at(&path, &serde_json::from_value(o["input"].clone()).unwrap(), t).map(|f| serde_json::to_value(f).unwrap()),
                        "revise" => {
                            let repl: Option<NewFinding> = (!o["repl"].is_null()).then(|| serde_json::from_value(o["repl"].clone()).unwrap());
                            revise_finding_at(&path, &serde_json::from_value(o["rev"].clone()).unwrap(), repl.as_ref(), t).map(|r| serde_json::to_value(r).unwrap())
                        }
                        _ => Ok(serde_json::to_value(read_store_at(&path, t)).unwrap()),
                    };
                    res.unwrap_or_else(|e| json!({ "error": e }))
                })
                .collect();
            let file = std::fs::read_to_string(&path).ok().map_or(Value::Null, |t| serde_json::from_str(&t).unwrap_or_else(|_| json!({ "raw": t })));
            let _ = std::fs::remove_dir_all(&dir);
            json!({ "out": out, "file": file })
        });
    }

    #[test]
    fn written_file_has_the_web_shape() {
        let dir = std::env::temp_dir().join(format!("actx-shape-{}", std::process::id()));
        let path = store_path(&dir);
        add_finding_at(&path, &NewFinding { claim: "A".into(), refs: vec!["x".into()], evidence: String::new() }, 1_767_323_045_678).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("{\n  \"version\": 1,\n  \"findings\": [\n    {\n      \"id\": \"f"), "{text}");
        assert!(text.contains("\"createdAt\": \"2026-01-02T03:04:05.678Z\""));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

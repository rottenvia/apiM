//! `inspect_binary` and `note_binary`: static inspection of executables and libraries (PE, ELF, Mach-O and friends)
//! without running them, and the verdict notes that survive Stop and compaction. The work lives in `crate::binary`;
//! this file only reads the model's arguments the way the web app's tool cases do and words the result.

use super::Output;
use crate::binary::artifacts::StaticArtifactLayers;
use crate::binary::decompiler::AnalyzerOverrides;
use crate::binary::formats::{InspectBinaryOptions, finish_inspection, format_binary_inspection, inspect_static};
use crate::binary::ledger::note_binary_inspection;
use crate::binary::pe::StringOptions;
use serde_json::Value;
use std::path::Path;

/// `String(value)` for a model-supplied argument: absent is empty, other types are coerced.
fn js_str(args: &Value, key: &str) -> String {
    js_string(&args[key])
}

fn js_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Array(a) => a.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// An optional number the model may have sent as a string; `None` when absent or not finite.
fn js_num(args: &Value, key: &str) -> Option<f64> {
    let n = match &args[key] {
        Value::Null => return None,
        Value::String(s) if s.is_empty() => return None,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        v => v.as_f64()?,
    };
    n.is_finite().then(|| n.trunc())
}

/// A strict boolean: the web checks `typeof x === "boolean"` / `=== true`, so "true" the string does not count.
fn strict_bool(args: &Value, key: &str) -> Option<bool> {
    args[key].as_bool()
}

fn strings_of(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().map(js_string).collect()).unwrap_or_default()
}

/// What the web returns for a thrown error. ponytail: no "did you mean" path suggestions after "No such file".
fn error(message: String) -> Output {
    Output { ok: false, text: format!("Error: {message}"), summary: message, ..Default::default() }
}

const LAYERS: [&str; 7] = ["summary", "strings", "entropy", "carve", "dependencies", "capa", "decompile"];

/// Reads `inspect_binary`'s arguments into the options the inspection takes.
fn options_from_args(args: &Value) -> InspectBinaryOptions {
    fn add(list: &mut Vec<&'static str>, name: &'static str) {
        if !list.contains(&name) {
            list.push(name);
        }
    }
    let explicit = args["analyses"].is_array();
    let mut requested: Vec<&'static str> = Vec::new();
    if let Some(list) = args["analyses"].as_array() {
        for value in list {
            let layer = js_string(value).to_lowercase();
            if layer == "all" {
                for l in LAYERS {
                    add(&mut requested, l);
                }
            } else if let Some(l) = LAYERS.iter().find(|l| **l == layer) {
                add(&mut requested, l);
            }
        }
    }
    // Cheap and useful rather than "everything" when the model omitted a choice.
    if requested.is_empty() {
        add(&mut requested, "summary");
    }
    if args["artifacts"] == true && !explicit {
        for l in ["summary", "strings", "entropy", "carve"] {
            add(&mut requested, l);
        }
    }
    let has = |l: &str| requested.contains(&l);
    let layers = StaticArtifactLayers { summary: has("summary"), strings: has("strings"), entropy: has("entropy"), carve: has("carve") };
    let artifacts_enabled = args["artifacts"] != false && (layers.summary || layers.strings || layers.entropy || layers.carve);
    let analyzer_list = |key: &str| args[key].is_array().then(|| strings_of(&args[key]));
    InspectBinaryOptions {
        strings: StringOptions {
            include_strings: Some(strict_bool(args, "include_strings").unwrap_or(has("strings") || has("summary"))),
            string_filter: args["string_filter"].as_str().map(str::to_string),
            min_string_length: js_num(args, "min_string_length"),
            max_strings: js_num(args, "max_strings"),
        },
        dependencies: Some(strict_bool(args, "dependencies").unwrap_or(has("dependencies"))),
        max_depth: js_num(args, "max_depth"),
        artifacts: Some(artifacts_enabled),
        artifact_layers: Some(layers),
        run_capa: Some(strict_bool(args, "run_capa").unwrap_or(has("capa"))),
        deep: Some(strict_bool(args, "deep").unwrap_or(has("decompile"))),
        force_deep: args["force_decompile"] == true,
        focus_terms: strings_of(&args["focus_terms"]),
        focused_only: Some(args["focused_only"] != false),
        analyzers: AnalyzerOverrides {
            preset: Some(if args["analyzer_preset"] == "full" { "full" } else { "fast" }.into()),
            disable: analyzer_list("disable_analyzers").unwrap_or_default(),
            enable: analyzer_list("enable_analyzers").unwrap_or_default(),
        },
        allow_full_fallback: args["allow_full_fallback"] == true,
    }
}

/// Parses an executable or library under the workspace root and returns the report text, writing the exhaustive
/// artifacts under `analysis/`. Async only because capa and the decompilers are external processes.
/// Needs the multi-threaded runtime (the parse runs under `block_in_place`, like the other file tools).
pub async fn inspect_binary(root: &Path, args: &Value) -> Output {
    let target = js_str(args, "path");
    let opts = options_from_args(args);
    let part = match tokio::task::block_in_place(|| inspect_static(root, &target, &opts)) {
        Ok(p) => p,
        Err(e) => return error(e),
    };
    let result = finish_inspection(root, &target, part, &opts).await;
    let p = &result.inspection;
    let generated = result.artifacts.outputs.len() + result.deep.outputs.len() + usize::from(result.capa.output.is_some());
    let summary = format!(
        "Inspected {target} — {}, {} libraries, {} exports, packing {}{}",
        p.architecture,
        p.imports.len(),
        p.exports.len(),
        p.packing.status,
        if generated > 0 { format!(", {generated} analysis artifact{}", if generated == 1 { "" } else { "s" }) } else { String::new() }
    );
    let changed = if !result.artifacts.root.is_empty() { Some(result.artifacts.root.clone()) } else { result.deep.outputs.first().map(|o| o.split('/').take(2).collect::<Vec<_>>().join("/")) };
    Output { ok: true, text: format_binary_inspection(&result), summary, changed, ..Default::default() }
}

/// Records the model's verdict about an executable in the ledger (`.analysis/binaries.json`), shown on every later turn.
pub fn note_binary(root: &Path, args: &Value) -> Output {
    let path = js_str(args, "path");
    let note = js_str(args, "note");
    if path.is_empty() || note.is_empty() {
        return Output { ok: false, text: "note_binary requires path and note.".into(), summary: "Missing path or note".into(), ..Default::default() };
    }
    let sha = js_str(args, "sha256");
    let updated = match note_binary_inspection(root, &path, Some(sha.as_str()).filter(|s| !s.is_empty()), &note) {
        Ok(n) => n,
        Err(e) => return error(e),
    };
    if updated > 0 {
        Output::ok(format!("Verdict saved for {path}. It will be shown in this workspace's binary analysis record on every later turn, so you will not need to re-inspect it to remember what you concluded."), format!("Noted: {path}"))
    } else {
        Output { ok: false, text: format!("Could not save a verdict for {path}."), summary: "Note not saved".into(), ..Default::default() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binary::pe::samples;
    use crate::binary::types::test_dir;
    use serde_json::json;

    #[test]
    fn arguments_map_to_the_webs_defaults() {
        let o = options_from_args(&json!({ "path": "a.exe" }));
        let l = o.artifact_layers.unwrap();
        assert_eq!((l.summary, l.strings, l.entropy, l.carve), (true, false, false, false));
        assert_eq!((o.artifacts, o.dependencies, o.run_capa, o.deep, o.strings.include_strings), (Some(true), Some(false), Some(false), Some(false), Some(true)));
        assert_eq!((o.analyzers.preset.as_deref(), o.focused_only), (Some("fast"), Some(true)));
        let all = options_from_args(&json!({ "path": "a.exe", "analyses": ["ALL"], "analyzer_preset": "full", "focus_terms": ["x", 5], "max_strings": "20", "string_filter": "http" }));
        assert_eq!((all.dependencies, all.run_capa, all.deep, all.strings.max_strings), (Some(true), Some(true), Some(true), Some(20.0)));
        assert_eq!((all.focus_terms, all.analyzers.preset.as_deref(), all.strings.string_filter.as_deref()), (vec!["x".to_string(), "5".to_string()], Some("full"), Some("http")));
        let legacy = options_from_args(&json!({ "path": "a.exe", "artifacts": true, "deep": true, "dependencies": false }));
        let l = legacy.artifact_layers.unwrap();
        assert_eq!((l.summary, l.strings, l.entropy, l.carve, legacy.deep, legacy.dependencies), (true, true, true, true, Some(true), Some(false)));
        let none = options_from_args(&json!({ "path": "a.exe", "analyses": ["decompile"], "artifacts": false }));
        assert_eq!((none.artifacts, none.deep), (Some(false), Some(true)));
        let only_dep = options_from_args(&json!({ "path": "a.exe", "analyses": ["dependencies", "bogus"] }));
        assert_eq!((only_dep.artifacts, only_dep.strings.include_strings), (Some(false), Some(false)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn inspect_then_note_end_to_end() {
        let root = test_dir("tool-binary");
        std::fs::create_dir_all(root.join("uploads/binaries")).unwrap();
        std::fs::write(root.join("uploads/binaries/sample.exe"), samples::pe64()).unwrap();
        let out = inspect_binary(&root, &json!({ "path": "uploads/binaries/sample.exe", "analyses": ["summary", "strings", "entropy", "carve", "dependencies"] })).await;
        assert!(out.ok, "{}", out.text);
        assert!(out.summary.starts_with("Inspected uploads/binaries/sample.exe — x86-64, 3 libraries, 3 exports, packing "), "{}", out.summary);
        assert!(out.summary.contains(" analysis artifacts"));
        assert!(out.changed.as_deref().is_some_and(|c| c.starts_with("analysis/sample-")));
        assert!(out.text.starts_with("Binary: uploads/binaries/sample.exe\nFormat: PE32+ · x86-64 · Windows console\n"));
        assert!(out.text.contains("\nStatic artifacts: Prepared PE summary, ") && out.text.contains("Dependency graph (1 local PE file(s) parsed):"));
        assert!(!out.text.contains("Deep decompilation"));

        let noted = note_binary(&root, &json!({ "path": "uploads/binaries/sample.exe", "note": "Clean sample; imports are normal." }));
        assert!(noted.ok && noted.text.starts_with("Verdict saved for uploads/binaries/sample.exe. It will be shown"), "{}", noted.text);
        assert_eq!(noted.summary, "Noted: uploads/binaries/sample.exe");
        let ledger = crate::binary::ledger::read_binary_ledger(&root);
        assert_eq!(ledger.entries.len(), 1);
        assert_eq!(ledger.entries[0].1.note.as_deref(), Some("Clean sample; imports are normal."));
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn errors_read_like_the_webs() {
        let root = test_dir("tool-binary-errors");
        let missing = inspect_binary(&root, &json!({ "path": "nope.dll" })).await;
        assert_eq!((missing.ok, missing.text.as_str(), missing.summary.as_str()), (false, "Error: No such file: nope.dll", "No such file: nope.dll"));
        let escape = inspect_binary(&root, &json!({ "path": "../x.exe" })).await;
        assert!(!escape.ok && escape.text.starts_with("Error: Path escapes the workspace"), "{}", escape.text);
        let none = note_binary(&root, &json!({ "path": "a.exe" }));
        assert_eq!((none.ok, none.text.as_str(), none.summary.as_str()), (false, "note_binary requires path and note.", "Missing path or note"));
        let blank = note_binary(&root, &json!({ "path": "a.exe", "note": "   " }));
        assert_eq!((blank.ok, blank.text.as_str(), blank.summary.as_str()), (false, "Could not save a verdict for a.exe.", "Note not saved"));
        std::fs::remove_dir_all(&root).ok();
    }

    /// Sorts the non-ASCII lines of the "Selected strings" block. ICU orders Han characters by radical and stroke, which
    /// this port does not know, so equal-score garbage strings (ASCII text read as UTF-16) may come in another order.
    fn canon(text: &str) -> String {
        fn flush(block: &mut Vec<String>, out: &mut Vec<String>) {
            let (ascii, mut other): (Vec<String>, Vec<String>) = block.drain(..).partition(|l| l.is_ascii());
            other.sort();
            out.extend(ascii.into_iter().chain(other));
        }
        let (mut out, mut block, mut inside) = (Vec::new(), Vec::new(), false);
        for line in text.split('\n') {
            if line.starts_with("Selected strings (") {
                inside = true;
                out.push(line.to_string());
            } else if inside && line.starts_with("  \"") {
                block.push(line.to_string());
            } else {
                if inside {
                    flush(&mut block, &mut out);
                    inside = false;
                }
                out.push(line.to_string());
            }
        }
        flush(&mut block, &mut out);
        out.join("\n")
    }

    /// The recorded output of the web app's own TypeScript for the same inputs: report text, summary, written files
    /// and ledger must come out the same (dates masked; files that are not text are compared by SHA-256).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn matches_recorded_typescript_output() {
        let stamp = regex::Regex::new("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z").unwrap();
        let mask = |s: &str| stamp.replace_all(s, "<ts>").to_string();
        let cases: Value = serde_json::from_str(include_str!("../binary/fixtures.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let root = test_dir(&format!("recorded-{name}"));
            for (rel, f) in case["files"].as_object().unwrap() {
                let bytes = crate::binary::fixtures::by_name(f["fixture"].as_str().unwrap());
                assert_eq!(crate::binary::types::sha256_hex(&bytes), f["sha256"].as_str().unwrap(), "{name}: fixture {rel} drifted");
                std::fs::create_dir_all(root.join(rel).parent().unwrap()).unwrap();
                std::fs::write(root.join(rel), bytes).unwrap();
            }
            for pre in case["before"].as_array().unwrap() {
                assert!(inspect_binary(&root, pre).await.ok);
            }
            let out = if case["tool"] == "note_binary" { note_binary(&root, &case["args"]) } else { inspect_binary(&root, &case["args"]).await };
            assert_eq!(out.ok, case["ok"].as_bool().unwrap(), "{name}");
            assert_eq!(canon(&mask(&out.text)), canon(case["content"].as_str().unwrap()), "{name}: text");
            assert_eq!(out.summary, case["summary"].as_str().unwrap(), "{name}: summary");
            assert_eq!(out.changed.unwrap_or_default(), case["changedPath"].as_str().unwrap(), "{name}: changed path");
            let mut written: Vec<String> = Vec::new();
            for dir in ["analysis", ".analysis"] {
                for entry in walkdir::WalkDir::new(root.join(dir)).into_iter().flatten().filter(|e| e.file_type().is_file()) {
                    written.push(entry.path().strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/"));
                }
            }
            written.sort();
            let recorded = case["artifacts"].as_object().unwrap();
            assert_eq!(written, recorded.keys().cloned().collect::<Vec<_>>(), "{name}: files written");
            for (rel, want) in recorded {
                let bytes = std::fs::read(root.join(rel)).unwrap();
                match want["text"].as_str() {
                    Some(text) => assert_eq!(mask(&String::from_utf8_lossy(&bytes)), text, "{name}: {rel}"),
                    None => assert_eq!(crate::binary::types::sha256_hex(&bytes), want["sha256"].as_str().unwrap(), "{name}: {rel}"),
                }
            }
            std::fs::remove_dir_all(&root).ok();
        }
    }
}

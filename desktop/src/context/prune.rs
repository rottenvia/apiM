//! Keeping a long agent transcript from growing without bound: port of src/lib/prune.ts.
//! Old tool results collapse to a one-line placeholder, fat tool-call arguments to a small valid JSON stub; the system
//! prompt, the user's question, `reasoning_content` and every call/reply pairing are never touched (providers answer 400 otherwise).
//! Works on OpenAI-shaped messages and returns a new list, so the stored transcript keeps everything.

use super::{js_head, js_len, js_round, js_trim, jstr};
use regex::Regex;
use serde_json::Value;
use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::LazyLock;

/// How many of the most recent tool results stay verbatim; everything older is eligible for collapse.
pub const KEEP_VERBATIM_RESULTS: usize = 8;
/// Only results above this size are worth collapsing: a short confirmation is smaller than its placeholder.
pub const MIN_COLLAPSE_CHARS: usize = 1_500;
/// Tool-call arguments past this are stubbed (a write_file argument IS the file, resent every round otherwise).
pub const MAX_VERBATIM_ARGS_CHARS: usize = 2_000;
/// Leave the transcript alone until it is this large.
pub const PRUNE_THRESHOLD_CHARS: usize = 24_000;
/// File reads (and whole-file writes) the agent is still working from stay verbatim, up to this many characters, newest first.
pub const FILE_READ_BUDGET_CHARS: usize = 150_000;

/// How many old results collapse at once when the caller asks for it (`Options::batch`). A collapse changes a message in
/// the middle of the request, and the provider's cache of everything after it is lost: one a round meant the newest
/// eight results were paid in full on every round (measured: 32% of the input cached over 24 reads, 9% of each round).
pub const COLLAPSE_BATCH: usize = 8;

const FILE_READ_TOOLS: [&str; 2] = ["read_file", "read_files"];
const FILE_WRITE_TOOLS: [&str; 9] = ["write_file", "write_files", "edit_file", "edit_files", "apply_patch", "replace_in_files", "move_file", "delete_file", "undo_file"];
/// Writes whose arguments ARE the whole file (not a diff).
const FULL_WRITE_TOOLS: [&str; 2] = ["write_file", "write_files"];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Options {
    pub keep_verbatim: usize,
    pub min_chars: usize,
    pub threshold_chars: usize,
    /// 0 turns read retention off.
    pub file_read_budget: usize,
    /// Old results collapse in groups of this many. 1 collapses each as soon as it is old, as the web does.
    pub batch: usize,
}

impl Default for Options {
    fn default() -> Self {
        Options { keep_verbatim: KEEP_VERBATIM_RESULTS, min_chars: MIN_COLLAPSE_CHARS, threshold_chars: PRUNE_THRESHOLD_CHARS, file_read_budget: FILE_READ_BUDGET_CHARS, batch: 1 }
    }
}

/// The small-window preset for local Qwen models (src/lib/local-context.ts).
pub const QWEN_PRUNE: Options = Options { keep_verbatim: 3, min_chars: 600, threshold_chars: 8_000, file_read_budget: 0, batch: 1 };

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PruneStats {
    /// Tool results replaced with a placeholder.
    pub collapsed: usize,
    /// Characters removed from the transcript.
    pub chars_saved: usize,
    /// Rough token saving, at ~3.6 chars per token.
    pub tokens_saved: usize,
}

/// What the model is still working from.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Retained {
    /// Message indices of tool results to keep verbatim.
    pub reads: BTreeSet<usize>,
    /// Tool-call ids of whole-file writes whose arguments stay verbatim.
    pub writes: HashSet<String>,
}

fn norm_path(p: &str) -> String {
    let p = js_trim(p).replace('\\', "/");
    let p = p.strip_prefix("./").unwrap_or(&p);
    p.trim_end_matches('/').to_string()
}

/// Paths a read call asked for (globs kept as written).
fn read_paths(args: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<Value>(args) else { return Vec::new() };
    if !v.is_object() {
        return Vec::new();
    }
    let Some(raw) = ["paths", "path", "files"].iter().map(|k| &v[*k]).find(|x| !x.is_null()) else { return Vec::new() };
    let one = |p: &Value| match p {
        Value::String(s) => s.clone(),
        Value::Object(_) => p["path"].as_str().unwrap_or("").to_string(),
        _ => String::new(),
    };
    let list: Vec<String> = match raw {
        Value::Array(a) => a.iter().map(one).collect(),
        other => vec![one(other)],
    };
    list.into_iter().filter(|s| !s.is_empty()).map(|s| norm_path(&s)).collect()
}

/// `*** Update File: x`, `+++ b/x` and `--- a/x` lines of a patch. (JS line terminators: \n \r U+2028 U+2029.)
static PATCH_FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)(?:^|[\r\x{2028}\x{2029}])(?:\*\*\* (?:Update|Add|Delete) File: |\+\+\+ b/|--- a/)([^\r\n\x{2028}\x{2029}]+)").unwrap());

fn walk_written(name: &str, v: &Value, key: Option<&str>, out: &mut Vec<String>) {
    match v {
        Value::String(s) => {
            if matches!(key, Some("path" | "from" | "to")) {
                out.push(norm_path(s));
            }
            if key == Some("patch") || (name == "apply_patch" && key == Some("input")) {
                out.extend(PATCH_FILE.captures_iter(s).map(|m| norm_path(&m[1])));
            }
        }
        Value::Array(a) => a.iter().for_each(|x| walk_written(name, x, key, out)),
        Value::Object(o) => o.iter().for_each(|(k, x)| walk_written(name, x, Some(k.as_str()), out)),
        _ => {}
    }
}

/// Every path a write-ish call touches, as best the arguments say.
fn written_paths(name: &str, args: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(v) = serde_json::from_str::<Value>(args) {
        walk_written(name, &v, None, &mut out);
    }
    out
}

/// Does a (possibly glob) read path cover this written path?
fn covers(read: &str, written: &str) -> bool {
    read == written || read.find('*').is_some_and(|star| written.starts_with(&read[..star]))
}

fn calls(m: &Value) -> &[Value] {
    m["tool_calls"].as_array().map_or(&[], Vec::as_slice)
}

fn call_str<'a>(c: &'a Value, key: &str) -> &'a str {
    c["function"][key].as_str().unwrap_or("")
}

/// The file text the model is still working from, newest first, within `budget`: the newest read of each file set not
/// rewritten since, and the newest whole-file write of each file not edited or re-read since.
pub fn retained_file_content(messages: &[Value], budget: usize) -> Retained {
    let mut out = Retained::default();
    if budget == 0 {
        return out;
    }
    let mut call_by_id: HashMap<&str, (&str, &str)> = HashMap::new();
    for m in messages.iter().filter(|m| m["role"] == "assistant") {
        for c in calls(m) {
            call_by_id.insert(c["id"].as_str().unwrap_or(""), (call_str(c, "name"), call_str(c, "arguments")));
        }
    }
    // Newest to oldest, remembering what later calls read and wrote.
    let (mut later_writes, mut later_read_paths): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    let mut later_reads: HashSet<String> = HashSet::new();
    let mut used = 0;
    for i in (0..messages.len()).rev() {
        let m = &messages[i];
        if m["role"] != "tool" {
            continue;
        }
        let id = m["tool_call_id"].as_str().unwrap_or("");
        let Some(&(name, args)) = call_by_id.get(id) else { continue };
        let content = m["content"].as_str();
        let failed = content.is_some_and(|c| c.starts_with("Error"));
        if FILE_WRITE_TOOLS.contains(&name) {
            let paths = written_paths(name, args);
            if !failed
                && FULL_WRITE_TOOLS.contains(&name)
                && !paths.is_empty()
                && !paths.iter().any(|p| later_writes.contains(p))
                && !paths.iter().any(|p| later_read_paths.iter().any(|r| covers(r, p)))
                && used + js_len(args) <= budget
            {
                used += js_len(args);
                out.writes.insert(id.to_string());
            }
            if !failed {
                later_writes.extend(paths);
            }
            continue;
        }
        if !FILE_READ_TOOLS.contains(&name) {
            continue;
        }
        let Some(content) = content else { continue };
        // A line standing in for the text is not a read of it: counted as one, "[Unchanged" made the copy it points at an old read, and that copy was collapsed.
        if content.starts_with("[earlier") || content.starts_with("[Folded") || content.starts_with("[Unchanged") || failed {
            continue;
        }
        let paths = read_paths(args);
        let mut sorted = paths.clone();
        sorted.sort();
        let superseded = !later_reads.insert(sorted.join("\n"));
        later_read_paths.extend(paths.iter().cloned());
        if superseded || paths.is_empty() {
            continue;
        }
        if paths.iter().any(|p| later_writes.iter().any(|w| covers(p, w))) || used + js_len(content) > budget {
            continue;
        }
        used += js_len(content);
        out.reads.insert(i);
    }
    out
}

/// Tool-result indices of reads to keep verbatim (see `retained_file_content`).
pub fn retained_reads(messages: &[Value], budget: usize) -> BTreeSet<usize> {
    retained_file_content(messages, budget).reads
}

/// Total size of a transcript in UTF-16 units, for deciding whether pruning is worthwhile.
pub fn transcript_chars(messages: &[Value]) -> usize {
    let len = |v: &Value| v.as_str().map_or(0, js_len);
    messages.iter().map(|m| len(&m["content"]) + if m["role"] == "assistant" { len(&m["reasoning_content"]) + calls(m).iter().map(|c| js_len(call_str(c, "arguments")) + js_len(call_str(c, "name"))).sum::<usize>() } else { 0 }).sum()
}

/// Name of the tool a result belongs to, for a more useful placeholder.
fn tool_name_for<'a>(messages: &'a [Value], id: &str) -> &'a str {
    messages.iter().filter(|m| m["role"] == "assistant").flat_map(calls).find(|c| c["id"].as_str() == Some(id)).map_or("tool", |c| call_str(c, "name"))
}

static FILE_NAMES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i-u)[\w./\\-]+\.(?:c|cpp|h|hpp|cs|ts|tsx|js|jsx|mjs|py|lua|luau|rs|go|java|kt|rb|php|css|html|json|toml|yaml|yml|md|txt|sln|vcxproj|dll|exe)\b").unwrap());
static VERDICT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"verdict|conclusion|found|proves?|^- \[").unwrap());

/// A collapsed result still says how big it was, how it started, which files it named and what it concluded,
/// so the model does not re-read the same file just to find out what it was.
fn placeholder(name: &str, content: &str) -> String {
    let lines: Vec<&str> = content.split('\n').collect();
    let meaningful: Vec<&str> = lines.iter().copied().filter(|l| !js_trim(l).is_empty()).collect();
    let head = meaningful.iter().take(3).map(|l| js_head(js_trim(l), 160)).collect::<Vec<_>>().join(" | ");
    let mut seen: Vec<&str> = Vec::new();
    for m in FILE_NAMES.find_iter(content).take(6) {
        if !seen.contains(&m.as_str()) {
            seen.push(m.as_str());
        }
    }
    let verdict = meaningful.iter().find(|l| VERDICT.is_match(l)).map(|l| js_head(js_trim(l), 200));
    let bits: Vec<String> = [
        Some(format!("{} lines / {} chars", lines.len(), js_len(content))),
        (!head.is_empty()).then(|| format!("starts: {head}")),
        (!seen.is_empty()).then(|| format!("files: {}", seen.join(", "))),
        verdict.filter(|v| !v.is_empty()).map(|v| format!("note: {v}")),
    ]
    .into_iter()
    .flatten()
    .collect();
    format!("[earlier {name} result collapsed to save context — {}. Re-run the tool or read the listed file if you need the full text.]", bits.join("; "))
}

/// A valid JSON object in place of fat arguments: never truncated JSON plus prose, which strict gateways reject.
fn stub_arguments(args: &str) -> String {
    format!("{{\"_trimmed\":true,\"_note\":{},\"_head\":{}}}", jstr("arguments trimmed from history — this call already ran; its paired result records what it did"), jstr(js_head(args, 400)))
}

/// Collapses old tool results and stubs fat arguments, leaving structure and recent context intact.
/// Below the threshold the input comes back as is.
pub fn prune_transcript<'a>(messages: &'a [Value], o: &Options) -> (Cow<'a, [Value]>, PruneStats) {
    if transcript_chars(messages) < o.threshold_chars {
        return (Cow::Borrowed(messages), PruneStats::default());
    }
    let results: Vec<usize> = (0..messages.len()).filter(|&i| messages[i]["role"] == "tool").collect();
    // Result collapsing needs old results to exist; argument stubbing does not.
    let batch = o.batch.max(1);
    let mut collapsible: HashSet<usize> = results[..results.len().saturating_sub(o.keep_verbatim) / batch * batch].iter().copied().collect();
    let retained = retained_file_content(messages, o.file_read_budget);
    for i in &retained.reads {
        collapsible.remove(i);
    }
    let (mut collapsed, mut chars_saved) = (0usize, 0usize);
    let out: Vec<Value> = messages
        .iter()
        .enumerate()
        .map(|(i, m)| {
            if m["role"] == "tool" {
                let Some(content) = m["content"].as_str().filter(|c| collapsible.contains(&i) && js_len(c) >= o.min_chars) else { return m.clone() };
                let replacement = placeholder(tool_name_for(messages, m["tool_call_id"].as_str().unwrap_or("")), content);
                // Never grow a message by "shrinking" it.
                if js_len(&replacement) >= js_len(content) {
                    return m.clone();
                }
                collapsed += 1;
                chars_saved += js_len(content) - js_len(&replacement);
                // Same role and tool_call_id, so the call/reply pairing is preserved.
                let mut r = m.clone();
                r["content"] = Value::String(replacement);
                return r;
            }
            if m["role"] == "assistant" && !calls(m).is_empty() {
                let mut touched = false;
                let mut r = m.clone();
                for (k, call) in calls(m).iter().enumerate() {
                    let args = call_str(call, "arguments");
                    if js_len(args) <= MAX_VERBATIM_ARGS_CHARS || retained.writes.contains(call["id"].as_str().unwrap_or("")) {
                        continue;
                    }
                    let stub = stub_arguments(args);
                    touched = true;
                    chars_saved += js_len(args) - js_len(&stub);
                    r["tool_calls"][k]["function"]["arguments"] = Value::String(stub);
                }
                return if touched { r } else { m.clone() };
            }
            m.clone()
        })
        .collect();
    (Cow::Owned(out), PruneStats { collapsed, chars_saved, tokens_saved: js_round(chars_saved as f64 / 3.6) as usize })
}

/// Every tool call has a reply and vice versa: the property a bad prune would break.
pub fn tool_calls_are_balanced(messages: &[Value]) -> bool {
    let mut called: HashSet<&str> = HashSet::new();
    let mut replied: HashSet<&str> = HashSet::new();
    for m in messages {
        if m["role"] == "assistant" {
            called.extend(calls(m).iter().map(|c| c["id"].as_str().unwrap_or("")));
        } else if m["role"] == "tool" {
            replied.insert(m["tool_call_id"].as_str().unwrap_or(""));
        }
    }
    called == replied
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::testkit::{check, expand};
    use serde_json::json;

    fn options(o: &Value) -> Options {
        let d = Options::default();
        let n = |k: &str, d: usize| o[k].as_u64().map_or(d, |x| x as usize);
        Options { keep_verbatim: n("keepVerbatim", d.keep_verbatim), min_chars: n("minChars", d.min_chars), threshold_chars: n("thresholdChars", d.threshold_chars), file_read_budget: n("fileReadBudget", d.file_read_budget), batch: d.batch }
    }

    #[test]
    fn replays_the_web_functions() {
        check("prune.all", |input| {
            let messages = input["messages"].as_array().unwrap();
            let (pruned, stats) = prune_transcript(messages, &options(&input["options"]));
            let r = retained_file_content(messages, input["budget"].as_u64().unwrap() as usize);
            let mut writes: Vec<&String> = r.writes.iter().collect();
            writes.sort();
            let changed: Vec<Value> = pruned.iter().enumerate().filter(|(i, m)| **m != messages[*i]).map(|(i, m)| json!([i, m])).collect();
            json!({
                "chars": transcript_chars(messages), "balanced": tool_calls_are_balanced(messages), "balancedAfter": tool_calls_are_balanced(&pruned),
                "reads": r.reads, "writes": writes, "stats": { "collapsed": stats.collapsed, "charsSaved": stats.chars_saved, "tokensSaved": stats.tokens_saved },
                "n": pruned.len(), "changed": changed,
            })
        });
    }

    #[test]
    fn small_transcripts_come_back_untouched() {
        let m = vec![json!({"role": "user", "content": "hi"}), json!({"role": "tool", "tool_call_id": "x", "content": "y".repeat(5000)})];
        let (out, stats) = prune_transcript(&m, &Options::default());
        assert!(matches!(out, Cow::Borrowed(_)) && stats == PruneStats::default());
    }

    /// `n` rounds of one command each, every answer big enough to collapse.
    fn rounds(n: usize) -> Vec<Value> {
        (0..n).flat_map(|i| [json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": format!("c{i}"), "type": "function", "function": { "name": "run_command", "arguments": "{}" } }] }), json!({ "role": "tool", "tool_call_id": format!("c{i}"), "content": format!("{i}{}", "y".repeat(4_000)) })]).collect()
    }

    #[test]
    fn old_results_collapse_a_batch_at_a_time() {
        let o = Options { batch: COLLAPSE_BATCH, ..Options::default() };
        let collapsed = |n: usize| prune_transcript(&rounds(n), &o).1.collapsed;
        // Nothing changes until a whole batch is old, so the request starts the same for the rounds between and stays cached.
        assert_eq!([8, 15, 16, 23, 24].map(collapsed), [0, 0, 8, 8, 16]);
        // One at a time, as the web does, when no batch is asked for.
        assert_eq!(prune_transcript(&rounds(15), &Options::default()).1.collapsed, 7);
    }

    #[test]
    fn a_line_standing_in_for_a_read_does_not_retire_the_read() {
        let read = |id: &str| json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": id, "type": "function", "function": { "name": "read_file", "arguments": "{\"path\":\"a.cpp\"}" } }] });
        let mut m = vec![read("r1"), json!({ "role": "tool", "tool_call_id": "r1", "content": "z".repeat(9_000) }), read("r2"), json!({ "role": "tool", "tool_call_id": "r2", "content": "[Unchanged: read_file(a.cpp) gave this same output earlier.]" })];
        m.extend(rounds(9));
        let (out, _) = prune_transcript(&m, &Options::default());
        assert_eq!(out[1], m[1], "the copy the line points at is still the newest read of the file");
    }

    #[test]
    fn placeholder_names_files_and_verdicts() {
        let body = expand(&json!({"$cat": ["  first line  \n\n", "see lib/util.lua, main.cpp and weird.tsxx\n", "VERDICT: no\n- [x] done\nwe found it\n", {"$rep": ["pad\n", 500]}]}));
        let p = placeholder("read_file", body.as_str().unwrap());
        assert!(p.starts_with("[earlier read_file result collapsed to save context — 507 lines /"), "{p}");
        assert!(p.contains("starts: first line | see lib/util.lua, main.cpp and weird.tsxx | VERDICT: no; files: lib/util.lua, main.cpp; note: - [x] done"), "{p}");
    }

    #[test]
    fn stubs_are_valid_json_and_never_split_a_character() {
        let args = format!("{{\"x\":\"{}😀😀{}\"}}", "a".repeat(393), "b".repeat(3000));
        let stub: Value = serde_json::from_str(&stub_arguments(&args)).unwrap();
        assert_eq!(stub["_trimmed"], true);
        assert_eq!(js_len(stub["_head"].as_str().unwrap()), 399);
    }
}

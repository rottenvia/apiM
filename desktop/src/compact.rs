//! Keeping a long run inside the model's window, and saying where a request's
//! characters went. Ports of src/lib/compact.ts and src/lib/request-size.ts.

use crate::store::Bucket;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

/// Rounds left untouched at the end: where "what was I in the middle of" lives.
const KEEP_RECENT_ROUNDS: usize = 4;
/// How far the fold boundary jumps at a time, so the cached prefix holds still between jumps.
const STEP: usize = 4;
/// Share of the window a run may fill before finished rounds fold: 650k tokens of a 1M window.
const FILL_PERCENT: u64 = 65;
const CHARS_PER_TOKEN: f64 = 3.6;
/// Results at or below this size are never folded to a pointer: the pointer would cost more.
const DEDUP_MIN_CHARS: usize = 200;

/// Tokens at which finished rounds start folding into summaries.
pub fn compact_at(window: u64) -> u64 {
    window * FILL_PERCENT / 100
}

fn threshold_chars(window: u64) -> usize {
    (compact_at(window) as f64 * CHARS_PER_TOKEN) as usize
}

fn len(v: &Value) -> usize {
    v.as_str().map_or(0, str::len)
}

fn calls(m: &Value) -> &[Value] {
    m["tool_calls"].as_array().map_or(&[], Vec::as_slice)
}

pub fn size_of(messages: &[Value]) -> usize {
    messages.iter().map(|m| len(&m["content"]) + len(&m["reasoning_content"]) + calls(m).iter().map(|c| len(&c["function"]["arguments"]) + len(&c["function"]["name"])).sum::<usize>()).sum()
}

/// A short, factual line for one tool call and how it turned out.
fn describe(name: &str, args: &str, result: Option<&str>) -> String {
    let parsed: Value = serde_json::from_str(args).unwrap_or_default();
    let target = ["path", "paths", "query", "command"].iter().map(|k| &parsed[*k]).find(|v| !v.is_null()).map_or(String::new(), |v| match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().take(3).filter_map(Value::as_str).collect::<Vec<_>>().join(", "),
        _ => String::new(),
    });
    // The first line of a result is nearly always the outcome.
    let first = result.unwrap_or("").lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let outcome = if first.starts_with("Error") { format!(" — failed: {}", first.chars().take(80).collect::<String>()) } else { String::new() };
    if target.is_empty() { format!("{name}{outcome}") } else { format!("{name}({target}){outcome}") }
}

/// Same call, byte-identical output: older copies become a pointer at the newest one.
fn dedupe(messages: &mut [Value]) -> usize {
    let mut call_by_id: HashMap<String, (String, String)> = HashMap::new();
    for m in messages.iter() {
        for c in calls(m) {
            call_by_id.insert(c["id"].as_str().unwrap_or("").to_string(), (c["function"]["name"].as_str().unwrap_or("").to_string(), c["function"]["arguments"].as_str().unwrap_or("").to_string()));
        }
    }
    // Newest first, so the first copy seen is the one that stays.
    let mut seen: HashSet<(String, String, String)> = HashSet::new();
    let mut saved = 0;
    for m in messages.iter_mut().rev() {
        if m["role"] != "tool" || len(&m["content"]) <= DEDUP_MIN_CHARS {
            continue;
        }
        let Some((name, args)) = call_by_id.get(m["tool_call_id"].as_str().unwrap_or("")) else { continue };
        // Parsed and printed again, so key order and spacing do not make two equal calls differ.
        let canon = serde_json::from_str::<Value>(args).map_or_else(|_| args.clone(), |v| v.to_string());
        let content = m["content"].as_str().unwrap_or("").to_string();
        let before = content.len();
        if !seen.insert((name.clone(), canon, content)) {
            let pointer = format!("[Folded: identical {} result — same call, byte-identical output. The latest copy is below; use it instead of re-fetching.]", describe(name, args, None));
            saved += before.saturating_sub(pointer.len());
            m["content"] = json!(pointer);
        }
    }
    saved
}

/// Results below this size go back as they are: a pointer would save little and read worse.
const REPEAT_MIN_CHARS: usize = 1_500;

/// A call asked again whose answer is already in the transcript, whole and byte for byte: the line that goes
/// back in place of the same text. The earlier copy stays where it is, so the start of the request (and the
/// provider's cache of it) does not move, and a model that asks for one big file every round stops paying for it.
pub fn repeat_of(messages: &[Value], name: &str, args: &str, text: &str) -> Option<String> {
    if text.len() < REPEAT_MIN_CHARS {
        return None;
    }
    // Parsed and printed again, so key order and spacing do not make two equal calls differ.
    let canon = |args: &str| serde_json::from_str::<Value>(args).map_or_else(|_| args.to_string(), |v| v.to_string());
    let wanted = canon(args);
    let same: HashSet<&str> = messages.iter().flat_map(calls).filter(|c| c["function"]["name"] == name && canon(c["function"]["arguments"].as_str().unwrap_or("")) == wanted).filter_map(|c| c["id"].as_str()).collect();
    // A guard's note may follow the earlier copy, so it only has to start with this text.
    let held = messages.iter().any(|m| m["role"] == "tool" && same.contains(m["tool_call_id"].as_str().unwrap_or("")) && m["content"].as_str().is_some_and(|c| c.starts_with(text)));
    // How to read on is the one line of a cut-short read worth saying twice.
    let more = text.lines().last().filter(|l| l.starts_with("[CUT SHORT")).map_or(String::new(), |l| format!("\n{l}"));
    held.then(|| format!("[Unchanged: {} gave this same output earlier in this conversation ({} chars, not one byte different). It is still above: work from that copy. While it is there, asking again returns this line and not the text.]{more}", describe(name, args, None), text.len()))
}

pub struct Folded {
    /// Agent rounds replaced by a summary.
    pub rounds: usize,
    pub tokens_saved: u64,
}

/// Folds every finished round except the newest into a plain line of what it did,
/// once the transcript passes the model's limit. A round loses its reasoning only
/// by losing its tool calls too: providers require the two together.
// ponytail: a folded file read keeps one line, not its text (the web app keeps
// unchanged files verbatim, prune.ts). Port that if runs re-read after a fold.
pub fn fold(messages: &mut Vec<Value>, window: u64) -> Folded {
    fold_at(messages, threshold_chars(window))
}

fn fold_at(messages: &mut Vec<Value>, threshold: usize) -> Folded {
    let mut saved = dedupe(messages);
    let before = size_of(messages);
    let rounds: Vec<usize> = (0..messages.len()).filter(|&i| messages[i]["role"] == "assistant" && !calls(&messages[i]).is_empty()).collect();
    let boundary = rounds.len().saturating_sub(KEEP_RECENT_ROUNDS) / STEP * STEP;
    if before < threshold || boundary == 0 {
        return Folded { rounds: 0, tokens_saved: (saved as f64 / CHARS_PER_TOKEN) as u64 };
    }
    let cutoff: HashSet<usize> = rounds[..boundary].iter().copied().collect();
    let results: HashMap<String, String> = messages.iter().filter(|m| m["role"] == "tool").map(|m| (m["tool_call_id"].as_str().unwrap_or("").to_string(), m["content"].as_str().unwrap_or("").to_string())).collect();

    let mut removed: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(messages.len());
    for (i, m) in std::mem::take(messages).into_iter().enumerate() {
        if m["role"] == "tool" {
            if !removed.contains(m["tool_call_id"].as_str().unwrap_or("")) {
                out.push(m);
            }
            continue;
        }
        if !cutoff.contains(&i) {
            out.push(m);
            continue;
        }
        let lines: Vec<String> = calls(&m)
            .iter()
            .map(|c| {
                let id = c["id"].as_str().unwrap_or("");
                removed.insert(id.to_string());
                format!("- {}", describe(c["function"]["name"].as_str().unwrap_or(""), c["function"]["arguments"].as_str().unwrap_or(""), results.get(id).map(String::as_str)))
            })
            .collect();
        let said = m["content"].as_str().unwrap_or("").trim();
        let narration = if said.is_empty() { String::new() } else { format!("{said}\n") };
        // No tool_calls, so no reasoning either: with the calls gone the API no longer wants it.
        out.push(json!({ "role": "assistant", "content": format!("{narration}[Earlier step, summarised to save context:\n{}]", lines.join("\n")) }));
    }
    saved += before.saturating_sub(size_of(&out));
    *messages = out;
    Folded { rounds: boundary, tokens_saved: (saved as f64 / CHARS_PER_TOKEN) as u64 }
}

/// Where a request's characters went, largest first: the context meter's bar.
pub fn breakdown(messages: &[Value], tools_chars: usize) -> Vec<Bucket> {
    let mut parts: HashMap<&'static str, u64> = HashMap::new();
    let mut add = |label: &'static str, chars: usize| {
        if chars > 0 {
            *parts.entry(label).or_default() += chars as u64;
        }
    };
    add("tool schemas", tools_chars);
    let last_user = messages.iter().rposition(|m| m["role"] == "user");
    for (i, m) in messages.iter().enumerate() {
        match m["role"].as_str().unwrap_or("") {
            "system" => {
                let text = m["content"].as_str().unwrap_or("");
                let label = if text.contains(crate::plugins::PROMPTS.plugin_marker.as_str()) {
                    "plugins"
                } else if ["Files already in the workspace", "The workspace is currently empty", "Current workspace contents", "Workspace changes since"].iter().any(|start| text.starts_with(start)) {
                    "file tree"
                } else if text.starts_with("PLAN. Goal:") {
                    "plan"
                } else if text.starts_with(crate::summary::MARKER) {
                    "summary"
                } else {
                    "instructions"
                };
                add(label, text.len());
            }
            "user" => {
                let bucket = if Some(i) == last_user { "your message" } else { "history" };
                match &m["content"] {
                    Value::String(text) => add(bucket, text.len()),
                    Value::Array(items) => {
                        for part in items {
                            add(bucket, len(&part["text"]));
                            add("media", len(&part["image_url"]["url"]) + len(&part["video_url"]["url"]));
                        }
                    }
                    _ => {}
                }
            }
            "assistant" => {
                add("history", len(&m["content"]));
                add("reasoning", len(&m["reasoning_content"]));
                add("tool calls", calls(m).iter().map(|c| len(&c["function"]["arguments"]) + len(&c["function"]["name"])).sum());
            }
            "tool" => add("tool results", len(&m["content"])),
            _ => {}
        }
    }
    let mut out: Vec<Bucket> = parts.into_iter().map(|(label, chars)| Bucket { label: label.to_string(), chars }).collect();
    out.sort_by(|a, b| b.chars.cmp(&a.chars).then(a.label.cmp(&b.label)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round(n: usize, reasoning: &str) -> [Value; 2] {
        let id = format!("c{n}");
        [
            json!({ "role": "assistant", "content": "", "reasoning_content": reasoning, "tool_calls": [{ "id": id, "type": "function", "function": { "name": "read_file", "arguments": format!("{{\"path\":\"f{n}.rs\"}}") } }] }),
            json!({ "role": "tool", "tool_call_id": id, "content": format!("contents of file {n}") }),
        ]
    }

    #[test]
    fn a_million_token_window_folds_at_650k() {
        assert_eq!(compact_at(1_000_000), 650_000);
        assert_eq!(threshold_chars(1_000_000), 2_340_000);
    }

    #[test]
    fn folds_old_rounds_whole_and_keeps_the_newest() {
        let thought = "t".repeat(1_000);
        let mut messages = vec![json!({ "role": "system", "content": "s" }), json!({ "role": "user", "content": "go" })];
        (0..9).for_each(|n| messages.extend(round(n, &thought)));
        let mut small = messages.clone();
        assert_eq!(fold_at(&mut small, 1_000_000).rounds, 0);
        assert_eq!(small, messages);

        // Nine rounds, four kept: five could fold, the boundary moves in fours.
        let folded = fold_at(&mut messages, 5_000);
        assert_eq!(folded.rounds, 4);
        assert!(folded.tokens_saved > 1_000);
        assert!(messages[2]["content"].as_str().unwrap().contains("- read_file(f0.rs)"));
        assert!(messages[2]["tool_calls"].is_null() && messages[2]["reasoning_content"].is_null());
        // Every tool reply left still has its call, or the provider rejects the request.
        let ids: HashSet<&str> = messages.iter().flat_map(|m| calls(m)).filter_map(|c| c["id"].as_str()).collect();
        assert!(messages.iter().filter(|m| m["role"] == "tool").all(|m| ids.contains(m["tool_call_id"].as_str().unwrap())));
        assert_eq!(ids.len(), 5);
    }

    #[test]
    fn identical_results_fold_to_a_pointer() {
        let body = "x".repeat(500);
        let call = |id: &str| json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": id, "type": "function", "function": { "name": "read_file", "arguments": "{\"path\":\"a\"}" } }] });
        let reply = |id: &str| json!({ "role": "tool", "tool_call_id": id, "content": body });
        let mut messages = vec![call("1"), reply("1"), call("2"), reply("2")];
        assert!(fold_at(&mut messages, usize::MAX).tokens_saved > 0);
        assert!(messages[1]["content"].as_str().unwrap().starts_with("[Folded: identical read_file(a)"));
        assert_eq!(messages[3]["content"].as_str().unwrap().len(), 500);
    }

    #[test]
    fn a_call_asked_again_gets_a_pointer_while_its_answer_is_still_there() {
        let body = format!("a.cpp: lines 1-90 of 120\n{}\n[CUT SHORT: you have lines 1-90 of 120. Continue with read_file {{\"path\":\"a.cpp\",\"start_line\":91}}]", "x".repeat(2_000));
        let call = |id: &str, args: &str| json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": id, "type": "function", "function": { "name": "read_file", "arguments": args } }] });
        // The earlier answer carries a guard's note after it; the call being answered is already in the transcript, unanswered.
        let mut messages = vec![call("1", "{\"path\":\"a.cpp\",\"end_line\":120}"), json!({ "role": "tool", "tool_call_id": "1", "content": format!("{body}\n[note]") }), call("2", "{}")];
        let pointer = repeat_of(&messages, "read_file", "{ \"end_line\": 120, \"path\": \"a.cpp\" }", &body).unwrap();
        assert!(pointer.starts_with("[Unchanged: read_file(a.cpp) gave this same output") && pointer.ends_with("\"start_line\":91}]"), "{pointer}");
        assert!(pointer.len() < 500);
        // Another range, another file's bytes, or a short answer: the text goes back.
        assert_eq!(repeat_of(&messages, "read_file", "{\"path\":\"a.cpp\",\"start_line\":91}", &body), None);
        assert_eq!(repeat_of(&messages, "read_file", "{\"path\":\"a.cpp\",\"end_line\":120}", &body.replace('x', "y")), None);
        assert_eq!(repeat_of(&messages, "read_file", "{\"path\":\"a.cpp\",\"end_line\":120}", "short"), None);
        // Once the earlier copy has been collapsed, the file is read out again.
        messages[1]["content"] = json!("[earlier read_file result collapsed to save context]");
        assert_eq!(repeat_of(&messages, "read_file", "{\"path\":\"a.cpp\",\"end_line\":120}", &body), None);
    }

    #[test]
    fn breakdown_labels() {
        let messages = vec![
            json!({ "role": "system", "content": "rules" }),
            json!({ "role": "user", "content": "old question" }),
            json!({ "role": "assistant", "content": "old answer", "reasoning_content": "hm" }),
            json!({ "role": "user", "content": [{ "type": "text", "text": "new" }, { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } }] }),
        ];
        let parts = breakdown(&messages, 100);
        let get = |label: &str| parts.iter().find(|b| b.label == label).map_or(0, |b| b.chars);
        assert_eq!((get("tool schemas"), get("instructions"), get("history"), get("your message"), get("reasoning"), get("media")), (100, 5, 22, 3, 2, 26));
        assert_eq!(parts[0].label, "tool schemas");
    }
}

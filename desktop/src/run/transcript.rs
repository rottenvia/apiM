//! The wire side of `src/lib/transcript.ts`: how the run's transcript is shaped
//! for each provider, and how a request the provider turned away is made smaller.

use super::{head, tail};
use regex::Regex;
use serde_json::{Value, json};
use std::sync::LazyLock;

/// Characters of a step's reasoning carried to hosts that take no reasoning back.
pub const CARRIED_THOUGHT_CHARS: usize = 1_600;

/// Escapes raw control characters inside string literals only: between tokens they are legal whitespace.
/// Unbalanced quotes decline the repair.
fn escape_controls_in_strings(text: &str) -> String {
    let (mut in_string, mut escaped, mut changed) = (false, false, false);
    let mut out = String::with_capacity(text.len() + 8);
    for ch in text.chars() {
        if !in_string {
            in_string = ch == '"';
            out.push(ch);
        } else if escaped {
            escaped = false;
            out.push(ch);
        } else if ch == '\\' || ch == '"' {
            (escaped, in_string) = (ch == '\\', ch != '"');
            out.push(ch);
        } else if (ch as u32) < 0x20 {
            changed = true;
            match ch {
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                '\u{8}' => out.push_str("\\b"),
                '\u{c}' => out.push_str("\\f"),
                other => out.push_str(&format!("\\u{:04x}", other as u32)),
            }
        } else {
            out.push(ch);
        }
    }
    if in_string || escaped || !changed { text.to_string() } else { out }
}

/// Makes a tool call's `arguments` survive strict validation. One raw control character in one historic call
/// makes a gateway reject the whole request, on every retry. A JSON object goes out verbatim; otherwise control
/// characters inside strings are escaped; blank becomes `{}`; other JSON is wrapped; the rest becomes a marker naming the loss.
pub fn harden_args(args: &str) -> String {
    if args.trim().is_empty() {
        return "{}".into();
    }
    let escaped = escape_controls_in_strings(args);
    for candidate in [args, escaped.as_str()] {
        match serde_json::from_str::<Value>(candidate) {
            Ok(Value::Object(_)) => return candidate.to_string(),
            Ok(other) => return format!(r#"{{"_value":{other}}}"#),
            Err(_) => {}
        }
    }
    format!(r#"{{"_unparseable":true,"_note":"original arguments were not valid JSON; replaced to satisfy API validation","_raw":{}}}"#, Value::String(head(args, 500).to_string()))
}

/// The end of a step's reasoning, where the decision is, cut on a sentence or line boundary.
pub fn carried_thought(reasoning: &str) -> String {
    // JS looks behind for the sentence end; this engine cannot, so the mark is matched and stepped over.
    static BREAK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[.!?\n]\s+\S").unwrap());
    let text = reasoning.trim();
    let mut end = text.to_string();
    if text.chars().count() > CARRIED_THOUGHT_CHARS {
        let mut cut = tail(text, CARRIED_THOUGHT_CHARS);
        if let Some(at) = BREAK.find(cut).map(|m| m.start() + 1).filter(|at| cut[..*at].chars().count() < 400) {
            cut = cut[at..].trim_start();
        }
        end = format!("…{cut}");
    }
    format!("[My reasoning at this step, condensed — what I concluded and decided:]\n{end}")
}

fn with_carried(reasoning: &str, content: &Value) -> Value {
    let carried = carried_thought(reasoning);
    json!(match content.as_str().filter(|c| !c.trim().is_empty()) {
        Some(content) => format!("{carried}\n\n{content}"),
        None => carried,
    })
}

/// The transcript as one provider takes it. Reasoning rides back only on turns that called a tool, in
/// `reasoning_field` (DeepSeek's `reasoning_content`, OpenRouter's `reasoning`). With no field, the end of the
/// reasoning rides as the turn's own words instead, or the model re-derives the whole task every round.
pub fn wire(messages: &[Value], reasoning_field: Option<&str>) -> Vec<Value> {
    messages
        .iter()
        .map(|m| match m["role"].as_str() {
            Some("tool") => json!({ "role": "tool", "tool_call_id": m["tool_call_id"], "content": m["content"] }),
            Some("assistant") => {
                let Some(calls) = m["tool_calls"].as_array().filter(|calls| !calls.is_empty()) else {
                    return json!({ "role": "assistant", "content": m["content"].as_str().unwrap_or("") });
                };
                let calls: Vec<Value> = calls.iter().map(|c| json!({ "id": c["id"], "type": "function", "function": { "name": c["function"]["name"], "arguments": harden_args(c["function"]["arguments"].as_str().unwrap_or("")) } })).collect();
                let mut out = json!({ "role": "assistant", "content": m["content"], "tool_calls": calls });
                let reasoning = m["reasoning_content"].as_str().unwrap_or("");
                match reasoning_field {
                    Some(field) if !reasoning.is_empty() => out[field] = json!(reasoning),
                    None if !reasoning.trim().is_empty() => out["content"] = with_carried(reasoning, &m["content"]),
                    _ => {}
                }
                out
            }
            _ => m.clone(),
        })
        .collect()
}

/// Swaps replayed `reasoning` fields for their condensed form, for an endpoint that rejected them. False when there were none.
pub fn condense_reasoning(messages: &mut [Value]) -> bool {
    let mut any = false;
    for m in messages.iter_mut() {
        let Some(reasoning) = m.get("reasoning").and_then(Value::as_str).map(str::to_string) else { continue };
        m["content"] = with_carried(&reasoning, &m["content"]);
        if let Some(turn) = m.as_object_mut() {
            turn.remove("reasoning");
        }
        any = true;
    }
    any
}

/// Drops the oldest plain turns until the request fits `target_chars`, leaving one line saying so. The newest
/// user turn and everything after it stay, and a tool-calling turn is never split from its results. Returns the
/// messages and how many turns went.
pub fn fold_oldest_history(messages: &[Value], target_chars: usize) -> (Vec<Value>, usize) {
    // ponytail: sizes are bytes of the compact JSON where the web counts UTF-16 units; they part only on non-Latin text, and this is a budget, not a limit.
    let sizes: Vec<usize> = messages.iter().map(|m| m.to_string().len()).collect();
    let mut remaining: usize = sizes.iter().sum();
    let last_user = messages.iter().rposition(|m| m["role"] == "user").unwrap_or(0);
    let mut drop = vec![false; messages.len()];
    for i in 0..last_user {
        if remaining <= target_chars {
            break;
        }
        let plain = match messages[i]["role"].as_str() {
            Some("user") => true,
            Some("assistant") => messages[i]["tool_calls"].as_array().is_none_or(|calls| calls.is_empty()),
            _ => false,
        };
        if plain {
            drop[i] = true;
            remaining -= sizes[i];
        }
    }
    let dropped = drop.iter().filter(|d| **d).count();
    if dropped == 0 {
        return (messages.to_vec(), 0);
    }
    let marker = format!("[{dropped} older history turn{} omitted from this retry to fit the provider's request limit — the newest turns are kept in full. If something you need was in them, ask and it will be re-sent.]", if dropped == 1 { "" } else { "s" });
    let mut out = Vec::with_capacity(messages.len());
    for (i, m) in messages.iter().enumerate() {
        if !drop[i] {
            out.push(m.clone());
        } else if i == drop.iter().position(|d| *d).unwrap_or(0) {
            out.push(json!({ "role": "system", "content": marker }));
        }
    }
    (out, dropped)
}

/// Replaces attached images and videos with a line saying they were left out. True when any were.
pub fn strip_media(messages: &mut [Value]) -> bool {
    let mut stripped = false;
    for m in messages.iter_mut().filter(|m| m["role"] == "user") {
        for part in m.get_mut("content").and_then(Value::as_array_mut).into_iter().flatten() {
            let kind = match part["type"].as_str() {
                Some("image_url") => "image",
                Some("video_url") => "video",
                _ => continue,
            };
            *part = json!({ "type": "text", "text": format!("[attached {kind} omitted from this retry — the provider rejected the media payload; answer from the conversation text]") });
            stripped = true;
        }
    }
    stripped
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::cases;

    #[test]
    fn repairs_match_the_web() {
        for (i, o) in cases("harden_args") {
            assert_eq!(harden_args(i.as_str().unwrap()), o.as_str().unwrap(), "{i}");
        }
        for (i, o) in cases("carried_thought") {
            assert_eq!(carried_thought(i.as_str().unwrap()), o.as_str().unwrap());
        }
    }

    #[test]
    fn wire_shapes_match_the_web() {
        let turns = json!([
            { "role": "system", "content": "rules" },
            { "role": "user", "content": "q" },
            { "role": "assistant", "content": null, "reasoning_content": "Thinking hard. So I will read it.", "tool_calls": [{ "id": "c1", "function": { "name": "read_file", "arguments": "{\"path\":\"a\nb\"}" } }] },
            { "role": "tool", "tool_call_id": "c1", "content": "body" },
            { "role": "assistant", "content": "Narration.", "reasoning_content": "why", "tool_calls": [{ "id": "c2", "function": { "name": "list_files", "arguments": "" } }] },
            { "role": "tool", "tool_call_id": "c2", "content": "list" },
            { "role": "assistant", "content": "final", "reasoning_content": "not replayed" },
            { "role": "assistant", "content": null, "reasoning_content": "[thinking produced no output — 90 chars trimmed]" },
            { "role": "user", "content": [{ "type": "text", "text": "see" }] },
        ]);
        for (i, o) in cases("serialize_for_api") {
            assert_eq!(json!(wire(turns.as_array().unwrap(), i.as_str())), o, "{i}");
        }
        // An endpoint that rejects the replayed field gets the same condensed form the web re-serialises to.
        let mut replayed = wire(turns.as_array().unwrap(), Some("reasoning"));
        assert!(condense_reasoning(&mut replayed));
        assert_eq!(json!(replayed), json!(wire(turns.as_array().unwrap(), None)));
        assert!(!condense_reasoning(&mut replayed));
    }

    #[test]
    fn folds_and_strips_like_the_web() {
        for (i, o) in cases("fold_oldest_history") {
            let (messages, dropped) = fold_oldest_history(i[0].as_array().unwrap(), i[1].as_u64().unwrap() as usize);
            assert_eq!((json!(messages), json!(dropped)), (o["messages"].clone(), o["dropped"].clone()), "target {}", i[1]);
        }
        let mut messages = vec![json!({ "role": "user", "content": [{ "type": "text", "text": "look" }, { "type": "image_url", "image_url": { "url": "data:x" } }] }), json!({ "role": "user", "content": "plain" })];
        assert!(strip_media(&mut messages));
        assert_eq!(messages[0]["content"][1]["text"], "[attached image omitted from this retry — the provider rejected the media payload; answer from the conversation text]");
        assert!(!strip_media(&mut messages));
    }
}

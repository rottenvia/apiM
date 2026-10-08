//! Port of `src/lib/local-context.ts`: fits an agent transcript into the in-app Qwen window. Only the copy on the wire
//! is reduced. The stored transcript is never touched.
//! ponytail: the web also runs pruneTranscript and compactTranscript before this step. agent.rs already does that for
//! Qwen (prune_transcript with QWEN_PRUNE, then compact::fold, agent.rs:730-741), so this covers the drop, clip and
//! balance steps only. The web's foldSystemMessagesToFront is left to the caller (chat/route.ts:2778).
//! ponytail: tool_calls_balanced is rewritten from how this file uses it, not from lib/prune.ts (not read).

use super::shared::{LOCAL_TOOL_RESERVE, SIDECAR_CTX, SIDECAR_MAX_OUTPUT};
use serde_json::{Value, json};
use std::collections::HashSet;

/// Conservative token estimate: 3 characters per token, counted in UTF-16 units like the web does.
pub fn estimate_tokens(messages: &[Value]) -> usize {
    let u16len = |s: &str| s.encode_utf16().count();
    let mut chars = 0usize;
    for m in messages {
        match &m["content"] {
            Value::String(s) => chars += u16len(s),
            Value::Array(parts) => {
                for p in parts {
                    match p["type"].as_str() {
                        Some("text") => chars += p["text"].as_str().map_or(0, u16len),
                        Some("image_url") => chars += 4_500,
                        Some("video_url") => chars += 24_000,
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        if m["role"] == "assistant" {
            chars += m["reasoning_content"].as_str().map_or(0, u16len);
            for call in m["tool_calls"].as_array().into_iter().flatten() {
                chars += call["function"]["arguments"].as_str().map_or(0, u16len) + call["function"]["name"].as_str().map_or(0, u16len) + 24;
            }
        }
    }
    chars.div_ceil(3)
}

/// Tokens left for messages after the output ceiling and the tool schemas (or a small fixed reserve without tools).
pub fn local_message_budget(has_tools: bool) -> usize {
    (SIDECAR_CTX - SIDECAR_MAX_OUTPUT - if has_tools { LOCAL_TOOL_RESERVE } else { 256 } - 256) as usize
}

/// Drop the oldest round that is not the leading system prompt or the last user turn. Tool calls leave with their
/// replies, so the request stays valid. None when nothing is left to drop.
fn drop_oldest_expendable(messages: &[Value]) -> Option<Vec<Value>> {
    let last_user = messages.iter().rposition(|m| m["role"] == "user")?;
    for i in 0..last_user {
        let m = &messages[i];
        let role = m["role"].as_str().unwrap_or("");
        if role == "system" && i == 0 {
            continue;
        }
        let calls = m["tool_calls"].as_array().filter(|c| !c.is_empty());
        if role == "assistant" && calls.is_some() {
            let ids: HashSet<&str> = calls.into_iter().flatten().filter_map(|c| c["id"].as_str()).collect();
            return Some(
                messages
                    .iter()
                    .enumerate()
                    .filter(|(idx, x)| *idx != i && !(x["role"] == "tool" && x["tool_call_id"].as_str().is_some_and(|id| ids.contains(id))))
                    .map(|(_, x)| x.clone())
                    .collect(),
            );
        }
        if matches!(role, "assistant" | "system" | "user" | "tool") {
            return Some(messages.iter().enumerate().filter(|(idx, _)| *idx != i).map(|(_, x)| x.clone()).collect());
        }
    }
    None
}

/// Replace a long leading system prompt with its first `keep_chars` characters and a clip marker.
fn clip_leading_system(messages: Vec<Value>, keep_chars: usize) -> Vec<Value> {
    let Some(first) = messages.first() else { return messages };
    if first["role"] != "system" {
        return messages;
    }
    let Some(s) = first["content"].as_str() else { return messages };
    if s.encode_utf16().count() <= keep_chars {
        return messages;
    }
    // ponytail: counts characters, the web slices UTF-16 units; the two differ only after an astral character.
    let head: String = s.chars().take(keep_chars).collect();
    let mut out = messages;
    out[0] = json!({"role": "system", "content": format!("{head}\n\n[clipped to fit the local context window]")});
    out
}

/// Every tool call has its reply straight after it, and no reply is orphaned.
fn tool_calls_balanced(messages: &[Value]) -> bool {
    let mut pending: HashSet<String> = HashSet::new();
    for m in messages {
        let role = m["role"].as_str().unwrap_or("");
        let calls = m["tool_calls"].as_array().filter(|c| !c.is_empty());
        if role == "assistant" && calls.is_some() {
            if !pending.is_empty() {
                return false;
            }
            pending = calls.into_iter().flatten().filter_map(|c| c["id"].as_str().map(String::from)).collect();
        } else if role == "tool" {
            if !pending.remove(m["tool_call_id"].as_str().unwrap_or("")) {
                return false;
            }
        } else if !pending.is_empty() {
            return false;
        }
    }
    pending.is_empty()
}

#[derive(Debug, PartialEq)]
pub struct Fit {
    pub messages: Vec<Value>,
    pub trimmed: bool,
    pub tokens: usize,
}

/// Drop old rounds, then clip the system prompt, until the wire copy fits `budget` tokens. Falls back to the input
/// when the result would leave a tool call without its reply. The input is never mutated.
pub fn fit_for_local_context(messages: Vec<Value>, budget: usize) -> Fit {
    let mut out = messages.clone();
    let mut trimmed = false;
    let mut guard = 0;
    while estimate_tokens(&out) > budget && guard < 80 {
        guard += 1;
        match drop_oldest_expendable(&out) {
            Some(next) if next.len() < out.len() => {
                out = next;
                trimmed = true;
            }
            _ => break,
        }
    }
    if estimate_tokens(&out) > budget && out.first().is_some_and(|m| m["role"] == "system") {
        let other = estimate_tokens(&out[1..]) as i64;
        let keep = (((budget as i64) - other - 64) * 3).max(4_000) as usize;
        let clipped = clip_leading_system(out.clone(), keep);
        if clipped != out {
            out = clipped;
            trimmed = true;
        }
    }
    if !tool_calls_balanced(&out) {
        return Fit { tokens: estimate_tokens(&messages), messages, trimmed };
    }
    Fit { tokens: estimate_tokens(&out), messages: out, trimmed }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::shared::tests::fx;

    #[test]
    fn estimate_budget_and_fit_match_web() {
        for (i, o) in fx("estimateMessageTokens") {
            let msgs = i.as_array().unwrap().clone();
            assert_eq!(estimate_tokens(&msgs) as u64, o.as_u64().unwrap());
        }
        for (i, o) in fx("localMessageBudget") {
            assert_eq!(local_message_budget(i.as_bool().unwrap()) as u64, o.as_u64().unwrap());
        }
        for (i, o) in fx("fitForLocalContext") {
            let msgs = i[0].as_array().unwrap().clone();
            let fit = fit_for_local_context(msgs, i[1].as_u64().unwrap() as usize);
            assert_eq!(Value::Array(fit.messages), o["messages"], "fitForLocalContext {}", i[1]);
            assert_eq!(fit.tokens as u64, o["tokens"].as_u64().unwrap());
        }
    }

    #[test]
    fn drops_rounds_but_keeps_tool_pairs_whole() {
        let msgs = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "old"}),
            json!({"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "f", "arguments": "{}"}}]}),
            json!({"role": "tool", "tool_call_id": "c1", "content": "r"}),
            json!({"role": "user", "content": "now"}),
        ];
        let d1 = drop_oldest_expendable(&msgs).unwrap();
        assert_eq!(d1.len(), 4, "the oldest user turn goes first");
        let d2 = drop_oldest_expendable(&d1).unwrap();
        assert_eq!(d2.len(), 2, "the tool call and its reply leave together");
        assert!(tool_calls_balanced(&d2));
        assert!(!tool_calls_balanced(&[json!({"role": "tool", "tool_call_id": "x", "content": ""})]));
    }

    #[test]
    fn clips_a_huge_system_prompt_with_the_marker() {
        let msgs = vec![json!({"role": "system", "content": "S".repeat(9000)}), json!({"role": "user", "content": "hi"})];
        let out = clip_leading_system(msgs, 4000);
        let s = out[0]["content"].as_str().unwrap();
        assert!(s.ends_with("\n\n[clipped to fit the local context window]") && s.starts_with(&"S".repeat(4000)));
    }
}

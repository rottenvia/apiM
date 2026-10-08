//! Rebuilding enough of an interrupted reply to carry on with it, and deciding which reply "resume" means.
//! Ports of src/lib/rebuild-resume.ts and src/lib/resume-target.ts.
//! A stored reply keeps nearly everything that matters (the model's reasoning, its prose, the order of events, the
//! COMPLETE arguments of every tool call, each outcome's summary). The one real gap is what a *read* returned, and those
//! files are still on disk, so the transcript is rebuilt faithful about what happened and honest about what is missing,
//! with an explicit placeholder where a result was never saved. Input is the web's stored message JSON (a chat file's
//! message with `content`, `reasoningContent`, `toolEvents`, `timeline`), so replies from either app resume in either.

use super::{js_len, js_trim, js_truthy};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

/// Tools whose result is recoverable by running them again.
const RE_READABLE: [&str; 7] = ["read_file", "read_files", "list_files", "search_files", "inspect_binary", "read_symbol", "find_references"];

/// The web stores this on the assistant message of a reply that has not finished: the exact transcript sent upstream,
/// verbatim (reasoning and tool results included), so Resume replays it instead of rebuilding.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeState {
    /// Rounds already spent, so a resumed reply does not get a fresh budget.
    pub tool_rounds: u32,
    /// Continuations already used against the output ceiling.
    pub continuations: u32,
    /// Think-only nudges already used, so resume cannot think forever.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub think_nudges: Option<u32>,
    pub messages: Vec<Value>,
}

/// A placeholder for a result that was never saved. Deliberately explicit: a vague note would let the model assume it
/// still had the contents and describe a file it can no longer see.
fn missing_result(name: &str, summary: Option<&str>) -> String {
    let what = summary.filter(|s| !s.is_empty()).map_or(String::new(), |s| format!("{s}. "));
    // A helper changes nothing; saying its "action took effect" would let the model believe it still had the findings.
    if name == "delegate" {
        format!("[{what}The helper's report was not kept when the reply was interrupted. It changed nothing — delegate again if you still need it.]")
    } else if RE_READABLE.contains(&name) {
        format!("[{what}This ran successfully, but its output was not kept when the reply was interrupted. The workspace still has the files — call the tool again if you need what it returned.]")
    } else {
        format!("[{what}This ran successfully. Its output was not kept when the reply was interrupted, but the action itself took effect.]")
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Rebuilt {
    pub messages: Vec<Value>,
    /// Tool calls whose results had to be replaced with a placeholder.
    pub lost_results: usize,
    /// Tool calls whose effect is still visible (writes, edits, deletes).
    pub kept_actions: usize,
}

enum Entry {
    Text(String),
    Tool(String),
    Think,
}

/// Turns a stored, interrupted reply back into a usable transcript, or None when there is nothing to carry forward
/// (no partial answer, no actions: resuming would be indistinguishable from asking again).
/// `system` and the user's question are the caller's to supply: they are rebuilt from the live prompt.
pub fn rebuild_resume_from_stored(prior: &Value) -> Option<Rebuilt> {
    let events: &[Value] = prior["toolEvents"].as_array().map_or(&[], Vec::as_slice);
    let content = prior["content"].as_str();
    let has_text = content.is_some_and(|c| !js_trim(c).is_empty());
    if !has_text && events.is_empty() && prior["reasoningContent"].as_str().is_none_or(|r| js_trim(r).is_empty()) {
        return None;
    }
    // Replay in the order things happened; without a timeline it is "all tools, then all text".
    let by_id: HashMap<&str, &Value> = events.iter().map(|e| (e["id"].as_str().unwrap_or(""), e)).collect();
    let order: Vec<Entry> = match prior["timeline"].as_array().filter(|t| !t.is_empty()) {
        Some(t) => t
            .iter()
            .map(|e| match e["kind"].as_str() {
                Some("text") => Entry::Text(e["text"].as_str().unwrap_or("").to_string()),
                Some("tool") => Entry::Tool(e["id"].as_str().unwrap_or("").to_string()),
                _ => Entry::Think,
            })
            .collect(),
        None => events.iter().map(|e| Entry::Tool(e["id"].as_str().unwrap_or("").to_string())).chain(has_text.then(|| Entry::Text(content.unwrap_or("").to_string()))).collect(),
    };

    let mut messages: Vec<Value> = Vec::new();
    let (mut lost_results, mut kept_actions) = (0, 0);
    // The reasoning belongs to the first assistant turn, the one the model continues from; replayed verbatim, as the API requires once tool calls are present.
    let mut reasoning: Option<String> = prior["reasoningContent"].as_str().map(str::to_string);
    let mut pending_text = String::new();
    let flush = |calls: Vec<Value>, messages: &mut Vec<Value>, pending: &mut String, reasoning: &mut Option<String>| {
        let mut m = json!({ "role": "assistant", "content": if pending.is_empty() { Value::Null } else { json!(pending.clone()) }, "reasoning_content": reasoning.clone().map_or(Value::Null, Value::String) });
        if !calls.is_empty() {
            m["tool_calls"] = Value::Array(calls);
        }
        messages.push(m);
        pending.clear();
        *reasoning = None;
    };

    let mut i = 0;
    while i < order.len() {
        match &order[i] {
            Entry::Text(t) => {
                pending_text.push_str(t);
                i += 1;
            }
            // A reasoning range is display-only; it marks a new round, which the tool batch below stops at.
            Entry::Think => i += 1,
            Entry::Tool(_) => {
                // Consecutive tool entries were one round: one assistant turn with several calls.
                let mut batch: Vec<Value> = Vec::new();
                while let Some(Entry::Tool(id)) = order.get(i) {
                    i += 1;
                    if let Some(e) = by_id.get(id.as_str()) {
                        batch.push(json!({ "id": e["id"], "type": "function", "function": { "name": e["name"], "arguments": e["args"] } }));
                    }
                }
                if batch.is_empty() {
                    continue;
                }
                flush(batch.clone(), &mut messages, &mut pending_text, &mut reasoning);
                for call in &batch {
                    let event = by_id[call["id"].as_str().unwrap_or("")];
                    let (name, summary) = (call["function"]["name"].as_str().unwrap_or(""), event["summary"].as_str());
                    let ok = event["ok"] != json!(false);
                    if ok {
                        if RE_READABLE.contains(&name) { lost_results += 1 } else { kept_actions += 1 }
                    }
                    messages.push(json!({ "role": "tool", "tool_call_id": call["id"], "content": if ok { missing_result(name, summary) } else { format!("[{}.]", summary.unwrap_or("This call failed")) } }));
                }
            }
        }
    }
    // Trailing prose with no action after it: the sentence it was cut off in.
    if !pending_text.is_empty() || reasoning.as_deref().is_some_and(|r| !r.is_empty()) {
        flush(Vec::new(), &mut messages, &mut pending_text, &mut reasoning);
    }
    (!messages.is_empty()).then_some(Rebuilt { messages, lost_results, kept_actions })
}

/// What to tell the model when resuming from a rebuilt transcript. Separate from the exact-replay instruction because
/// some results above are placeholders, and pretending otherwise is how a model ends up describing a file it never saw.
pub fn rebuilt_resume_instruction(info: &Rebuilt) -> String {
    let mut parts = vec!["You were interrupted before finishing. Everything above is your own work from that attempt: your reasoning, and every tool call you made with its full arguments.".to_string()];
    if info.kept_actions > 0 {
        parts.push(format!("The {} file change(s) above already took effect and are on disk — do not redo them.", info.kept_actions));
    }
    if info.lost_results > 0 {
        parts.push(format!("The output of {} read/search call(s) was not kept, and is shown as a placeholder. If you need any of it, call the tool again — the files are still there. Never describe the contents of something you can no longer see.", info.lost_results));
    }
    parts.push("Check the workspace listing below for the current state, then continue from where you stopped. If a file was only partly written, finish it with edit_file rather than starting it again.".to_string());
    parts.join(" ")
}

/// The brief when a reply has an exact saved transcript (`ResumeState`) instead of a rebuilt one (route.ts, `rebuilt` unset).
pub const EXACT_RESUME_INSTRUCTION: &str = "You were interrupted before finishing. Everything above is your own work so far, including what the tools returned — it is still valid, so do not repeat it. Continue from exactly where you stopped. If a file was only partly written, finish it with edit_file rather than rewriting it from the start.";

/// When the user types "resume" / "continue", can this last reply be continued? Wider than the automatic `incomplete`
/// detection so typing the word restores the same reply even when the Resume button never appeared. Deliberately not
/// "any assistant bubble": after a finished Q&A, "continue" is a real next question. `m` is the web's message JSON.
pub fn reply_can_continue(m: &Value) -> bool {
    if m["role"] != "assistant" || js_truthy(&m["isStreaming"]) || js_truthy(&m["isError"]) {
        return false;
    }
    if js_truthy(&m["incomplete"]) || m["toolEvents"].as_array().is_some_and(|e| !e.is_empty()) {
        return true;
    }
    if m["plan"]["steps"].as_array().is_some_and(|s| s.iter().any(|s| matches!(s["state"].as_str(), Some("todo" | "doing")))) {
        return true;
    }
    // Thinking-only abort the detector missed: a long thought and almost no answer.
    let length = m["reasoningLength"].as_f64().unwrap_or(0.0);
    let thinking = if length != 0.0 { length } else { m["reasoningContent"].as_str().map_or(0, |r| js_len(js_trim(r))) as f64 };
    thinking >= 200.0 && m["content"].as_str().map_or(0, |c| js_len(js_trim(c))) < 80
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::testkit::check;

    #[test]
    fn replays_the_web_functions() {
        check("rebuild_resume.rebuild", |prior| match rebuild_resume_from_stored(prior) {
            Some(r) => json!({ "r": { "messages": r.messages, "lostResults": r.lost_results, "keptActions": r.kept_actions }, "instruction": rebuilt_resume_instruction(&r) }),
            None => json!({ "r": null, "instruction": null }),
        });
        check("rebuild_resume.instruction", |i| json!(rebuilt_resume_instruction(&Rebuilt { messages: vec![], lost_results: i["lostResults"].as_u64().unwrap() as usize, kept_actions: i["keptActions"].as_u64().unwrap() as usize })));
        check("resume_target.replyCanContinue", |m| json!(reply_can_continue(m)));
    }

    #[test]
    fn resume_state_keeps_the_web_field_names() {
        let s: ResumeState = serde_json::from_value(json!({ "toolRounds": 3, "continuations": 1, "messages": [{ "role": "user", "content": "x" }] })).unwrap();
        assert_eq!((s.tool_rounds, s.think_nudges), (3, None));
        assert_eq!(serde_json::to_value(&s).unwrap()["toolRounds"], 3);
    }
}

//! Claude on Anthropic's own API, the Messages API. Everything else in apiM speaks Chat Completions: a request is turned
//! into a Messages one on its way out, and what comes back (a reply, or each event of a stream) into the Chat Completions
//! shape the loop reads, so one loop serves every provider. Reference: platform.claude.com/docs/en/api/messages.

use crate::models::ProviderId;
use crate::provider::Verified;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;

pub const BASE_URL: &str = "https://api.anthropic.com/v1";
/// The API version every request names. 2026-10-21 refuses sampling fields (`temperature` and the like): none are sent.
pub const VERSION: &str = "2026-10-21";

pub fn headers(key: &str) -> Vec<(String, String)> {
    vec![("x-api-key".into(), key.trim().into()), ("anthropic-version".into(), VERSION.into())]
}

/// A Claude model's family and version from its id: `claude-opus-4-6`, `claude-haiku-4-5-20251001`, and the older
/// `claude-3-7-sonnet-20250219`. None for an id named some other way.
fn generation(id: &str) -> Option<(String, (u32, u32))> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^claude-(?:([a-z]+)-(\d+)(?:-(\d{1,2}))?|(\d+)(?:-(\d{1,2}))?-([a-z]+))(?:-\d{8})?$").unwrap());
    let c = RE.captures(id)?;
    let num = |i: usize| c.get(i).map_or(Some(0), |m| m.as_str().parse().ok());
    Some(match c.get(1) {
        Some(family) => (family.as_str().to_string(), (num(2)?, num(3)?)),
        None => (c[6].to_string(), (num(4)?, num(5)?)),
    })
}

/// Whether the model thinks the adaptive way (Claude 4.6 and later), and whether it is told to show its thinking (4.7
/// and later show none unless asked; 4.6 shows a summary by itself). An id this app cannot read is a newer model.
fn thinks(id: &str) -> (bool, bool) {
    generation(id).map_or((true, true), |(_, version)| (version >= (4, 6), version >= (4, 7)))
}

/// Anthropic's list price in USD per million tokens: input, cached input, output. The API does not say them. A cache read
/// costs a tenth of the input, a twentieth on Opus 5.5 and a fortieth on Fable 5.1 and Mythos 5.1. None for a model not
/// on the list: its use is then not costed, rather than costed wrong.
pub fn rates(id: &str) -> Option<(f64, f64, f64)> {
    let (family, v) = generation(id)?;
    let (input, output, read) = match (family.as_str(), v) {
        ("fable" | "mythos", (5, 1)) => (10.0, 50.0, 0.025),
        ("fable", (5, 0)) => (10.0, 50.0, 0.1),
        ("opus", (5, 5)) => (4.0, 20.0, 0.05),
        ("opus", v) if v >= (4, 5) && v <= (5, 0) => (5.0, 25.0, 0.1),
        ("opus", v) if v < (4, 5) => (15.0, 75.0, 0.1),
        ("sonnet", v) if v >= (5, 0) && v <= (5, 5) => (2.0, 10.0, 0.1),
        ("sonnet", v) if v < (5, 0) => (3.0, 15.0, 0.1),
        // ponytail: past 100,000 tokens of prompt Haiku 5.5 costs five times this; a round that sends more is costed low.
        ("haiku", (5, 5)) => (0.1, 0.5, 0.1),
        ("haiku", (4, 5)) => (1.0, 5.0, 0.1),
        ("haiku", (3, 5)) => (0.8, 4.0, 0.1),
        ("haiku", (3, 0)) => (0.25, 1.25, 0.1),
        _ => return None,
    };
    Some((input, input * read, output))
}

/// The thinking fields. Thinking is adaptive (the model decides how much) and its depth is the effort; off is low effort,
/// as the newest models cannot switch it off. A model older than 4.6 runs without: its thinking in a tool loop would have
/// to be sent back each round, and it is not (`conversation`).
pub fn apply_thinking(body: &mut Map<String, Value>, enabled: bool, effort: &str) {
    let (adaptive, display) = thinks(body.get("model").and_then(Value::as_str).unwrap_or(""));
    if !adaptive {
        return;
    }
    if enabled {
        body.insert("thinking".into(), if display { json!({ "type": "adaptive", "display": "summarized" }) } else { json!({ "type": "adaptive" }) });
    }
    body.insert("output_config".into(), json!({ "effort": if enabled { effort } else { "low" } }));
}

/// The text of a Chat Completions content value: a string, or the text of its parts.
fn plain(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n\n"),
        _ => String::new(),
    }
}

/// Claude turns a blank text block away.
fn text_block(text: &str, cache: Option<&Value>) -> Option<Value> {
    if text.trim().is_empty() {
        return None;
    }
    let mut block = json!({ "type": "text", "text": text });
    if let Some(mark) = cache.filter(|mark| !mark.is_null()) {
        block["cache_control"] = mark.clone();
    }
    Some(block)
}

/// One content part. Claude reads JPEG, PNG, GIF and WebP pictures, and no video.
fn part(p: &Value) -> Option<Value> {
    match p["type"].as_str()? {
        "text" => text_block(p["text"].as_str()?, p.get("cache_control")),
        "image_url" => {
            let url = p["image_url"]["url"].as_str()?;
            Some(match url.strip_prefix("data:").and_then(|rest| rest.split_once(";base64,")) {
                Some((mime @ ("image/jpeg" | "image/png" | "image/gif" | "image/webp"), data)) => json!({ "type": "image", "source": { "type": "base64", "media_type": mime, "data": data } }),
                Some((mime, _)) => json!({ "type": "text", "text": format!("[A picture in a format Claude does not read ({mime}) was left out.]") }),
                None => json!({ "type": "image", "source": { "type": "url", "url": url } }),
            })
        }
        "video_url" => Some(json!({ "type": "text", "text": "[A video was left out: Claude reads pictures, not video.]" })),
        _ => None,
    }
}

fn blocks(content: &Value) -> Vec<Value> {
    match content {
        Value::Array(parts) => parts.iter().filter_map(part).collect(),
        other => text_block(&plain(other), None).into_iter().collect(),
    }
}

/// Claude takes tool call ids of letters, digits, `_` and `-`; another provider's, earlier in the chat, may hold more.
fn call_id(id: &Value) -> String {
    let id: String = id.as_str().unwrap_or("").chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    if id.is_empty() { "call".into() } else { id }
}

/// Chat Completions messages as Claude takes them. The system messages before the conversation become the top-level
/// `system`; a later one rides in the user's turn, marked as the app's (Claude's own mid-conversation system message is not
/// on every model, and has rules on where it may stand). A tool's result joins the user turn after the call, turns of one
/// role in a row become one, and the conversation ends on the user's turn: the newest models take no prefill. Without
/// tools in the request, earlier calls and results go as text: Claude refuses tool blocks then.
// ponytail: thinking is not sent back. The loop rebuilds the newest turns of every request (`render_work_state`) and Claude
// checks a returned thought against everything before it, so it would be dropped or refused anyway. Send it once the
// work state rides append-only (`clear_at` system messages).
fn conversation(list: &[Value], tools: bool) -> (Vec<Value>, Vec<(&'static str, Vec<Value>)>) {
    let mut system = Vec::new();
    let mut turns: Vec<(&'static str, Vec<Value>)> = Vec::new();
    for m in list {
        let (role, content) = match m["role"].as_str().unwrap_or("user") {
            "system" if turns.is_empty() => {
                system.extend(blocks(&m["content"]));
                continue;
            }
            "system" => ("user", text_block(&format!("<system-reminder>\n{}\n</system-reminder>", plain(&m["content"]).trim()), None).into_iter().collect()),
            "assistant" => {
                let mut out = blocks(&m["content"]);
                for call in m["tool_calls"].as_array().into_iter().flatten() {
                    let (name, args) = (&call["function"]["name"], call["function"]["arguments"].as_str().unwrap_or(""));
                    if tools {
                        let input = serde_json::from_str::<Value>(args).ok().filter(Value::is_object).unwrap_or_else(|| json!({}));
                        out.push(json!({ "type": "tool_use", "id": call_id(&call["id"]), "name": name, "input": input }));
                    } else {
                        out.extend(text_block(&format!("[Called {}: {args}]", name.as_str().unwrap_or("a tool")), None));
                    }
                }
                ("assistant", out)
            }
            "tool" => {
                let text = plain(&m["content"]);
                let text = if text.trim().is_empty() { "(no output)".to_string() } else { text };
                if !tools {
                    ("user", text_block(&format!("[Result of an earlier tool call]\n{text}"), None).into_iter().collect())
                } else {
                    let mut result = json!({ "type": "tool_result", "tool_use_id": call_id(&m["tool_call_id"]), "content": text });
                    // The loop marks where the provider's cache should reach; on a result, the mark goes on the block itself.
                    if let Some(mark) = m["content"].as_array().and_then(|parts| parts.iter().find_map(|p| p.get("cache_control"))) {
                        result["cache_control"] = mark.clone();
                    }
                    ("user", vec![result])
                }
            }
            _ => ("user", blocks(&m["content"])),
        };
        if content.is_empty() {
            continue;
        }
        match turns.last_mut() {
            Some((last, blocks)) if *last == role => blocks.extend(content),
            _ => turns.push((role, content)),
        }
    }
    for (role, blocks) in &mut turns {
        if *role == "user" {
            // A turn opens with its tool results; what the user or the app adds comes after them.
            blocks.sort_by_key(|b| b["type"] != "tool_result");
        }
    }
    if turns.first().is_some_and(|(role, _)| *role == "assistant") {
        turns.insert(0, ("user", vec![json!({ "type": "text", "text": "(The conversation so far.)" })]));
    }
    if turns.last().is_none_or(|(role, _)| *role == "assistant") {
        turns.push(("user", vec![json!({ "type": "text", "text": "Continue." })]));
    }
    (system, turns)
}

/// A Chat Completions request body as a Messages one. Fields Claude has no use for (`stream_options`, OpenRouter's
/// routing, other providers' thinking switches) are left behind.
pub fn request(body: &Value) -> Value {
    let tools: Vec<Value> = body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tool| {
            let f = &tool["function"];
            let schema = if f["parameters"].is_object() { f["parameters"].clone() } else { json!({ "type": "object", "properties": {} }) };
            let mut tool = json!({ "name": f["name"].as_str()?, "input_schema": schema });
            if let Some(about) = f["description"].as_str().filter(|about| !about.is_empty()) {
                tool["description"] = json!(about);
            }
            Some(tool)
        })
        .collect();
    let (system, turns) = conversation(body["messages"].as_array().map_or(&[][..], Vec::as_slice), !tools.is_empty());
    let mut out = Map::new();
    for key in ["model", "max_tokens", "stream", "cache_control", "thinking", "output_config"] {
        if let Some(value) = body.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    out.entry("max_tokens").or_insert(json!(16_000));
    if !system.is_empty() {
        out.insert("system".into(), json!(system));
    }
    out.insert("messages".into(), turns.into_iter().map(|(role, content)| json!({ "role": role, "content": content })).collect());
    if !tools.is_empty() {
        // Forcing a call is refused by the newest models; the loop only ever asks for "auto" or "none".
        out.insert("tool_choice".into(), json!({ "type": if body["tool_choice"] == "none" { "none" } else { "auto" } }));
        out.insert("tools".into(), json!(tools));
    }
    Value::Object(out)
}

fn finish(stop: Option<&str>) -> Value {
    json!(match stop {
        Some("end_turn" | "stop_sequence" | "pause_turn") => "stop",
        Some("max_tokens" | "model_context_window_exceeded") => "length",
        Some("tool_use") => "tool_calls",
        // Claude's safety classifiers declined: the provider's filter, as the loop calls it.
        Some("refusal") => "content_filter",
        Some(other) => other,
        None => return Value::Null,
    })
}

/// Claude's token counts in the Chat Completions shape. Writing to the cache is billed at 1.25 times the input price,
/// so a written token counts 1.25 times among the misses: the cost never undercounts.
fn usage(u: &Value) -> Value {
    let n = |key: &str| u[key].as_u64().unwrap_or(0);
    let (fresh, written, read) = (n("input_tokens"), n("cache_creation_input_tokens"), n("cache_read_input_tokens"));
    // Written for five minutes costs 1.25 times the input price, for an hour twice it.
    let hour = u["cache_creation"]["ephemeral_1h_input_tokens"].as_u64().unwrap_or(0).min(written);
    json!({
        "prompt_tokens": fresh + written + read,
        "completion_tokens": n("output_tokens"),
        "prompt_tokens_details": { "cached_tokens": read },
        "prompt_cache_miss_tokens": fresh + written + (written - hour) / 4 + hour,
    })
}

/// A Messages reply in the Chat Completions shape: its text, thinking and tool calls, why it stopped, and the tokens.
pub fn reply(message: &Value) -> Value {
    let (mut text, mut thought, mut calls) = (String::new(), String::new(), Vec::new());
    for block in message["content"].as_array().into_iter().flatten() {
        match block["type"].as_str() {
            Some("text") => text.push_str(block["text"].as_str().unwrap_or("")),
            Some("thinking") => thought.push_str(block["thinking"].as_str().unwrap_or("")),
            Some("tool_use") => calls.push(json!({ "id": block["id"], "type": "function", "function": { "name": block["name"], "arguments": block["input"].to_string() } })),
            _ => {}
        }
    }
    let mut turn = json!({ "role": "assistant", "content": text });
    if !thought.is_empty() {
        turn["reasoning_content"] = json!(thought);
    }
    if !calls.is_empty() {
        turn["tool_calls"] = json!(calls);
    }
    json!({ "choices": [{ "message": turn, "finish_reason": finish(message["stop_reason"].as_str()) }], "usage": usage(&message["usage"]) })
}

/// Reads a Messages stream event by event, as the Chat Completions chunks they amount to.
#[derive(Default)]
pub struct Events {
    /// Content block index to tool call index.
    calls: HashMap<u64, usize>,
    /// The newest count of each kind: `message_start` has the prompt's, `message_delta` the output's.
    counts: Map<String, Value>,
}

impl Events {
    /// None for an event the loop has no use for (pings, block ends, signatures).
    pub fn chunk(&mut self, event: &Value) -> Option<Value> {
        let delta = |d: Value| json!({ "choices": [{ "delta": d }] });
        match event["type"].as_str()? {
            "message_start" => Some(json!({ "usage": self.count(&event["message"]["usage"]) })),
            "content_block_start" if event["content_block"]["type"] == "tool_use" => {
                let block = &event["content_block"];
                let call = self.calls.len();
                self.calls.insert(event["index"].as_u64()?, call);
                Some(delta(json!({ "tool_calls": [{ "index": call, "id": block["id"], "function": { "name": block["name"], "arguments": "" } }] })))
            }
            "content_block_delta" => {
                let d = &event["delta"];
                match d["type"].as_str()? {
                    "text_delta" => Some(delta(json!({ "content": d["text"] }))),
                    "thinking_delta" => Some(delta(json!({ "reasoning_content": d["thinking"] }))),
                    "input_json_delta" => {
                        let call = *self.calls.get(&event["index"].as_u64()?)?;
                        Some(delta(json!({ "tool_calls": [{ "index": call, "function": { "arguments": d["partial_json"] } }] })))
                    }
                    _ => None,
                }
            }
            "message_delta" => Some(json!({ "choices": [{ "delta": {}, "finish_reason": finish(event["delta"]["stop_reason"].as_str()) }], "usage": self.count(&event["usage"]) })),
            "error" => Some(json!({ "error": event["error"] })),
            _ => None,
        }
    }

    /// Objects are kept too: what was written for an hour, billed at twice the five-minute price, is told only in
    /// message_start's `cache_creation`, and every hour-long write was costed as a five-minute one without it.
    fn count(&mut self, counts: &Value) -> Value {
        self.counts.extend(counts.as_object().into_iter().flatten().filter(|(_, v)| v.is_u64() || v.is_object()).map(|(k, v)| (k.clone(), v.clone())));
        usage(&Value::Object(self.counts.clone()))
    }
}

/// The Claude model id in what the user typed or pasted: `claude-sonnet-5-5`, or `claude-opus-5.5` as people write it.
/// Not OpenRouter's `anthropic/claude-…`: that is an OpenRouter model.
pub fn model_id(text: &str) -> Option<String> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:^|[^\w/.-])(claude-[a-z0-9][a-z0-9.-]*[a-z0-9])").unwrap());
    RE.captures(text).map(|c| c[1].to_ascii_lowercase().replace('.', "-"))
}

/// One GET from the Models API. Ok(None) is "no such model".
async fn get(key: &str, path: &str) -> Result<Option<Value>, String> {
    if key.trim().is_empty() {
        return Err("Add an Anthropic API key in Settings → API keys first: Claude models run on it.".into());
    }
    let mut request = crate::provider::client().get(format!("{BASE_URL}{path}")).timeout(Duration::from_secs(15));
    for (name, value) in headers(key) {
        request = request.header(name, value);
    }
    let res = request.send().await.map_err(|_| "Could not reach Anthropic. Check the connection and try again.".to_string())?;
    match res.status().as_u16() {
        200 => res.json().await.map(Some).map_err(|_| "Anthropic's answer could not be read. Try again in a moment.".to_string()),
        404 => Ok(None),
        401 | 403 => Err("That Anthropic API key was rejected. Check it in Settings → API keys.".into()),
        status => Err(format!("Anthropic returned {status}. Try again in a moment.")),
    }
}

/// The Claude models this key can use, newest first: (id, name).
pub async fn list(key: &str) -> Result<Vec<(String, String)>, String> {
    let page = get(key, "/models?limit=100").await?.unwrap_or_default();
    Ok(page["data"].as_array().into_iter().flatten().filter_map(|m| Some((m["id"].as_str()?.to_string(), m["display_name"].as_str().unwrap_or("").to_string()))).collect())
}

/// Checks a Claude model id with Anthropic and brings back its window, output limit and abilities; prices are from
/// Anthropic's list (`rates`).
pub async fn verify(id: &str, key: &str) -> Result<Verified, String> {
    match get(key, &format!("/models/{id}")).await? {
        Some(found) => Ok(shape(&found, id)),
        None => {
            let have = list(key).await.unwrap_or_default().into_iter().map(|(id, _)| id).take(12).collect::<Vec<_>>();
            Err(format!("No Claude model \"{id}\" on this key.{}", if have.is_empty() { String::new() } else { format!(" It has: {}.", have.join(", ")) }))
        }
    }
}

fn shape(found: &Value, asked: &str) -> Verified {
    let id = found["id"].as_str().unwrap_or(asked).to_string();
    let supported = |ability: &Value| ability["supported"].as_bool().unwrap_or(true);
    let price = rates(&id);
    Verified {
        provider: ProviderId::Anthropic,
        name: found["display_name"].as_str().filter(|n| !n.is_empty()).unwrap_or(&id).to_string(),
        context_length: found["max_input_tokens"].as_u64().filter(|n| *n > 0),
        max_output: found["max_tokens"].as_u64().filter(|n| *n > 0).map(|n| n.min(u32::MAX as u64) as u32),
        input_price: price.map(|p| p.0),
        output_price: price.map(|p| p.2),
        supports_tools: true,
        supports_vision: supported(&found["capabilities"]["image_input"]),
        supports_thinking: supported(&found["capabilities"]["thinking"]),
        id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_name_the_generation_and_the_price() {
        assert_eq!(generation("claude-opus-4-6"), Some(("opus".into(), (4, 6))));
        assert_eq!(generation("claude-haiku-4-5-20251001"), Some(("haiku".into(), (4, 5))));
        assert_eq!(generation("claude-opus-4-20250514"), Some(("opus".into(), (4, 0))));
        assert_eq!(generation("claude-3-7-sonnet-20250219"), Some(("sonnet".into(), (3, 7))));
        assert_eq!(generation("claude-fable-5"), Some(("fable".into(), (5, 0))));
        assert_eq!((thinks("claude-opus-4-6"), thinks("claude-sonnet-5-5"), thinks("claude-haiku-4-5"), thinks("claude-new-thing")), ((true, false), (true, true), (false, false), (true, true)));
        assert_eq!(rates("claude-opus-5-5"), Some((4.0, 0.2, 20.0)));
        assert!(rates("claude-sonnet-4-6").is_some_and(|(input, cached, output)| input == 3.0 && (cached - 0.3).abs() < 1e-9 && output == 15.0));
        assert_eq!(rates("claude-fable-5-1").map(|r| r.1), Some(0.25));
        assert_eq!((rates("claude-opus-6"), rates("claude-sonnet-6")), (None, None));
        assert_eq!(model_id("add claude-opus-5.5 please"), Some("claude-opus-5-5".into()));
        assert_eq!(model_id("Claude-Sonnet-5-5"), Some("claude-sonnet-5-5".into()));
        assert_eq!((model_id("anthropic/claude-opus-5-5"), model_id("https://openrouter.ai/anthropic/claude-haiku-5-5")), (None, None));
    }

    #[test]
    fn thinking_is_adaptive_and_off_is_low_effort() {
        let fields = |model: &str, on: bool| {
            let mut body = Map::new();
            body.insert("model".into(), json!(model));
            apply_thinking(&mut body, on, "max");
            (body.get("thinking").cloned(), body.get("output_config").cloned())
        };
        assert_eq!(fields("claude-opus-5-5", true), (Some(json!({ "type": "adaptive", "display": "summarized" })), Some(json!({ "effort": "max" }))));
        assert_eq!(fields("claude-opus-5-5", false), (None, Some(json!({ "effort": "low" }))));
        assert_eq!(fields("claude-sonnet-4-6", true).0, Some(json!({ "type": "adaptive" })));
        assert_eq!(fields("claude-haiku-4-5", true), (None, None));
    }

    #[test]
    fn a_chat_completions_request_becomes_a_messages_one() {
        let body = json!({
            "model": "claude-sonnet-5-5", "max_tokens": 1000, "stream": true, "stream_options": { "include_usage": true }, "session_id": "x",
            "cache_control": { "type": "ephemeral" }, "output_config": { "effort": "high" }, "tool_choice": "auto",
            "tools": [{ "type": "function", "function": { "name": "read_file", "description": "Reads", "parameters": { "type": "object", "properties": { "path": { "type": "string" } } } } }],
            "messages": [
                { "role": "system", "content": [{ "type": "text", "text": "rules", "cache_control": { "type": "ephemeral" } }] },
                { "role": "system", "content": "summary" },
                { "role": "user", "content": [{ "type": "text", "text": "look" }, { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } }, { "type": "image_url", "image_url": { "url": "data:image/bmp;base64,BB" } }] },
                { "role": "assistant", "content": "", "reasoning_content": "hm", "tool_calls": [
                    { "id": "functions.read_file:0", "type": "function", "function": { "name": "read_file", "arguments": "{\"path\":\"a\"}" } },
                    { "id": "b", "type": "function", "function": { "name": "read_file", "arguments": "broken" } }] },
                { "role": "tool", "tool_call_id": "functions.read_file:0", "content": "A" },
                { "role": "system", "content": "Workspace changes since" },
                { "role": "tool", "tool_call_id": "b", "content": [{ "type": "text", "text": "", "cache_control": { "type": "ephemeral" } }] },
                { "role": "user", "content": "state" },
                { "role": "assistant", "content": "partial" },
            ]
        });
        let sent = request(&body);
        for gone in ["stream_options", "session_id", "temperature"] {
            assert!(sent.get(gone).is_none(), "{gone}");
        }
        assert_eq!(sent["system"], json!([{ "type": "text", "text": "rules", "cache_control": { "type": "ephemeral" } }, { "type": "text", "text": "summary" }]));
        assert_eq!(sent["tools"][0]["input_schema"]["properties"]["path"]["type"], "string");
        assert_eq!((sent["tool_choice"].clone(), sent["cache_control"].clone(), sent["output_config"]["effort"].clone()), (json!({ "type": "auto" }), json!({ "type": "ephemeral" }), json!("high")));
        let turns = sent["messages"].as_array().unwrap();
        assert_eq!(turns.iter().map(|t| t["role"].as_str().unwrap()).collect::<Vec<_>>(), ["user", "assistant", "user", "assistant", "user"]);
        assert_eq!(turns[0]["content"][1]["source"], json!({ "type": "base64", "media_type": "image/png", "data": "AAAA" }));
        assert!(turns[0]["content"][2]["text"].as_str().unwrap().contains("image/bmp"));
        // No thinking goes back, an empty text block is left out, and a broken argument list is an empty input.
        assert_eq!(turns[1]["content"], json!([{ "type": "tool_use", "id": "functions_read_file_0", "name": "read_file", "input": { "path": "a" } }, { "type": "tool_use", "id": "b", "name": "read_file", "input": {} }]));
        // Both results open the next turn, the cache mark on the block; the app's note and the work state follow.
        let user = turns[2]["content"].as_array().unwrap();
        assert_eq!(user.iter().map(|b| b["type"].as_str().unwrap()).collect::<Vec<_>>(), ["tool_result", "tool_result", "text", "text"]);
        assert_eq!((user[0]["tool_use_id"].as_str(), user[1]["content"].as_str(), user[1]["cache_control"]["type"].as_str()), (Some("functions_read_file_0"), Some("(no output)"), Some("ephemeral")));
        assert!(user[2]["text"].as_str().unwrap().starts_with("<system-reminder>\nWorkspace changes since"));
        // A request never ends on Claude's own words.
        assert_eq!(turns[4]["content"][0]["text"], "Continue.");
        // Without tools, the calls and their results ride as text.
        let mut bare = body.clone();
        bare.as_object_mut().unwrap().remove("tools");
        let sent = request(&bare);
        assert!(sent.get("tools").is_none() && sent.get("tool_choice").is_none());
        assert!(sent["messages"][1]["content"][0]["text"].as_str().unwrap().starts_with("[Called read_file: {\"path\":\"a\"}]"));
        assert_eq!(request(&json!({ "tool_choice": "none", "tools": body["tools"], "messages": [] }))["tool_choice"], json!({ "type": "none" }));
    }

    #[test]
    fn a_stream_reads_as_chat_completions_chunks() {
        let mut events = Events::default();
        let mut chunks = Vec::new();
        for event in [
            json!({ "type": "message_start", "message": { "usage": { "input_tokens": 100, "cache_creation_input_tokens": 40, "cache_read_input_tokens": 1000, "cache_creation": { "ephemeral_5m_input_tokens": 20, "ephemeral_1h_input_tokens": 20 }, "output_tokens": 1 } } }),
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "Let me look." } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "x" } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "Reading." } }),
            json!({ "type": "content_block_start", "index": 2, "content_block": { "type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {} } }),
            json!({ "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "{\"path\":" } }),
            json!({ "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "\"a\"}" } }),
            json!({ "type": "ping" }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" }, "usage": { "output_tokens": 30 } }),
        ] {
            chunks.extend(events.chunk(&event));
        }
        assert_eq!(chunks.len(), 7);
        assert_eq!(chunks[1]["choices"][0]["delta"]["reasoning_content"], "Let me look.");
        assert_eq!(chunks[2]["choices"][0]["delta"]["content"], "Reading.");
        assert_eq!(chunks[3]["choices"][0]["delta"]["tool_calls"][0], json!({ "index": 0, "id": "toolu_1", "function": { "name": "read_file", "arguments": "" } }));
        assert_eq!(chunks[5]["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"], "\"a\"}");
        let last = &chunks[6];
        assert_eq!(last["choices"][0]["finish_reason"], "tool_calls");
        let used = crate::models::Usage::from_wire(&last["usage"]);
        assert_eq!((used.prompt, used.cache_hit, used.cache_miss, used.completion), (1140, 1000, 165, 30));
        assert!(events.chunk(&json!({ "type": "error", "error": { "type": "overloaded_error", "message": "Overloaded" } })).unwrap()["error"]["message"] == "Overloaded");
    }

    #[tokio::test]
    async fn a_round_streams_from_claudes_own_api() {
        use crate::provider::{Delta, Target, ThinkingStyle, client, stream_round};
        let event = |e: Value| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap());
        let reply: String = [
            json!({ "type": "message_start", "message": { "usage": { "input_tokens": 12, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 1 } } }),
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "Read it first." } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "tool_use", "id": "toolu_9", "name": "read_file", "input": {} } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{\"path\":\"a.rs\"}" } }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" }, "usage": { "output_tokens": 20 } }),
            json!({ "type": "message_stop" }),
        ]
        .into_iter()
        .map(event)
        .collect();
        let stub = crate::context::testkit::stub(vec![(200, reply)]);
        let target = Target { model: crate::models::resolve("glm-5.3-flash", &[]), provider: ProviderId::Anthropic, style: ThinkingStyle::Anthropic, api_key: "sk-ant-test".into(), base_url: stub.base.clone(), api_model: "claude-sonnet-5-5".into() };
        let tools = json!([{ "type": "function", "function": { "name": "read_file", "parameters": { "type": "object", "properties": {} } } }]);
        let body = json!({ "model": "claude-sonnet-5-5", "max_tokens": 100, "stream": true, "stream_options": { "include_usage": true }, "tools": tools, "tool_choice": "auto",
            "messages": [{ "role": "system", "content": "rules" }, { "role": "user", "content": "go" }] });
        let mut thought = String::new();
        let round = stream_round(&client(), &target, &body, |delta| {
            if let Delta::Reasoning(text) = delta {
                thought.push_str(text);
            }
        })
        .await
        .unwrap();
        assert_eq!((round.finish.as_deref(), thought.as_str(), round.tool_calls.len()), (Some("tool_calls"), "Read it first.", 1));
        assert_eq!((round.tool_calls[0].id.as_str(), round.tool_calls[0].args.as_str()), ("toolu_9", "{\"path\":\"a.rs\"}"));
        assert_eq!(round.usage.map(|u| (u.prompt, u.completion)), Some((12, 20)));
        let seen = &stub.requests()[0];
        assert_eq!((seen["url"].as_str(), seen["headers"]["x-api-key"].as_str(), seen["headers"]["anthropic-version"].as_str(), seen["headers"].get("authorization")), (Some("/v1/messages"), Some("sk-ant-test"), Some(VERSION), None));
        assert_eq!((seen["body"]["system"][0]["text"].as_str(), seen["body"].get("stream_options"), seen["body"]["tools"][0]["name"].as_str()), (Some("rules"), None, Some("read_file")));
        // A busy Anthropic reads as theirs, and is worth another try.
        let busy = crate::context::testkit::stub(vec![(529, json!({ "type": "error", "error": { "type": "overloaded_error", "message": "Overloaded" } }).to_string())]);
        let e = stream_round(&client(), &Target { base_url: busy.base.clone(), ..target }, &body, |_| {}).await.unwrap_err();
        assert!(e.retryable && e.message == "Anthropic is temporarily unavailable (529). This is their servers, not your API key. Wait a minute and try again.", "{}", e.message);
    }

    #[test]
    fn a_reply_reads_as_a_chat_completions_one() {
        let message = json!({ "stop_reason": "refusal", "usage": { "input_tokens": 5, "output_tokens": 2 }, "content": [
            { "type": "thinking", "thinking": "hm", "signature": "s" }, { "type": "text", "text": "No." },
            { "type": "tool_use", "id": "t", "name": "read_file", "input": { "path": "a" } }] });
        let out = reply(&message);
        let turn = &out["choices"][0]["message"];
        assert_eq!((turn["content"].as_str(), turn["reasoning_content"].as_str(), out["choices"][0]["finish_reason"].as_str()), (Some("No."), Some("hm"), Some("content_filter")));
        assert_eq!(turn["tool_calls"][0]["function"]["arguments"], "{\"path\":\"a\"}");
        assert_eq!(out["usage"]["prompt_tokens"], 5);
    }
}

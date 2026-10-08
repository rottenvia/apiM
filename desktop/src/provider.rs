//! Resolves which LLM endpoint a request hits, and streams one Chat
//! Completions round from it. Three front doors, one wire shape: DeepSeek's own
//! API, the OpenRouter gateway, and a local OpenAI-compatible host.

use crate::models::{self, ModelInfo, ProviderId, Usage};
use crate::refusal;
use crate::store::Settings;
use futures_util::StreamExt;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::time::Duration;

pub const DEFAULT_LOCAL_BASE_URL: &str = "http://127.0.0.1:18765/v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThinkingStyle {
    Deepseek,
    Openai,
    Qwen,
}

#[derive(Clone, Debug)]
pub struct Target {
    pub model: ModelInfo,
    pub provider: ProviderId,
    pub style: ThinkingStyle,
    pub api_key: String,
    pub base_url: String,
    /// Value of the Chat Completions `model` field.
    pub api_model: String,
}

/// The cheap lane for side calls (search planning): Flash when a DeepSeek key
/// exists, else the free Nemotron lane. Never the main model, never a custom.
pub fn helper_target(s: &Settings) -> Option<Target> {
    let id = if !s.deepseek().is_empty() { "deepseek-v4-flash" } else { "nvidia-nemotron-3-ultra-free" };
    resolve_target(id, s).ok()
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| default.to_string())
}

/// Accepts the ways people paste a local host: bare, `/v1`, or `/v1/chat/completions`.
pub fn normalize_openai_base(url: &str) -> String {
    let mut u = url.trim().trim_end_matches('/').to_string();
    if u.is_empty() {
        return DEFAULT_LOCAL_BASE_URL.to_string();
    }
    if u.to_ascii_lowercase().ends_with("/chat/completions") {
        u.truncate(u.len() - "/chat/completions".len());
        u = u.trim_end_matches('/').to_string();
    }
    let has_version = u.rsplit('/').next().is_some_and(|seg| {
        let s = seg.to_ascii_lowercase();
        s.len() > 1 && s.starts_with('v') && s[1..].chars().all(|c| c.is_ascii_digit())
    });
    if !has_version {
        u.push_str("/v1");
    }
    u
}

pub fn resolve_target(model_id: &str, s: &Settings) -> Result<Target, String> {
    let model = models::resolve(model_id, &s.custom_models);
    let (style, api_key, base_url, api_model) = match model.provider {
        ProviderId::Openrouter => {
            let key = s.openrouter();
            if key.is_empty() {
                return Err(format!(
                    "An OpenRouter API key is required for {}. Add one in Settings (openrouter.ai/settings/keys).",
                    model.label
                ));
            }
            (ThinkingStyle::Openai, key, env_or("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"), model.api_model.clone())
        }
        ProviderId::Deepseek => {
            let key = s.deepseek();
            if key.is_empty() {
                return Err("A DeepSeek API key is required for this model. Add one in Settings.".into());
            }
            (ThinkingStyle::Deepseek, key, env_or("DEEPSEEK_BASE_URL", "https://api.deepseek.com"), model.api_model.clone())
        }
        ProviderId::Local => {
            let base = if s.local_base_url.trim().is_empty() { env_or("LOCAL_BASE_URL", DEFAULT_LOCAL_BASE_URL) } else { s.local_base_url.clone() };
            // The sidecar accepts any bearer token; it still has to be a well-formed header.
            let key = if s.local_api_key.trim().is_empty() { "local".to_string() } else { s.local_api_key.trim().to_string() };
            let api_model = if s.local_api_model.trim().is_empty() { model.api_model.clone() } else { s.local_api_model.trim().to_string() };
            (ThinkingStyle::Qwen, key, normalize_openai_base(&base), api_model)
        }
    };
    Ok(Target { provider: model.provider, model, style, api_key, base_url: base_url.trim_end_matches('/').to_string(), api_model })
}

/// Pinned cheapest OpenRouter endpoint per catalog model. `allow_fallbacks: false`
/// keeps every token on the pinned price; customs and the free lane auto-route.
pub fn openrouter_provider_for(model_id: &str) -> Option<Value> {
    let tag = match model_id {
        "glm-5.3-flash" => "inference-net/fp4",
        "deepseek-v4.1-flash" => "morph",
        _ => return None,
    };
    Some(json!({ "only": [tag], "allow_fallbacks": false }))
}

/// Catalog models whose pinned endpoint 400s on the reasoning disable.
pub fn openrouter_reasoning_mandatory(model_id: &str) -> bool {
    model_id == "glm-5.3-flash"
}

/// Provider-specific thinking fields. `effort` is low | high | max.
pub fn apply_thinking(body: &mut Map<String, Value>, style: ThinkingStyle, enabled: bool, effort: &str, mandatory: bool) {
    let level = if matches!(effort, "low" | "high" | "max") { effort } else { "high" };
    match style {
        ThinkingStyle::Deepseek => {
            body.insert("thinking".into(), json!({ "type": if enabled { "enabled" } else { "disabled" } }));
            if enabled {
                body.insert("reasoning_effort".into(), json!(level));
            }
        }
        ThinkingStyle::Qwen => {
            if enabled {
                let qwen = match level {
                    "low" => "low",
                    "max" => "xhigh",
                    _ => "medium",
                };
                body.insert(
                    "chat_template_kwargs".into(),
                    json!({ "enable_thinking": true, "preserve_thinking": true, "reasoning_effort": qwen }),
                );
                body.insert("reasoning_effort".into(), json!(qwen));
                body.insert("think".into(), json!(true));
            } else {
                body.insert("chat_template_kwargs".into(), json!({ "enable_thinking": false }));
                body.insert("think".into(), json!(false));
            }
        }
        ThinkingStyle::Openai => {
            if enabled {
                body.insert("reasoning_effort".into(), json!(level));
            } else if mandatory {
                // A mandatory-reasoning endpoint 400s on the disable; minimal effort keeps the round legal.
                body.insert("reasoning_effort".into(), json!("low"));
            } else {
                body.insert("reasoning".into(), json!({ "effort": "none" }));
            }
        }
    }
}

/// User-facing error for a failed Chat Completions call.
pub fn http_error(status: u16, provider: &str, detail: &str) -> String {
    // Checked first: a content filter answers 400 or 403, and both would
    // otherwise read as a broken key or a bug in apiM.
    if refusal::is_provider_content_block(detail) {
        return refusal::provider_content_block_message(provider, detail);
    }
    let detail = refusal::readable_detail(detail);
    match status {
        401 => format!("Your {provider} API key was rejected. Check it in Settings."),
        402 => format!("Your {provider} account has insufficient balance. Everything done so far is saved. Add credit and press Try again."),
        429 if provider == "OpenRouter" => "OpenRouter is rate limiting this model right now (429). This is their capacity, not your key. Wait a bit, or pick another model.".into(),
        429 => format!("Rate limited by {provider}. Please wait a moment and try again."),
        502..=504 => format!("{provider} is temporarily unavailable ({status}). This is their servers, not your API key. Wait a minute and try again."),
        _ if detail.is_empty() => format!("{provider} API error ({status})"),
        _ => format!("{provider} API error ({status}): {detail}"),
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Raw JSON arguments, exactly as streamed.
    pub args: String,
}

/// What one round produced.
#[derive(Debug, Default)]
pub struct Round {
    pub content: String,
    pub reasoning: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish: Option<String>,
    pub usage: Option<Usage>,
}

pub enum Delta<'a> {
    Content(&'a str),
    Reasoning(&'a str),
    /// A tool call still streaming its arguments (a file being written).
    ToolDraft { name: &'a str, chars: usize },
}

#[derive(Debug)]
pub struct RoundError {
    pub message: String,
    /// HTTP status, or 0 for network and timeout failures.
    pub status: u16,
    /// Raw provider detail, for the mandatory-reasoning retry.
    pub detail: String,
    /// Safe to retry: nothing was shown to the user yet.
    pub retryable: bool,
}

/// Collects streamed tool calls. Parallel calls are kept separate even when the
/// provider streams them all on the same index; they used to concatenate into
/// one unparseable call.
#[derive(Default)]
struct ToolAcc {
    calls: Vec<ToolCall>,
    slot: HashMap<i64, usize>,
}

impl ToolAcc {
    fn add(&mut self, tc: &Value) {
        let index = tc["index"].as_i64().unwrap_or(0);
        let id = tc["id"].as_str().unwrap_or("");
        let name = tc["function"]["name"].as_str().unwrap_or("");
        let fresh = match self.slot.get(&index) {
            None => true,
            Some(&i) => !id.is_empty() && !self.calls[i].id.is_empty() && self.calls[i].id != id,
        };
        if fresh {
            self.calls.push(ToolCall::default());
            self.slot.insert(index, self.calls.len() - 1);
        }
        let call = &mut self.calls[self.slot[&index]];
        if call.id.is_empty() {
            call.id = id.to_string();
        }
        if call.name.is_empty() {
            call.name = name.to_string();
        }
        call.args.push_str(tc["function"]["arguments"].as_str().unwrap_or(""));
    }
}

/// Before the first byte of the body; a silent 503 fails fast.
const FIRST_TOKEN: Duration = Duration::from_secs(120);
/// Between chunks once the stream is alive. Five minutes of nothing is a dead connection, not a deep think.
const STREAM_IDLE: Duration = Duration::from_secs(300);

pub fn client() -> reqwest::Client {
    reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build().expect("HTTP client")
}

/// Streams one round. `on` sees text as it arrives.
pub async fn stream_round(client: &reqwest::Client, target: &Target, body: &Value, mut on: impl FnMut(Delta)) -> Result<Round, RoundError> {
    let provider = target.provider.name();
    let fail = |message: String, retryable: bool| RoundError { message, status: 0, detail: String::new(), retryable };

    let mut req = client.post(format!("{}/chat/completions", target.base_url)).bearer_auth(&target.api_key).json(body);
    if target.provider == ProviderId::Openrouter {
        req = req.header("HTTP-Referer", "https://github.com/rottenvia/apiM").header("X-Title", "apiM");
    }
    let resp = match tokio::time::timeout(FIRST_TOKEN, req.send()).await {
        Err(_) => return Err(fail(format!("The {provider} API took too long to respond."), true)),
        Ok(Err(e)) if target.provider == ProviderId::Local => {
            return Err(fail(format!("Couldn't reach the local model at {} ({e}). Start it, or check the address in Settings.", target.base_url), false));
        }
        Ok(Err(e)) => return Err(fail(format!("Couldn't reach the {provider} API ({e}). Check the network connection and try again."), true)),
        Ok(Ok(r)) => r,
    };

    let status = resp.status().as_u16();
    if status != 200 {
        let detail = resp.text().await.unwrap_or_default();
        return Err(RoundError {
            message: http_error(status, provider, &detail),
            status,
            retryable: matches!(status, 408 | 429 | 500..=599) && !refusal::is_provider_content_block(&detail),
            detail,
        });
    }

    let mut round = Round::default();
    let mut acc = ToolAcc::default();
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut alive = false;

    loop {
        let wait = if alive { STREAM_IDLE } else { FIRST_TOKEN };
        let chunk = match tokio::time::timeout(wait, stream.next()).await {
            Err(_) => return Err(fail(format!("{provider} stopped sending data mid-reply."), !alive)),
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(fail(format!("The connection to {provider} dropped ({e})."), !alive)),
            Ok(Some(Ok(c))) => c,
        };
        buf.extend_from_slice(&chunk);

        // SSE frames are newline-delimited; keep the trailing partial line.
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(payload) = line.trim().strip_prefix("data:").map(str::trim) else { continue };
            if payload.is_empty() || payload == "[DONE]" {
                continue;
            }
            // Malformed frames are ignored rather than aborting the reply.
            let Ok(frame) = serde_json::from_str::<Value>(payload) else { continue };

            if let Some(err) = frame.get("error").filter(|e| !e.is_null()) {
                let detail = err["message"].as_str().map(str::to_string).unwrap_or_else(|| err.to_string());
                let code = err["code"].as_u64().unwrap_or(0) as u16;
                return Err(RoundError { message: http_error(if code == 0 { 500 } else { code }, provider, &detail), status: code, detail, retryable: !alive });
            }
            if frame["usage"].is_object() {
                round.usage = Some(Usage::from_wire(&frame["usage"]));
            }
            let choice = &frame["choices"][0];
            if let Some(reason) = choice["finish_reason"].as_str() {
                round.finish = Some(reason.to_string());
            }
            let delta = &choice["delta"];
            // Providers disagree on where thinking goes.
            for key in ["reasoning_content", "reasoning", "thinking", "reasoningContent"] {
                if let Some(text) = delta[key].as_str().filter(|t| !t.is_empty()) {
                    alive = true;
                    round.reasoning.push_str(text);
                    on(Delta::Reasoning(text));
                    break;
                }
            }
            if let Some(calls) = delta["tool_calls"].as_array() {
                alive = true;
                for tc in calls {
                    acc.add(tc);
                }
                if let Some(last) = acc.calls.last() {
                    on(Delta::ToolDraft { name: &last.name, chars: last.args.len() });
                }
            }
            if let Some(text) = delta["content"].as_str().filter(|t| !t.is_empty()) {
                alive = true;
                round.content.push_str(text);
                on(Delta::Content(text));
            }
        }
    }

    round.tool_calls = acc.calls.into_iter().filter(|c| !c.name.is_empty()).collect();
    for (i, call) in round.tool_calls.iter_mut().enumerate() {
        if call.id.is_empty() {
            call.id = format!("call_{i}");
        }
    }
    if !alive && round.finish.is_none() {
        return Err(fail(format!("{provider} answered with an empty reply."), true));
    }
    Ok(round)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_base_normalised() {
        assert_eq!(normalize_openai_base("http://127.0.0.1:8080"), "http://127.0.0.1:8080/v1");
        assert_eq!(normalize_openai_base("http://h/v1/"), "http://h/v1");
        assert_eq!(normalize_openai_base("http://h/v1/chat/completions"), "http://h/v1");
        assert_eq!(normalize_openai_base(""), DEFAULT_LOCAL_BASE_URL);
    }

    #[test]
    fn thinking_fields() {
        let mut b = Map::new();
        apply_thinking(&mut b, ThinkingStyle::Openai, false, "none", false);
        assert_eq!(b["reasoning"], json!({"effort": "none"}));
        let mut b = Map::new();
        apply_thinking(&mut b, ThinkingStyle::Openai, false, "none", true);
        assert_eq!(b["reasoning_effort"], "low");
        let mut b = Map::new();
        apply_thinking(&mut b, ThinkingStyle::Deepseek, true, "max", false);
        assert_eq!((b["thinking"]["type"].as_str(), b["reasoning_effort"].as_str()), (Some("enabled"), Some("max")));
        let mut b = Map::new();
        apply_thinking(&mut b, ThinkingStyle::Qwen, true, "max", false);
        assert_eq!(b["reasoning_effort"], "xhigh");
    }

    #[test]
    fn parallel_tool_calls_on_one_index_stay_separate() {
        let mut acc = ToolAcc::default();
        acc.add(&json!({"index":0,"id":"a","function":{"name":"read_file","arguments":"{\"path\":"}}));
        acc.add(&json!({"index":0,"function":{"arguments":"\"x\"}"}}));
        acc.add(&json!({"index":0,"id":"b","function":{"name":"read_file","arguments":"{\"path\":\"y\"}"}}));
        acc.add(&json!({"index":1,"id":"c","function":{"name":"list_files","arguments":"{}"}}));
        assert_eq!(acc.calls.len(), 3);
        assert_eq!(acc.calls[0].args, "{\"path\":\"x\"}");
        assert_eq!(acc.calls[1].id, "b");
    }

    #[test]
    fn errors_name_the_provider() {
        assert!(http_error(400, "DeepSeek", "Content Exists Risk").contains("its own content filter"));
        assert!(http_error(401, "OpenRouter", "").contains("key was rejected"));
        assert_eq!(http_error(400, "X", r#"{"error":{"message":"bad"}}"#), "X API error (400): bad");
    }
}

/// DeepSeek bills cached tokens at about half price from 16:30 to 00:30 Beijing time.
fn deepseek_clock(now_ms: u64) -> (bool, u32) {
    const PEAK_START: u32 = 30;
    const OFF_PEAK_START: u32 = 16 * 60 + 30;
    let beijing = ((now_ms / 60_000) as u32 + 8 * 60) % (24 * 60);
    let peak = (PEAK_START..OFF_PEAK_START).contains(&beijing);
    let next = if peak { OFF_PEAK_START } else { PEAK_START };
    (!peak, (next + 24 * 60 - beijing - 1) % (24 * 60) + 1)
}

pub fn deepseek_off_peak() -> bool {
    deepseek_clock(crate::store::now_ms()).0
}

/// When the price period next flips: the user's local wall-clock time, and minutes until then.
pub fn deepseek_next_change() -> (String, u32) {
    let minutes = deepseek_clock(crate::store::now_ms()).1;
    let at = chrono::Local::now() + chrono::Duration::minutes(minutes as i64);
    (at.format("%H:%M").to_string(), minutes)
}

#[cfg(test)]
mod hours_tests {
    use super::deepseek_clock;

    #[test]
    fn peak_and_off_peak() {
        let at = |h: u64, m: u64| (h * 60 + m) * 60_000; // UTC
        assert_eq!(deepseek_clock(at(0, 0)), (false, 8 * 60 + 30)); // 08:00 Beijing: peak, off-peak at 16:30
        assert_eq!(deepseek_clock(at(8, 30)), (true, 8 * 60)); // 16:30 Beijing: off-peak begins
        assert_eq!(deepseek_clock(at(16, 29)), (true, 1)); // 00:29 Beijing: last off-peak minute
        assert_eq!(deepseek_clock(at(16, 30)), (false, 16 * 60)); // 00:30 Beijing: peak again
    }
}

// ------------------------------------------------------------------ OpenRouter model lookup

/// What OpenRouter says about a model id (src/app/api/openrouter/verify/route.ts).
#[derive(Clone, Debug, PartialEq)]
pub struct Verified {
    /// The id as typed: what goes on the wire, `:free` suffix and all.
    pub id: String,
    pub name: String,
    pub context_length: Option<u64>,
    /// USD per 1M tokens.
    pub input_price: Option<f64>,
    pub output_price: Option<f64>,
    pub supports_tools: bool,
    pub supports_vision: bool,
    pub supports_thinking: bool,
}

fn shape_verified(entry: &Value, wire: &str) -> Verified {
    let list = |v: &Value| v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>()).unwrap_or_default();
    let params = list(&entry["supported_parameters"]);
    let inputs = list(&entry["architecture"]["input_modalities"]);
    // Prices arrive per token, as strings.
    let per_million = |v: &Value| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()).filter(|n| n.is_finite() && *n >= 0.0).map(|n| n * 1_000_000.0);
    Verified {
        id: wire.to_string(),
        name: entry["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(wire).to_string(),
        context_length: entry["context_length"].as_f64().filter(|n| *n > 0.0).map(|n| n as u64),
        input_price: per_million(&entry["pricing"]["prompt"]),
        output_price: per_million(&entry["pricing"]["completion"]),
        supports_tools: params.is_empty() || params.iter().any(|p| p == "tools"),
        supports_vision: inputs.iter().any(|m| m == "image" || m == "video"),
        supports_thinking: params.iter().any(|p| p == "reasoning" || p == "include_reasoning"),
    }
}

/// Checks a model id with OpenRouter and brings back its window, prices and abilities.
pub async fn verify_openrouter(slug: &str, api_key: &str) -> Result<Verified, String> {
    const MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
    let wire = slug.trim();
    if wire.is_empty() || wire.len() > 160 || !crate::models::valid_slug(wire) || wire.len() < 2 {
        return Err("That is not an OpenRouter model id. It looks like `author/model-name`, optionally with `:free` on the end — copy it from the model's openrouter.ai page.".into());
    }
    // `:free` / `:nitro` / `:floor` route the request but are not catalog ids.
    let catalog = wire.split(':').next().unwrap_or(wire);
    let key = api_key.trim();
    let get = |url: String, secs| {
        let request = client().get(url).timeout(std::time::Duration::from_secs(secs));
        if key.is_empty() { request } else { request.bearer_auth(key) }
    };
    let rejected = || Err("That OpenRouter API key was rejected. Check it in Settings → Keys.".to_string());

    // 1. Cheap exact lookup.
    if let Ok(res) = get(format!("{MODELS_URL}/{catalog}"), 15).send().await {
        if res.status().is_success() {
            if let Ok(parsed) = res.json::<Value>().await {
                if parsed["data"]["id"].is_string() {
                    return Ok(shape_verified(&parsed["data"], wire));
                }
            }
        } else if res.status().as_u16() == 401 && !key.is_empty() {
            return rejected();
        }
    }
    // 2. The whole list, for `:free` variants and ids the per-model endpoint will not address.
    let unreachable = "Could not reach OpenRouter. Check the connection and try again.";
    let res = get(MODELS_URL.to_string(), 20).send().await.map_err(|_| unreachable.to_string())?;
    if !res.status().is_success() {
        if res.status().as_u16() == 401 && !key.is_empty() {
            return rejected();
        }
        return Err(format!("OpenRouter returned {}. Try again in a moment.", res.status().as_u16()));
    }
    let parsed: Value = res.json().await.map_err(|_| unreachable.to_string())?;
    let list = parsed["data"].as_array().map(Vec::as_slice).unwrap_or_default();
    let found = list.iter().find(|m| m["id"] == wire).or_else(|| list.iter().find(|m| m["id"] == catalog));
    match found {
        Some(entry) => Ok(shape_verified(entry, wire)),
        None => Err(format!("No OpenRouter model matches \"{wire}\". Open the model on openrouter.ai and copy its id exactly.")),
    }
}

#[cfg(test)]
mod verify_tests {
    use super::*;

    #[test]
    fn shapes_a_catalog_entry() {
        let entry = json!({ "id": "z/glm", "name": "GLM", "context_length": 1048576, "pricing": { "prompt": "0.00000015", "completion": "0.0000005" },
            "supported_parameters": ["tools", "reasoning"], "architecture": { "input_modalities": ["text", "image"] } });
        let v = shape_verified(&entry, "z/glm:free");
        assert_eq!((v.id.as_str(), v.name.as_str(), v.context_length), ("z/glm:free", "GLM", Some(1_048_576)));
        assert!((v.input_price.unwrap() - 0.15).abs() < 1e-9 && (v.output_price.unwrap() - 0.5).abs() < 1e-9);
        assert!(v.supports_tools && v.supports_vision && v.supports_thinking);
        // No parameter list means tools are assumed; no pricing means unknown, not free.
        let bare = shape_verified(&json!({ "id": "a/b" }), "a/b");
        assert!(bare.supports_tools && !bare.supports_vision && bare.input_price.is_none() && bare.name == "a/b");
    }
}

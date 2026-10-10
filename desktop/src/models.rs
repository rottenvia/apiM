//! Models the user can pick, and which provider serves each one.
//! The catalog itself is assets/models.json, synced from the web app.

use crate::local::shared::SIDECAR_CTX;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    Deepseek,
    Openrouter,
    Local,
}

impl ProviderId {
    pub fn name(self) -> &'static str {
        match self {
            ProviderId::Deepseek => "DeepSeek",
            ProviderId::Openrouter => "OpenRouter",
            ProviderId::Local => "On this PC",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Vision {
    None,
    Native,
    #[default]
    Helper,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    /// Sent in the Chat Completions `model` field. May differ from `id`.
    pub api_model: String,
    pub provider: ProviderId,
    pub label: String,
    pub short_label: String,
    pub description: String,
    pub specs: String,
    pub vision: Vision,
    #[serde(default)]
    pub video: bool,
    /// The line under the name on the Settings model cards.
    #[serde(default)]
    pub settings_subtitle: String,
    pub max_output_tokens: u32,
}

/// A user-added OpenRouter model (Settings -> Models).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CustomModel {
    /// OpenRouter slug for the wire, e.g. `anthropic/claude-opus-4-6`.
    pub api_model: String,
    pub label: String,
    #[serde(default)]
    pub vision: Vision,
    #[serde(default = "default_max_output")]
    pub max_output_tokens: u32,
    #[serde(default)]
    pub context_length: Option<u64>,
    /// USD per 1M tokens. None means unknown, not free.
    #[serde(default)]
    pub input_price: Option<f64>,
    #[serde(default)]
    pub output_price: Option<f64>,
    /// Uncapped tools: whole-file reads, no batch ceilings.
    #[serde(default)]
    pub open_limits: bool,
}

fn default_max_output() -> u32 {
    65_536
}

pub const CUSTOM_PREFIX: &str = "custom:";
pub const DEFAULT_MODEL_ID: &str = "glm-5.3-flash";
pub const FALLBACK_CONTEXT_TOKENS: u64 = 128_000;

#[derive(Deserialize)]
struct Catalog {
    models: Vec<ModelInfo>,
}

pub static MODELS: LazyLock<Vec<ModelInfo>> = LazyLock::new(|| {
    serde_json::from_str::<Catalog>(include_str!("../assets/models.json"))
        .expect("assets/models.json is valid")
        .models
});

/// OpenRouter slugs look like `vendor/model-name` with an optional `:free`-style suffix.
pub fn valid_slug(slug: &str) -> bool {
    static RE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?(?::[A-Za-z0-9-]+)?$").unwrap()
    });
    !slug.is_empty() && slug.len() <= 128 && RE.is_match(slug)
}

impl CustomModel {
    pub fn id(&self) -> String {
        format!("{CUSTOM_PREFIX}{}", self.api_model)
    }

    /// "128K ctx · $0.15/$0.6 per 1M · custom" (`customSpecs` in src/lib/models.ts).
    pub fn specs(&self) -> String {
        let mut bits = Vec::new();
        if let Some(ctx) = self.context_length.filter(|c| *c > 0) {
            bits.push(if ctx >= 1_000_000 {
                // Two decimals at most, trailing zeros dropped: 1.05M, 2M.
                format!("{}M ctx", (ctx as f64 / 10_000.0).round() / 100.0)
            } else {
                format!("{}K ctx", (ctx as f64 / 1000.0).round())
            });
        }
        if self.input_price.is_some() || self.output_price.is_some() {
            let f = |v: Option<f64>| v.map_or("?".to_string(), |v| format!("${v}"));
            bits.push(format!("{}/{} per 1M", f(self.input_price), f(self.output_price)));
        }
        bits.push("custom".into());
        bits.join(" · ")
    }

    pub fn to_info(&self) -> ModelInfo {
        let short: String = if self.label.chars().count() > 22 {
            self.label.chars().take(21).chain(std::iter::once('…')).collect()
        } else {
            self.label.clone()
        };
        ModelInfo {
            id: self.id(),
            api_model: self.api_model.clone(),
            provider: ProviderId::Openrouter,
            label: self.label.clone(),
            short_label: short,
            description: format!("Custom OpenRouter model ({}).", self.api_model),
            specs: self.specs(),
            vision: self.vision,
            video: false,
            settings_subtitle: format!("OpenRouter · {}", self.specs()),
            max_output_tokens: self.max_output_tokens.clamp(1_000, 1_000_000),
        }
    }
}

/// Catalog first, then the user's customs, then the default.
pub fn resolve(id: &str, customs: &[CustomModel]) -> ModelInfo {
    if let Some(m) = MODELS.iter().find(|m| m.id == id) {
        return m.clone();
    }
    if let Some(c) = customs.iter().find(|c| c.id() == id) {
        return c.to_info();
    }
    MODELS[0].clone()
}

/// Every pickable model: catalog then customs.
pub fn all(customs: &[CustomModel]) -> Vec<ModelInfo> {
    MODELS.iter().cloned().chain(customs.iter().map(CustomModel::to_info)).collect()
}

/// The model's context window in tokens, read from the specs line the catalog shows.
pub fn context_window(id: &str, customs: &[CustomModel]) -> u64 {
    if let Some(c) = customs.iter().find(|c| c.id() == id) {
        return c.context_length.unwrap_or(FALLBACK_CONTEXT_TOKENS);
    }
    let info = resolve(id, customs);
    if info.provider == ProviderId::Local {
        return SIDECAR_CTX;
    }
    static RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?i)(\d+(?:\.\d+)?)\s*([KM])\s*(?:context|ctx|window)").unwrap());
    match RE.captures(&info.specs) {
        Some(c) => {
            let n: f64 = c[1].parse().unwrap_or(128.0);
            (n * if c[2].eq_ignore_ascii_case("M") { 1_000_000.0 } else { 1_000.0 }) as u64
        }
        None => FALLBACK_CONTEXT_TOKENS,
    }
}

/// What the endpoint picked for a model charges (`provider::choose_endpoint`): these come before the catalog's prices.
static ENDPOINT_RATES: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, (f64, f64, f64)>>> = std::sync::LazyLock::new(Default::default);

pub fn set_endpoint_rates(id: &str, rates: (f64, f64, f64)) {
    ENDPOINT_RATES.lock().unwrap().insert(id.to_string(), rates);
}

/// USD per 1M tokens: (input, cached input, output). None when unknown.
pub fn rates(id: &str, customs: &[CustomModel]) -> Option<(f64, f64, f64)> {
    if let Some(picked) = ENDPOINT_RATES.lock().unwrap().get(id) {
        return Some(*picked);
    }
    Some(match id {
        "deepseek-v4-pro" => (0.435, 0.003625, 0.87),
        "deepseek-v4-flash" => (0.14, 0.0028, 0.28),
        "glm-5.3-flash" => (0.15, 0.03, 0.5),
        "deepseek-v4.1-flash" => (0.15, 0.003, 0.6),
        "nvidia-nemotron-3-ultra-free" | "qwen-3.8-27b" => (0.0, 0.0, 0.0),
        _ => {
            let c = customs.iter().find(|c| c.id() == id)?;
            let input = c.input_price?;
            (input, input, c.output_price?)
        }
    })
}

/// Token counts for one reply, summed over its rounds.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Usage {
    pub prompt: u64,
    pub completion: u64,
    pub cache_hit: u64,
    /// Prompt tokens billed at the full input rate. 0 when the provider did not say: then it is the prompt less the hits.
    #[serde(default)]
    pub cache_miss: u64,
    pub reasoning: u64,
    /// Tokens the newest round occupied in the context window.
    pub context: u64,
}

impl Usage {
    /// Reads one round's `usage` object, normalising DeepSeek's and OpenRouter's cache fields.
    pub fn from_wire(u: &serde_json::Value) -> Usage {
        let n = |v: &serde_json::Value| v.as_u64().unwrap_or(0);
        let prompt = n(&u["prompt_tokens"]);
        let completion = n(&u["completion_tokens"]);
        let details = &u["prompt_tokens_details"];
        // The same split as the web app's `cacheSplit`, quirks included: a provider that reports its hits in
        // both shapes has them counted twice, and both apps must show the same price.
        let cache_hit = n(&u["prompt_cache_hit_tokens"]) + n(&details["cached_tokens"]) + n(&details["cache_read_tokens"]);
        let said = n(&u["prompt_cache_miss_tokens"]);
        // Writing to the cache is billed like ordinary input.
        let cache_miss = if said > 0 { said } else { prompt.saturating_sub(cache_hit) }.max(n(&details["cache_creation_tokens"]));
        Usage {
            prompt,
            completion,
            cache_hit,
            cache_miss,
            reasoning: n(&u["completion_tokens_details"]["reasoning_tokens"]),
            context: prompt + completion,
        }
    }

    pub fn add(&mut self, round: Usage) {
        self.prompt += round.prompt;
        self.completion += round.completion;
        self.cache_hit += round.cache_hit;
        self.cache_miss += round.cache_miss;
        self.reasoning += round.reasoning;
        if round.context > 0 {
            self.context = round.context;
        }
    }

    /// List price: what the spending limit counts, so it never undercounts.
    pub fn cost(&self, model_id: &str, customs: &[CustomModel]) -> Option<f64> {
        self.shown_cost(model_id, customs, false)
    }

    /// What a reply is shown to have cost. In DeepSeek's off-peak hours input and output are
    /// halved and cached input is not — for every model, exactly as the web app's `estimateCost` has it.
    pub fn shown_cost(&self, model_id: &str, customs: &[CustomModel], off_peak: bool) -> Option<f64> {
        let (input, cached, output) = rates(model_id, customs)?;
        let factor = if off_peak { 0.5 } else { 1.0 };
        let miss = if self.cache_miss > 0 { self.cache_miss } else { self.prompt.saturating_sub(self.cache_hit) };
        Some((miss as f64 * input * factor + self.cache_hit as f64 * cached + self.completion as f64 * output * factor) / 1e6)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_loads_and_resolves() {
        assert!(MODELS.iter().any(|m| m.id == DEFAULT_MODEL_ID));
        assert_eq!(resolve("nope", &[]).id, MODELS[0].id);
        assert_eq!(context_window("glm-5.3-flash", &[]), 1_000_000);
    }

    #[test]
    fn custom_models() {
        assert!(valid_slug("z-ai/glm-5.3-flash"));
        assert!(valid_slug("x/y:free"));
        assert!(!valid_slug("bad slug"));
        let c = CustomModel {
            api_model: "a/b".into(),
            label: "AB".into(),
            vision: Vision::Native,
            max_output_tokens: 5,
            context_length: Some(200_000),
            input_price: Some(3.0),
            output_price: Some(15.0),
            open_limits: false,
        };
        let customs = [c];
        assert_eq!(resolve("custom:a/b", &customs).max_output_tokens, 1_000);
        assert_eq!(context_window("custom:a/b", &customs), 200_000);
        let u = Usage { prompt: 1_000_000, completion: 1_000_000, ..Default::default() };
        assert_eq!(u.cost("custom:a/b", &customs), Some(18.0));
        assert_eq!(u.shown_cost("custom:a/b", &customs, true), Some(9.0));
        // DeepSeek reports its cache hits twice over; the price follows the web app's reading of that.
        let wire = serde_json::json!({ "prompt_tokens": 1000, "completion_tokens": 100, "prompt_cache_hit_tokens": 600, "prompt_cache_miss_tokens": 400, "prompt_tokens_details": { "cached_tokens": 600 } });
        let u = Usage::from_wire(&wire);
        assert_eq!((u.cache_hit, u.cache_miss), (1200, 400));
        assert_eq!(u.cost("deepseek-v4-pro", &[]), Some((400.0 * 0.435 + 1200.0 * 0.003625 + 100.0 * 0.87) / 1e6));
    }

    #[test]
    fn usage_cache_split() {
        let u = Usage::from_wire(&serde_json::json!({
            "prompt_tokens": 100, "completion_tokens": 10,
            "prompt_tokens_details": {"cached_tokens": 80}
        }));
        assert_eq!((u.prompt, u.cache_hit, u.context), (100, 80, 110));
    }
}

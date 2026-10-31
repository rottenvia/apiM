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
    Anthropic,
}

impl ProviderId {
    pub fn name(self) -> &'static str {
        match self {
            ProviderId::Deepseek => "DeepSeek",
            ProviderId::Openrouter => "OpenRouter",
            ProviderId::Local => "On this PC",
            ProviderId::Anthropic => "Anthropic",
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

/// A user-added model (Settings -> Models): an OpenRouter one, or a Claude one on the user's own Anthropic key.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CustomModel {
    /// The id on the wire: OpenRouter's slug (`anthropic/claude-opus-4-6`), or Anthropic's own (`claude-opus-4-6`).
    pub api_model: String,
    #[serde(default = "openrouter")]
    pub provider: ProviderId,
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

fn openrouter() -> ProviderId {
    ProviderId::Openrouter
}

fn default_max_output() -> u32 {
    65_536
}

/// Thinking depths from shallowest to deepest, by the names the settings keep.
pub const EFFORT_ORDER: [&str; 6] = ["none", "low", "medium", "high", "xhigh", "max"];

/// The depths a model really has, shallowest first; empty when it has no thinking to set. Claude 4.6 and later
/// cannot stop thinking (off is its low effort) and takes five depths; DeepSeek V4 Pro's low is its high; GLM's
/// pinned endpoint refuses reasoning off (`provider::openrouter_reasoning_mandatory`). A slider stop that changed
/// nothing on the wire would only mislead.
pub fn effort_levels(id: &str, customs: &[CustomModel]) -> Vec<&'static str> {
    let model = resolve(id, customs);
    match model.provider {
        ProviderId::Anthropic if crate::anthropic::adaptive(&model.api_model) => vec!["low", "medium", "high", "xhigh", "max"],
        ProviderId::Anthropic => Vec::new(),
        ProviderId::Deepseek if model.api_model == "deepseek-v4-pro" => vec!["none", "high", "max"],
        ProviderId::Deepseek | ProviderId::Local => vec!["none", "low", "high", "max"],
        ProviderId::Openrouter if crate::provider::openrouter_reasoning_mandatory(id) => vec!["low", "medium", "high", "max"],
        ProviderId::Openrouter => vec!["none", "low", "medium", "high", "max"],
    }
}

/// The depth sent for `asked`: itself when the model has it, else the model's nearest (the deeper one on a tie).
pub fn fit_effort(levels: &[&'static str], asked: &str) -> &'static str {
    let rank = |level: &str| EFFORT_ORDER.iter().position(|l| *l == level).unwrap_or(3) as i32;
    let want = rank(asked);
    // Some thinking asked for is never turned into none: V4 Pro's Low is its High.
    let thinking = levels.iter().copied().filter(|level| asked == "none" || *level != "none");
    thinking.min_by_key(|level| ((rank(level) - want).abs(), -rank(level))).unwrap_or(EFFORT_ORDER[want as usize])
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
            provider: self.provider,
            label: self.label.clone(),
            short_label: short,
            description: format!("Custom {} model ({}).", self.provider.name(), self.api_model),
            specs: self.specs(),
            vision: self.vision,
            video: false,
            settings_subtitle: format!("{} · {}", self.provider.name(), self.specs()),
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

/// Where the endpoint picked for each model, and what it charges, is remembered between sessions.
pub fn endpoints_file() -> std::path::PathBuf {
    crate::store::data_dir().join("endpoints.json")
}

/// What the endpoint picked for a model charges (`provider::choose_endpoint`): these come before the catalog's prices.
/// Read back from the last session's pick at the start: a session that had not sent a reply yet showed every earlier
/// reply at the catalog's prices, and the same reply at the endpoint's once one was sent.
static ENDPOINT_RATES: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, (f64, f64, f64)>>> = std::sync::LazyLock::new(|| {
    let saved: serde_json::Value = if cfg!(test) { Default::default() } else { std::fs::read(endpoints_file()).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default() };
    let rates = |entry: &serde_json::Value| Some((entry["rates"][0].as_f64()?, entry["rates"][1].as_f64()?, entry["rates"][2].as_f64()?));
    std::sync::Mutex::new(saved.as_object().into_iter().flatten().filter_map(|(id, entry)| Some((id.clone(), rates(entry)?))).collect())
});

pub fn set_endpoint_rates(id: &str, rates: (f64, f64, f64)) {
    ENDPOINT_RATES.lock().unwrap().insert(id.to_string(), rates);
}

/// A cached input token costs a quarter of a fresh one or less (DeepSeek 2%, Claude 10%): old text is then cheaper
/// left as it is than rewritten, since a rewrite sends everything after it again at full price.
pub fn cache_is_cheap(id: &str, customs: &[CustomModel]) -> bool {
    rates(id, customs).is_some_and(|(input, cached, _)| cached <= input / 4.0)
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
            // OpenRouter lists no cached price, so none is assumed; Claude's is a fraction of its input price.
            let cached = if c.provider == ProviderId::Anthropic { crate::anthropic::rates(&c.api_model).map_or(input, |rates| rates.1) } else { input };
            (input, cached, c.output_price?)
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

    /// What a reply is shown to have cost. In DeepSeek's off-peak hours input and output are halved and cached
    /// input is not, on DeepSeek's own API. The web app's `estimateCost` halves every model then, and so did
    /// this: an OpenRouter reply read as half of what it was billed for those hours of the day.
    pub fn shown_cost(&self, model_id: &str, customs: &[CustomModel], off_peak: bool) -> Option<f64> {
        let (input, cached, output) = rates(model_id, customs)?;
        let factor = if off_peak && resolve(model_id, customs).provider == ProviderId::Deepseek { 0.5 } else { 1.0 };
        Some(self.cost_at((input * factor, cached, output * factor)))
    }

    /// What it cost at these prices, in USD per million tokens: input, cached input, output.
    pub fn cost_at(&self, (input, cached, output): (f64, f64, f64)) -> f64 {
        let miss = if self.cache_miss > 0 { self.cache_miss } else { self.prompt.saturating_sub(self.cache_hit) };
        (miss as f64 * input + self.cache_hit as f64 * cached + self.completion as f64 * output) / 1e6
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_model_offers_only_the_depths_it_has() {
        let claude = CustomModel { api_model: "claude-haiku-5-5".into(), provider: ProviderId::Anthropic, label: "Claude Haiku 5.5".into(), vision: Vision::Native, max_output_tokens: 64_000, context_length: None, input_price: None, output_price: None, open_limits: false };
        let customs = [claude.clone()];
        let levels = effort_levels(&claude.id(), &customs);
        assert_eq!(levels, ["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(fit_effort(&levels, "none"), "low");
        assert_eq!(effort_levels("deepseek-v4-pro", &[]), ["none", "high", "max"]);
        assert_eq!(fit_effort(&effort_levels("deepseek-v4-pro", &[]), "low"), "high");
        assert_eq!(fit_effort(&effort_levels("deepseek-v4-pro", &[]), "medium"), "high");
        assert!(!effort_levels("glm-5.3-flash", &[]).contains(&"none"));
        assert_eq!(fit_effort(&effort_levels("glm-5.3-flash", &[]), "none"), "low");
        assert_eq!(fit_effort(&effort_levels("deepseek-v4-flash", &[]), "xhigh"), "max");
    }

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
            provider: ProviderId::Openrouter,
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
        // A Claude model reads its cache at Anthropic's price for it: a twentieth of the input on Opus 5.5.
        let claude = [CustomModel { api_model: "claude-opus-5-5".into(), provider: ProviderId::Anthropic, input_price: Some(4.0), output_price: Some(20.0), ..customs[0].clone() }];
        let cached = Usage { prompt: 1_000_000, cache_hit: 1_000_000, ..Default::default() };
        assert!(cached.cost("custom:claude-opus-5-5", &claude).is_some_and(|usd| (usd - 0.2).abs() < 1e-9));
        assert_eq!((resolve("custom:claude-opus-5-5", &claude).provider, resolve("custom:claude-opus-5-5", &claude).settings_subtitle.starts_with("Anthropic · ")), (ProviderId::Anthropic, true));
        // Off-peak is DeepSeek's own discount: an OpenRouter model costs the same at any hour.
        assert_eq!(u.shown_cost("custom:a/b", &customs, true), Some(18.0));
        assert_eq!(u.shown_cost("deepseek-v4-flash", &[], true).map(|usd| (usd * 100.0).round()), u.cost("deepseek-v4-flash", &[]).map(|usd| (usd * 50.0).round()));
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

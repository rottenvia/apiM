//! Settings and chats on disk. Plain JSON under the user's app-data folder.

use crate::models::{CustomModel, DEFAULT_MODEL_ID, Usage};
use crate::plugins::Plugin;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

/// `%APPDATA%\apiM`, `~/Library/Application Support/apiM` or `~/.local/share/apiM`.
/// `APIM_DATA_DIR` overrides it (tests, portable installs).
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("APIM_DATA_DIR").or_else(|| std::env::var_os("APIM_DATA_ROOT")) {
        return PathBuf::from(dir);
    }
    // Started from a checkout of the web app: both apps then open the same chats.
    static SHARED: std::sync::LazyLock<Option<PathBuf>> = std::sync::LazyLock::new(|| {
        let exe = std::env::current_exe().ok()?;
        exe.ancestors().skip(1).take(6).find(|dir| dir.join("package.json").is_file() && dir.join("data").join("chats").is_dir()).map(|dir| dir.join("data"))
    });
    SHARED.clone().unwrap_or_else(config_dir)
}

/// Where settings (and the keys in them) live: always the user's own profile, never a project folder.
pub fn config_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("APIM_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = || PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(home)
    } else if cfg!(target_os = "macos") {
        home().join("Library/Application Support")
    } else {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".local/share"))
    };
    base.join("apiM")
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Unique enough for local files: time plus a per-process counter.
pub fn new_id() -> String {
    static N: AtomicU32 = AtomicU32::new(0);
    format!("{:x}{:03x}", now_ms(), N.fetch_add(1, Ordering::Relaxed) & 0xfff)
}

/// Writes through a temp file so a crash mid-write never leaves half a file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Approval {
    /// Reading is free; commands and other risky actions ask first.
    #[default]
    Manual,
    /// The agent runs commands without asking.
    Auto,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Settings {
    // ponytail: keys sit in plain JSON in the user's profile, like the web
    // version's localStorage. Move to the OS keyring if this machine is shared.
    pub deepseek_key: String,
    pub openrouter_key: String,
    pub tavily_key: String,
    pub exa_key: String,
    /// GitHub Personal Access Token typed into the GitHub dialog. `GITHUB_TOKEN` / `GITHUB_PAT` stand in when empty.
    pub github_token: String,
    /// A provider switched off keeps its key but is not searched.
    pub tavily_enabled: bool,
    pub exa_enabled: bool,
    /// OpenAI key for describing pictures to models that cannot see them. Optional: OCR is free.
    pub vision_key: String,
    pub vision_model: String,
    pub local_base_url: String,
    pub local_api_key: String,
    pub local_api_model: String,
    pub model: String,
    /// auto | none | low | high | max
    pub effort: String,
    /// off | auto | always
    pub web_search_mode: String,
    pub enabled_plugins: Vec<String>,
    /// The user's own plugins. They live in data/plugins.json (shared with the web app), not in settings.json.
    #[serde(skip_serializing)]
    pub custom_plugins: Vec<Plugin>,
    pub custom_models: Vec<CustomModel>,
    pub approval: Approval,
    /// Hard ceiling on what one reply may cost, in USD. None means no cap.
    pub budget_usd: Option<f64>,
    pub sidebar_open: bool,
    pub workspace_open: bool,
    pub zoom: f32,
    /// A preset from the theme wall, or "custom".
    pub theme: String,
    /// The custom theme's four seeds: background, surface, text, accent.
    pub custom_theme: [String; 4],
    /// Seconds the Delete button stays locked in the confirm dialog.
    pub delete_delay: u32,
    /// claude | split: where a reply's steps sit next to its text.
    pub reply_layout: String,
    /// quality | balanced | cheap: how hard a web search looks.
    pub search_profile: String,
    /// Keep a LESSONS.md of proven facts in the workspace and read it back.
    pub lessons_enabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            deepseek_key: String::new(),
            openrouter_key: String::new(),
            tavily_key: String::new(),
            exa_key: String::new(),
            github_token: String::new(),
            tavily_enabled: true,
            exa_enabled: true,
            vision_key: String::new(),
            vision_model: "gpt-4o-mini".into(),
            local_base_url: String::new(),
            local_api_key: String::new(),
            local_api_model: String::new(),
            model: DEFAULT_MODEL_ID.into(),
            effort: "auto".into(),
            web_search_mode: "auto".into(),
            enabled_plugins: Vec::new(),
            custom_plugins: Vec::new(),
            custom_models: Vec::new(),
            approval: Approval::Manual,
            budget_usd: None,
            sidebar_open: true,
            workspace_open: false,
            zoom: 1.0,
            theme: "apim".into(),
            custom_theme: ["#191715".into(), "#2a2723".into(), "#ede9e2".into(), "#c96442".into()],
            delete_delay: 5,
            reply_layout: "claude".into(),
            search_profile: "balanced".into(),
            lessons_enabled: false,
        }
    }
}

impl Settings {
    fn path() -> PathBuf {
        config_dir().join("settings.json")
    }

    pub fn load() -> Settings {
        let mut s: Settings = std::fs::read(Self::path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        // Plugins written by an older desktop build sat in settings.json: move them next to the web app's.
        for old in std::mem::take(&mut s.custom_plugins) {
            let _ = crate::plugins::save(&Plugin { id: String::new(), ..old });
        }
        s.custom_plugins = crate::plugins::custom();
        s
    }

    pub fn save(&self) {
        if let Ok(json) = serde_json::to_vec_pretty(self) {
            let _ = write_atomic(&Self::path(), &json);
        }
    }

    /// A key from Settings, else from the environment (handy for scripts and tests).
    pub fn key(&self, saved: &str, env: &str) -> String {
        let saved = saved.trim();
        if saved.is_empty() { std::env::var(env).unwrap_or_default().trim().to_string() } else { saved.to_string() }
    }
    pub fn openrouter(&self) -> String {
        self.key(&self.openrouter_key, "OPENROUTER_API_KEY")
    }
    pub fn deepseek(&self) -> String {
        self.key(&self.deepseek_key, "DEEPSEEK_API_KEY")
    }
    pub fn tavily(&self) -> String {
        if self.tavily_enabled { self.key(&self.tavily_key, "TAVILY_API_KEY") } else { String::new() }
    }
    pub fn exa(&self) -> String {
        if self.exa_enabled { self.key(&self.exa_key, "EXA_API_KEY") } else { String::new() }
    }

    pub fn web_mode(&self) -> &'static str {
        match self.web_search_mode.as_str() {
            "off" => "off",
            "always" => "always",
            _ => "auto",
        }
    }
    pub fn set_web_mode(&mut self, mode: &str) {
        self.web_search_mode = mode.to_string();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    #[default]
    User,
    Assistant,
}

/// One action the agent took, as shown in the reply.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ToolEvent {
    pub id: String,
    pub name: String,
    /// Raw JSON arguments.
    pub args: String,
    /// None while it is still running.
    pub ok: Option<bool>,
    pub summary: String,
    /// An image the tool produced, shown under the step. Relative to the workspace when inside it.
    pub image: Option<PathBuf>,
    /// The web app's link to that image, kept so a chat saved here still shows it there.
    pub image_url: String,
    pub caption: String,
    /// The file this step wrote, for the workspace panel's "just changed" mark.
    pub changed_path: Option<String>,
}

/// A reply reads top to bottom: each stretch of text is followed by the steps it led to.
#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    Text(String),
    /// `ms` stays 0 while the model is still thinking.
    Thinking { text: String, ms: u64 },
    Tool(ToolEvent),
    /// A one-line note from the app: retried, continued, stopped.
    Notice(String),
}

/// A file sent with a message. Pictures carry their bytes as a data URL, like the web app stores them.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub name: String,
    /// text | image | video
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description_source: Option<String>,
    /// Videos only: stills sampled at attach time. Present (with no `data_url`) means the clip rides as a strip of images.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub frames: Vec<crate::media::video::Frame>,
    /// Videos only: the clip's length and the spacing of its frames, in seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_interval_sec: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub domain: String,
}

/// Where the newest request's characters went, largest first (the context meter's bar).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
pub struct Bucket {
    pub label: String,
    pub chars: u64,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Message {
    pub id: String,
    pub role: Role,
    pub parts: Vec<Part>,
    pub model: String,
    pub usage: Usage,
    pub cost: Option<f64>,
    pub duration_ms: u64,
    pub reasoning_ms: u64,
    pub error: Option<String>,
    /// Final finish_reason from the provider.
    pub finish: Option<String>,
    /// Stopped or cut off before it finished.
    pub incomplete: bool,
    pub attachments: Vec<Attachment>,
    pub created_at: u64,
    /// The thinking effort this message was sent or answered with.
    pub effort: Option<String>,
    pub search_results: Vec<SearchResult>,
    pub search_queries: Vec<String>,
    /// Estimated spend on the web searches this reply ran, in USD.
    pub search_usd: f64,
    pub plugins_used: Vec<String>,
    pub context_breakdown: Vec<Bucket>,
    /// A "btw" note added while a reply was running: shown as a chip, not a bubble.
    pub note: bool,
    /// Thinking the web app saved without a place among the steps. Shown as one box above them.
    pub loose_reasoning: String,
    /// `usage` and `ending` exactly as loaded, written back untouched unless this app re-ran the message.
    pub raw_usage: Option<serde_json::Value>,
    pub raw_ending: Option<serde_json::Value>,
    /// Fields of the web app's format this app does not use yet, kept so saving loses nothing.
    pub other: serde_json::Map<String, serde_json::Value>,
}

impl Message {
    /// The message as the web app stores it: what the rules shared with the web (`crate::context`) read.
    pub fn to_web(&self) -> serde_json::Value {
        serde_json::to_value(wire::Msg::from(self)).unwrap_or_default()
    }

    pub fn new(role: Role, text: &str) -> Message {
        Message { id: new_id(), role, parts: if text.is_empty() { Vec::new() } else { vec![Part::Text(text.to_string())] }, created_at: now_ms(), ..Default::default() }
    }

    /// A message from the web app's stored JSON, for tests that replay saved chats.
    #[cfg(test)]
    pub fn from_web(v: &serde_json::Value) -> Message {
        serde_json::from_value::<wire::Msg>(v.clone()).expect("a stored web message").into()
    }

    /// The prose of the message, without thinking or steps.
    pub fn text(&self) -> String {
        let mut out = String::new();
        for p in &self.parts {
            if let Part::Text(t) = p {
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push_str("\n\n");
                }
                out.push_str(t);
            }
        }
        out
    }

    /// Everything the model thought, in order.
    pub fn reasoning(&self) -> String {
        if !self.loose_reasoning.is_empty() {
            return self.loose_reasoning.clone();
        }
        self.parts.iter().filter_map(|p| if let Part::Thinking { text, .. } = p { Some(text.as_str()) } else { None }).collect()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
pub struct PlanStep {
    pub id: u32,
    pub text: String,
    /// todo | doing | done | blocked
    pub state: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
pub struct Plan {
    pub goal: String,
    pub steps: Vec<PlanStep>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
pub struct Finding {
    pub id: String,
    pub claim: String,
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub refs: Vec<String>,
    pub active: bool,
}

/// A summary standing in for older turns (`/compact`, or the automatic one).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HistorySummary {
    pub text: String,
    /// The last message this covers.
    pub up_to_id: String,
    /// Turns older than this summary that never made it in.
    pub dropped_turns: u32,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub covered_turns: Option<u32>,
    /// True when the user asked for it with Compact.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub manual: bool,
    /// Turns it covered were later retried or edited.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub revised: bool,
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub archived: bool,
    pub created_at: u64,
    pub updated_at: u64,
    pub messages: Vec<Message>,
    /// A folder the user pointed this chat at. None means the chat's own folder.
    pub folder: Option<PathBuf>,
    pub plan: Option<Plan>,
    /// What the agent concluded in this chat. Never shown to another chat.
    pub findings: Vec<Finding>,
    pub summary: Option<HistorySummary>,
    /// Folder name under `chats/` and `workspaces/`, made from the title. Empty until first saved.
    pub slug: String,
    other: serde_json::Map<String, serde_json::Value>,
}

/// What the sidebar needs without holding every chat in memory.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ChatMeta {
    pub id: String,
    pub title: String,
    pub archived: bool,
    pub updated_at: u64,
    pub message_count: usize,
    pub slug: String,
}

// ---------------------------------------------------------------- on disk
//
// The web app's layout and JSON, field for field (src/lib/store.ts), so both
// apps open the same chats: `chats/<slug>/chat.json`, `workspaces/<slug>/`.

mod wire {
    use super::*;
    use serde_json::{Map, Value};

    #[derive(Serialize, Deserialize)]
    #[serde(tag = "kind", rename_all = "lowercase")]
    pub enum Step {
        Text { text: String },
        Tool { id: String },
        Think { start: usize, end: usize },
        /// Desktop only: a one-line note from the app.
        Notice { text: String },
    }

    #[derive(Serialize, Deserialize, Default)]
    #[serde(rename_all = "camelCase", default)]
    pub struct Tool {
        pub id: String,
        pub name: String,
        pub args: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub ok: Option<bool>,
        #[serde(skip_serializing_if = "String::is_empty")]
        pub summary: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub changed_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub shown_image: Option<Shown>,
    }

    #[derive(Serialize, Deserialize, Default)]
    #[serde(default)]
    pub struct Shown {
        pub url: String,
        pub path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub caption: Option<String>,
    }

    #[derive(Serialize, Deserialize, Default)]
    #[serde(rename_all = "camelCase", default)]
    pub struct Msg {
        pub id: String,
        pub role: Role,
        pub content: String,
        pub attachments: Option<Vec<Attachment>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub reasoning_content: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub thinking_effort: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub search_results: Option<Vec<SearchResult>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub search_queries: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub search_usd: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub plugins_used: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub token_count: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub usage: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub duration_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub reasoning_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub context_tokens: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub context_breakdown: Option<Vec<Bucket>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub ending: Option<Value>,
        pub created_at: String,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        pub incomplete: bool,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        pub note: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub timeline: Option<Vec<Step>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub tool_events: Option<Vec<Tool>>,
        /// Desktop only.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub error: Option<String>,
        #[serde(flatten)]
        pub other: Map<String, Value>,
    }

    #[derive(Serialize, Deserialize, Default)]
    #[serde(default)]
    pub struct Desktop {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub folder: Option<PathBuf>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub plan: Option<Plan>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        pub findings: Vec<Finding>,
    }

    #[derive(Serialize, Deserialize, Default)]
    #[serde(rename_all = "camelCase", default)]
    pub struct Conv {
        pub id: String,
        pub title: String,
        pub archived: bool,
        pub created_at: String,
        pub updated_at: String,
        pub messages: Vec<Msg>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub history_summary: Option<HistorySummary>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub desktop: Option<Desktop>,
        #[serde(flatten)]
        pub other: Map<String, Value>,
    }

    /// The sidebar's view: `messages` is only counted, never built.
    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase", default)]
    pub struct Summary {
        pub id: String,
        pub title: String,
        pub archived: bool,
        pub updated_at: String,
        pub messages: Vec<serde::de::IgnoredAny>,
    }
}

pub fn iso(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64).unwrap_or_default().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn from_iso(text: &str) -> u64 {
    chrono::DateTime::parse_from_rfc3339(text).map_or(0, |d| d.timestamp_millis().max(0) as u64)
}

/// A byte offset moved back onto a character boundary, so slicing never panics on odd files.
fn floor_char(text: &str, at: usize) -> usize {
    let mut at = at.min(text.len());
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// The web app counts timeline offsets in UTF-16 units; Rust strings are UTF-8.
fn utf16_to_byte(text: &str, units: usize) -> usize {
    let mut seen = 0;
    for (byte, ch) in text.char_indices() {
        if seen >= units {
            return byte;
        }
        seen += ch.len_utf16();
    }
    text.len()
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

impl From<wire::Msg> for Message {
    fn from(w: wire::Msg) -> Message {
        let reasoning = w.reasoning_content.unwrap_or_default();
        let incomplete = w.incomplete;
        let mut order: Vec<String> = Vec::new();
        let mut tools: std::collections::HashMap<String, ToolEvent> = w
            .tool_events
            .unwrap_or_default()
            .into_iter()
            .map(|t| {
                let (image, image_url, caption) = match t.shown_image {
                    Some(s) => (Some(PathBuf::from(s.path)), s.url, s.caption.unwrap_or_default()),
                    None => (None, String::new(), String::new()),
                };
                order.push(t.id.clone());
                // A saved step is over: one with no verdict was cut short.
                (t.id.clone(), ToolEvent { id: t.id, name: t.name, args: t.args, ok: t.ok.or(Some(!incomplete)), summary: t.summary, image, image_url, caption, changed_path: t.changed_path })
            })
            .collect();
        let thinking_ms = w.reasoning_ms.unwrap_or(0).max(1);
        let mut parts = Vec::new();
        let mut loose_reasoning = String::new();
        match w.timeline {
            Some(steps) if !steps.is_empty() => {
                for step in steps {
                    match step {
                        wire::Step::Text { text } => parts.push(Part::Text(text)),
                        wire::Step::Notice { text } => parts.push(Part::Notice(text)),
                        wire::Step::Tool { id } => parts.extend(tools.remove(&id).map(Part::Tool)),
                        wire::Step::Think { start, end } => {
                            let (a, b) = (floor_char(&reasoning, utf16_to_byte(&reasoning, start)), floor_char(&reasoning, utf16_to_byte(&reasoning, end)));
                            if b > a {
                                parts.push(Part::Thinking { text: reasoning[a..b].to_string(), ms: thinking_ms });
                            }
                        }
                    }
                }
                if !parts.iter().any(|p| matches!(p, Part::Thinking { .. })) {
                    loose_reasoning = reasoning;
                }
                // A timeline that lost its text (older saves) still shows the answer.
                if !w.content.is_empty() && !parts.iter().any(|p| matches!(p, Part::Text(_))) {
                    parts.push(Part::Text(w.content));
                }
            }
            _ => {
                if !reasoning.is_empty() {
                    parts.push(Part::Thinking { text: reasoning, ms: thinking_ms });
                }
                parts.extend(order.iter().filter_map(|id| tools.remove(id)).map(Part::Tool));
                if !w.content.is_empty() {
                    parts.push(Part::Text(w.content));
                }
            }
        }
        let had_steps = parts.iter().any(|p| matches!(p, Part::Tool(_)));
        let usage = w.usage.as_ref().map(Usage::from_wire).map(|mut u| {
            // `usage` is summed over the reply's requests, so it is not the size of the newest one. Earlier versions
            // saved that sum as the context size of replies with steps: such a number is dropped, not shown.
            u.context = match w.context_tokens {
                Some(stored) if had_steps && stored == u.prompt + u.completion => 0,
                Some(stored) => stored,
                None if had_steps => 0,
                None => u.context,
            };
            u
        });
        Message {
            id: w.id,
            role: w.role,
            parts,
            model: w.model.unwrap_or_default(),
            usage: usage.unwrap_or_default(),
            cost: None,
            duration_ms: w.duration_ms.unwrap_or(0),
            reasoning_ms: w.reasoning_ms.unwrap_or(0),
            error: w.error,
            finish: w.ending.as_ref().and_then(|e| e["finish"].as_str()).map(String::from),
            incomplete,
            attachments: w.attachments.unwrap_or_default(),
            created_at: from_iso(&w.created_at),
            effort: w.thinking_effort,
            search_results: w.search_results.unwrap_or_default(),
            search_queries: w.search_queries.unwrap_or_default(),
            search_usd: w.search_usd.unwrap_or(0.0),
            plugins_used: w.plugins_used.unwrap_or_default(),
            context_breakdown: w.context_breakdown.unwrap_or_default(),
            note: w.note,
            loose_reasoning,
            raw_usage: w.usage,
            raw_ending: w.ending,
            other: w.other,
        }
    }
}

impl From<&Message> for wire::Msg {
    fn from(m: &Message) -> wire::Msg {
        let assistant = m.role == Role::Assistant;
        let reasoning = m.reasoning();
        let (mut timeline, mut tools, mut at) = (Vec::new(), Vec::new(), 0);
        for part in &m.parts {
            match part {
                Part::Text(text) => timeline.push(wire::Step::Text { text: text.clone() }),
                Part::Notice(text) => timeline.push(wire::Step::Notice { text: text.clone() }),
                Part::Thinking { text, .. } => {
                    let len = utf16_len(text);
                    timeline.push(wire::Step::Think { start: at, end: at + len });
                    at += len;
                }
                Part::Tool(t) => {
                    timeline.push(wire::Step::Tool { id: t.id.clone() });
                    tools.push(wire::Tool {
                        id: t.id.clone(),
                        name: t.name.clone(),
                        args: t.args.clone(),
                        ok: t.ok,
                        summary: t.summary.clone(),
                        changed_path: t.changed_path.clone(),
                        shown_image: t.image.as_ref().map(|p| wire::Shown { url: t.image_url.clone(), path: p.to_string_lossy().replace('\\', "/"), caption: (!t.caption.is_empty()).then(|| t.caption.clone()) }),
                    });
                }
            }
        }
        let u = &m.usage;
        let used = u.prompt + u.completion > 0;
        wire::Msg {
            id: m.id.clone(),
            role: m.role,
            content: m.text(),
            attachments: (!m.attachments.is_empty()).then(|| m.attachments.clone()),
            reasoning_content: (!reasoning.is_empty()).then_some(reasoning),
            thinking_effort: m.effort.clone(),
            search_results: (!m.search_results.is_empty()).then(|| m.search_results.clone()),
            search_queries: (!m.search_queries.is_empty()).then(|| m.search_queries.clone()),
            search_usd: (m.search_usd > 0.0).then_some(m.search_usd),
            plugins_used: (!m.plugins_used.is_empty()).then(|| m.plugins_used.clone()),
            token_count: used.then_some(u.prompt + u.completion),
            usage: m.raw_usage.clone().or_else(|| used.then(|| {
                serde_json::json!({
                    "prompt_tokens": u.prompt, "completion_tokens": u.completion, "total_tokens": u.prompt + u.completion,
                    "prompt_cache_hit_tokens": u.cache_hit, "prompt_cache_miss_tokens": if u.cache_miss > 0 { u.cache_miss } else { u.prompt.saturating_sub(u.cache_hit) },
                    "completion_tokens_details": { "reasoning_tokens": u.reasoning },
                })
            })),
            model: (!m.model.is_empty()).then(|| m.model.clone()),
            duration_ms: (m.duration_ms > 0).then_some(m.duration_ms),
            reasoning_ms: (m.reasoning_ms > 0).then_some(m.reasoning_ms),
            context_tokens: (u.context > 0).then_some(u.context),
            context_breakdown: (!m.context_breakdown.is_empty()).then(|| m.context_breakdown.clone()),
            ending: m.raw_ending.clone().or_else(|| (assistant && m.finish.is_some()).then(|| serde_json::json!({ "finish": m.finish, "continuedOutput": 0, "continuedConnection": 0, "thinkOnlyStalls": 0 }))),
            created_at: iso(m.created_at),
            incomplete: m.incomplete,
            note: m.note,
            timeline: (assistant && !timeline.is_empty()).then_some(timeline),
            tool_events: (!tools.is_empty()).then_some(tools),
            error: m.error.clone(),
            other: m.other.clone(),
        }
    }
}

/// The web app's `slugify`: a readable, safe folder name from a title. Empty when nothing usable survives.
pub fn slugify(title: &str) -> String {
    const RESERVED: [&str; 22] = ["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"];
    let mut out = String::new();
    for ch in title.chars().flat_map(char::to_lowercase) {
        // ponytail: accents are dropped, not folded ("Café" gives "caf", the web app gives "cafe"). Add unicode-normalization if titles need it.
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let mut s = out.trim_matches('-').to_string();
    if s.len() > 48 {
        s.truncate(48);
        s = s.trim_end_matches('-').to_string();
    }
    if RESERVED.contains(&s.as_str()) { format!("{s}-chat") } else { s }
}

fn unique_slug(title: &str, taken: &std::collections::HashSet<String>, fallback: &str) -> String {
    let base = [slugify(title), slugify(fallback)].into_iter().find(|s| !s.is_empty()).unwrap_or_else(|| "chat".into());
    if !taken.contains(&base) {
        return base;
    }
    (2..1000).map(|n| format!("{base}-{n}")).find(|s| !taken.contains(s)).unwrap_or_else(|| format!("{base}-{}", new_id()))
}

fn chats_dir() -> PathBuf {
    data_dir().join("chats")
}

impl Conversation {
    pub fn new() -> Conversation {
        let now = now_ms();
        Conversation { id: new_id(), title: "New chat".into(), created_at: now, updated_at: now, ..Default::default() }
    }

    fn from_wire(w: wire::Conv, slug: String) -> Conversation {
        let desktop = w.desktop.unwrap_or_default();
        Conversation {
            id: w.id,
            title: w.title,
            archived: w.archived,
            created_at: from_iso(&w.created_at),
            updated_at: from_iso(&w.updated_at),
            messages: w.messages.into_iter().map(Message::from).collect(),
            folder: desktop.folder,
            plan: desktop.plan,
            findings: desktop.findings,
            summary: w.history_summary,
            slug,
            other: w.other,
        }
    }

    fn to_wire(&self) -> wire::Conv {
        let desktop = wire::Desktop { folder: self.folder.clone(), plan: self.plan.clone(), findings: self.findings.clone() };
        wire::Conv {
            id: self.id.clone(),
            title: self.title.clone(),
            archived: self.archived,
            created_at: iso(self.created_at),
            updated_at: iso(self.updated_at),
            messages: self.messages.iter().map(wire::Msg::from).collect(),
            history_summary: self.summary.clone(),
            desktop: (desktop.folder.is_some() || desktop.plan.is_some() || !desktop.findings.is_empty()).then_some(desktop),
            other: self.other.clone(),
        }
    }

    /// The chat as the web app's JSON: what "Download → JSON" writes and "Import chats" reads.
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(&self.to_wire()).unwrap_or_default()
    }

    /// The chats in an export, cleaned the way the web's `importConversations` cleans them: one chat or an array of them,
    /// only user and assistant messages with text, a fresh id for each chat and message, and no chat without a usable
    /// message. The second list is the web's error line for each chat that was left out for that reason.
    pub fn import_chats(raw: &serde_json::Value) -> (Vec<Conversation>, Vec<String>) {
        let candidates: Vec<&serde_json::Value> = match raw {
            serde_json::Value::Array(list) => list.iter().collect(),
            single => vec![single],
        };
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let (mut chats, mut errors) = (Vec::new(), Vec::new());
        for candidate in candidates {
            let Some(conv) = candidate.as_object() else { continue };
            let messages: Vec<serde_json::Value> = conv
                .get("messages")
                .and_then(|m| m.as_array())
                .into_iter()
                .flatten()
                .filter(|m| matches!(m["role"].as_str(), Some("user" | "assistant")) && m["content"].is_string())
                .map(|m| {
                    let mut m = m.clone();
                    m["id"] = serde_json::json!(new_id());
                    if m["createdAt"].is_null() {
                        m["createdAt"] = serde_json::json!(now);
                    }
                    m
                })
                .collect();
            if messages.is_empty() {
                let title: String = conv.get("title").and_then(|t| t.as_str()).unwrap_or("untitled").chars().take(40).collect();
                errors.push(format!("\"{title}\" had no usable messages"));
                continue;
            }
            let title: String = match conv.get("title").and_then(|t| t.as_str()).filter(|t| !t.trim().is_empty()) {
                Some(t) => t.chars().take(200).collect(),
                None => "Imported chat".into(),
            };
            let created = conv.get("createdAt").and_then(|c| c.as_str()).map_or(now.clone(), String::from);
            let wire_json = serde_json::json!({ "id": new_id(), "title": title, "archived": false, "createdAt": created, "updatedAt": now, "messages": messages });
            if let Ok(w) = serde_json::from_value::<wire::Conv>(wire_json) {
                chats.push(Self::from_wire(w, String::new()));
            }
        }
        (chats, errors)
    }

    pub fn load(id: &str) -> Option<Conversation> {
        flush();
        let slug = Self::list().into_iter().find(|c| c.id == id)?.slug;
        let w: wire::Conv = serde_json::from_slice(&std::fs::read(chats_dir().join(&slug).join("chat.json")).ok()?).ok()?;
        Some(Self::from_wire(w, slug))
    }

    /// Saves the chat. The folder is named after the title and follows a rename, and the workspace folder with it.
    /// The file itself is written by another thread (`flush` waits for it), so a long chat does not hold up the window.
    pub fn save(&mut self) {
        let taken: std::collections::HashSet<String> = Self::list().into_iter().filter(|c| c.id != self.id).map(|c| c.slug).collect();
        let wanted = unique_slug(&self.title, &taken, &self.id);
        // A numeric suffix added to dodge a clash is not a reason to rename on every save.
        let settled = !self.slug.is_empty() && (self.slug == wanted || self.slug.trim_end_matches(|c: char| c.is_ascii_digit()).trim_end_matches('-') == slugify(&self.title));
        if !settled {
            // Nothing may still be on its way to the old folder when it moves.
            flush();
            let moved = self.slug.is_empty() || std::fs::rename(chats_dir().join(&self.slug), chats_dir().join(&wanted)).is_ok();
            if moved {
                // Files can arrive before the chat is named; they follow it.
                let old = if self.slug.is_empty() { self.id.clone() } else { self.slug.clone() };
                let _ = std::fs::rename(data_dir().join("workspaces").join(&old), data_dir().join("workspaces").join(&wanted));
                let _ = std::fs::rename(data_dir().join("state").join(&old), data_dir().join("state").join(&wanted));
                // A connected GitHub repository is keyed by the same folder name, so it follows too.
                let links = data_dir().join("github").join("workspaces");
                let _ = std::fs::rename(links.join(format!("{old}.json")), links.join(format!("{wanted}.json")));
                LISTED.lock().unwrap().remove(&chats_dir().join(&old).join("chat.json"));
                self.slug = wanted;
            }
        }
        let path = chats_dir().join(&self.slug).join("chat.json");
        // The sidebar hears of the save now, not when the file lands.
        let meta = ChatMeta { id: self.id.clone(), title: self.title.clone(), archived: self.archived, updated_at: self.updated_at, message_count: self.messages.len(), slug: self.slug.clone() };
        let mut listed = LISTED.lock().unwrap();
        let waiting = listed.get(&path).map_or(0, |l| l.waiting) + 1;
        listed.insert(path.clone(), Listed { stamp: None, waiting, meta });
        drop(listed);
        let _ = WRITER.send(Job::Write(path, Box::new(self.to_wire())));
    }

    /// Removes the chat and its own folder. A folder the user picked is never touched.
    pub fn delete(id: &str) {
        flush();
        let Some(meta) = Self::list().into_iter().find(|c| c.id == id) else { return };
        let _ = std::fs::remove_dir_all(chats_dir().join(&meta.slug));
        let _ = std::fs::remove_dir_all(data_dir().join("workspaces").join(&meta.slug));
        let _ = std::fs::remove_dir_all(data_dir().join("state").join(&meta.slug));
    }

    fn own_folder(&self) -> &str {
        if self.slug.is_empty() { &self.id } else { &self.slug }
    }

    /// Where the agent's file tools work for this chat.
    pub fn workspace(&self) -> PathBuf {
        self.folder.clone().unwrap_or_else(|| data_dir().join("workspaces").join(self.own_folder()))
    }

    /// Undo history and other per-chat files that must not sit in the workspace.
    pub fn state_dir(&self) -> PathBuf {
        data_dir().join("state").join(self.own_folder())
    }

    /// Newest first. A chat file is read again only when its size or time changed, as the web app does it.
    pub fn list() -> Vec<ChatMeta> {
        let dir = chats_dir();
        let mut listed = LISTED.lock().unwrap();
        // A chat saved a moment ago is listed from memory: its file may not be written yet.
        let mut fresh: std::collections::BTreeMap<PathBuf, Listed> = listed.iter().filter(|(path, l)| l.waiting > 0 && path.starts_with(&dir)).map(|(path, l)| (path.clone(), l.clone())).collect();
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten().filter(|e| e.path().is_dir()) {
            let path = entry.path().join("chat.json");
            if fresh.contains_key(&path) {
                continue;
            }
            let Some(stamp) = stamp_of(&path) else { continue };
            let known = listed.get(&path).filter(|l| l.stamp == Some(stamp)).cloned();
            let read = || {
                let w: wire::Summary = serde_json::from_slice(&std::fs::read(&path).ok()?).ok()?;
                let meta = ChatMeta { id: w.id, title: w.title, archived: w.archived, updated_at: from_iso(&w.updated_at), message_count: w.messages.len(), slug: entry.file_name().to_string_lossy().into_owned() };
                Some(Listed { stamp: Some(stamp), waiting: 0, meta })
            };
            if let Some(l) = known.or_else(read) {
                fresh.insert(path, l);
            }
        }
        *listed = fresh;
        let mut out: Vec<ChatMeta> = listed.values().map(|l| l.meta.clone()).filter(|c| !c.id.is_empty()).collect();
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        out
    }
}

/// One chat file as the sidebar last saw it.
#[derive(Clone)]
struct Listed {
    /// Size and time of the file `meta` was read from. None while a save is still to be written.
    stamp: Option<(u64, std::time::SystemTime)>,
    /// Saves of this chat still waiting to be written.
    waiting: u32,
    meta: ChatMeta,
}

static LISTED: std::sync::Mutex<std::collections::BTreeMap<PathBuf, Listed>> = std::sync::Mutex::new(std::collections::BTreeMap::new());

fn stamp_of(path: &Path) -> Option<(u64, std::time::SystemTime)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

enum Job {
    Write(PathBuf, Box<wire::Conv>),
    Flush(std::sync::mpsc::Sender<()>),
}

/// The thread that writes chat files, one after another, in the order they were saved.
static WRITER: std::sync::LazyLock<std::sync::mpsc::Sender<Job>> = std::sync::LazyLock::new(|| {
    let (tx, rx) = std::sync::mpsc::channel::<Job>();
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let jobs: Vec<Job> = std::iter::once(first).chain(rx.try_iter()).collect();
            for (i, job) in jobs.iter().enumerate() {
                match job {
                    Job::Flush(done) => {
                        let _ = done.send(());
                    }
                    Job::Write(path, conv) => {
                        // Several saves of one chat in line: only the newest is worth the disk.
                        let newest = !jobs[i + 1..].iter().any(|later| matches!(later, Job::Write(other, _) if other == path));
                        if newest && let Ok(json) = serde_json::to_vec_pretty(conv) {
                            let _ = write_atomic(path, &json);
                        }
                        if let Some(listed) = LISTED.lock().unwrap().get_mut(path) {
                            listed.waiting = listed.waiting.saturating_sub(1);
                            if listed.waiting == 0 {
                                listed.stamp = stamp_of(path);
                            }
                        }
                    }
                }
            }
        }
    });
    tx
});

/// Waits until every chat saved so far is on disk. Call before reading chat files, and before the program ends.
pub fn flush() {
    let (done, wait) = std::sync::mpsc::channel();
    if WRITER.send(Job::Flush(done)).is_ok() {
        let _ = wait.recv();
    }
}

/// First line of the first message, trimmed to a sidebar-sized title.
pub fn derive_title(message: &str) -> String {
    let line = message.lines().find(|l| !l.trim().is_empty()).unwrap_or("New chat").trim();
    let mut title: String = line.chars().take(48).collect();
    if line.chars().count() > 48 {
        title.push('…');
    }
    title
}

#[cfg(test)]
mod tests {
    /// The web's import cleaning: one chat or many, partial records kept, fresh ids, and nothing without a usable message.
    #[test]
    fn an_export_imports_the_way_the_web_app_reads_it() {
        let raw = serde_json::json!([
            { "id": "old", "title": "  ", "messages": [{ "role": "user", "content": "hi" }, { "role": "system", "content": "x" }, { "role": "assistant", "content": 5 }, { "role": "assistant", "content": "hello", "createdAt": "2026-10-01T10:01:00.000Z" }] },
            { "title": "Empty", "messages": [{ "role": "system", "content": "x" }] },
            7
        ]);
        let (chats, errors) = Conversation::import_chats(&raw);
        assert_eq!(chats.len(), 1);
        assert_eq!((chats[0].title.as_str(), chats[0].id == "old"), ("Imported chat", false));
        assert_eq!(chats[0].messages.iter().map(|m| m.text()).collect::<Vec<_>>(), ["hi", "hello"]);
        assert_eq!(errors, ["\"Empty\" had no usable messages"]);
    }

    use super::*;

    /// Timings against real chats, read-only: `APIM_DATA_DIR=<data> cargo test --release perf_probe -- --ignored --nocapture`.
    #[test]
    #[ignore = "reads the real data folder"]
    fn perf_probe() {
        let t = std::time::Instant::now();
        let all = Conversation::list();
        eprintln!("list (cold): {} chats in {:?}", all.len(), t.elapsed());
        let t = std::time::Instant::now();
        let again = Conversation::list();
        eprintln!("list (again): {} chats in {:?}", again.len(), t.elapsed());
        for meta in all.iter().take(6) {
            let t = std::time::Instant::now();
            let conv = Conversation::load(&meta.id).unwrap();
            let loaded = t.elapsed();
            let t = std::time::Instant::now();
            let wire = conv.to_wire();
            let copied = t.elapsed();
            let bytes = serde_json::to_vec_pretty(&wire).unwrap().len();
            eprintln!("{}: load {loaded:?}, copy for saving {copied:?}, serialise {:?} ({} MB, {} messages)", meta.slug, t.elapsed(), bytes / 1_048_576, conv.messages.len());
            let t = std::time::Instant::now();
            let files = crate::snapshots::list_files(&conv.workspace()).len();
            eprintln!("    workspace: {files} files listed in {:?}", t.elapsed());
        }
    }

    #[test]
    fn round_trip() {
        let dir = std::env::temp_dir().join(format!("apim-test-{}", new_id()));
        // SAFETY: tests in this module are the only ones touching this variable.
        unsafe { std::env::set_var("APIM_DATA_DIR", &dir) };

        let mut s = Settings::default();
        s.model = "x".into();
        s.save();
        assert_eq!(Settings::load().model, "x");

        let mut c = Conversation::new();
        c.title = derive_title("\n  Hello, there!  \nsecond");
        c.messages.push(Message::new(Role::User, "hello"));
        c.messages.push(Message {
            parts: vec![
                Part::Thinking { text: "hm 🙂".into(), ms: 5 },
                Part::Text("a".into()),
                Part::Tool(ToolEvent { id: "t1".into(), name: "read_file".into(), ok: Some(true), ..Default::default() }),
                Part::Thinking { text: "more".into(), ms: 5 },
                Part::Text("b".into()),
            ],
            reasoning_ms: 5,
            ..Message::new(Role::Assistant, "")
        });
        c.save();
        flush();
        assert_eq!(c.slug, "hello-there");
        assert!(dir.join("chats/hello-there/chat.json").exists());
        let back = Conversation::load(&c.id).unwrap();
        // Timestamps are whole milliseconds on disk, so the copy compares equal.
        assert_eq!(back, c);
        assert_eq!(back.messages[1].text(), "a\n\nb");

        // The web app's own field names are what is on disk.
        let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("chats/hello-there/chat.json")).unwrap()).unwrap();
        assert_eq!(raw["messages"][1]["reasoningContent"], "hm 🙂more");
        assert_eq!(raw["messages"][1]["timeline"][3], serde_json::json!({ "kind": "think", "start": 5, "end": 9 }));
        assert_eq!(raw["messages"][1]["toolEvents"][0]["name"], "read_file");

        // A rename moves the folder; a second chat with the same title gets its own.
        std::fs::create_dir_all(c.workspace()).unwrap();
        c.title = "Budget".into();
        c.save();
        flush();
        assert!(dir.join("chats/budget/chat.json").exists() && !dir.join("chats/hello-there").exists());
        assert!(dir.join("workspaces/budget").exists());
        let mut twin = Conversation::new();
        twin.title = "Budget".into();
        twin.save();
        assert_eq!(twin.slug, "budget-2");
        assert_eq!(Conversation::list().len(), 2);

        Conversation::delete(&c.id);
        assert!(Conversation::load(&c.id).is_none());
        assert_eq!(slugify("  CON "), "con-chat");
        assert_eq!(slugify("🙂🙂"), "");
        let _ = std::fs::remove_dir_all(dir);
    }
}

// ---------------------------------------------------------------- search across chats

/// One chat that matched a search (`searchConversations` in src/lib/store.ts).
#[derive(Clone, Debug, PartialEq)]
pub struct SearchHit {
    pub id: String,
    pub title: String,
    pub archived: bool,
    pub updated_at: u64,
    /// Messages that contain the text.
    pub match_count: usize,
    pub title_match: bool,
    /// The first three of them: (written by the user, the text around the match).
    pub snippets: Vec<(bool, String)>,
}

/// Lower-cased one character at a time, so positions line up with the original.
fn lowered(text: &str) -> Vec<char> {
    text.chars().map(|c| c.to_lowercase().next().unwrap_or(c)).collect()
}

fn find(hay: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// 45 characters before the match and 75 after it, on one line.
fn snippet(content: &str, needle: &[char]) -> String {
    let chars: Vec<char> = content.chars().collect();
    let Some(at) = find(&lowered(content), needle) else { return chars.iter().take(120).collect::<String>().trim().to_string() };
    let start = at.saturating_sub(45);
    let end = (at + needle.len() + 75).min(chars.len());
    let middle: String = chars[start..end].iter().collect();
    format!("{}{}{}", if start > 0 { "…" } else { "" }, middle.split_whitespace().collect::<Vec<_>>().join(" "), if end < chars.len() { "…" } else { "" })
}

/// Every chat whose title or messages contain `query`, whatever its case: title matches
/// first, then the most matches, then the most recent.
// ponytail: a linear scan of every chat.json per search. Index the text if the history grows past a few thousand chats.
pub fn search_chats(query: &str, limit: usize) -> Vec<SearchHit> {
    flush();
    let needle = lowered(query.trim());
    if needle.is_empty() {
        return Vec::new();
    }
    let mut hits = Vec::new();
    for entry in std::fs::read_dir(chats_dir()).into_iter().flatten().flatten().filter(|e| e.path().is_dir()) {
        let Some(conv) = std::fs::read(entry.path().join("chat.json")).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) else { continue };
        let title = conv["title"].as_str().unwrap_or_default();
        let title_match = find(&lowered(title), &needle).is_some();
        let matching: Vec<&serde_json::Value> = conv["messages"].as_array().into_iter().flatten().filter(|m| m["content"].as_str().is_some_and(|c| find(&lowered(c), &needle).is_some())).collect();
        if !title_match && matching.is_empty() {
            continue;
        }
        hits.push(SearchHit {
            id: conv["id"].as_str().unwrap_or_default().to_string(),
            title: title.to_string(),
            archived: conv["archived"].as_bool().unwrap_or(false),
            updated_at: from_iso(conv["updatedAt"].as_str().unwrap_or_default()),
            match_count: matching.len(),
            title_match,
            snippets: matching.iter().take(3).map(|m| (m["role"] == "user", snippet(m["content"].as_str().unwrap_or_default(), &needle))).collect(),
        });
    }
    hits.sort_by(|a, b| b.title_match.cmp(&a.title_match).then(b.match_count.cmp(&a.match_count)).then(b.updated_at.cmp(&a.updated_at)));
    hits.truncate(limit);
    hits
}

#[cfg(test)]
mod search_tests {
    use super::*;

    #[test]
    fn snippets_keep_the_match_in_view() {
        let needle = lowered("NEEDLE");
        let text = format!("{}\n\n  the Needle  is here {}", "a".repeat(100), "b".repeat(200));
        let s = snippet(&text, &needle);
        assert!(s.starts_with('…') && s.ends_with('…') && s.contains("the Needle is here"));
        // 45 before + 6 + 75 after, less the collapsed whitespace.
        assert!(s.chars().count() <= 45 + 6 + 75 + 2);
        assert_eq!(snippet("short Needle", &needle), "short Needle");
        assert_eq!(snippet("  nothing to see  ", &needle), "nothing to see");
    }
}

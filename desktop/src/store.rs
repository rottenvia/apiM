//! Settings and chats on disk. Plain JSON under the user's app-data folder.

use crate::models::{CustomModel, DEFAULT_MODEL_ID, Usage};
use crate::plugins::Plugin;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

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
    /// The agent runs on its own, but still asks before the critical actions: an install into the
    /// machine, adding a skill, and changing a process the app did not start.
    Critical,
    /// The agent runs everything without asking, installs included.
    Auto,
}

impl Approval {
    /// Manual only: the user approves each command and change that is not plain reading.
    pub fn asks_routine(self) -> bool {
        matches!(self, Approval::Manual)
    }
    /// Manual and Critical: the user approves the critical actions — an install into the machine,
    /// adding a skill, changing a process the app did not start. Auto approves nothing.
    pub fn asks_critical(self) -> bool {
        !matches!(self, Approval::Auto)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Settings {
    // ponytail: keys sit in plain JSON in the user's profile, like the web
    // version's localStorage. Move to the OS keyring if this machine is shared.
    pub deepseek_key: String,
    pub openrouter_key: String,
    /// For Claude models on Anthropic's own API.
    pub anthropic_key: String,
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
    /// The app's own models taken out of the model menu (right-click there); Settings → Models brings them back.
    pub hidden_models: Vec<String>,
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
            anthropic_key: String::new(),
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
            hidden_models: Vec::new(),
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

    /// How many models the model menu lists.
    pub fn in_menu(&self) -> usize {
        crate::models::MODELS.iter().filter(|m| !self.hidden_models.contains(&m.id)).count() + self.custom_models.len()
    }

    /// Takes a model out of the model menu: one of the app's own is hidden (Settings → Models shows it again), one of the
    /// user's is removed. The model in use moves to the first one left. False, and nothing done, for the last one.
    pub fn drop_from_menu(&mut self, id: &str) -> bool {
        if self.in_menu() <= 1 {
            return false;
        }
        match self.custom_models.iter().position(|c| c.id() == id) {
            Some(i) => drop(self.custom_models.remove(i)),
            // Hidden already, and back in the menu only as the model in use: it is moved off.
            None if self.hidden_models.iter().any(|h| h == id) => {
                if self.model != id {
                    return false;
                }
            }
            None if crate::models::MODELS.iter().any(|m| m.id == id) => self.hidden_models.push(id.to_string()),
            None => return false,
        }
        if self.model == id {
            let first = crate::models::MODELS.iter().find(|m| !self.hidden_models.contains(&m.id)).map(|m| m.id.clone());
            self.model = first.or_else(|| self.custom_models.first().map(CustomModel::id)).unwrap_or_else(|| DEFAULT_MODEL_ID.into());
        }
        true
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
    pub fn anthropic(&self) -> String {
        self.key(&self.anthropic_key, "ANTHROPIC_API_KEY")
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
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
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
        // A reply still holding the transcript it was being written from never ended: the app was closed or died under
        // it, and nothing marked it. Unmarked, it came back with no word that it had stopped and no Resume.
        let incomplete = w.incomplete || (w.role == Role::Assistant && w.other.contains_key("resumeState"));
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
        // The reply's thinking time, shared out over its thinks. Each used to get all of it, and ending a resumed reply adds
        // them up: the total was multiplied by the number of thinks on every Resume (one reply reached 783 hours).
        let thinks = w.timeline.iter().flatten().filter(|step| matches!(step, wire::Step::Think { .. })).count().max(1) as u64;
        let thinking_ms = (w.reasoning_ms.unwrap_or(0) / thinks).max(1);
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
            messages: {
                // Only the last reply can be resumed (`App::resume`): the transcript an earlier unfinished one kept is
                // dead weight. One chat's file held 155 MB of it across its replies, read into memory and written out
                // again with every save. Whether a reply ended is read before this (`Message::from`).
                let mut messages: Vec<Message> = w.messages.into_iter().map(Message::from).collect();
                let earlier = messages.len().saturating_sub(1);
                messages[..earlier].iter_mut().for_each(|m| drop(m.other.remove("resumeState")));
                messages
            },
            folder: desktop.folder,
            plan: desktop.plan,
            findings: desktop.findings,
            // A stored "summary" that is the model declining to write one is no summary: the turns go out as they would with none.
            summary: w.history_summary.filter(|s| !crate::summary::declined(&s.text)),
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
        Self::load_showing(id, None)
    }

    /// `load`, telling `progress` how far the file has come: a long chat takes seconds to read.
    pub fn load_showing(id: &str, progress: Option<&Progress>) -> Option<Conversation> {
        flush();
        let slug = Self::list().into_iter().find(|c| c.id == id)?.slug;
        let path = chats_dir().join(&slug).join("chat.json");
        if let Some(progress) = progress {
            progress.total.store(stamp_of(&path).map_or(0, |stamp| stamp.0), Ordering::Relaxed);
        }
        let w: wire::Conv = read_chat(&path, progress, true)?;
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
        // The chat leaves the list with its file. Its folders are cleared off the window's thread: a workspace
        // can hold hundreds of megabytes, and the window stood still for 1.4 s while one was deleted.
        // ponytail: a program closed in that second leaves what was not yet removed; sweep folders without a chat.json at start if that shows.
        let folders = [chats_dir().join(&meta.slug), data_dir().join("workspaces").join(&meta.slug), data_dir().join("state").join(&meta.slug)];
        let _ = std::fs::remove_file(folders[0].join("chat.json"));
        crate::background(move || {
            for folder in folders {
                let _ = std::fs::remove_dir_all(folder);
            }
        });
    }

    fn own_folder(&self) -> &str {
        if self.slug.is_empty() { &self.id } else { &self.slug }
    }

    /// Where the agent's file tools work for this chat.
    pub fn workspace(&self) -> PathBuf {
        self.folder.clone().unwrap_or_else(|| data_dir().join("workspaces").join(self.own_folder()))
    }

    /// A list of names kept with the chat: "skills" (the plugins on for this chat alone) and "toolGroups"
    /// (the tool groups it has loaded).
    pub fn names(&self, key: &str) -> Vec<String> {
        self.other.get(key).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default()
    }

    pub fn set_names(&mut self, key: &str, names: Vec<String>) {
        if names.is_empty() {
            self.other.remove(key);
        } else {
            self.other.insert(key.into(), serde_json::json!(names));
        }
    }

    /// Undo history and other per-chat files that must not sit in the workspace.
    pub fn state_dir(&self) -> PathBuf {
        data_dir().join("state").join(self.own_folder())
    }

    /// Newest first. A chat file is read again only when its size or time changed, as the web app does it.
    pub fn list() -> Vec<ChatMeta> {
        Self::list_showing(None)
    }

    /// `list`, telling `progress` how far the reading has come: the first listing of a start can take seconds.
    pub fn list_showing(progress: Option<&Progress>) -> Vec<ChatMeta> {
        let dir = chats_dir();
        let mut listed = LISTED.lock().unwrap();
        // What the last run knew of this folder comes first: the files that have not changed since are not read.
        if SEEDED.lock().unwrap().replace(dir.clone()).as_ref() != Some(&dir) {
            for (path, known) in read_index(&dir) {
                listed.entry(path).or_insert(known);
            }
        }
        // A chat saved a moment ago is listed from memory: its file may not be written yet.
        let mut fresh: std::collections::BTreeMap<PathBuf, Listed> = listed.iter().filter(|(path, l)| l.waiting > 0 && path.starts_with(&dir)).map(|(path, l)| (path.clone(), l.clone())).collect();
        // Found first and read after, so the bar knows how much there is before the first byte of it.
        let mut unread = Vec::new();
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten().filter(|e| e.path().is_dir()) {
            let path = entry.path().join("chat.json");
            if fresh.contains_key(&path) {
                continue;
            }
            let Some(stamp) = stamp_of(&path) else { continue };
            match listed.get(&path).filter(|l| l.stamp == Some(stamp)) {
                Some(known) => drop(fresh.insert(path, known.clone())),
                None => unread.push((path, stamp, entry.file_name().to_string_lossy().into_owned())),
            }
        }
        if let Some(progress) = progress {
            progress.total.store(unread.iter().map(|(_, stamp, _)| stamp.0).sum(), Ordering::Relaxed);
        }
        for (path, stamp, slug) in unread {
            if let Some(w) = read_chat::<wire::Summary>(&path, progress, false) {
                let meta = ChatMeta { id: w.id, title: w.title, archived: w.archived, updated_at: from_iso(&w.updated_at), message_count: w.messages.len(), slug };
                fresh.insert(path, Listed { stamp: Some(stamp), waiting: 0, meta });
            }
        }
        write_index(&dir, &fresh);
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

// ---------------------------------------------------------------- the list, kept between starts
//
// Every start used to read every chat file whole to list it: 264 MB of them on one PC, before the window drew
// anything. The list is kept in `chat-index.json` beside the chats, each entry with the size and time of the
// file it was read from, and a start reads only the files that have changed since.

/// The chats folder `LISTED` was last seeded for from the kept list.
static SEEDED: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);
/// What the kept list held when it was last written: it is written again only when that changes.
static INDEXED: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Index {
    /// `PACE`, so the first bar of a start is drawn at this disk's speed.
    pace: [u64; 2],
    /// (bytes, time changed in nanoseconds, the chat) of every chat file.
    chats: Vec<(u64, u64, ChatMeta)>,
}

fn index_path(dir: &Path) -> PathBuf {
    dir.with_file_name("chat-index.json")
}

fn read_index(dir: &Path) -> Vec<(PathBuf, Listed)> {
    let index: Index = std::fs::read(index_path(dir)).ok().and_then(|raw| serde_json::from_slice(&raw).ok()).unwrap_or_default();
    for (slot, pace) in PACE.iter().zip(index.pace) {
        if pace > 0 {
            slot.store(pace, Ordering::Relaxed);
        }
    }
    let stamp = |bytes, nanos| Some((bytes, std::time::UNIX_EPOCH + std::time::Duration::from_nanos(nanos)));
    index.chats.into_iter().map(|(bytes, nanos, meta)| (dir.join(&meta.slug).join("chat.json"), Listed { stamp: stamp(bytes, nanos), waiting: 0, meta })).collect()
}

/// Hands the list to the writing thread when it differs from what is kept. A chat still on its way to disk has
/// no size and time yet and is left out: the next start reads that one file.
fn write_index(dir: &Path, listed: &std::collections::BTreeMap<PathBuf, Listed>) {
    use std::hash::{Hash, Hasher};
    let nanos = |time: std::time::SystemTime| time.duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_nanos() as u64);
    let chats: Vec<(u64, u64, ChatMeta)> = listed.values().filter_map(|l| l.stamp.map(|(bytes, time)| (bytes, nanos(time), l.meta.clone()))).collect();
    let mut print = std::collections::hash_map::DefaultHasher::new();
    dir.hash(&mut print);
    for (bytes, time, meta) in &chats {
        (bytes, time, &meta.id, &meta.title, meta.archived, &meta.slug).hash(&mut print);
    }
    if INDEXED.swap(print.finish(), Ordering::Relaxed) != print.finish() {
        let index = Index { pace: [PACE[0].load(Ordering::Relaxed), PACE[1].load(Ordering::Relaxed)], chats };
        let _ = WRITER.send(Job::Index(index_path(dir), serde_json::to_vec(&index).unwrap_or_default()));
    }
}

// ---------------------------------------------------------------- reading, with a bar

/// How far a read of chat files has come, for whoever draws a bar of it.
#[derive(Default)]
pub struct Progress {
    /// Bytes of every file this read takes in, and of the files it has finished.
    pub total: AtomicU64,
    done: AtomicU64,
    /// The file in hand: its bytes, when it was started, and whether its messages are built (an opening) or skipped (a listing).
    current: std::sync::Mutex<Option<(u64, std::time::Instant, bool)>>,
}

impl Progress {
    /// A read part way through, for a self-portrait of its bar: this much done, and a file of `in_hand` just begun.
    pub fn staged(total: u64, done: u64, in_hand: u64) -> Progress {
        Progress { total: total.into(), done: done.into(), current: Some((in_hand, std::time::Instant::now(), false)).into() }
    }

    /// (the share done, seconds left).
    pub fn eta(&self) -> (f32, f32) {
        // Held across both, so a file finishing is never counted as done and in hand at once.
        let current = self.current.lock().unwrap();
        let pace = PACE[current.is_some_and(|file| file.2) as usize].load(Ordering::Relaxed) as f32;
        eta(self.total.load(Ordering::Relaxed), self.done.load(Ordering::Relaxed), current.map(|(bytes, since, _)| (bytes, since.elapsed().as_secs_f32())), pace)
    }

    pub fn megabytes(&self) -> f32 {
        self.total.load(Ordering::Relaxed) as f32 / 1_048_576.0
    }
}

/// Bytes a second a chat file is taken in at, [listed, opened]: measured on every read of some size, and
/// remembered between starts. The file in hand is one call to the JSON reader, which says nothing until it is
/// done; this is what tells how far it has come meanwhile.
static PACE: [AtomicU64; 2] = [AtomicU64::new(400_000_000), AtomicU64::new(120_000_000)];

/// (the share done, seconds left) of a read: the files finished, and the one in hand for `secs` as far as `pace`
/// says it has come. It is never called finished before it is.
pub fn eta(total: u64, done: u64, current: Option<(u64, f32)>, pace: f32) -> (f32, f32) {
    if total == 0 {
        return (1.0, 0.0);
    }
    let pace = pace.max(1.0);
    let came = done as f32 + current.map_or(0.0, |(bytes, secs)| (pace * secs).min(bytes as f32 * 0.95));
    ((came / total as f32).min(1.0), (total as f32 - came).max(0.0) / pace)
}

/// Reads one chat file, keeping `progress` told and learning the pace from it.
fn read_chat<T: serde::de::DeserializeOwned>(path: &Path, progress: Option<&Progress>, opening: bool) -> Option<T> {
    let bytes = stamp_of(path).map_or(0, |stamp| stamp.0);
    let started = std::time::Instant::now();
    if let Some(progress) = progress {
        *progress.current.lock().unwrap() = Some((bytes, started, opening));
    }
    let read = std::fs::read(path).ok().and_then(|raw| serde_json::from_slice(&raw).ok());
    // A small file tells of the time to find it on the disk, not of the pace.
    if bytes > 4_000_000 {
        let pace = &PACE[opening as usize];
        let measured = bytes as f64 / started.elapsed().as_secs_f64().max(1e-6);
        pace.store(((pace.load(Ordering::Relaxed) as f64 + measured) / 2.0) as u64, Ordering::Relaxed);
    }
    if let Some(progress) = progress {
        let mut current = progress.current.lock().unwrap();
        progress.done.fetch_add(bytes, Ordering::Relaxed);
        *current = None;
    }
    read
}

fn stamp_of(path: &Path) -> Option<(u64, std::time::SystemTime)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

enum Job {
    Write(PathBuf, Box<wire::Conv>),
    /// The kept list of chats, already as bytes.
    Index(PathBuf, Vec<u8>),
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
                    Job::Index(path, json) => {
                        let _ = write_atomic(path, json);
                    }
                    Job::Write(path, conv) => {
                        // Several saves of one chat in line: only the newest is worth the disk.
                        let newest = !jobs[i + 1..].iter().any(|later| matches!(later, Job::Write(other, _) if other == path));
                        let started = std::time::Instant::now();
                        if newest && let Ok(json) = serde_json::to_vec_pretty(conv) {
                            let _ = write_atomic(path, &json);
                            WRITE_MS.store(started.elapsed().as_millis() as u64, std::sync::atomic::Ordering::Relaxed);
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

static WRITE_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// How long the newest chat file took to reach the disk. A reply in progress is saved no more often than
/// twenty times this: a chat of hundreds of megabytes was otherwise written out whole every five seconds.
pub fn write_cost() -> std::time::Duration {
    std::time::Duration::from_millis(WRITE_MS.load(std::sync::atomic::Ordering::Relaxed))
}

/// Waits until every chat saved so far is on disk. Call before reading chat files, and before the program ends.
pub fn flush() {
    let (done, wait) = std::sync::mpsc::channel();
    if WRITER.send(Job::Flush(done)).is_ok() {
        let _ = wait.recv();
    }
}

/// First line of the first message, trimmed to a sidebar-sized title.
pub fn derive_title(message: &str) -> String {
    // A title is plain text: the backticks around a name in the message are not part of it.
    let line = message.lines().find(|l| !l.trim().is_empty()).unwrap_or("New chat").replace('`', "");
    let line = line.trim();
    let mut title: String = line.chars().take(48).collect();
    if line.chars().count() > 48 {
        title.push('…');
    }
    title
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_model_leaves_the_menu_and_the_one_in_use_moves() {
        use crate::models::{CustomModel, MODELS, Vision};
        let mine = CustomModel { api_model: "a/b".into(), provider: crate::models::ProviderId::Openrouter, label: "AB".into(), vision: Vision::None, max_output_tokens: 5, context_length: None, input_price: None, output_price: None, open_limits: false };
        let mut s = super::Settings { model: MODELS[0].id.clone(), custom_models: vec![mine], ..Default::default() };
        // The one in use, hidden: the next of the app's own takes its place.
        assert!(s.drop_from_menu(&MODELS[0].id));
        assert_eq!((s.hidden_models.clone(), s.model.clone()), (vec![MODELS[0].id.clone()], MODELS[1].id.clone()));
        // Hidden twice, or a model that is not there: nothing. Hidden and then picked in Settings: it is moved off again.
        assert!(!s.drop_from_menu(&MODELS[0].id) && !s.drop_from_menu("nope"));
        s.model = MODELS[0].id.clone();
        assert!(s.drop_from_menu(&MODELS[0].id));
        assert_eq!((s.hidden_models.len(), s.model.clone()), (1, MODELS[1].id.clone()));
        // The user's own is removed, not hidden.
        assert!(s.drop_from_menu("custom:a/b"));
        assert!(s.custom_models.is_empty() && !s.hidden_models.contains(&"custom:a/b".to_string()));
        // Down to one, it stays.
        for m in MODELS.iter().skip(1).take(MODELS.len() - 2) {
            assert!(s.drop_from_menu(&m.id));
        }
        assert_eq!(s.in_menu(), 1);
        assert!(!s.drop_from_menu(&MODELS[MODELS.len() - 1].id));
        assert_eq!(s.model, MODELS[MODELS.len() - 1].id);
    }

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

    #[test]
    fn a_bar_follows_the_files_done_and_the_pace_of_the_one_in_hand() {
        // Nothing to read is a full bar; nothing read yet an empty one with the whole wait ahead.
        assert_eq!((eta(0, 0, None, 100.0), eta(1000, 0, None, 100.0)), ((1.0, 0.0), (0.0, 10.0)));
        // 400 of 1000 done, and two seconds into a file of 600 at 100 a second: 600 came, four seconds left.
        assert_eq!(eta(1000, 400, Some((600, 2.0)), 100.0), (0.6, 4.0));
        // A file slower than the pace said stops short of its end: the bar never claims what is not read.
        let (share, left) = eta(1000, 400, Some((600, 60.0)), 100.0);
        assert!((share - 0.97).abs() < 1e-4 && (left - 0.3).abs() < 1e-3, "{share} {left}");
    }

    #[test]
    fn the_list_is_kept_between_starts_and_only_changed_chats_are_read() {
        let dir = std::env::temp_dir().join(format!("apim-index-{}", new_id())).join("chats");
        let file = |slug: &str| dir.join(slug).join("chat.json");
        for (slug, title) in [("one", "One"), ("two", "Two")] {
            write_atomic(&file(slug), format!(r#"{{"id":"{slug}","title":"{title}","updatedAt":"2026-10-01T10:00:00.000Z","messages":[{{}},{{}}]}}"#).as_bytes()).unwrap();
        }
        let listed: std::collections::BTreeMap<PathBuf, Listed> = ["one", "two"].iter().map(|slug| (file(slug), Listed { stamp: stamp_of(&file(slug)), waiting: 0, meta: ChatMeta { id: slug.to_string(), title: "kept".into(), slug: slug.to_string(), ..Default::default() } })).collect();
        write_index(&dir, &listed);
        flush();
        // What comes back is what was kept, each with the size and time of its file, so neither is read again.
        let back = read_index(&dir);
        assert_eq!(back.len(), 2);
        assert!(back.iter().all(|(path, known)| known.stamp == stamp_of(path) && known.meta.title == "kept"), "stamps survive the round trip");
        // A file that grew no longer matches its entry.
        std::fs::write(file("two"), br#"{"id":"two","title":"Two, longer","messages":[]}"#).unwrap();
        assert_eq!(back.iter().filter(|(path, known)| known.stamp == stamp_of(path)).count(), 1);
        // A kept list that is not JSON is no list: everything is read.
        std::fs::write(index_path(&dir), b"{ half").unwrap();
        assert!(read_index(&dir).is_empty());
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

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

    /// Only the newest reply keeps the transcript it can be resumed from; an earlier one still reads as unfinished.
    #[test]
    fn a_loaded_chat_keeps_only_its_last_saved_transcript() {
        let state = serde_json::json!({ "messages": [{ "role": "user", "content": "go" }], "toolRounds": 1, "continuations": 0 });
        let reply = |id: &str| serde_json::json!({ "id": id, "role": "assistant", "content": "partly", "createdAt": "2026-01-01T00:00:00.000Z", "resumeState": state });
        let ask = |id: &str| serde_json::json!({ "id": id, "role": "user", "content": "do it", "createdAt": "2026-01-01T00:00:00.000Z" });
        let wire: wire::Conv = serde_json::from_value(serde_json::json!({ "id": "c", "title": "t", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z", "messages": [ask("u1"), reply("a1"), ask("u2"), reply("a2")] })).unwrap();
        let chat = Conversation::from_wire(wire, "t".into());
        let kept: Vec<bool> = chat.messages.iter().map(|m| m.other.contains_key("resumeState")).collect();
        assert_eq!(kept, [false, false, false, true]);
        assert!(chat.messages[1].incomplete && chat.messages[3].incomplete);
    }

    #[test]
    fn a_reply_the_app_died_under_reads_as_unfinished() {
        let stored = |extra: serde_json::Value| {
            let mut m = serde_json::json!({ "id": "a1", "role": "assistant", "content": "", "toolEvents": [{ "id": "t1", "name": "write_file", "args": "{}", "ok": true, "summary": "Wrote n01.txt" }], "timeline": [{ "kind": "tool", "id": "t1" }] });
            m.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            Message::from_web(&m)
        };
        assert!(stored(serde_json::json!({ "resumeState": { "messages": [{ "role": "user", "content": "go" }], "toolRounds": 1, "continuations": 0 } })).incomplete);
        assert!(!stored(serde_json::json!({})).incomplete);
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
            reasoning_ms: 10,
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

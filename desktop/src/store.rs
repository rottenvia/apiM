//! Settings and chats on disk. Plain JSON under the user's app-data folder.

use crate::models::{CustomModel, DEFAULT_MODEL_ID, Usage};
use crate::plugins::Plugin;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

/// `%APPDATA%\apiM`, `~/Library/Application Support/apiM` or `~/.local/share/apiM`.
/// `APIM_DATA_DIR` overrides it (tests, portable installs).
pub fn data_dir() -> PathBuf {
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
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
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
    pub local_base_url: String,
    pub local_api_key: String,
    pub local_api_model: String,
    pub model: String,
    /// auto | none | low | high | max
    pub effort: String,
    pub web_search: bool,
    pub enabled_plugins: Vec<String>,
    pub custom_plugins: Vec<Plugin>,
    pub custom_models: Vec<CustomModel>,
    pub approval: Approval,
    /// Hard ceiling on what one reply may cost, in USD. None means no cap.
    pub budget_usd: Option<f64>,
    pub sidebar_open: bool,
    pub workspace_open: bool,
    pub zoom: f32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            deepseek_key: String::new(),
            openrouter_key: String::new(),
            tavily_key: String::new(),
            exa_key: String::new(),
            local_base_url: String::new(),
            local_api_key: String::new(),
            local_api_model: String::new(),
            model: DEFAULT_MODEL_ID.into(),
            effort: "auto".into(),
            web_search: true,
            enabled_plugins: Vec::new(),
            custom_plugins: Vec::new(),
            custom_models: Vec::new(),
            approval: Approval::Manual,
            budget_usd: None,
            sidebar_open: true,
            workspace_open: false,
            zoom: 1.0,
        }
    }
}

impl Settings {
    fn path() -> PathBuf {
        data_dir().join("settings.json")
    }

    pub fn load() -> Settings {
        std::fs::read(Self::path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
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
        self.key(&self.tavily_key, "TAVILY_API_KEY")
    }
    pub fn exa(&self) -> String {
        self.key(&self.exa_key, "EXA_API_KEY")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

/// One action the agent took, as shown in the reply.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
pub struct ToolEvent {
    pub id: String,
    pub name: String,
    /// Raw JSON arguments.
    pub args: String,
    /// None while it is still running.
    pub ok: Option<bool>,
    #[serde(default)]
    pub summary: String,
    /// An image the tool produced, shown under the step.
    #[serde(default)]
    pub image: Option<PathBuf>,
}

/// A reply reads top to bottom: each stretch of text is followed by the steps it led to.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Part {
    Text(String),
    /// `ms` stays 0 while the model is still thinking.
    Thinking { text: String, ms: u64 },
    Tool(ToolEvent),
    /// A one-line note from the app: retried, continued, stopped.
    Notice(String),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Message {
    pub id: String,
    pub role: Role,
    pub parts: Vec<Part>,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub usage: Usage,
    #[serde(default)]
    pub cost: Option<f64>,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub error: Option<String>,
    /// Final finish_reason from the provider.
    #[serde(default)]
    pub finish: Option<String>,
    /// Stopped or cut off before it finished.
    #[serde(default)]
    pub incomplete: bool,
    /// Image files attached to a user message.
    #[serde(default)]
    pub attachments: Vec<PathBuf>,
    #[serde(default)]
    pub created_at: u64,
}

impl Message {
    pub fn new(role: Role, text: &str) -> Message {
        Message {
            id: new_id(),
            role,
            parts: if text.is_empty() { Vec::new() } else { vec![Part::Text(text.to_string())] },
            model: String::new(),
            usage: Usage::default(),
            cost: None,
            duration_ms: 0,
            error: None,
            finish: None,
            incomplete: false,
            attachments: Vec::new(),
            created_at: now_ms(),
        }
    }

    /// What later turns are told this message said: the prose, plus one line per
    /// step so the model remembers what it already did in this chat.
    pub fn history_text(&self) -> String {
        let steps: Vec<String> = self
            .parts
            .iter()
            .filter_map(|p| match p {
                Part::Tool(t) if !t.summary.is_empty() => Some(t.summary.chars().take(120).collect()),
                _ => None,
            })
            .take(30)
            .collect();
        let text = self.text();
        if steps.is_empty() { text } else { format!("{text}

[Steps taken in this reply: {}]", steps.join("; ")) }
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub messages: Vec<Message>,
    /// A folder the user pointed this chat at. None means the chat's own folder.
    #[serde(default)]
    pub folder: Option<PathBuf>,
    #[serde(default)]
    pub plan: Option<Plan>,
    /// What the agent concluded in this chat. Never shown to another chat.
    #[serde(default)]
    pub findings: Vec<Finding>,
}

/// What the sidebar needs without holding every chat in memory.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ChatMeta {
    pub id: String,
    pub title: String,
    pub updated_at: u64,
}

impl Conversation {
    pub fn new() -> Conversation {
        let now = now_ms();
        Conversation { id: new_id(), title: "New chat".into(), created_at: now, updated_at: now, ..Default::default() }
    }

    fn path(id: &str) -> PathBuf {
        data_dir().join("chats").join(format!("{id}.json"))
    }

    pub fn load(id: &str) -> Option<Conversation> {
        serde_json::from_slice(&std::fs::read(Self::path(id)).ok()?).ok()
    }

    pub fn save(&self) {
        if let Ok(json) = serde_json::to_vec(self) {
            let _ = write_atomic(&Self::path(&self.id), &json);
        }
    }

    /// Removes the chat and its own folder. A folder the user picked is never touched.
    pub fn delete(id: &str) {
        let _ = std::fs::remove_file(Self::path(id));
        let _ = std::fs::remove_dir_all(data_dir().join("workspaces").join(id));
        let _ = std::fs::remove_dir_all(data_dir().join("state").join(id));
    }

    /// Where the agent's file tools work for this chat.
    pub fn workspace(&self) -> PathBuf {
        self.folder.clone().unwrap_or_else(|| data_dir().join("workspaces").join(&self.id))
    }

    /// Undo history and other per-chat files that must not sit in the workspace.
    pub fn state_dir(&self) -> PathBuf {
        data_dir().join("state").join(&self.id)
    }

    /// Newest first.
    // ponytail: parses every chat file at startup. Keep an index file if thousands of chats make launch slow.
    pub fn list() -> Vec<ChatMeta> {
        let mut out: Vec<ChatMeta> = std::fs::read_dir(data_dir().join("chats"))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| serde_json::from_slice(&std::fs::read(e.path()).ok()?).ok())
            .collect();
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        out
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
    use super::*;

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
        c.title = derive_title("\n  hello there  \nsecond");
        c.messages.push(Message::new(Role::User, "hello"));
        c.messages.push(Message {
            parts: vec![
                Part::Thinking { text: "hm".into(), ms: 5 },
                Part::Text("a".into()),
                Part::Tool(ToolEvent { name: "read_file".into(), ..Default::default() }),
                Part::Text("b".into()),
            ],
            ..Message::new(Role::Assistant, "")
        });
        c.save();
        let back = Conversation::load(&c.id).unwrap();
        assert_eq!(back, c);
        assert_eq!(back.messages[1].text(), "a\n\nb");
        assert_eq!(Conversation::list()[0].title, "hello there");
        Conversation::delete(&c.id);
        assert!(Conversation::load(&c.id).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}

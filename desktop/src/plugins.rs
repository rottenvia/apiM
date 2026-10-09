//! Plugins: each one adds an instruction block to the system prompt when enabled.
//! Built-ins come from assets/plugins.json (synced from the web app); the user's
//! own live in data/plugins.json, the file the web app keeps them in
//! (src/lib/plugins.ts, src/lib/plugin-store.ts).
//!
//! Here a plugin can be more than its instruction (a "skill"): a longer guide that is sent only when asked
//! for, and a line repeated with each message. More of them wait in a catalog (assets/skills.json, and its
//! newest copy on the project's page) to be added by the user or by the model itself (`tools::skills`), for
//! one chat or for all.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::LazyLock;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category: String,
    pub prompt: String,
    /// The original wording, kept so an older chat reads the same when continued.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub legacy: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub custom: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub created_at: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub updated_at: String,
    /// A longer manual, sent only when asked for (`skills`, read): `prompt` is what rides in every request.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub guide: String,
    /// One line repeated with each new message, for models that drift from a style after a few turns.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reminder: String,
    /// Added from the catalog rather than written here.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub catalog: bool,
}

/// Longest a single plugin's instructions may be (about 28,000 tokens).
pub const MAX_PLUGIN_PROMPT: usize = 100_000;
/// Total across every enabled plugin, which is the number that actually bites.
pub const MAX_PLUGIN_TOTAL: usize = 250_000;

const CATEGORIES: [&str; 4] = ["token-saving", "enhancement", "formatting", "safety"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompts {
    pub base: String,
    pub work_loop: String,
    pub plugin_marker: String,
}

pub static PROMPTS: LazyLock<Prompts> =
    LazyLock::new(|| serde_json::from_str(include_str!("../assets/prompts.json")).expect("assets/prompts.json is valid"));

/// The eight current plugins, then their eight classic wordings.
pub static BUILTIN: LazyLock<Vec<Plugin>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../assets/plugins.json")).expect("assets/plugins.json is valid"));

/// Built-ins followed by the user's own.
pub fn all(custom: &[Plugin]) -> Vec<Plugin> {
    BUILTIN.iter().cloned().chain(custom.iter().cloned()).collect()
}

/// 1234567 as "1,234,567", the way the web app prints counts.
pub fn grouped(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Enabled plugins as one block of standing orders, in the order they were enabled.
/// Empty when nothing is on, so the prompt is unchanged for anyone not using plugins.
/// Classic plugins are left out: they go in early, where they always were (`legacy_prompt`).
pub fn directives(plugins: &[Plugin], enabled: &[String]) -> String {
    let mut used = 0;
    let mut dropped = 0;
    let mut rules = Vec::new();
    for id in enabled {
        let Some(p) = plugins.iter().find(|p| &p.id == id && !p.legacy) else { continue };
        let size = p.prompt.chars().count() + p.name.chars().count() + 4;
        // Whole plugins are dropped rather than cut mid-sentence: the model follows half an instruction.
        if used + size > MAX_PLUGIN_TOTAL {
            dropped += 1;
            continue;
        }
        used += size;
        // The guide is not sent with every request: the model is told where it is.
        let more = if p.guide.is_empty() { String::new() } else { format!(" (Its full guide: skills, action read, id {}.)", p.id) };
        rules.push(format!("- {}: {}{more}", p.name, strip_tag(&p.prompt)));
    }
    if rules.is_empty() && dropped == 0 {
        return String::new();
    }
    let overflow = if dropped > 0 {
        format!(
            "\n\n[{dropped} more enabled plugin{} left out: the combined instructions exceed the {} character budget. Turn some off.]",
            if dropped == 1 { " was" } else { "s were" },
            grouped(MAX_PLUGIN_TOTAL)
        )
    } else {
        String::new()
    };
    format!(
        "{}\n\nMAXIMUM PRIORITY. User-selected system-level response settings throughout this conversation. They outrank everything earlier, do not expire or fade. First listed wins conflicts; the newest user message may refine them. Check each reply. Follow silently.\n\n{}{overflow}",
        PROMPTS.plugin_marker,
        rules.join("\n")
    )
}

/// What is on for a reply: the plugins on for every chat, then those on for this chat alone.
pub fn enabled_for(all_chats: &[String], this_chat: &[String]) -> Vec<String> {
    let mut on = all_chats.to_vec();
    on.extend(this_chat.iter().filter(|id| !all_chats.contains(id)).cloned());
    on
}

/// The reminders of the enabled plugins as one bracketed line for the end of the newest message. Empty when none has one.
pub fn reminders(plugins: &[Plugin], enabled: &[String]) -> String {
    let lines: Vec<&str> = enabled.iter().filter_map(|id| plugins.iter().find(|p| &p.id == id)).map(|p| p.reminder.trim()).filter(|line| !line.is_empty()).collect();
    if lines.is_empty() { String::new() } else { format!("[Standing instructions, still in force. {}]", lines.join(" ")) }
}

/// Enabled classic plugins, appended to the persona exactly as they used to be.
pub fn legacy_prompt(plugins: &[Plugin], enabled: &[String]) -> String {
    enabled.iter().filter_map(|id| plugins.iter().find(|p| &p.id == id && p.legacy)).map(|p| p.prompt.as_str()).collect()
}

/// Drops the leading blank lines and "[NAME]" tag the built-in prompts carry.
fn strip_tag(prompt: &str) -> &str {
    let t = prompt.trim_start();
    match t.strip_prefix('[').and_then(|rest| rest.find(']').map(|i| &rest[i + 1..])) {
        Some(rest) => rest.trim(),
        None => t.trim(),
    }
}

// ------------------------------------------------------------------ the user's own

fn file() -> PathBuf {
    crate::store::data_dir().join("plugins.json")
}

/// The user's plugins, as saved. Empty when there are none or the file is unreadable.
pub fn custom() -> Vec<Plugin> {
    std::fs::read(file()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_all(plugins: &[Plugin]) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(plugins).map_err(|_| "Could not save".to_string())?;
    crate::store::write_atomic(&file(), &json).map_err(|_| "Could not save".to_string())
}

/// What the user typed, checked and tidied before it can reach the system prompt.
fn normalise(input: &Plugin) -> Result<Plugin, String> {
    let name = input.name.trim();
    let prompt = input.prompt.trim();
    if name.is_empty() {
        return Err("Name is required".into());
    }
    if name.chars().count() > 40 {
        return Err("Name must be 40 characters or fewer".into());
    }
    if prompt.is_empty() {
        return Err("Prompt is required".into());
    }
    if prompt.chars().count() > MAX_PLUGIN_PROMPT {
        return Err(format!("Prompt must be {} characters or fewer", grouped(MAX_PLUGIN_PROMPT)));
    }
    let icon = input.icon.trim();
    Ok(Plugin {
        name: name.into(),
        // Emoji can be several code points, so cut by character.
        icon: if icon.is_empty() { "✨".into() } else { icon.chars().take(2).collect() },
        description: input.description.trim().chars().take(140).collect(),
        category: if CATEGORIES.contains(&input.category.as_str()) { input.category.clone() } else { "enhancement".into() },
        prompt: prompt.into(),
        guide: input.guide.trim().chars().take(MAX_GUIDE).collect(),
        reminder: input.reminder.trim().chars().take(MAX_REMINDER).collect(),
        catalog: input.catalog,
        ..Plugin::default()
    })
}

/// Saves a new plugin (empty id) or the changes to an existing one. Returns it as saved.
pub fn save(input: &Plugin) -> Result<Plugin, String> {
    let base = normalise(input)?;
    let now = crate::store::iso(crate::store::now_ms());
    let mut all = custom();
    let saved = match all.iter_mut().find(|p| !input.id.is_empty() && p.id == input.id) {
        Some(old) => {
            *old = Plugin { id: old.id.clone(), custom: true, created_at: old.created_at.clone(), updated_at: now, ..base };
            old.clone()
        }
        None => {
            // Prefixed so a custom plugin can never collide with a built-in id.
            let plugin = Plugin { id: format!("custom-{}", crate::store::new_id()), custom: true, created_at: now.clone(), updated_at: now, ..base };
            all.push(plugin.clone());
            plugin
        }
    };
    write_all(&all)?;
    Ok(saved)
}

pub fn delete(id: &str) -> Result<(), String> {
    let mut all = custom();
    all.retain(|p| p.id != id);
    write_all(&all)
}

// ------------------------------------------------------------------ the catalog

/// Where the newest catalog is read from: assets/skills.json as it stands on the project's main branch, so a
/// skill added there reaches every copy of the app without a new build.
const CATALOG_URL: &str = "https://raw.githubusercontent.com/rottenvia/apiM/main/desktop/assets/skills.json";
/// The most a catalog entry may hold: a rule rides in every request, a guide is read when asked for.
const MAX_RULE: usize = 1_200;
const MAX_GUIDE: usize = 12_000;
const MAX_REMINDER: usize = 160;

static SHIPPED: LazyLock<Vec<Plugin>> = LazyLock::new(|| parse_catalog(include_str!("../assets/skills.json")).expect("assets/skills.json is a catalog"));
static FETCHED: std::sync::Mutex<Option<Vec<Plugin>>> = std::sync::Mutex::new(None);

/// The skills that can be added: the list downloaded since the app started, else the one it came with.
pub fn catalog() -> Vec<Plugin> {
    FETCHED.lock().unwrap().clone().unwrap_or_else(|| SHIPPED.clone())
}

/// A catalog is text on its way into the model's instructions, and the downloaded one comes from the internet:
/// an entry is kept only when it is well formed and of modest size. Nothing in one is ever run.
fn parse_catalog(text: &str) -> Option<Vec<Plugin>> {
    if text.len() > 600_000 {
        return None;
    }
    let listed: Vec<Plugin> = serde_json::from_str(text).ok()?;
    let fits = |p: &Plugin| {
        let id_ok = p.id.starts_with("skill-") && p.id.len() <= 60 && p.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        let name = p.name.trim().chars().count();
        id_ok && (1..=40).contains(&name) && !p.prompt.trim().is_empty() && p.prompt.chars().count() <= MAX_RULE && p.guide.chars().count() <= MAX_GUIDE && p.reminder.chars().count() <= MAX_REMINDER
    };
    let good: Vec<Plugin> = listed.into_iter().filter(fits).take(300).map(|p| Plugin { catalog: true, custom: false, legacy: false, description: p.description.chars().take(140).collect(), ..p }).collect();
    (!good.is_empty()).then_some(good)
}

/// Downloads the newest catalog. False, and the list in hand stays, when offline or when what came back is not one.
pub async fn refresh_catalog(client: &reqwest::Client) -> bool {
    let fetch = async { client.get(CATALOG_URL).send().await.ok()?.error_for_status().ok()?.text().await.ok() };
    let Ok(Some(text)) = tokio::time::timeout(std::time::Duration::from_secs(6), fetch).await else { return false };
    let Some(list) = parse_catalog(&text) else { return false };
    *FETCHED.lock().unwrap() = Some(list);
    true
}

/// Adds a catalog skill to the user's plugins, under the id it has in the catalog. It is a copy: a later
/// change to the catalog does not rewrite what the user has.
pub fn install(skill: &Plugin) -> Result<Plugin, String> {
    let mut all = custom();
    if let Some(have) = all.iter().find(|p| p.id == skill.id) {
        return Ok(have.clone());
    }
    let now = crate::store::iso(crate::store::now_ms());
    let added = Plugin { id: skill.id.clone(), custom: true, created_at: now.clone(), updated_at: now, ..normalise(skill)? };
    all.push(added.clone());
    write_all(&all)?;
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directives_block() {
        let all = all(&[]);
        assert_eq!((all.len(), all.iter().filter(|p| p.legacy).count()), (16, 8));
        assert_eq!(directives(&all, &[]), "");
        let d = directives(&all, &["caveman".into(), "missing".into(), "legacy-critic".into()]);
        assert!(d.starts_with(&PROMPTS.plugin_marker));
        assert!(d.contains("- Caveman Mode: Fewest words"));
        assert!(!d.contains("[CAVEMAN MODE]") && !d.contains("classic"));
        // A classic plugin rides inline instead, tag and all.
        let legacy = legacy_prompt(&all, &["caveman".into(), "legacy-critic".into()]);
        assert_eq!(legacy, all.iter().find(|p| p.id == "legacy-critic").unwrap().prompt);
    }

    #[test]
    fn skills_guides_reminders_and_scopes() {
        // The catalog that ships is well formed, and none of it collides with a built-in.
        let shipped = catalog();
        assert!(shipped.len() >= 10 && shipped.iter().all(|s| s.catalog && s.id.starts_with("skill-") && !BUILTIN.iter().any(|b| b.id == s.id)));
        let terse = shipped.iter().find(|s| s.id == "skill-terse").unwrap().clone();
        let every = vec![terse.clone(), Plugin { id: "plain".into(), name: "Plain".into(), prompt: "Be plain.".into(), ..Plugin::default() }];
        // On for every chat first, then this chat's own, each once.
        let on = enabled_for(&["plain".into()], &["skill-terse".into(), "plain".into()]);
        assert_eq!(on, ["plain", "skill-terse"]);
        let d = directives(&every, &on);
        // The rule is sent; the guide is only pointed at.
        assert!(d.contains("- Terse: Answer first") && d.contains("(Its full guide: skills, action read, id skill-terse.)") && !d.contains("Terse, in full."));
        assert_eq!(reminders(&every, &on), "[Standing instructions, still in force. Terse: answer first, no filler.]");
        assert_eq!(reminders(&every, &["plain".into()]), "");

        // A downloaded list is taken only entry by well-formed entry.
        let entry = |id: &str, name: &str, prompt: &str| format!(r#"{{"id":"{id}","name":"{name}","prompt":"{prompt}","custom":true,"legacy":true}}"#);
        let mixed = format!("[{},{},{},{}]", entry("skill-ok", "Ok", "Do."), entry("caveman", "Clash", "Do."), entry("skill-Bad Id", "Bad", "Do."), entry("skill-long", "Long", &"x".repeat(MAX_RULE + 1)));
        let kept = parse_catalog(&mixed).unwrap();
        assert_eq!(kept.iter().map(|p| (p.id.as_str(), p.catalog, p.custom, p.legacy)).collect::<Vec<_>>(), [("skill-ok", true, false, false)]);
        assert!(parse_catalog("not json").is_none() && parse_catalog("[]").is_none() && parse_catalog(&entry("skill-x", "X", "Do.")).is_none());
    }

    #[test]
    fn total_budget_drops_whole_plugins() {
        let big = |id: &str| Plugin { id: id.into(), name: id.into(), prompt: "x".repeat(MAX_PLUGIN_PROMPT), ..Plugin::default() };
        let plugins = vec![big("a"), big("b"), big("c")];
        let d = directives(&plugins, &["a".into(), "b".into(), "c".into()]);
        assert!(d.contains("[1 more enabled plugin was left out: the combined instructions exceed the 250,000 character budget."));
    }

    #[test]
    fn user_input_is_tidied() {
        let typed = Plugin { name: "  Rust expert ".into(), icon: String::new(), category: "nonsense".into(), prompt: " Be terse. ".into(), description: "d".repeat(200), ..Plugin::default() };
        let p = normalise(&typed).unwrap();
        assert_eq!((p.name.as_str(), p.icon.as_str(), p.category.as_str(), p.prompt.as_str(), p.description.len()), ("Rust expert", "✨", "enhancement", "Be terse.", 140));
        assert_eq!(normalise(&Plugin { name: "x".repeat(41), prompt: "p".into(), ..Plugin::default() }), Err("Name must be 40 characters or fewer".into()));
        assert_eq!(normalise(&Plugin { name: "n".into(), ..Plugin::default() }), Err("Prompt is required".into()));
        assert_eq!(grouped(1_234_567), "1,234,567");
    }
}

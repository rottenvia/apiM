//! Plugins: each one adds an instruction block to the system prompt when enabled.
//! Built-ins come from assets/plugins.json (synced from the web app); the user's
//! own live in data/plugins.json, the file the web app keeps them in
//! (src/lib/plugins.ts, src/lib/plugin-store.ts).

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
        rules.push(format!("- {}: {}", p.name, strip_tag(&p.prompt)));
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

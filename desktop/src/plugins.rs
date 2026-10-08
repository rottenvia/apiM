//! Plugins: each one adds an instruction block to the system prompt when enabled.
//! Built-ins come from assets/plugins.json (synced from the web app).

use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Plugin {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category: String,
    pub prompt: String,
}

/// Longest a single plugin's instructions may be (about 28,000 tokens).
pub const MAX_PLUGIN_PROMPT: usize = 100_000;
/// Total across every enabled plugin, which is the number that actually bites.
pub const MAX_PLUGIN_TOTAL: usize = 250_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompts {
    pub base: String,
    pub work_loop: String,
    pub plugin_marker: String,
}

pub static PROMPTS: LazyLock<Prompts> =
    LazyLock::new(|| serde_json::from_str(include_str!("../assets/prompts.json")).expect("assets/prompts.json is valid"));

pub static BUILTIN: LazyLock<Vec<Plugin>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../assets/plugins.json")).expect("assets/plugins.json is valid"));

/// Built-ins followed by the user's own.
pub fn all(custom: &[Plugin]) -> Vec<Plugin> {
    BUILTIN.iter().cloned().chain(custom.iter().cloned()).collect()
}

/// Enabled plugins as one block of standing orders, in the order they were enabled.
/// Empty when nothing is on, so the prompt is unchanged for anyone not using plugins.
pub fn directives(plugins: &[Plugin], enabled: &[String]) -> String {
    let mut used = 0;
    let mut dropped = 0;
    let mut rules = Vec::new();
    for id in enabled {
        let Some(p) = plugins.iter().find(|p| &p.id == id) else { continue };
        let size = p.prompt.len() + p.name.len() + 4;
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
            "\n\n[{dropped} more enabled plugin{} left out: the combined instructions exceed the {MAX_PLUGIN_TOTAL} character budget. Turn some off.]",
            if dropped == 1 { " was" } else { "s were" }
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

/// Drops the leading blank lines and "[NAME]" tag the built-in prompts carry.
fn strip_tag(prompt: &str) -> &str {
    let t = prompt.trim_start();
    match t.strip_prefix('[').and_then(|rest| rest.find(']').map(|i| &rest[i + 1..])) {
        Some(rest) => rest.trim(),
        None => t.trim(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directives_block() {
        let all = all(&[]);
        assert_eq!(all.len(), 8);
        assert_eq!(directives(&all, &[]), "");
        let d = directives(&all, &["caveman".into(), "missing".into()]);
        assert!(d.starts_with(&PROMPTS.plugin_marker));
        assert!(d.contains("- Caveman Mode: Fewest words"));
        assert!(!d.contains("[CAVEMAN MODE]"));
    }

    #[test]
    fn total_budget_drops_whole_plugins() {
        let big = |id: &str| Plugin {
            id: id.into(),
            name: id.into(),
            icon: String::new(),
            description: String::new(),
            category: String::new(),
            prompt: "x".repeat(MAX_PLUGIN_PROMPT),
        };
        let plugins = vec![big("a"), big("b"), big("c")];
        let d = directives(&plugins, &["a".into(), "b".into(), "c".into()]);
        assert!(d.contains("[1 more enabled plugin was left out"));
    }
}

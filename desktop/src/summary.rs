//! Summaries that stand in for older turns: the automatic one and `/compact`.
//! A port of src/lib/history-summary.ts and the compact route.

use crate::models::ProviderId;
use crate::provider::{self, Target};
use crate::store::{Conversation, HistorySummary, Message, Role, Settings};
use serde_json::{Map, Value, json};

/// Turns always sent word for word.
const VERBATIM_TURNS: usize = 8;
const VERBATIM_MAX: usize = 20;
/// Older turns waiting for a summary are folded in once they pass either of these.
const TRIGGER_CHARS: usize = 4_000;
const TRIGGER_TURNS: usize = 6;
const DIGEST_MAX_CHARS: usize = 60_000;
const TURN_MAX_CHARS: usize = 20_000;
const TEXT_MAX_CHARS: usize = 4_000;
const COMPACT_TEXT_MAX_CHARS: usize = 12_000;
const COMPACT_MAX_CHUNKS: usize = 8;
pub const MARKER: &str = "[Conversation summary — older turns]";

const SUMMARY_SYSTEM: &str = "You maintain the running summary of a long chat with an AI coding assistant, so older turns can leave context without losing what matters.

You get PREVIOUS SUMMARY (may be empty) and NEW TURNS, oldest first.

Update the summary. Record only what is durable:
- the current goal and its state (what is done, what is open)
- decisions made and why
- files or systems created or changed, with paths
- proven facts about this project (commands, paths, quirks that bit)
- preferences the user stated
- open threads and unfinished items

Do NOT record: play-by-play, failed attempts (unless they proved a durable fact above), pleasantries, verbatim code (describe it and name the path).

State, not story: write what is TRUE NOW, not what happened. Keep under 300 words. Plain text, short lines, no headers. If the new turns add nothing durable, return the previous summary unchanged.";

fn compact_system(focus: &str) -> String {
    let focus = focus.trim();
    let focus = if focus.is_empty() { String::new() } else { format!("\n\nThe user asked this compaction to focus on: {}", focus.chars().take(500).collect::<String>()) };
    format!(
        "You are compacting a chat between a user and an AI coding assistant. Your summary REPLACES the conversation: after this, the assistant sees only your summary plus new messages, so anything you leave out is forgotten.

You get PREVIOUS SUMMARY (may be empty) and NEW TURNS, oldest first.

Write the updated summary with these parts, as short plain-text lines:
- Goal: what the user is ultimately trying to get done, in their terms.
- Current state: what is done and working, what is half-done, what is broken.
- Files and systems: every file, command, URL or service that matters, with exact paths and names.
- Decisions and constraints: choices made and why; requirements and preferences the user stated.
- Facts learned: errors and their fixes, quirks, values that were verified.
- Next steps: what was about to happen, and any question left open.

Keep exact identifiers (paths, function names, versions, error strings) verbatim. No play-by-play, no pleasantries, no code beyond short identifiers. Up to 800 words.{focus}"
    )
}

/// What a request carries of the chat so far.
pub struct Shape<'a> {
    /// Sent word for word.
    pub verbatim: &'a [Message],
    /// Older than that and not yet summarised.
    pub pending: &'a [Message],
}

/// Splits the turns after the stored summary into the tail sent verbatim and what should be summarised.
pub fn shape<'a>(messages: &'a [Message], stored: Option<&HistorySummary>) -> Shape<'a> {
    let covered = stored.and_then(|s| messages.iter().position(|m| m.id == s.up_to_id));
    let open = &messages[covered.map_or(0, |i| i + 1)..];
    let pending = &open[..open.len().saturating_sub(VERBATIM_TURNS)];
    Shape { verbatim: &open[open.len().saturating_sub(VERBATIM_MAX)..], pending }
}

pub fn should_refresh(pending: &[Message]) -> bool {
    !pending.is_empty() && (pending.len() >= TRIGGER_TURNS || pending.iter().map(|m| m.history_text().len()).sum::<usize>() >= TRIGGER_CHARS)
}

fn cut(text: &str, chars: usize) -> &str {
    text.char_indices().nth(chars).map_or(text, |(i, _)| &text[..i])
}

fn digest_turn(m: &Message) -> String {
    let who = if m.role == Role::User { "USER" } else { "ASSISTANT" };
    let full = m.history_text();
    let count = full.chars().count();
    let text = if count > TURN_MAX_CHARS { format!("{}\n…[turn truncated, {} more chars]…", cut(&full, TURN_MAX_CHARS), count - TURN_MAX_CHARS) } else { full };
    let media: Vec<String> = m
        .attachments
        .iter()
        .map(|a| match a.description.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            Some(d) => format!("[{} {}: \"{}\"]", a.kind, a.name, cut(d, 200)),
            None => format!("[{} {}]", a.kind, a.name),
        })
        .collect();
    if media.is_empty() { format!("{who}: {text}") } else { format!("{who}: {text}\nShared: {}", media.join(" ")) }
}

/// The newest turns that fit, oldest first, and how many older ones were left out.
fn digest(pending: &[Message]) -> (String, usize) {
    let mut kept: Vec<String> = Vec::new();
    let mut chars = 0;
    for m in pending.iter().rev() {
        let line = digest_turn(m);
        let size = line.chars().count();
        if chars + size > DIGEST_MAX_CHARS && !kept.is_empty() {
            break;
        }
        kept.push(cut(&line, DIGEST_MAX_CHARS - chars).to_string());
        chars += size.min(DIGEST_MAX_CHARS - chars);
        if chars >= DIGEST_MAX_CHARS {
            break;
        }
    }
    kept.reverse();
    let dropped = pending.len() - kept.len();
    (kept.join("\n\n"), dropped)
}

/// One summarising call. None when the provider gave nothing usable.
async fn run(previous: Option<&str>, pending: &[Message], target: &Target, system: &str, max_tokens: u32, max_chars: usize) -> Option<(String, usize)> {
    let (text, dropped) = digest(pending);
    let mut body = Map::new();
    body.insert("model".into(), json!(target.api_model));
    body.insert("stream".into(), json!(true));
    body.insert("max_tokens".into(), json!(max_tokens));
    let previous = previous.filter(|p| !p.is_empty()).map_or(String::new(), |p| format!("PREVIOUS SUMMARY:\n{p}\n\n"));
    body.insert("messages".into(), json!([{ "role": "system", "content": system }, { "role": "user", "content": format!("{previous}NEW TURNS:\n{text}") }]));
    if target.provider == ProviderId::Openrouter {
        body.extend(provider::openrouter_provider_for(&target.model.id).map(|p| ("provider".to_string(), p)));
    }
    let mandatory = target.provider == ProviderId::Openrouter && provider::openrouter_reasoning_mandatory(&target.model.id);
    provider::apply_thinking(&mut body, target.style, false, "none", mandatory);
    let round = provider::stream_round(&provider::client(), target, &Value::Object(body), |_| {}).await.ok()?;
    let out = round.content.trim();
    (!out.is_empty()).then(|| (cut(out, max_chars).to_string(), dropped))
}

/// The automatic summary: folds `pending` into what is stored. None leaves the chat as it was.
pub async fn refresh(stored: Option<HistorySummary>, pending: Vec<Message>, settings: Settings) -> Option<HistorySummary> {
    let target = provider::resolve_target(&settings.model, &settings).ok()?;
    let (text, dropped) = run(stored.as_ref().map(|s| s.text.as_str()), &pending, &target, SUMMARY_SYSTEM, 700, TEXT_MAX_CHARS).await?;
    Some(HistorySummary {
        text,
        up_to_id: pending.last()?.id.clone(),
        dropped_turns: stored.as_ref().map_or(0, |s| s.dropped_turns) + dropped as u32,
        updated_at: crate::store::iso(crate::store::now_ms()),
        covered_turns: None,
        manual: false,
        revised: false,
    })
}

/// Why this chat cannot be compacted right now, if it cannot.
pub fn compact_blocker(conv: &Conversation) -> Option<&'static str> {
    let covered = conv.summary.as_ref().and_then(|s| conv.messages.iter().position(|m| m.id == s.up_to_id));
    if covered.is_some_and(|i| i + 1 == conv.messages.len()) {
        Some("Nothing new to compact — the conversation is already summarised.")
    } else if conv.summary.is_none() && conv.messages.len() < 2 {
        Some("Nothing to compact yet — send a message first.")
    } else {
        None
    }
}

/// `/compact`: the whole conversation becomes one summary. The transcript on screen is untouched.
pub async fn compact(messages: Vec<Message>, stored: Option<HistorySummary>, settings: Settings, focus: String) -> Result<HistorySummary, String> {
    let target = provider::resolve_target(&settings.model, &settings)?;
    let covered = stored.as_ref().and_then(|s| messages.iter().position(|m| m.id == s.up_to_id));
    let uncovered = &messages[covered.map_or(0, |i| i + 1)..];

    // Chunks the summariser can read in one go; a chat too long for eight of them loses its oldest part.
    let mut chunks: Vec<&[Message]> = Vec::new();
    let (mut start, mut chars) = (0, 0);
    for (i, m) in uncovered.iter().enumerate() {
        let size = digest_turn(m).chars().count() + 2;
        if i > start && chars + size > DIGEST_MAX_CHARS {
            chunks.push(&uncovered[start..i]);
            (start, chars) = (i, 0);
        }
        chars += size;
    }
    chunks.push(&uncovered[start..]);
    let skipped: usize = chunks[..chunks.len().saturating_sub(COMPACT_MAX_CHUNKS)].iter().map(|c| c.len()).sum();
    let chunks = &chunks[chunks.len().saturating_sub(COMPACT_MAX_CHUNKS)..];

    let system = compact_system(&focus);
    let provider = target.provider.name();
    let mut text = stored.as_ref().map(|s| s.text.clone());
    let mut dropped = skipped;
    for (i, chunk) in chunks.iter().enumerate() {
        let Some((fresh, d)) = run(text.as_deref(), chunk, &target, &system, 4000, COMPACT_TEXT_MAX_CHARS).await else {
            return Err(if i == 0 { format!("{provider} did not return a summary. Nothing was changed — try again.") } else { format!("{provider} stopped partway through. Nothing was changed — try again.") });
        };
        text = Some(fresh);
        dropped += d;
    }
    Ok(HistorySummary {
        text: text.unwrap_or_default(),
        up_to_id: messages.last().map(|m| m.id.clone()).unwrap_or_default(),
        dropped_turns: stored.as_ref().map_or(0, |s| s.dropped_turns) + dropped as u32,
        updated_at: crate::store::iso(crate::store::now_ms()),
        covered_turns: Some(messages.len() as u32),
        manual: true,
        revised: false,
    })
}

/// The system message a stored summary becomes.
pub fn render(summary: &HistorySummary) -> String {
    let n = summary.dropped_turns;
    let dropped = if n > 0 {
        let (s, verb, be) = if n == 1 { ("", "predates", "is") } else { ("s", "predate", "are") };
        format!("\n({n} oldest turn{s} {verb} this summary and {be} not in context.)")
    } else {
        String::new()
    };
    let revised = if summary.revised { "\n(Some of the newest turns this summary covered were later retried, edited or rewound. Where it disagrees with the conversation below, the conversation is right.)" } else { "" };
    format!("{MARKER}\n{}{dropped}{revised}", summary.text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turns(n: usize, size: usize) -> Vec<Message> {
        (0..n).map(|i| Message { id: i.to_string(), ..Message::new(if i % 2 == 0 { Role::User } else { Role::Assistant }, &"w".repeat(size)) }).collect()
    }

    #[test]
    fn shape_and_triggers() {
        let all = turns(20, 10);
        let s = shape(&all, None);
        assert_eq!((s.verbatim.len(), s.pending.len()), (20, 12));
        assert!(should_refresh(s.pending));
        // A stored summary covers up to turn 9: ten turns stay open, eight of them verbatim.
        let stored = HistorySummary { up_to_id: "9".into(), ..Default::default() };
        let s = shape(&all, Some(&stored));
        assert_eq!((s.verbatim.len(), s.pending.len(), s.pending[0].id.as_str()), (10, 2, "10"));
        assert!(!should_refresh(s.pending));
        assert!(should_refresh(&turns(1, 4_000)));
        assert!(!should_refresh(&[]));
    }

    #[test]
    fn digest_keeps_the_newest_turns() {
        let (text, dropped) = digest(&turns(5, 25_000));
        // Each turn is cut to 20k plus its label: two fit whole in 60k, a third would not.
        assert_eq!(dropped, 3);
        assert!(text.chars().count() <= DIGEST_MAX_CHARS + 4);
        assert!(text.ends_with("more chars]…"));
    }

    #[test]
    fn render_says_what_is_missing() {
        let s = HistorySummary { text: "Goal: ship".into(), dropped_turns: 1, ..Default::default() };
        assert_eq!(render(&s), format!("{MARKER}\nGoal: ship\n(1 oldest turn predates this summary and is not in context.)"));
    }
}

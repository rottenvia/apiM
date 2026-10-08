//! Rolling summary of older conversation turns: port of src/lib/history-summary.ts.
//! The newest turns ride verbatim; everything older is covered by a stored summary a cheap helper model keeps current;
//! turns the helper has not covered yet ALSO ride verbatim, so nothing is silently missing. The stored shape
//! (`StoredSummary`) is the chat file's `summary` field in the web's JSON, so both apps read each other's.
//! `desktop/src/summary.rs` already drives the Message-based flow through the provider layer; this file is the same
//! algorithm over plain turns, plus the pieces summary.rs lacks: `history_chars`, `compact_chunks` as a function, and
//! `run_history_summary`, which needs only a `reqwest::Client` and an endpoint.

use super::{js_head, js_len, js_trim, post_json, Stop};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Newest messages that always ride verbatim.
pub const HISTORY_VERBATIM_TURNS: usize = 8;
/// Stretched cap when the helper is down: uncovered overflow rides verbatim too, up to the pre-summary last-20 replay.
pub const HISTORY_VERBATIM_MAX: usize = 20;
/// Uncovered backlog chars that trigger a refresh.
pub const SUMMARY_TRIGGER_CHARS: usize = 4000;
/// Uncovered backlog turns that trigger a refresh even when small, so a run of "ok" turns cannot fall off unsummarised.
pub const SUMMARY_TRIGGER_TURNS: usize = 6;
/// Largest digest ever handed to the helper in one call.
pub const SUMMARY_DIGEST_MAX_CHARS: usize = 60000;
/// One turn's share of the digest: a giant paste is head-truncated.
const SUMMARY_TURN_MAX_CHARS: usize = 20000;
/// Stored summaries never grow past this, however long the chat.
pub const SUMMARY_TEXT_MAX_CHARS: usize = 4000;
/// First line of the injected summary block (and the request-size bucket key).
pub const HISTORY_SUMMARY_MARKER: &str = "[Conversation summary — older turns]";
/// Stored /compact summaries may be longer: they replace the whole chat.
pub const COMPACT_TEXT_MAX_CHARS: usize = 12_000;
const COMPACT_CHUNK_CHARS: usize = SUMMARY_DIGEST_MAX_CHARS;
/// Beyond this many rolls the oldest turns are counted, not summarised.
const COMPACT_MAX_CHUNKS: usize = 8;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Attachment {
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One replayable turn with its stable id, so a cursor can point past it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ScopedMessage {
    pub id: String,
    /// "user" or "assistant".
    pub role: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub attachments: Option<Vec<Attachment>>,
    #[serde(default)]
    pub note: Option<bool>,
}

/// Stored per conversation; `up_to_id` is the last turn this covers.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSummary {
    pub text: String,
    pub up_to_id: String,
    /// Turns permanently outside both summary and window.
    pub dropped_turns: u32,
    pub updated_at: String,
    /// Set by /compact: everything up to the cursor left context, the newest turns included.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual: Option<bool>,
    /// Turns the summary stands in for, for the "compacted" divider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub covered_turns: Option<u32>,
    /// The cursor turn was retried, edited or rewound away: the text may describe a turn that no longer exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revised: Option<bool>,
}

pub struct HistoryShape<'a> {
    /// What rides verbatim: newest turns plus uncovered backlog, capped.
    pub verbatim: &'a [ScopedMessage],
    /// Uncovered overflow, oldest first: the refresh backlog.
    pub pending: &'a [ScopedMessage],
}

/// Splits the replayable history into the verbatim window and the backlog after the stored summary's cursor.
/// A stale cursor (message deleted, summary from another branch) re-covers the whole overflow.
pub fn shape_history<'a>(messages: &'a [ScopedMessage], stored: Option<&StoredSummary>) -> HistoryShape<'a> {
    let covered = stored.and_then(|s| messages.iter().position(|m| m.id == s.up_to_id));
    let open = &messages[covered.map_or(0, |i| i + 1)..];
    let tail = open.len().min(HISTORY_VERBATIM_TURNS);
    HistoryShape { verbatim: &open[open.len().saturating_sub(HISTORY_VERBATIM_MAX)..], pending: &open[..open.len() - tail] }
}

/// True once the uncovered backlog is worth one cheap helper call.
pub fn should_refresh_history_summary(pending: &[ScopedMessage]) -> bool {
    !pending.is_empty() && (pending.len() >= SUMMARY_TRIGGER_TURNS || pending.iter().map(|m| m.content.as_deref().map_or(0, js_len)).sum::<usize>() >= SUMMARY_TRIGGER_CHARS)
}

fn attachment_marker(a: &Attachment) -> String {
    let desc = a.description.as_deref().map(js_trim).filter(|d| !d.is_empty()).map_or(String::new(), |d| format!(": \"{}\"", js_head(d, 200)));
    format!("[{} {}{desc}]", a.kind, a.name)
}

/// One turn as the helper reads it. No "mid-task note" tag: by the time a turn reaches the digest its run is over.
pub fn render_digest_turn(m: &ScopedMessage) -> String {
    let who = if m.role == "user" { "USER" } else { "ASSISTANT" };
    let content = m.content.as_deref().unwrap_or("");
    let text = if js_len(content) > SUMMARY_TURN_MAX_CHARS { format!("{}\n…[turn truncated, {} more chars]…", js_head(content, SUMMARY_TURN_MAX_CHARS), js_len(content) - SUMMARY_TURN_MAX_CHARS) } else { content.to_string() };
    let media = m.attachments.iter().flatten().map(attachment_marker).collect::<Vec<_>>().join(" ");
    format!("{who}: {text}{}", if media.is_empty() { String::new() } else { format!("\nShared: {media}") })
}

#[derive(Debug, PartialEq)]
pub struct SummaryDigest {
    pub text: String,
    /// Pending turns covered by the digest.
    pub included: usize,
    /// Pending turns that did not fit: counted, not silently lost.
    pub dropped: usize,
}

/// Renders the backlog oldest-first for the helper, filling newest-first so the digest abuts the verbatim window it must
/// dovetail with. Always covers at least the newest turn, truncated to the cap if it is itself enormous.
pub fn build_summary_digest(pending: &[ScopedMessage]) -> SummaryDigest {
    let rendered: Vec<String> = pending.iter().map(render_digest_turn).collect();
    let mut kept: Vec<&str> = Vec::new();
    let mut chars = 0;
    for line in rendered.iter().rev() {
        let size = js_len(line);
        if chars + size > SUMMARY_DIGEST_MAX_CHARS && !kept.is_empty() {
            break;
        }
        let piece = if chars + size > SUMMARY_DIGEST_MAX_CHARS { js_head(line, SUMMARY_DIGEST_MAX_CHARS - chars) } else { line.as_str() };
        kept.push(piece);
        chars += js_len(piece);
        if chars >= SUMMARY_DIGEST_MAX_CHARS {
            break;
        }
    }
    kept.reverse();
    SummaryDigest { text: kept.join("\n\n"), included: kept.len(), dropped: pending.len() - kept.len() }
}

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

/// Where and as whom to ask. `thinking_style` is "deepseek", "openai" or "qwen"; only deepseek needs `thinking` switched off.
pub struct Credentials<'a> {
    pub api_key: &'a str,
    pub base_url: &'a str,
    pub model: &'a str,
    pub thinking_style: &'a str,
}

/// What the web passes as `options`: all optional.
#[derive(Default)]
pub struct SummaryOptions {
    /// Replaces the default system prompt (the /compact variant).
    pub system: Option<String>,
    pub max_tokens: Option<u32>,
    pub max_chars: Option<usize>,
    /// Extra request fields: thinking switches, endpoint pins.
    pub extra_body: Map<String, Value>,
    pub headers: Vec<(String, String)>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryResult {
    pub text: String,
    pub dropped_turns: usize,
    /// Tokens spent, so the cost of remembering is never hidden.
    pub usage: Option<Usage>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

/// Rolls the backlog into the stored summary with a cheap helper model: thinking off (extraction, not reasoning), a
/// small output cap. Every failure is None: a missed refresh just stretches the verbatim window until the next request retries.
pub async fn run_history_summary(client: &reqwest::Client, previous: Option<&str>, pending: &[ScopedMessage], creds: &Credentials<'_>, stop: Option<&Stop>, options: &SummaryOptions) -> Option<SummaryResult> {
    if pending.is_empty() {
        return None;
    }
    let digest = build_summary_digest(pending);
    let mut body = Map::new();
    body.insert("model".into(), json!(creds.model));
    if creds.thinking_style == "deepseek" {
        body.insert("thinking".into(), json!({ "type": "disabled" }));
    }
    body.extend(options.extra_body.clone());
    body.insert("max_tokens".into(), json!(options.max_tokens.unwrap_or(700)));
    let prev = previous.filter(|p| !p.is_empty()).map_or(String::new(), |p| format!("PREVIOUS SUMMARY:\n{p}\n\n"));
    body.insert("messages".into(), json!([{ "role": "system", "content": options.system.as_deref().unwrap_or(SUMMARY_SYSTEM) }, { "role": "user", "content": format!("{prev}NEW TURNS:\n{}", digest.text) }]));
    let mut headers = vec![("Authorization".to_string(), format!("Bearer {}", creds.api_key))];
    headers.extend(options.headers.iter().cloned());
    let (status, text) = post_json(client, &format!("{}/chat/completions", creds.base_url), &headers, &Value::Object(body), None, stop).await.ok()?;
    if !(200..300).contains(&status) {
        return None;
    }
    let reply: Value = serde_json::from_str(&text).ok()?;
    let raw = reply["choices"][0]["message"]["content"].as_str().unwrap_or("");
    let raw = js_trim(raw);
    if raw.is_empty() {
        return None;
    }
    let (p, c) = (&reply["usage"]["prompt_tokens"], &reply["usage"]["completion_tokens"]);
    Some(SummaryResult {
        text: js_head(raw, options.max_chars.unwrap_or(SUMMARY_TEXT_MAX_CHARS)).to_string(),
        dropped_turns: digest.dropped,
        usage: (p.is_number() && c.is_number()).then(|| Usage { prompt_tokens: p.as_f64().unwrap_or(0.0) as u64, completion_tokens: c.as_f64().unwrap_or(0.0) as u64 }),
    })
}

/// The system block injected ahead of the verbatim window.
pub fn render_history_summary(s: &StoredSummary) -> String {
    let n = s.dropped_turns;
    let dropped = if n > 0 { format!("\n({n} oldest turn{} predate{} this summary and {} not in context.)", if n == 1 { "" } else { "s" }, if n == 1 { "s" } else { "" }, if n == 1 { "is" } else { "are" }) } else { String::new() };
    let revised = if s.revised == Some(true) { "\n(Some of the newest turns this summary covered were later retried, edited or rewound. Where it disagrees with the conversation below, the conversation is right.)" } else { "" };
    format!("{HISTORY_SUMMARY_MARKER}\n{}{dropped}{revised}", s.text)
}

/// The /compact prompt: the summary becomes the whole conversation.
pub fn compact_system_prompt(instructions: Option<&str>) -> String {
    let focus = instructions.map(js_trim).filter(|i| !i.is_empty()).map_or(String::new(), |i| format!("\n\nThe user asked this compaction to focus on: {}", js_head(i, 500)));
    format!("You are compacting a chat between a user and an AI coding assistant. Your summary REPLACES the conversation: after this, the assistant sees only your summary plus new messages, so anything you leave out is forgotten.

You get PREVIOUS SUMMARY (may be empty) and NEW TURNS, oldest first.

Write the updated summary with these parts, as short plain-text lines:
- Goal: what the user is ultimately trying to get done, in their terms.
- Current state: what is done and working, what is half-done, what is broken.
- Files and systems: every file, command, URL or service that matters, with exact paths and names.
- Decisions and constraints: choices made and why; requirements and preferences the user stated.
- Facts learned: errors and their fixes, quirks, values that were verified.
- Next steps: what was about to happen, and any question left open.

Keep exact identifiers (paths, function names, versions, error strings) verbatim. No play-by-play, no pleasantries, no code beyond short identifiers. Up to 800 words.{focus}")
}

/// Splits every uncovered turn into digest-sized chunks, oldest first, sized exactly as the digest renders them
/// (attachment markers included). /compact rolls them through the summary in order; beyond 8 the oldest are counted as skipped.
pub fn compact_chunks(turns: &[ScopedMessage]) -> (Vec<&[ScopedMessage]>, usize) {
    let mut chunks: Vec<&[ScopedMessage]> = Vec::new();
    let (mut start, mut chars) = (0, 0);
    for (i, turn) in turns.iter().enumerate() {
        let size = js_len(&render_digest_turn(turn)) + 2;
        if i > start && chars + size > COMPACT_CHUNK_CHARS {
            chunks.push(&turns[start..i]);
            (start, chars) = (i, 0);
        }
        chars += size;
    }
    if start < turns.len() {
        chunks.push(&turns[start..]);
    }
    if chunks.len() <= COMPACT_MAX_CHUNKS {
        return (chunks, 0);
    }
    let cut = chunks.len() - COMPACT_MAX_CHUNKS;
    let skipped = chunks[..cut].iter().map(|c| c.len()).sum();
    (chunks.split_off(cut), skipped)
}

/// Chars a history window occupies on the wire, for before/after figures.
pub fn history_chars(turns: &[ScopedMessage], summary: Option<&StoredSummary>) -> usize {
    summary.map_or(0, |s| js_len(&render_history_summary(s))) + turns.iter().map(|t| t.content.as_deref().map_or(0, js_len) + 16).sum::<usize>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::testkit::{check, cases, client, expand, stub};

    fn msgs(v: &Value) -> Vec<ScopedMessage> {
        serde_json::from_value(v.clone()).unwrap()
    }
    fn stored(v: &Value) -> Option<StoredSummary> {
        (!v.is_null()).then(|| serde_json::from_value(v.clone()).unwrap())
    }
    fn ids(m: &[ScopedMessage]) -> Vec<&str> {
        m.iter().map(|m| m.id.as_str()).collect()
    }

    #[test]
    fn replays_the_pure_functions() {
        check("history_summary.shapeHistory", |i| {
            let all = msgs(&i["messages"]);
            let s = shape_history(&all, stored(&i["stored"]).as_ref());
            json!({ "verbatim": ids(s.verbatim), "pending": ids(s.pending), "refresh": should_refresh_history_summary(s.pending) })
        });
        check("history_summary.renderDigestTurn", |i| json!(render_digest_turn(&serde_json::from_value(i.clone()).unwrap())));
        check("history_summary.buildSummaryDigest", |i| {
            let d = build_summary_digest(&msgs(i));
            json!({ "text": d.text, "included": d.included, "dropped": d.dropped })
        });
        check("history_summary.renderHistorySummary", |i| json!(render_history_summary(&stored(i).unwrap())));
        check("history_summary.compactSystemPrompt", |i| json!(compact_system_prompt(i.as_str())));
        check("history_summary.compactChunks", |i| {
            let t = msgs(i);
            let (chunks, skipped) = compact_chunks(&t);
            json!({ "chunks": chunks.iter().map(|c| ids(c)).collect::<Vec<_>>(), "skipped": skipped })
        });
        check("history_summary.historyChars", |i| json!(history_chars(&msgs(&i["turns"]), stored(&i["summary"]).as_ref())));
    }

    #[tokio::test]
    async fn replays_the_model_call_against_a_stub() {
        for (i, (spec, want)) in cases("history_summary.run").iter().enumerate() {
            let spec = expand(spec);
            let replies = spec["script"].as_array().unwrap().iter().map(|s| (s["status"].as_u64().unwrap() as u16, s["body"].to_string())).collect();
            let server = stub(replies);
            let o = &spec["options"];
            let options = SummaryOptions {
                system: o["system"].as_str().map(str::to_string),
                max_tokens: o["maxTokens"].as_u64().map(|n| n as u32),
                max_chars: o["maxChars"].as_u64().map(|n| n as usize),
                extra_body: o["extraBody"].as_object().cloned().unwrap_or_default(),
                headers: o["headers"].as_object().map(|h| h.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).collect()).unwrap_or_default(),
            };
            let creds = Credentials { api_key: "key-1", base_url: &server.base, model: "helper", thinking_style: spec["style"].as_str().unwrap() };
            let result = run_history_summary(&client(), spec["previous"].as_str(), &msgs(&spec["pending"]), &creds, None, &options).await;
            let requests: Vec<Value> = server.requests().iter().map(|r| json!({ "url": r["url"], "headers": r["headers"], "body": r["body"] })).collect();
            let got = crate::context::testkit::compact(&json!({ "result": result, "requests": requests }));
            // Headers: every recorded one must arrive (names compare lower-case on the wire).
            let (mut got_v, mut want_v) = (got.clone(), want.clone());
            for (g, w) in got_v["requests"].as_array_mut().unwrap().iter_mut().zip(want_v["requests"].as_array_mut().unwrap().iter_mut()) {
                let sent = g["headers"].clone();
                let expected: Map<String, Value> = w["headers"].as_object().unwrap().iter().map(|(k, v)| (k.to_lowercase(), v.clone())).collect();
                assert!(expected.iter().all(|(k, v)| sent[k] == *v), "case {i}: headers {sent} lack {expected:?}");
                g["headers"] = Value::Null;
                w["headers"] = Value::Null;
            }
            assert_eq!(got_v, want_v, "history_summary.run case {i}");
        }
    }
}

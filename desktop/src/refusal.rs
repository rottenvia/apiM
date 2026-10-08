//! Works out who stopped a reply: the provider's content filter, or the model
//! itself. apiM adds no content rules, and the UI says so under such a reply.

use regex::Regex;
use std::sync::LazyLock;

fn set(patterns: &[&str]) -> Vec<Regex> {
    patterns.iter().map(|p| Regex::new(p).expect("valid pattern")).collect()
}

static PROVIDER_FILTER: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    set(&[
        r"(?i)content exists risk",
        r"\bcontentFilter\b",
        r"(?is)\b1301\b.{0,200}(?:sensitive|unsafe)",
        r"(?i)(?:unsafe|sensitive) content",
        r"不安全或敏感",
        r"(?i)data_inspection_failed",
        r"(?i)\bcontent[\s_-]?(?:filter|moderation|management policy)\b",
        r"(?i)requires? moderation|flagged by (?:the )?moderation|moderation (?:flagged|block)",
        r"(?i)\bsafety (?:system|filter)\b",
        r"(?i)\b(?:prohibited|inappropriate) content\b",
    ])
});

/// True when a provider error body is its content filter, not a broken key or a bug.
pub fn is_provider_content_block(detail: &str) -> bool {
    PROVIDER_FILTER.iter().any(|re| re.is_match(detail))
}

/// Pulls the human message out of a raw JSON error body, if it is one.
pub fn readable_detail(detail: &str) -> String {
    if let Ok(body) = serde_json::from_str::<serde_json::Value>(detail) {
        let inner = match &body["error"] {
            serde_json::Value::Object(o) => o.get("message").cloned(),
            serde_json::Value::String(s) => Some(serde_json::Value::String(s.clone())),
            _ => None,
        };
        let message = inner.or_else(|| body.get("message").cloned());
        if let Some(s) = message.as_ref().and_then(|m| m.as_str()) {
            if !s.trim().is_empty() {
                return s.to_string();
            }
        }
    }
    detail.to_string()
}

pub fn provider_content_block_message(provider: &str, detail: &str) -> String {
    let readable = readable_detail(detail);
    let trimmed: String = readable.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect();
    let quoted = if trimmed.is_empty() { String::new() } else { format!(" (\"{trimmed}\")") };
    format!(
        "{provider} blocked this request with its own content filter{quoted}. This check runs on {provider}'s servers; \
         apiM does not filter or change what you send. Rephrase it, or switch to another model and press Try again."
    )
}

static REPLY_REFUSAL: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    set(&[
        // The verb is captured: "I can't help noticing" is not a refusal, checked below.
        r"(?i)\bI\s+(?:cannot|can'?t|won'?t|will\s+not|am\s+not\s+able\s+to|am\s+unable\s+to|'m\s+unable\s+to)\s+(help|assist|comply|provide|create|write|generate|fulfill|fulfil|support|engage)\b",
        r"(?i)\b(?:I'?m\s+)?sorry,?\s+but\s+I\s+(?:cannot|can'?t|won'?t)\b",
        r"(?i)\bI\s+(?:must|have\s+to)\s+decline\b",
        r"(?i)\b(?:against|violates?)\s+(?:my|the|our)\s+(?:content\s+|safety\s+|usage\s+)?(?:policy|policies|guidelines?|principles?)\b",
        r"(?i)\bnot\s+(?:able|allowed|permitted)\s+to\s+(?:help|assist|provide|create|write|generate)\s+(?:with\s+)?(?:that|this)\b",
    ])
});
static HELP_IDIOM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^\s+(?:noticing|but|thinking|wondering)").unwrap());

const MAX_REFUSAL_CHARS: usize = 1500;
const OPENING_CHARS: usize = 600;

/// A short reply that opens by declining. Long answers are never refusals.
pub fn looks_like_model_refusal(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() || t.chars().count() > MAX_REFUSAL_CHARS {
        return false;
    }
    let opening: String = t.chars().take(OPENING_CHARS).collect();
    REPLY_REFUSAL.iter().enumerate().any(|(i, re)| {
        re.captures_iter(&opening).any(|c| {
            let idiom = i == 0
                && c.get(1).is_some_and(|verb| {
                    verb.as_str().eq_ignore_ascii_case("help") && HELP_IDIOM.is_match(&opening[verb.end()..])
                });
            !idiom
        })
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefusalSource {
    ContentFilter,
    Model,
}

pub fn refusal_source(content: &str, finish: Option<&str>) -> Option<RefusalSource> {
    static FILTER_FINISH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^content[_-]filter$").unwrap());
    if finish.is_some_and(|f| FILTER_FINISH.is_match(f)) {
        return Some(RefusalSource::ContentFilter);
    }
    looks_like_model_refusal(content).then_some(RefusalSource::Model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_filters() {
        assert!(is_provider_content_block("Content Exists Risk"));
        assert!(is_provider_content_block(r#"{"error":{"code":"1301","message":"系统检测到输入或生成内容可能包含不安全或敏感内容"}}"#));
        assert!(is_provider_content_block("Input data may contain inappropriate content."));
        assert!(!is_provider_content_block("Invalid API key"));
        let msg = provider_content_block_message("DeepSeek", r#"{"error":{"message":"Content Exists Risk"}}"#);
        assert!(msg.starts_with("DeepSeek blocked this request with its own content filter (\"Content Exists Risk\")"));
    }

    #[test]
    fn model_refusals() {
        assert!(looks_like_model_refusal("I'm sorry, but I can't help with that request."));
        assert!(looks_like_model_refusal("I cannot assist with creating that."));
        assert!(looks_like_model_refusal("That would be against my guidelines."));
        assert!(!looks_like_model_refusal("I can't help noticing the loop never exits. Fixed it."));
        assert!(!looks_like_model_refusal("I can't reproduce the bug on my side."));
        assert!(!looks_like_model_refusal(&"I cannot assist. ".repeat(200)));
        assert_eq!(refusal_source("fine", Some("content_filter")), Some(RefusalSource::ContentFilter));
        assert_eq!(refusal_source("Here is the code.", Some("stop")), None);
    }
}

//! Port of `src/lib/retry.ts`: which failures deserve another try, how long to
//! wait, how a rejection is read, and the wording of the "retrying" line.

use super::head;
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

pub struct Policy {
    /// Total tries, the first included.
    pub attempts: u32,
    pub base_ms: u64,
    pub max_ms: u64,
}

/// DeepSeek and the local engine.
pub const DEFAULT: Policy = Policy { attempts: 3, base_ms: 700, max_ms: 8_000 };
/// OpenRouter's shared pool answers 503 several times a day; three tries do not outlast it.
pub const OPENROUTER: Policy = Policy { attempts: 5, base_ms: 1_200, max_ms: 10_000 };

/// True when an HTTP status is worth another attempt.
pub fn is_retryable_status(status: u16) -> bool {
    !matches!(status, 400 | 401 | 402 | 403 | 404 | 422) && (matches!(status, 408 | 409 | 425 | 429) || status >= 500)
}

/// What the retry line calls a failed status.
pub fn status_reason(status: u16) -> String {
    match status {
        429 => "rate limited".into(),
        503 => "inference unavailable".into(),
        _ => format!("server error {status}"),
    }
}

/// How long to wait after try number `attempt` (1-based) failed. A Retry-After header wins, under the cap.
pub fn wait_ms(policy: &Policy, attempt: u32, retry_after_ms: Option<u64>) -> u64 {
    let backoff = policy.max_ms.min(policy.base_ms.saturating_mul(1 << (attempt - 1).min(20)));
    // ponytail: the clock's nanoseconds stand in for Math.random(); the jitter only has to differ between runs.
    let jitter = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos() as u64 % 250);
    policy.max_ms.min(retry_after_ms.unwrap_or(backoff + jitter))
}

/// The Retry-After header as milliseconds: a number of seconds, or an HTTP date.
pub fn retry_after_ms(header: &str) -> Option<u64> {
    let header = header.trim();
    if header.is_empty() {
        return None;
    }
    if let Ok(seconds) = header.parse::<f64>() {
        return seconds.is_finite().then(|| (seconds.max(0.0) * 1000.0) as u64);
    }
    let date = chrono::DateTime::parse_from_rfc2822(header).ok()?;
    Some((date.timestamp_millis() - chrono::Utc::now().timestamp_millis()).max(0) as u64)
}

/// Was this rejection about the body's size rather than its shape?
/// Size wants the history folded; shape wants the tools stripped.
pub fn is_size_rejection(status: u16, detail: &str) -> bool {
    // JS writes `window(?!s)`; this regex engine has no lookahead, so "not followed by s" is spelled out.
    // ponytail: `\b` is Unicode-aware here and ASCII-only in JS; they differ only next to non-Latin letters.
    static SIZE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\btoo large\b|\btoo long\b|\bmaximum\b|exceeds?|context.{0,20}(length|\blimits?\b|size|window(?:[^s]|$))|input.{0,20}(tokens?|length|\blong(er|est)?\b)|tokens?.{0,20}(\blimits?\b|exceed|\bmaximum\b)|request.{0,20}(\btoo\b|\blarg(e|er|est)\b|\bentity\b|\blimits?\b)|payload|content.{0,20}(\btoo\b|\blarg(e|er|est)\b|length)|message.{0,20}(\btoo\b|\blarg(e|er|est)\b)").unwrap()
    });
    match status {
        413 => true,
        // Codes arrive in snake_case (`input_too_long`), messages in prose: one pattern reads both.
        400 | 422 => SIZE.is_match(&detail.replace('_', " ")),
        _ => false,
    }
}

/// True when the rejection names the model, not the body: no reshaping will ever pass it.
pub fn is_unknown_model_rejection(detail: &str) -> bool {
    static UNKNOWN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)not a valid model|invalid model|model not found|unknown model").unwrap());
    UNKNOWN.is_match(detail)
}

/// JS `String(value ?? "")` for the shapes a provider sends.
/// ponytail: an object or array as `message` prints as JSON here and as "[object Object]" in JS; no provider sends one.
fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

fn codes_of(err: &Value) -> Vec<String> {
    [&err["code"], &err["type"]].into_iter().filter_map(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string).collect()
}

/// The provider's real rejection message, unwrapped from OpenRouter's envelope
/// (`error.metadata.raw` holds the cause when the outer message is only "Provider returned error").
pub fn extract_rejection_detail(err_text: &str, cap: usize) -> String {
    static GENERIC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)provider returned error|an error occurred|internal error|something went wrong|request failed").unwrap());
    let clip = |value: &str| head(value, cap).to_string();
    let Ok(root) = serde_json::from_str::<Value>(err_text) else { return clip(err_text) };
    let err = &root["error"];
    let message = text_of(&err["message"]).or_else(|| text_of(&root["message"])).unwrap_or_default();
    if message.is_empty() || GENERIC.is_match(&message) {
        if let Some(raw) = err["metadata"]["raw"].as_str().filter(|r| !r.is_empty()) {
            match serde_json::from_str::<Value>(raw) {
                // `null.error` throws in JS, which lands in the same catch as text that is not JSON.
                Err(_) | Ok(Value::Null) => return clip(raw),
                Ok(nested) => {
                    let nested_err = &nested["error"];
                    let nested_message = text_of(&nested_err["message"]).or_else(|| text_of(&nested["message"])).unwrap_or_default();
                    if !nested_message.is_empty() {
                        let mut parts = codes_of(nested_err);
                        parts.push(nested_message);
                        return clip(&parts.join(" · "));
                    }
                }
            }
        }
    }
    let mut parts = codes_of(err);
    if !message.is_empty() {
        parts.push(message);
    }
    if parts.is_empty() { clip(err_text) } else { clip(&parts.join(" · ")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::cases;

    #[test]
    fn matches_the_web() {
        for (i, o) in cases("is_retryable_status") {
            assert_eq!(is_retryable_status(i.as_u64().unwrap() as u16), o, "{i}");
        }
        for (i, o) in cases("is_size_rejection") {
            assert_eq!(is_size_rejection(i[0].as_u64().unwrap() as u16, i[1].as_str().unwrap()), o, "{i}");
        }
        for (i, o) in cases("is_unknown_model_rejection") {
            assert_eq!(is_unknown_model_rejection(i.as_str().unwrap()), o, "{i}");
        }
        for (i, o) in cases("extract_rejection_detail") {
            assert_eq!(extract_rejection_detail(i[0].as_str().unwrap(), i[1].as_u64().unwrap() as usize), o.as_str().unwrap(), "{i}");
        }
    }

    #[test]
    fn waits_double_under_the_cap() {
        assert!((700..950).contains(&wait_ms(&DEFAULT, 1, None)));
        assert!((2_800..3_050).contains(&wait_ms(&DEFAULT, 3, None)));
        assert_eq!(wait_ms(&OPENROUTER, 9, None), 10_000);
        assert_eq!(wait_ms(&OPENROUTER, 1, Some(120_000)), 10_000);
        assert_eq!(wait_ms(&OPENROUTER, 1, Some(0)), 0);
        assert_eq!(retry_after_ms("3"), Some(3_000));
        assert_eq!(retry_after_ms(""), None);
        assert_eq!(retry_after_ms("soon"), None);
        assert_eq!(retry_after_ms("Wed, 21 Oct 2015 07:28:00 GMT"), Some(0));
    }
}

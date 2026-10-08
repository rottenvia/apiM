//! Port of `src/lib/reasoning-stream.ts`: plain-text reasoning out of a streamed
//! delta. DeepSeek documents `reasoning_content`; gateways and model revisions
//! also use `reasoning`, `thinking` or camelCase, as a string, a list of parts or
//! an object. Ordinary answer content is never relabelled as thought.

use serde_json::Value;

const FIELDS: [&str; 4] = ["reasoning_content", "reasoning", "thinking", "reasoningContent"];

fn text_or_content(item: &Value) -> &str {
    item["text"].as_str().or_else(|| item["content"].as_str()).unwrap_or("")
}

fn plain_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|part| part.is_object())
            // A part that names its type must be a reasoning one: output_text blocks stay out.
            .filter(|part| part["type"].as_str().map(str::to_lowercase).is_none_or(|kind| kind.is_empty() || kind.contains("reason") || kind.contains("think")))
            .map(text_or_content)
            .collect(),
        Value::Object(_) => text_or_content(value).to_string(),
        _ => String::new(),
    }
}

/// The reasoning text of one delta and the field it came in, if any.
pub fn extract(delta: &Value) -> Option<(String, &'static str)> {
    FIELDS.iter().map(|field| (plain_text(&delta[*field]), *field)).find(|(text, _)| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::cases;

    #[test]
    fn matches_the_web() {
        for (i, o) in cases("extract_reasoning_delta") {
            let found = extract(&i);
            assert_eq!(found.as_ref().map(|(text, field)| (text.as_str(), *field)), o["text"].as_str().zip(o["field"].as_str()), "{i}");
        }
    }
}

//! Turning what happened into what was learned: port of src/lib/refine.ts.
//! After a finished task a cheap model is shown the OUTCOMES (which commands ran, which failed, what the errors said),
//! not the transcript, and asked to write down only facts that would have saved time if known at the start. Thinking is
//! off (extraction, not deliberation). Any failure is an empty result: this is an optional extra after the real work is
//! saved and must never turn a finished task into a failed one.

use super::{js_trim, post_json, Stop};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// One thing the agent did, and how it turned out.
#[derive(Clone, Debug, Deserialize)]
pub struct Outcome {
    pub name: String,
    pub args: String,
    pub ok: bool,
    pub summary: String,
}

/// A lesson already on file (the fields refine reads of lessons.ts's `Lesson`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownLesson {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub superseded_by: Option<String>,
}

/// A lesson the model proposes (lessons.ts's `LessonUpdate`): `replaces` names a known id it contradicts.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LessonUpdate {
    pub text: String,
    pub evidence: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaces: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct RefineResult {
    pub lessons: Vec<LessonUpdate>,
    /// Ids of known lessons the outcomes confirm.
    pub confirms: Vec<String>,
    /// Tokens spent, so the cost of learning is never hidden.
    pub usage: Option<RefineUsage>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RefineUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

const REFINE_SYSTEM: &str = r#"You record what was learned while working in a project, so the same ground is not covered twice.

You will be given the actions taken during one task and whether each worked.

Write only facts that are PROVEN by those outcomes and that would have saved time if known at the start. Good examples:
- "npm install fails here; this project uses pnpm" (proved by a failed command)
- "tests live in spec/, not tests/" (proved by a path that did not exist)
- "the build needs NODE_OPTIONS=--max-old-space-size=4096" (proved by an OOM)

Never write:
- guesses, risks, or things that "might" happen
- restatements of what the task was
- generic advice true of any project ("write tests", "handle errors")
- anything not demonstrated by the outcomes you were given

If an outcome contradicts something in KNOWN, replace it: give the id in "replaces".
If an outcome confirms something in KNOWN, list its id in "confirms".

Most tasks teach nothing durable. Returning empty lists is the correct and common answer — never invent a lesson to seem useful.

Reply with JSON only:
{"lessons":[{"text":"...","evidence":"...","replaces":"id or omit"}],"confirms":["id"]}"#;

/// Compacts the outcomes into the smallest useful evidence: one line each, `OK  `/`FAIL`, the tool, its command, path or query, the result.
pub fn build_outcome_digest(outcomes: &[Outcome]) -> String {
    outcomes
        .iter()
        .map(|o| {
            // `command ?? path ?? query`: the first one present decides, and only a string counts.
            let target = serde_json::from_str::<Value>(&o.args).ok().filter(Value::is_object).and_then(|p| ["command", "path", "query"].iter().map(|k| p[*k].clone()).find(|v| !v.is_null())).and_then(|v| v.as_str().map(|s| format!(" {s}"))).unwrap_or_default();
            format!("{} {}{target} — {}", if o.ok { "OK  " } else { "FAIL" }, o.name, o.summary)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Asks a cheap model what this task proved. `model` defaults to DeepSeek Flash; `thinking_style` None or "deepseek"
/// sends DeepSeek's `thinking: disabled` (other providers ignore it, and Ox Alpha-only setups pass their own model and style).
#[allow(clippy::too_many_arguments)]
pub async fn run_refine(client: &reqwest::Client, outcomes: &[Outcome], known: &[KnownLesson], api_key: &str, base_url: &str, stop: Option<&Stop>, model: Option<&str>, thinking_style: Option<&str>) -> RefineResult {
    // Nothing ran, so nothing was demonstrated.
    if outcomes.is_empty() {
        return RefineResult::default();
    }
    let known_block = known.iter().filter(|l| l.superseded_by.as_deref().is_none_or(str::is_empty)).map(|l| format!("[{}] {}", l.id, l.text)).collect::<Vec<_>>().join("\n");
    let mut body = Map::new();
    body.insert("model".into(), json!(model.unwrap_or("deepseek-v4-flash")));
    if thinking_style.is_none_or(|s| s == "deepseek") {
        body.insert("thinking".into(), json!({ "type": "disabled" }));
    }
    body.insert("max_tokens".into(), json!(800));
    body.insert("response_format".into(), json!({ "type": "json_object" }));
    body.insert("messages".into(), json!([{ "role": "system", "content": REFINE_SYSTEM }, { "role": "user", "content": format!("{}WHAT HAPPENED:\n{}", if known_block.is_empty() { String::new() } else { format!("KNOWN:\n{known_block}\n\n") }, build_outcome_digest(outcomes)) }]));
    let headers = [("Authorization".to_string(), format!("Bearer {api_key}"))];
    let Ok((status, text)) = post_json(client, &format!("{base_url}/chat/completions"), &headers, &Value::Object(body), None, stop).await else { return RefineResult::default() };
    if !(200..300).contains(&status) {
        return RefineResult::default();
    }
    parse_reply(&text).unwrap_or_default()
}

/// The model's JSON answer. A non-object lesson entry (`null`) throws in the web and empties the whole result; mirrored.
fn parse_reply(text: &str) -> Option<RefineResult> {
    let reply: Value = serde_json::from_str(text).ok()?;
    let raw = reply["choices"][0]["message"]["content"].as_str().unwrap_or("");
    if js_trim(raw).is_empty() {
        return None;
    }
    let parsed: Value = serde_json::from_str(raw).ok().filter(|p: &Value| !p.is_null())?;
    let lessons = match parsed["lessons"].as_array() {
        Some(list) => {
            if list.iter().any(Value::is_null) {
                return None;
            }
            list.iter()
                .filter(|l| l["text"].is_string() && l["evidence"].is_string())
                .take(12)
                .map(|l| LessonUpdate { text: l["text"].as_str().unwrap_or("").to_string(), evidence: l["evidence"].as_str().unwrap_or("").to_string(), replaces: l["replaces"].as_str().filter(|r| !r.is_empty()).map(str::to_string) })
                .collect()
        }
        None => Vec::new(),
    };
    let confirms = parsed["confirms"].as_array().map_or_else(Vec::new, |a| a.iter().filter_map(|c| c.as_str().map(str::to_string)).take(20).collect());
    let num = |v: &Value| v.as_f64().unwrap_or(0.0) as u64;
    let usage = super::js_truthy(&reply["usage"]).then(|| RefineUsage { prompt_tokens: num(&reply["usage"]["prompt_tokens"]), completion_tokens: num(&reply["usage"]["completion_tokens"]) });
    Some(RefineResult { lessons, confirms, usage })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::testkit::{cases, check, client, compact, expand, stub};

    fn outcomes(v: &Value) -> Vec<Outcome> {
        serde_json::from_value(v.clone()).unwrap()
    }

    #[test]
    fn replays_the_digest() {
        check("refine.buildOutcomeDigest", |i| json!(build_outcome_digest(&outcomes(i))));
    }

    #[tokio::test]
    async fn replays_the_model_call_against_a_stub() {
        for (i, (spec, want)) in cases("refine.run").iter().enumerate() {
            let spec = expand(spec);
            let replies = spec["script"].as_array().unwrap().iter().map(|s| (s["status"].as_u64().unwrap() as u16, if let Some(t) = s["body"].as_str() { t.to_string() } else { s["body"].to_string() })).collect();
            let server = stub(replies);
            let known: Vec<KnownLesson> = serde_json::from_value(spec["known"].clone()).unwrap();
            let o = &spec["options"];
            let result = run_refine(&client(), &outcomes(&spec["outcomes"]), &known, "key-2", &server.base, None, o["model"].as_str(), o["thinkingStyle"].as_str()).await;
            let requests: Vec<Value> = server.requests().iter().map(|r| json!({ "url": r["url"], "headers": r["headers"], "body": r["body"] })).collect();
            let mut got = compact(&json!({ "result": result, "requests": requests }));
            let mut want = want.clone();
            for (g, w) in got["requests"].as_array_mut().unwrap().iter_mut().zip(want["requests"].as_array_mut().unwrap().iter_mut()) {
                assert_eq!(g["headers"]["authorization"], w["headers"]["Authorization"], "case {i}");
                assert_eq!(g["headers"]["content-type"], w["headers"]["Content-Type"], "case {i}");
                g["headers"] = Value::Null;
                w["headers"] = Value::Null;
            }
            assert_eq!(got, want, "refine.run case {i}");
        }
    }
}

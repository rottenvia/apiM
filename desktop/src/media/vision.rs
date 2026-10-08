//! Image understanding for a model that cannot see (src/lib/vision.ts, src/app/api/vision/route.ts). The picture is
//! described by an OpenAI-style vision model and only that description reaches the text-only model. Models that can see
//! take the pixels themselves and never come here. There is no cache in the web: the description is stored on the
//! attachment (`description`, `description_source`) and travels with the message.

use super::slice16;
use serde_json::{Value, json};
use std::time::Duration;

pub const DEFAULT_VISION_BASE_URL: &str = "https://api.openai.com/v1";
/// Cheap, fast, and good enough for screenshots.
pub const DEFAULT_VISION_MODEL: &str = "gpt-4o-mini";
pub const IMAGE_MIME_TYPES: [&str; 6] = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/bmp"];

/// Where vision requests go: `VISION_BASE_URL` when set, else OpenAI.
pub fn vision_base_url() -> String {
    std::env::var("VISION_BASE_URL").unwrap_or_else(|_| DEFAULT_VISION_BASE_URL.to_string())
}

/// The route's `model || DEFAULT_VISION_MODEL`: an empty setting means the default.
pub fn model_or_default(model: &str) -> &str {
    if model.is_empty() { DEFAULT_VISION_MODEL } else { model }
}

pub fn is_image_file(mime: &str, name: &str) -> bool {
    IMAGE_MIME_TYPES.contains(&mime) || regex::Regex::new(r"(?i)\.(png|jpe?g|webp|gif|bmp)$").unwrap().is_match(name)
}

const SYSTEM_PROMPT: &str = "You convert images into text for a text-only assistant that cannot see them.

Describe the image completely enough that someone reading only your description could answer questions about it.

- Transcribe ALL visible text exactly, preserving code indentation and line breaks.
- For code or terminal output, reproduce it verbatim inside a fenced code block with the right language.
- For errors, give the full message, file paths and line numbers exactly.
- For a UI, describe the layout, what is where, and anything that looks broken, misaligned or cut off.
- For charts or diagrams, state the structure, labels and the values or relationships shown.
- Note anything visually wrong even if not asked.

Be factual. Never guess at text that is unreadable — say it is unclear instead.
Do not add commentary, opinions or a preamble. Output only the description.";

/// What came back: a description, or the reason there is none.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct VisionResult {
    pub description: Option<String>,
    pub error: Option<String>,
    /// "vision" or "ocr"; absent on a hard failure.
    pub source: Option<&'static str>,
}

impl VisionResult {
    pub fn error(text: impl Into<String>) -> VisionResult {
        VisionResult { error: Some(text.into()), ..Default::default() }
    }
}

/// How JavaScript would print a JSON value inside a template string.
fn js_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(items) => items.iter().map(js_text).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        other => other.to_string(),
    }
}

/// Sends one picture to the vision model and returns its description. `data_url` is a base64 data URL, which is how a
/// pasted or dropped file arrives with no upload step. `base_url` is `vision_base_url()` outside tests.
pub async fn describe_image(client: &reqwest::Client, base_url: &str, data_url: &str, api_key: &str, model: &str, hint: Option<&str>) -> VisionResult {
    if api_key.is_empty() {
        return VisionResult::error("No vision API key configured");
    }
    let ask = match hint.filter(|h| !h.is_empty()) {
        Some(h) => format!("Describe this image. The user asks: \"{h}\""),
        None => "Describe this image.".to_string(),
    };
    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            // "high" detail costs more but is what makes small UI text and stack traces legible, which is the whole point.
            { "role": "user", "content": [{ "type": "text", "text": ask }, { "type": "image_url", "image_url": { "url": data_url, "detail": "high" } }] },
        ],
        "max_tokens": 4096,
        "temperature": 0,
    });
    let sent = client.post(format!("{base_url}/chat/completions")).bearer_auth(api_key).timeout(Duration::from_secs(90)).json(&body).send().await;
    let failed = |e: reqwest::Error| VisionResult::error(if e.is_timeout() { "The vision model took too long to respond" } else { "Couldn't reach the vision API" });
    let response = match sent {
        Ok(r) => r,
        Err(e) => return failed(e),
    };
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let detail = match serde_json::from_str::<Value>(&text) {
            Ok(v) => js_text(&v["error"]["message"]),
            Err(_) => slice16(&text, 160).to_string(),
        };
        return VisionResult::error(match status.as_u16() {
            401 => "Vision API key was rejected. Check it in Settings.".to_string(),
            429 => "Vision API rate limit reached. Try again shortly.".to_string(),
            code => format!("Vision API error ({code}){}", if detail.is_empty() { String::new() } else { format!(": {detail}") }),
        });
    }
    let data: Value = match response.json().await {
        Ok(v) => v,
        Err(e) => return failed(e),
    };
    match data["choices"][0]["message"]["content"].as_str().map(super::js_trim) {
        Some(description) if !description.is_empty() => VisionResult { description: Some(description.to_string()), ..Default::default() },
        _ => VisionResult::error("The vision model returned an empty description"),
    }
}

/// Wraps a description so the model knows it came from a picture, not from the user.
pub fn format_image_block(name: &str, description: &str) -> String {
    format!("<image name=\"{name}\">\n{description}\n</image>")
}

#[cfg(test)]
pub(crate) mod stub {
    use std::io::{Read, Write};

    /// A one-shot HTTP server on 127.0.0.1 answering with a canned status and body; returns its base URL and the request it saw.
    pub fn serve(status: &str, body: &str) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let reply = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut seen = Vec::new();
            let mut buf = [0u8; 8192];
            loop {
                let n = stream.read(&mut buf).unwrap_or(0);
                seen.extend(&buf[..n]);
                let text = String::from_utf8_lossy(&seen).to_string();
                if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                    let wanted = head.to_lowercase().split("content-length: ").nth(1).and_then(|l| l.split("\r\n").next()?.trim().parse::<usize>().ok()).unwrap_or(0);
                    if rest.len() >= wanted {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            stream.write_all(reply.as_bytes()).unwrap();
            String::from_utf8_lossy(&seen).to_string()
        });
        (base, handle)
    }
}

#[cfg(test)]
mod tests {
    use super::stub::serve;
    use super::*;

    const GOOD: &str = r#"{"choices":[{"message":{"content":"  A login form.  "}}]}"#;

    #[tokio::test]
    async fn a_description_comes_back_trimmed_and_the_request_is_the_webs() {
        let (base, seen) = serve("200 OK", GOOD);
        let r = describe_image(&reqwest::Client::new(), &base, "data:image/png;base64,AQID", "sk-test", "gpt-4o-mini", Some("what is wrong?")).await;
        assert_eq!(r, VisionResult { description: Some("A login form.".into()), ..Default::default() });
        let request = seen.join().unwrap();
        let (head, body) = request.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("POST /chat/completions HTTP/1.1") && head.to_lowercase().contains("authorization: bearer sk-test"), "{head}");
        let sent: Value = serde_json::from_str(body).unwrap();
        assert_eq!((sent["model"].as_str(), sent["max_tokens"].as_u64(), sent["temperature"].as_u64(), sent["messages"][0]["content"].as_str().map(|s| s.starts_with("You convert images into text"))), (Some("gpt-4o-mini"), Some(4096), Some(0), Some(true)));
        assert_eq!(sent["messages"][1]["content"][0]["text"], "Describe this image. The user asks: \"what is wrong?\"");
        assert_eq!((&sent["messages"][1]["content"][1]["image_url"]["url"], &sent["messages"][1]["content"][1]["image_url"]["detail"]), (&json!("data:image/png;base64,AQID"), &json!("high")));
    }

    #[tokio::test]
    async fn failures_use_the_webs_words() {
        let client = reqwest::Client::new();
        let go = |status: &'static str, body: &'static str| {
            let client = client.clone();
            async move {
                let (base, seen) = serve(status, body);
                let r = describe_image(&client, &base, "data:image/png;base64,AQID", "k", "m", None).await;
                let _ = seen.join();
                r.error.unwrap()
            }
        };
        assert_eq!(go("401 Unauthorized", "{}").await, "Vision API key was rejected. Check it in Settings.");
        assert_eq!(go("429 Too Many Requests", "{}").await, "Vision API rate limit reached. Try again shortly.");
        assert_eq!(go("402 Payment Required", r#"{"error":{"message":"You exceeded your current quota"}}"#).await, "Vision API error (402): You exceeded your current quota");
        assert_eq!(go("500 Internal Server Error", "<html>boom</html>").await, "Vision API error (500): <html>boom</html>");
        assert_eq!(go("500 Internal Server Error", r#"{"x":1}"#).await, "Vision API error (500)");
        assert_eq!(go("200 OK", r#"{"choices":[{"message":{"content":"  "}}]}"#).await, "The vision model returned an empty description");
        assert_eq!(go("200 OK", "not json").await, "Couldn't reach the vision API");
        assert_eq!(describe_image(&client, "http://127.0.0.1:1", "data:image/png;base64,AQID", "k", "m", None).await.error.unwrap(), "Couldn't reach the vision API");
        assert_eq!(describe_image(&client, "http://127.0.0.1:1", "x", "", "m", None).await.error.unwrap(), "No vision API key configured");
    }

    #[test]
    fn small_helpers() {
        assert!(is_image_file("image/webp", "x") && is_image_file("", "Shot.JPEG") && !is_image_file("", "a.svg"));
        assert_eq!((model_or_default(""), model_or_default("gpt-4o")), ("gpt-4o-mini", "gpt-4o"));
        assert_eq!(format_image_block("a.png", "a cat"), "<image name=\"a.png\">\na cat\n</image>");
    }
}

#[cfg(test)]
mod parity {
    use super::stub::serve;
    use super::*;
    use crate::media::fixtures::ALL;

    #[tokio::test]
    async fn requests_and_failures_match_the_web() {
        let client = reqwest::Client::new();
        for case in ALL["vision"].as_array().unwrap() {
            let (label, key, model) = (case["label"].as_str().unwrap(), case["key"].as_str().unwrap(), case["model"].as_str().unwrap());
            let served = (!key.is_empty()).then(|| serve(&format!("{} Stub", case["status"]), case["body"].as_str().unwrap()));
            let base = served.as_ref().map_or("http://127.0.0.1:1".to_string(), |(base, _)| base.clone());
            let got = describe_image(&client, &base, "data:image/png;base64,AQID", key, model, case["hint"].as_str()).await;
            let want = &case["expect"];
            assert_eq!((got.description.as_deref(), got.error.as_deref()), (want["description"].as_str(), want["error"].as_str()), "{label}");
            if let Some((_, seen)) = served {
                let request = seen.join().unwrap();
                let sent: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
                assert_eq!(sent, case["request"], "{label}");
            }
        }
        assert_eq!(format_image_block("a.png", "a cat"), ALL["imageBlock"].as_str().unwrap());
    }
}

//! What the model is sent for one user turn (src/lib/multimodal.ts): plain text, or OpenAI-compatible content parts.
//! The web has one wire shape for every provider (`text`, `image_url`, `video_url` parts); turning that into a
//! provider's own dialect is the provider layer's job, not this file's.
//!
//! A model that can see gets text plus `image_url` / `video_url` parts; one that cannot gets a string, with the picture
//! descriptions as `<image>` blocks. History turns can be sent with their pixels replaced by one-line references, because
//! re-sending every past attachment on every request is what bloats the body past what a gateway accepts.

use super::video::Frame;
use super::{js_trim, to_fixed};
use crate::models::Vision;
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MediaKind {
    #[default]
    Text,
    Image,
    Video,
}

/// One attachment as stored on a chat message (the web's `StoredAttachment`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Media {
    pub name: String,
    pub kind: MediaKind,
    /// Pictures and native video: a data URL, so a model that can see can replay the pixels.
    pub data_url: Option<String>,
    /// Video sampled into stills at attach time. With frames, `data_url` is absent: never both.
    pub frames: Vec<Frame>,
    pub duration_sec: f64,
    pub frame_interval_sec: f64,
    /// Pictures on the helper path: what vision or OCR extracted.
    pub description: Option<String>,
}

impl From<&crate::store::Attachment> for Media {
    fn from(a: &crate::store::Attachment) -> Media {
        let kind = match a.kind.as_str() {
            "image" => MediaKind::Image,
            "video" => MediaKind::Video,
            _ => MediaKind::Text,
        };
        Media { name: a.name.clone(), kind, data_url: a.data_url.clone(), frames: a.frames.clone(), duration_sec: a.duration_sec.unwrap_or(0.0), frame_interval_sec: a.frame_interval_sec.unwrap_or(0.0), description: a.description.clone() }
    }
}

/// Which media a history turn still sends in full; `None` means yes.
#[derive(Clone, Copy, Debug, Default)]
pub struct MediaWindow {
    pub images: Option<bool>,
    pub videos: Option<bool>,
}

const RIDE_ALONG_REFERENCE: &str = "[video omitted — it already rode once; re-attach the clip or flip the chip to frames to look again]";
const RIDE_ALONG_IMAGE_REFERENCE: &str = "[earlier attachment(s) omitted — they already rode once; re-attach the image to look again]";
const INLINE_MEDIA_REFERENCE: &str = "[media omitted — it already rode once; re-attach the file to look again]";

fn text_part(text: impl Into<String>) -> Value {
    json!({ "type": "text", "text": text.into() })
}
fn image_part(url: &str) -> Value {
    json!({ "type": "image_url", "image_url": { "url": url } })
}

/// True when the turn has something the model can read.
pub fn user_has_content(content: &Value) -> bool {
    match content {
        Value::String(s) => !js_trim(s).is_empty(),
        Value::Array(parts) => parts.iter().any(|p| match p["type"].as_str() {
            Some("text") => !js_trim(p["text"].as_str().unwrap_or("")).is_empty(),
            Some("image_url") => p["image_url"]["url"].as_str().is_some_and(|u| !u.is_empty()),
            _ => p["video_url"]["url"].as_str().is_some_and(|u| !u.is_empty()),
        }),
        _ => false,
    }
}

/// The turn as plain text, for titles, search planning and logs.
pub fn user_content_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => js_trim(&parts.iter().filter(|p| p["type"] == "text").map(|p| p["text"].as_str().unwrap_or("")).collect::<Vec<_>>().join("\n")).to_string(),
        _ => String::new(),
    }
}

/// `[Video "…" — N still frames]`: the line that introduces a group of frames.
fn is_frame_group_header(part: &Value) -> bool {
    part["type"] == "text" && part["text"].as_str().is_some_and(|t| t.starts_with("[Video \""))
}

/// `${n.toFixed(2).replace(/\.?0+$/, "")}`: 2.00 → "2", 0.50 → "0.5".
fn trim_zeros(text: &str) -> String {
    regex::Regex::new(r"\.?0+$").unwrap().replace(text, "").into_owned()
}

/// The user turn's `content`: a string, or an array of parts for a model that sees.
pub fn build_user_content(text: &str, attachments: &[Media], vision: Vision, window: Option<MediaWindow>) -> Value {
    let media: Vec<&Media> = attachments.iter().filter(|a| (a.kind == MediaKind::Image && a.data_url.as_deref().is_some_and(|u| !u.is_empty())) || (a.kind == MediaKind::Video && (a.data_url.as_deref().is_some_and(|u| !u.is_empty()) || !a.frames.is_empty()))).collect();

    if vision == Vision::Native && !media.is_empty() {
        let (mut parts, mut dropped) = (Vec::new(), Vec::new());
        let trimmed = js_trim(text);
        if !trimmed.is_empty() {
            parts.push(text_part(trimmed));
        }
        for a in &media {
            // A frames-mode video is images on the wire but a video in spirit: it windows exactly like a native one.
            let as_frames = a.kind == MediaKind::Video && a.data_url.as_deref().is_none_or(str::is_empty) && !a.frames.is_empty();
            let keep = window.is_none_or(|w| if a.kind == MediaKind::Video { w.videos != Some(false) } else { w.images != Some(false) });
            if !keep {
                dropped.push(if as_frames { format!("{} (video as frames)", a.name) } else { format!("{} ({})", a.name, if a.kind == MediaKind::Video { "video" } else { "image" }) });
                continue;
            }
            if as_frames {
                let n = a.frames.len();
                let interval = trim_zeros(&to_fixed(a.frame_interval_sec, 2));
                let cadence = if n == 1 { "a single still at 0.0s".to_string() } else { format!("{n} still frames sampled evenly across the clip, one every {interval}s starting at 0.0s, in order — frame k of {n} sits at about (k-1)×{interval}s") };
                parts.push(text_part(format!("[Video \"{}\" ({}s) attached as {cadence}. Motion between frames is not visible; reason across the sequence for anything time-based.]", a.name, to_fixed(a.duration_sec, 1))));
                parts.extend(a.frames.iter().map(|f| image_part(&f.data_url)));
            } else if a.kind == MediaKind::Video {
                parts.push(json!({ "type": "video_url", "video_url": { "url": a.data_url } }));
            } else {
                parts.push(image_part(a.data_url.as_deref().unwrap_or("")));
            }
        }
        if !dropped.is_empty() {
            parts.push(text_part(format!("[Earlier attachment{}: {} — kept in the conversation, not re-sent in later turns]", if dropped.len() > 1 { "s" } else { "" }, dropped.join(", "))));
        }
        return if parts.is_empty() { Value::String(text.to_string()) } else { Value::Array(parts) };
    }

    // History replay on a helper model: the stored content is what the user typed, so the description blocks the
    // composer would have inlined are rebuilt.
    if vision == Vision::Helper && !has_image_block(text) && media.iter().any(|a| a.kind == MediaKind::Image && a.description.is_some()) {
        let blocks: Vec<String> = media.iter().filter(|a| a.kind == MediaKind::Image).map(|a| match &a.description {
            Some(d) if !d.is_empty() => format!("<image name=\"{}\">\n{d}\n</image>", a.name),
            _ => format!("<image name=\"{}\">\n[the image could not be read]\n</image>", a.name),
        }).collect();
        let trimmed = js_trim(text);
        return Value::String(if trimmed.is_empty() { blocks.join("\n\n") } else { format!("{}\n\n{trimmed}", blocks.join("\n\n")) });
    }
    Value::String(text.to_string())
}

/// `/<image\s/i`.
fn has_image_block(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.match_indices("<image").any(|(at, _)| lower[at + 6..].chars().next().is_some_and(char::is_whitespace))
}

/// Inline base64 media of 100 KB or more inside string content, from older transcript shapes, replaced by a reference.
/// Scanned by hand: the equivalent pattern would be a 100,000-state automaton run over megabytes.
fn strip_inline_blobs(text: &str) -> String {
    let is_b64 = |b: &u8| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=');
    let (mut out, mut rest) = (String::new(), text);
    while let Some(at) = rest.find("data:") {
        let after = &rest[at + 5..];
        let kind = ["image/", "video/"].iter().find(|k| after.starts_with(*k)).map_or(0, |k| k.len());
        let subtype = after[kind..].bytes().take_while(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'+' | b'-')).count();
        let header = kind + subtype;
        if kind > 0 && subtype > 0 && after[header..].starts_with(";base64,") {
            let body = header + 8;
            let run = after[body..].bytes().take_while(is_b64).count();
            if run >= 100_000 {
                out.push_str(&rest[..at]);
                out.push_str(INLINE_MEDIA_REFERENCE);
                rest = &after[body + run..];
                continue;
            }
        }
        out.push_str(&rest[..at + 5]);
        rest = after;
    }
    out.push_str(rest);
    out
}

/// Replaces media payloads with one-line references, for the copy that goes on the wire. A clip's first ride does the
/// work; replaying megabytes of base64 on every later round re-ships what the model cannot re-ingest. Three encodings
/// carry pixels and all three are covered: a native `video_url` part, a frames group (the `[Video "…"` header and the
/// images after it), and inline base64 in string content. `keep_last_user_video` is true only for the opening request of a
/// fresh send. Returns new messages; the stored ones keep their originals.
pub fn strip_ride_along_videos(messages: &[Value], keep_last_user_video: bool) -> Vec<Value> {
    let last_user = if keep_last_user_video { messages.iter().rposition(|m| m["role"] == "user") } else { None };
    messages.iter().enumerate().map(|(i, msg)| {
        if msg["role"] != "user" || Some(i) == last_user {
            return msg.clone();
        }
        let with = |content: Value| {
            let mut changed = msg.clone();
            changed["content"] = content;
            changed
        };
        if let Some(text) = msg["content"].as_str() {
            if !text.contains(";base64,") {
                return msg.clone();
            }
            let stripped = strip_inline_blobs(text);
            return if stripped == text { msg.clone() } else { with(Value::String(stripped)) };
        }
        let Some(parts) = msg["content"].as_array() else { return msg.clone() };
        // A plain screenshot rides as an ordinary image part and would re-ship on every mid-run round unless guarded.
        if !parts.iter().any(|p| p["type"] == "video_url" || p["type"] == "image_url" || is_frame_group_header(p)) {
            return msg.clone();
        }
        let (mut out, mut p) = (Vec::new(), 0);
        while p < parts.len() {
            let part = &parts[p];
            if part["type"] == "video_url" {
                out.push(text_part(RIDE_ALONG_REFERENCE));
            } else if is_frame_group_header(part) {
                out.push(text_part(RIDE_ALONG_REFERENCE));
                // The still frames that belong to this header go with it.
                while p + 1 < parts.len() && parts[p + 1]["type"] == "image_url" {
                    p += 1;
                }
            } else if part["type"] == "image_url" {
                out.push(text_part(RIDE_ALONG_IMAGE_REFERENCE));
            } else {
                out.push(part.clone());
            }
            p += 1;
        }
        with(Value::Array(out))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picture(name: &str) -> Media {
        Media { name: name.into(), kind: MediaKind::Image, data_url: Some(format!("data:image/png;base64,{name}")), description: Some(format!("desc of {name}")), ..Default::default() }
    }
    fn clip(name: &str) -> Media {
        Media { name: name.into(), kind: MediaKind::Video, data_url: Some("data:video/mp4;base64,QQ==".into()), ..Default::default() }
    }
    fn strip(name: &str, n: usize) -> Media {
        Media { name: name.into(), kind: MediaKind::Video, frames: (0..n).map(|i| Frame { data_url: format!("data:image/jpeg;base64,F{i}"), t: i as f64 * 0.5 }).collect(), duration_sec: 2.0, frame_interval_sec: 0.5, ..Default::default() }
    }

    #[test]
    fn a_model_that_sees_gets_parts() {
        let parts = build_user_content(" look ", &[picture("a.png"), clip("c.mp4"), strip("s.mp4", 4)], Vision::Native, None);
        assert_eq!(parts[0], json!({ "type": "text", "text": "look" }));
        assert_eq!(parts[1], json!({ "type": "image_url", "image_url": { "url": "data:image/png;base64,a.png" } }));
        assert_eq!(parts[2], json!({ "type": "video_url", "video_url": { "url": "data:video/mp4;base64,QQ==" } }));
        assert_eq!(parts[3]["text"], "[Video \"s.mp4\" (2.0s) attached as 4 still frames sampled evenly across the clip, one every 0.5s starting at 0.0s, in order — frame k of 4 sits at about (k-1)×0.5s. Motion between frames is not visible; reason across the sequence for anything time-based.]");
        assert_eq!((parts.as_array().unwrap().len(), parts[7]["image_url"]["url"].as_str()), (8, Some("data:image/jpeg;base64,F3")));
        let one = build_user_content("", &[strip("s.mp4", 1)], Vision::Native, None);
        assert!(one[0]["text"].as_str().unwrap().contains("attached as a single still at 0.0s."));
        assert_eq!(trim_zeros("2.00"), "2");
        assert_eq!((trim_zeros("0.50"), trim_zeros("10.00"), trim_zeros("0.00"), trim_zeros("1.05")), ("0.5".into(), "10".into(), "0".into(), "1.05".into()));
    }

    #[test]
    fn history_turns_can_drop_their_pixels() {
        let window = MediaWindow { images: Some(false), videos: None };
        let parts = build_user_content("hi", &[picture("a.png"), picture("b.png"), strip("s.mp4", 2)], Vision::Native, Some(window));
        assert_eq!(parts.as_array().unwrap().len(), 5);
        assert_eq!(parts[4]["text"], "[Earlier attachments: a.png (image), b.png (image) — kept in the conversation, not re-sent in later turns]");
        let all = build_user_content("hi", &[strip("s.mp4", 2)], Vision::Native, Some(MediaWindow { images: None, videos: Some(false) }));
        assert_eq!(all[1]["text"], "[Earlier attachment: s.mp4 (video as frames) — kept in the conversation, not re-sent in later turns]");
    }

    #[test]
    fn a_helper_model_gets_a_string() {
        assert_eq!(build_user_content("what?", &[picture("a.png")], Vision::Helper, None), json!("<image name=\"a.png\">\ndesc of a.png\n</image>\n\nwhat?"));
        let mut blind = picture("b.png");
        blind.description = None;
        assert_eq!(build_user_content("", &[picture("a.png"), blind.clone()], Vision::Helper, None), json!("<image name=\"a.png\">\ndesc of a.png\n</image>\n\n<image name=\"b.png\">\n[the image could not be read]\n</image>"));
        assert_eq!(build_user_content("x", &[blind.clone()], Vision::Helper, None), json!("x"));
        assert_eq!(build_user_content("<image name=\"a\">d</image>", &[picture("a.png")], Vision::Helper, None), json!("<image name=\"a\">d</image>"));
        assert_eq!(build_user_content("hi", &[picture("a.png")], Vision::None, None), json!("hi"));
        assert_eq!(build_user_content("hi", &[], Vision::Native, None), json!("hi"));
    }

    #[test]
    fn content_checks() {
        assert!(!user_has_content(&json!("  ")) && user_has_content(&json!("a")) && !user_has_content(&Value::Null));
        assert!(user_has_content(&json!([{ "type": "video_url", "video_url": { "url": "x" } }])) && !user_has_content(&json!([{ "type": "image_url", "image_url": { "url": "" } }])));
        assert_eq!(user_content_text(&json!([{ "type": "text", "text": "a" }, { "type": "image_url", "image_url": { "url": "u" } }, { "type": "text", "text": "b" }])), "a\nb");
        assert_eq!(user_content_text(&json!("s")), "s");
    }

    #[test]
    fn ride_along_media_is_replaced_after_its_first_round() {
        let frames = build_user_content("see", &[picture("a.png"), strip("s.mp4", 2)], Vision::Native, None);
        let native = build_user_content("see", &[clip("c.mp4")], Vision::Native, None);
        let blob = format!("hello data:image/png;base64,{} bye data:image/png;base64,AAAA", "A".repeat(100_000));
        let messages = vec![json!({ "role": "user", "content": frames }), json!({ "role": "assistant", "content": "ok" }), json!({ "role": "user", "content": native.clone() }), json!({ "role": "user", "content": blob }), json!({ "role": "user", "content": "plain" })];
        let sent = strip_ride_along_videos(&messages, true);
        assert_eq!(sent[0]["content"], json!([{ "type": "text", "text": "see" }, { "type": "text", "text": RIDE_ALONG_IMAGE_REFERENCE }, { "type": "text", "text": RIDE_ALONG_REFERENCE }]));
        assert_eq!(sent[1], messages[1]);
        assert_eq!(sent[3]["content"], format!("hello {INLINE_MEDIA_REFERENCE} bye data:image/png;base64,AAAA"));
        assert_eq!(sent[4], messages[4]);
        assert_eq!(sent[2]["content"], json!([{ "type": "text", "text": "see" }, { "type": "text", "text": RIDE_ALONG_REFERENCE }]));
        let opening = strip_ride_along_videos(&messages[2..3], true);
        assert_eq!(opening[0], messages[2]);
        assert!(has_image_block("x <IMAGE name=\"a\">") && !has_image_block("<imagery>") && !has_image_block("<image"));
    }
}

#[cfg(test)]
mod parity {
    use super::*;
    use crate::media::fixtures::ALL;

    fn media(a: &Value) -> Media {
        Media {
            name: a["name"].as_str().unwrap().to_string(),
            kind: match a["kind"].as_str().unwrap() { "image" => MediaKind::Image, "video" => MediaKind::Video, _ => MediaKind::Text },
            data_url: a["dataUrl"].as_str().map(String::from),
            frames: a["frames"].as_array().map_or(Vec::new(), |f| f.iter().map(|x| Frame { data_url: x["dataUrl"].as_str().unwrap().to_string(), t: x["t"].as_f64().unwrap() }).collect()),
            duration_sec: a["durationSec"].as_f64().unwrap_or(0.0),
            frame_interval_sec: a["frameIntervalSec"].as_f64().unwrap_or(0.0),
            description: a["description"].as_str().map(String::from),
        }
    }

    #[test]
    fn user_content_matches_the_web() {
        for case in ALL["multimodal"].as_array().unwrap() {
            let attached: Vec<Media> = case["attachments"].as_array().unwrap().iter().map(media).collect();
            let vision = match case["vision"].as_str().unwrap() { "native" => Vision::Native, "none" => Vision::None, _ => Vision::Helper };
            let window = case["window"].as_object().map(|_| MediaWindow { images: case["window"]["images"].as_bool(), videos: case["window"]["videos"].as_bool() });
            assert_eq!(build_user_content(case["text"].as_str().unwrap(), &attached, vision, window), case["expect"], "{case}");
        }
        for c in ALL["hasContent"].as_array().unwrap() {
            assert_eq!((user_has_content(&c[0]), user_content_text(&c[0]).as_str()), (c[1].as_bool().unwrap(), c[2].as_str().unwrap()), "{c}");
        }
    }

    #[test]
    fn stripping_matches_the_web() {
        for case in ALL["strip"].as_array().unwrap() {
            let messages = case["messages"].as_array().unwrap();
            let got = strip_ride_along_videos(messages, case["keepLastUserVideo"].as_bool().unwrap());
            assert_eq!(Value::Array(got), case["expect"], "keep={}", case["keepLastUserVideo"]);
        }
    }
}

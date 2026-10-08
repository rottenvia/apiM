//! What earlier turns of a chat send the model: a port of the web app's replay in `src/app/api/chat/route.ts` (the
//! `scopedHistory` loop and `mediaWindowFor`), with `replayable` from `src/lib/chat-history.ts` and the window from
//! `shapeHistory` in `src/lib/history-summary.ts`.
//!
//! An earlier reply goes out as its prose alone: its tool steps, their results and its reasoning stay in the chat.
//! Interrupted and errored replies do not replay at all. A reply being resumed is the exception and is rebuilt from its
//! own saved transcript (`rebuild_resume`), not from here.

use crate::media::multimodal::{Media, MediaWindow, build_user_content, user_has_content};
use crate::models::Vision;
use crate::store::{Attachment, HistorySummary, Message, Role};
use crate::summary;
use serde_json::{Value, json};

/// A finished user or assistant turn with text or media: the turns the web replays (its `replayable`).
pub fn replays(m: &Message) -> bool {
    matches!(m.role, Role::User | Role::Assistant) && (!m.text().trim().is_empty() || !m.attachments.is_empty()) && !m.incomplete
}

/// The earlier turns a request replays, oldest first, as (role, prose, attachments): the rolling window the web keeps.
pub fn history(messages: &[Message], stored: Option<&HistorySummary>) -> Vec<(Role, String, Vec<Attachment>)> {
    summary::shape(messages, stored).verbatim.iter().map(|m| (m.role, m.text(), m.attachments.clone())).collect()
}

/// The web's `mediaWindowFor`: on a native model the two newest pictures in the history ride in full, and a clip never
/// replays from history. Other models get no window: their history carries descriptions, not pixels.
pub fn media_windows(turns: &[(Role, String, Vec<Attachment>)], native: bool) -> Vec<Option<MediaWindow>> {
    let mut windows = vec![None; turns.len()];
    if !native {
        return windows;
    }
    let mut pictures = 0;
    for (i, (role, _, attached)) in turns.iter().enumerate().rev() {
        if *role != Role::User {
            continue;
        }
        let picture = attached.iter().any(|a| a.kind == "image" && a.data_url.as_deref().is_some_and(|u| !u.is_empty()));
        let clip = attached.iter().any(|a| a.kind == "video" && (a.data_url.is_some() || !a.frames.is_empty()));
        if picture || clip {
            windows[i] = Some(MediaWindow { images: Some(picture && pictures < 2), videos: Some(false) });
        }
        pictures += usize::from(picture);
    }
    windows
}

/// The conversation the model reads for this turn: the earlier turns, then the message being answered, built the way the
/// web's `buildUserContent` builds each user turn.
pub fn wire_turns(history: &[(Role, String, Vec<Attachment>)], text: &str, images: &[Attachment], vision: Vision) -> Vec<Value> {
    let mut out = Vec::new();
    for ((role, past, attached), window) in history.iter().zip(media_windows(history, vision == Vision::Native)) {
        if *role == Role::User {
            let media: Vec<Media> = attached.iter().map(Media::from).collect();
            let content = build_user_content(past, &media, vision, window);
            if user_has_content(&content) {
                out.push(json!({ "role": "user", "content": content }));
            }
        } else if !past.trim().is_empty() {
            out.push(json!({ "role": "assistant", "content": past }));
        }
    }
    // The question as it reads on every model: a model that cannot see gets the text alone, with no note about the pictures.
    let media: Vec<Media> = images.iter().map(Media::from).collect();
    out.push(json!({ "role": "user", "content": build_user_content(text, &media, vision, None) }));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The web's replay, case by case. Each pair is [input, output]: a stored chat with the question being answered, and what
    /// the web sends for it (the summary first, then the window). `transcript_fixtures.json` was dumped from the TypeScript
    /// history code (`shapeHistory`, `buildUserContent`) with the chat route's replay loop copied in.
    #[test]
    fn earlier_turns_go_out_as_the_web_sends_them() {
        let cases: Vec<(Value, Value)> = serde_json::from_str(include_str!("transcript_fixtures.json")).unwrap();
        assert_eq!(cases.len(), 5);
        for (input, expected) in cases {
            let chat = &input["chat"];
            let messages: Vec<Message> = chat["messages"].as_array().unwrap().iter().map(Message::from_web).collect();
            let stored: Option<HistorySummary> = serde_json::from_value(chat["historySummary"].clone()).ok();
            let vision = match input["vision"].as_str().unwrap() {
                "native" => Vision::Native,
                "helper" => Vision::Helper,
                _ => Vision::None,
            };
            let mut sent: Vec<Value> = stored.iter().map(|s| json!({ "role": "system", "content": summary::render(s) })).collect();
            sent.extend(wire_turns(&history(&messages, stored.as_ref()), input["text"].as_str().unwrap(), &[], vision));
            assert_eq!(Value::Array(sent), expected, "case {}", input["name"]);
        }
    }

    /// A picture in the question reaches a model that cannot see as nothing, as the web's `buildUserContent` sends it.
    #[test]
    fn a_question_with_a_picture_reads_as_text_to_a_model_that_cannot_see() {
        let picture = Attachment { name: "ui.png".into(), kind: "image".into(), data_url: Some("data:image/png;base64,AQID".into()), ..Default::default() };
        assert_eq!(wire_turns(&[], "Look", std::slice::from_ref(&picture), Vision::None), vec![json!({ "role": "user", "content": "Look" })]);
    }

    /// An earlier reply's tool steps and reasoning are not part of what replays: only its prose is.
    #[test]
    fn a_reply_replays_as_its_prose() {
        let reply = Message::from_web(&json!({
            "id": "a1", "role": "assistant", "content": "There are three files.", "reasoningContent": "list first",
            "toolEvents": [{ "id": "t1", "name": "list_files", "args": "{}", "ok": true, "summary": "Listed src" }]
        }));
        assert_eq!(history(&[reply], None), vec![(Role::Assistant, "There are three files.".to_string(), Vec::new())]);
    }
}

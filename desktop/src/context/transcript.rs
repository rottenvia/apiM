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

/// An earlier message of the user's longer than this goes out as its two ends.
const OLD_PASTE_CHARS: usize = 16_000;

/// A long paste in an earlier message (a log, a file), cut to its first and last 8,000 characters: the reply after
/// it has read it and says what it found, and whole it rode again on every round of every later reply. The
/// user's newest earlier message, and the one being answered, are never cut.
// ponytail: the cut text stays in the chat and cannot be asked back by a tool. Save long pastes into the
// workspace and name the file here if models turn out to need a middle again.
fn old_paste(text: &str) -> std::borrow::Cow<'_, str> {
    if text.len() <= OLD_PASTE_CHARS {
        return text.into();
    }
    let (mut head, mut tail) = (OLD_PASTE_CHARS / 2, text.len() - OLD_PASTE_CHARS / 2);
    while !text.is_char_boundary(head) {
        head -= 1;
    }
    while !text.is_char_boundary(tail) {
        tail += 1;
    }
    format!("{}\n\n[… {} characters of this earlier message are left out here: it was a long paste, and the reply that follows it has read it whole. Ask the user for it again if you need a part of it …]\n\n{}", &text[..head], tail - head, &text[tail..]).into()
}

/// A saved transcript taken up again (Resume): the long pastes in the turns before the request it answers are cut
/// as `wire_turns` cuts them. One saved before that cut existed carried them whole into every round after Resume.
pub fn cut_old_pastes(messages: &mut [Value]) {
    // The run starts at the first turn that calls a tool; the request is the user message before it, and the one before that is the newest earlier one.
    let run = messages.iter().position(|m| m["tool_calls"].as_array().is_some_and(|c| !c.is_empty())).unwrap_or(messages.len());
    let asked: Vec<usize> = (0..run).filter(|&i| messages[i]["role"] == "user").collect();
    for &i in &asked[..asked.len().saturating_sub(2)] {
        let cut = |text: &mut Value| {
            if let Some(short) = text.as_str().map(old_paste).filter(|s| matches!(s, std::borrow::Cow::Owned(_))) {
                *text = Value::String(short.into_owned());
            }
        };
        match &mut messages[i]["content"] {
            Value::Array(parts) => parts.iter_mut().for_each(|part| cut(&mut part["text"])),
            text => cut(text),
        }
    }
}

/// A saved transcript taken up again: tool results from before reads cut their long lines are cut the same way
/// (`tools::files::cut_long_lines`). One such result was a third of every request for as long as its chat ran.
pub fn cut_long_result_lines(messages: &mut [Value]) {
    for m in messages.iter_mut().filter(|m| m["role"] == "tool") {
        if let Some(cut) = m["content"].as_str().and_then(crate::tools::files::cut_long_lines) {
            m["content"] = Value::String(cut);
        }
    }
}

/// The conversation the model reads for this turn: the earlier turns, then the message being answered, built the way the
/// web's `buildUserContent` builds each user turn.
pub fn wire_turns(history: &[(Role, String, Vec<Attachment>)], text: &str, images: &[Attachment], vision: Vision) -> Vec<Value> {
    let mut out = Vec::new();
    let newest_asked = history.iter().rposition(|(role, ..)| *role == Role::User);
    for (i, ((role, past, attached), window)) in history.iter().zip(media_windows(history, vision == Vision::Native)).enumerate() {
        if *role == Role::User {
            let media: Vec<Media> = attached.iter().map(Media::from).collect();
            let past = if Some(i) == newest_asked { past.as_str().into() } else { old_paste(past) };
            let content = build_user_content(&past, &media, vision, window);
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

    #[test]
    fn a_resumed_transcript_loses_its_old_pastes_and_keeps_the_request() {
        let long = "p".repeat(OLD_PASTE_CHARS * 3);
        let mut messages = vec![
            json!({ "role": "system", "content": long }),
            json!({ "role": "user", "content": long }),
            json!({ "role": "assistant", "content": "read it" }),
            json!({ "role": "user", "content": [{ "type": "text", "text": long }] }),
            json!({ "role": "assistant", "content": "and that" }),
            json!({ "role": "user", "content": long }),
            json!({ "role": "user", "content": long }),
            json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "a", "type": "function", "function": { "name": "read_file", "arguments": "{}" } }] }),
            json!({ "role": "user", "content": long }),
        ];
        cut_old_pastes(&mut messages);
        let size = |m: &Value| m["content"].as_str().or(m["content"][0]["text"].as_str()).unwrap().len();
        // Two earlier pastes are cut; the newest earlier message, the request, what came during the run and the instructions are whole.
        assert!(size(&messages[1]) < OLD_PASTE_CHARS + 400 && size(&messages[3]) < OLD_PASTE_CHARS + 400);
        assert!([0, 5, 6, 8].iter().all(|&i| size(&messages[i]) == long.len()));
    }

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

    /// A log pasted two questions ago rides as its two ends; the newest earlier message and the question ride whole.
    #[test]
    fn an_old_long_paste_goes_out_as_its_ends() {
        let paste = format!("START {} я END", "ж".repeat(20_000));
        let turn = |role, text: &str| (role, text.to_string(), Vec::new());
        let history = [turn(Role::User, &paste), turn(Role::Assistant, "read it"), turn(Role::User, &paste), turn(Role::Assistant, "again")];
        let sent = wire_turns(&history, &paste, &[], Vision::None);
        let old = sent[0]["content"].as_str().unwrap();
        assert!(old.starts_with("START ж") && old.ends_with("ж я END") && old.contains("characters of this earlier message are left out"), "{}", &old[..60]);
        assert!(old.len() < OLD_PASTE_CHARS + 400);
        assert_eq!((sent[2]["content"].as_str(), sent[4]["content"].as_str()), (Some(paste.as_str()), Some(paste.as_str())));
        assert_eq!(old_paste("short"), "short");
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

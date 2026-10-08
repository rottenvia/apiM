//! A chat as a file to keep or share: src/lib/export.ts.

use crate::store::{Conversation, Message, Role};

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn date(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64).map_or(String::new(), |d| d.with_timezone(&chrono::Local).format("%-d/%-m/%Y, %H:%M:%S").to_string())
}

fn who(m: &Message) -> &'static str {
    if m.role == Role::User { "You" } else { "Assistant" }
}

/// `format` is one of md, json, txt, html.
pub fn render(conv: &Conversation, format: &str) -> String {
    let now = date(crate::store::now_ms());
    let count = conv.messages.len();
    match format {
        "json" => conv.to_json(),
        "txt" => {
            // The underline is as long as the title in the web's UTF-16 units, not in chars.
            let mut lines = vec![conv.title.clone(), "=".repeat(conv.title.encode_utf16().count()), format!("Exported {now}"), String::new()];
            for m in &conv.messages {
                lines.push(format!("[{}] {}", if m.role == Role::User { "USER" } else { "ASSISTANT" }, date(m.created_at)));
                lines.extend([m.text(), String::new()]);
            }
            lines.join("\n")
        }
        "md" => {
            let mut lines = vec![format!("# {}", conv.title), String::new(), format!("*Exported {now} · {count} messages*"), String::new()];
            for m in &conv.messages {
                lines.extend([format!("## {}", who(m)), String::new()]);
                let reasoning = m.reasoning();
                if !reasoning.is_empty() {
                    lines.extend(["<details><summary>Thinking</summary>", "", "```", &reasoning, "```", "", "</details>", ""].map(String::from));
                }
                lines.extend([m.text(), String::new()]);
                if !m.search_results.is_empty() {
                    lines.extend(["**Sources**".to_string(), String::new()]);
                    lines.extend(m.search_results.iter().enumerate().map(|(i, r)| format!("{}. [{}]({}) — {}", i + 1, r.title, r.url, r.domain)));
                    lines.push(String::new());
                }
                lines.extend(["---".to_string(), String::new()]);
            }
            lines.join("\n")
        }
        _ => {
            let body: Vec<String> = conv
                .messages
                .iter()
                .map(|m| {
                    let sources = if m.search_results.is_empty() {
                        String::new()
                    } else {
                        let items: String = m.search_results.iter().map(|r| format!("<li><a href=\"{}\">{}</a> <span>{}</span></li>", escape(&r.url), escape(&r.title), escape(&r.domain))).collect();
                        format!("<div class=\"sources\"><strong>Sources</strong><ol>{items}</ol></div>")
                    };
                    let reasoning = m.reasoning();
                    let thinking = if reasoning.is_empty() { String::new() } else { format!("<details class=\"thinking\"><summary>Thinking</summary><pre>{}</pre></details>", escape(&reasoning)) };
                    let role = if m.role == Role::User { "user" } else { "assistant" };
                    format!("<article class=\"msg {role}\"><header>{}<time>{}</time></header>{thinking}<div class=\"body\"><pre>{}</pre></div>{sources}</article>", who(m), escape(&date(m.created_at)), escape(&m.text()))
                })
                .collect();
            format!(
                r#"<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
:root{{--bg:#191715;--card:#141210;--line:#2c2924;--fg:#ede9e2;--dim:#a29d92;--muted:#6d685d;--accent:#c96442}}
*{{box-sizing:border-box}}
body{{margin:0;padding:2.5rem 1rem;background:var(--bg);color:var(--fg);
font:15px/1.7 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}}
main{{max-width:52rem;margin:0 auto}}
h1{{font-size:1.6rem;margin:0 0 .25rem}}
.meta{{color:var(--muted);font-size:.8rem;margin-bottom:2rem}}
.msg{{border:1px solid var(--line);border-radius:14px;padding:1rem 1.15rem;margin-bottom:1rem;background:var(--card)}}
.msg.user{{background:#201e1b}}
.msg header{{display:flex;justify-content:space-between;align-items:baseline;
font-weight:600;font-size:.8rem;letter-spacing:.04em;text-transform:uppercase;color:var(--accent);margin-bottom:.6rem}}
.msg.user header{{color:var(--dim)}}
.msg time{{font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted);font-size:.72rem}}
.body pre{{white-space:pre-wrap;word-wrap:break-word;margin:0;font:inherit}}
.thinking{{margin-bottom:.75rem;border:1px solid #cfa25a33;border-radius:10px;padding:.5rem .75rem}}
.thinking summary{{cursor:pointer;color:#cfa25a;font-size:.8rem;font-weight:600}}
.thinking pre{{white-space:pre-wrap;color:var(--dim);font-size:.85rem;margin:.5rem 0 0}}
.sources{{margin-top:.85rem;padding-top:.7rem;border-top:1px solid var(--line);font-size:.85rem}}
.sources strong{{color:#6ba3a0;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}}
.sources ol{{margin:.4rem 0 0;padding-left:1.2rem;color:var(--dim)}}
.sources a{{color:#d97f5d}}
.sources span{{color:var(--muted);font-size:.78rem}}
</style></head>
<body><main>
<h1>{title}</h1>
<p class="meta">{count} messages · exported {now}</p>
{body}
</main></body></html>"#,
                title = escape(&conv.title),
                now = escape(&now),
                body = body.join("\n")
            )
        }
    }
}

/// "My chat: notes!" becomes "my-chat-notes.md".
pub fn filename(title: &str, format: &str) -> String {
    // The web's `[^\w\s-]`: its word characters are ASCII, so an accented letter goes with the punctuation.
    let kept: String = title.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || c.is_whitespace()).collect();
    let safe: String = kept.split_whitespace().collect::<Vec<_>>().join("-").chars().take(60).collect::<String>().to_lowercase();
    format!("{}.{format}", if safe.is_empty() { "conversation" } else { &safe })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        let mut conv = Conversation::new();
        conv.title = "My chat: <notes>!".into();
        conv.messages.push(Message::new(Role::User, "hi <b>"));
        conv.messages.push(Message::new(Role::Assistant, "hello"));
        assert_eq!(filename(&conv.title, "md"), "my-chat-notes.md");
        assert_eq!(filename("!!!", "txt"), "conversation.txt");
        assert!(render(&conv, "md").starts_with("# My chat: <notes>!\n\n*Exported "));
        assert!(render(&conv, "md").contains("## You\n\nhi <b>\n\n---\n\n## Assistant\n\nhello"));
        assert!(render(&conv, "txt").contains("[USER] "));
        let html = render(&conv, "html");
        assert!(html.contains("<title>My chat: &lt;notes&gt;!</title>") && html.contains("<pre>hi &lt;b&gt;</pre>"));
        assert!(render(&conv, "json").contains("\"role\": \"user\""));
    }

    /// Dates and the export moment depend on the clock and the locale, so both sides mask them the same way.
    fn masked(text: &str) -> String {
        regex::Regex::new(r"\d{1,2}/\d{1,2}/\d{4}, \d{1,2}:\d{2}:\d{2}(?: [AP]M)?").unwrap().replace_all(text, "DATE").into_owned()
    }

    /// The web's exports and filenames for one chat (`export_fixtures.json`, dumped from src/lib/export.ts).
    #[test]
    fn exports_and_filenames_match_the_web_app() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("export_fixtures.json")).unwrap();
        let mut conv = Conversation::new();
        conv.title = fixture["conv"]["title"].as_str().unwrap().into();
        conv.messages = fixture["conv"]["messages"].as_array().unwrap().iter().map(Message::from_web).collect();
        for (format, expected) in fixture["exports"].as_object().unwrap() {
            assert_eq!(masked(&render(&conv, format)), masked(expected.as_str().unwrap()), "{format}");
        }
        for pair in fixture["filenames"].as_array().unwrap() {
            assert_eq!(filename(pair[0].as_str().unwrap(), "md"), pair[1].as_str().unwrap());
        }
    }
}

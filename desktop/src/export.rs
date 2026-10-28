//! A chat as a file to keep or share: src/lib/export.ts.
//!
//! Two of these formats are this app's own, for a model asked to read a past chat (the `read_chat` tool and the
//! Download menu): `read` is the chat as prose with each tool step inline, `trace` is the tool timeline with the
//! wall-clock time each call took. The web formats (md/json/txt/html) stay byte-for-byte the web's.

use crate::store::{Conversation, Message, Part, Role};

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn date(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64).map_or(String::new(), |d| d.with_timezone(&chrono::Local).format("%-d/%-m/%Y, %H:%M:%S").to_string())
}

fn clock(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64).map_or(String::new(), |d| d.with_timezone(&chrono::Local).format("%H:%M:%S").to_string())
}

fn who(m: &Message) -> &'static str {
    if m.role == Role::User { "You" } else { "Assistant" }
}

/// Above this, a tool's duration is called out as external wall-clock wait, not a stall or a fault. The driving case:
/// a tool returned ~15s late because the process it was reading had already closed; a reading model saw "15s", decided
/// the chat had stalled or broken, and refused to build on it. The Trace view names the wait so that question never comes up.
const SLOW_MS: u64 = 8_000;

/// A duration for a human and for a reading model: ms under a second, else one decimal of seconds. `—` when never recorded.
fn dur(ms: u64) -> String {
    if ms == 0 {
        "—".into()
    } else if ms < 1000 {
        format!("{ms}ms")
    } else {
        format!("{:.1}s", ms as f64 / 1000.0)
    }
}

fn first_line(text: &str, max: usize) -> String {
    let line = text.trim().lines().next().unwrap_or("").trim();
    match line.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", line[..at].trim_end()),
        None => line.to_string(),
    }
}

/// The chat as prose for reading, with each tool step shown inline where it ran (`md` drops tool steps entirely). This
/// is the "just read the chat" method: text, thinking and steps in the order they happened, nothing folded away.
fn read(conv: &Conversation) -> String {
    let mut out = vec![conv.title.clone(), String::new()];
    for m in &conv.messages {
        out.push(format!("════ {} · {} ════", who(m), date(m.created_at)));
        if m.role == Role::User {
            let t = m.text();
            out.push(if t.is_empty() { "(no text)".into() } else { t });
            out.push(String::new());
            continue;
        }
        for p in &m.parts {
            match p {
                Part::Text(t) if !t.trim().is_empty() => out.push(t.clone()),
                Part::Thinking { text, ms } if !text.trim().is_empty() => {
                    out.push(format!("[thinking · {}]", dur(*ms)));
                    out.push(text.clone());
                }
                Part::Tool(t) => {
                    let verdict = match t.ok {
                        Some(false) => " · FAILED",
                        None => " · (cut off)",
                        _ => "",
                    };
                    let summary = if t.summary.is_empty() { String::new() } else { format!(" — {}", first_line(&t.summary, 160)) };
                    out.push(format!("⚙ {} ({}{}){}", t.name, dur(t.duration_ms), verdict, summary));
                }
                Part::Notice(n) => out.push(format!("— {n}")),
                _ => {}
            }
        }
        if let Some(err) = &m.error {
            out.push(format!("[error: {err}]"));
        }
        out.push(String::new());
    }
    out.join("\n")
}

/// The tool timeline with the wall-clock time each call took. The header defuses the one misread this is built for: a
/// long duration is time waited on something outside the model, not a stall or an error. Only a FAIL row is a failure.
fn trace(conv: &Conversation) -> String {
    let tools = conv.messages.iter().flat_map(|m| &m.parts).filter(|p| matches!(p, Part::Tool(_))).count();
    let mut out = vec![
        format!("TRACE of \"{}\" — {} messages, {} tool calls.", conv.title, conv.messages.len(), tools),
        String::new(),
        "How to read this: each ⚙ row is one tool call and the wall-clock time it took. A LONG duration is time spent".into(),
        "WAITING on something outside the model — a command running, a process that had already closed, a slow network".into(),
        "read, a window being captured — NOT the model stalling, looping, or an error. Durations are elapsed real time,".into(),
        "not the model's effort. A call only went wrong if its row is marked FAIL. `think` rows are the model's own time.".into(),
        String::new(),
    ];
    // An older chat was saved before per-tool timing existed; its durations are all unknown. Say so once, so a `—` is not read as a bug.
    if !conv.messages.iter().flat_map(|m| &m.parts).any(|p| matches!(p, Part::Tool(t) if t.duration_ms > 0)) && tools > 0 {
        out.push("(This chat predates per-tool timing, so every duration shows as — . The order of calls is still exact.)".into());
        out.push(String::new());
    }
    for m in &conv.messages {
        if m.role == Role::User {
            let line = first_line(&m.text(), 100);
            out.push(format!("[you · {}] {}", clock(m.created_at), line));
            out.push(String::new());
            continue;
        }
        let base = m.parts.iter().filter_map(|p| if let Part::Tool(t) = p { (t.started_at > 0).then_some(t.started_at) } else { None }).min().unwrap_or(0);
        out.push(format!("[assistant · {}]", clock(m.created_at)));
        let (mut tool_ms, mut fails, mut slowest) = (0u64, 0u32, (0u64, ""));
        for p in &m.parts {
            match p {
                Part::Thinking { ms, .. } if *ms > 0 => out.push(format!("  think                {:>7}", dur(*ms))),
                Part::Tool(t) => {
                    tool_ms += t.duration_ms;
                    if t.ok == Some(false) {
                        fails += 1;
                    }
                    if t.duration_ms > slowest.0 {
                        slowest = (t.duration_ms, &t.name);
                    }
                    // Offset into the reply. Unlike a duration, 0 here is a real value (the first call), so it is not `dur`.
                    let at = if base > 0 && t.started_at >= base { format!("+{:.1}s", (t.started_at - base) as f64 / 1000.0) } else { "—".into() };
                    let verdict = match t.ok {
                        Some(true) => "ok  ",
                        Some(false) => "FAIL",
                        None => "cut ",
                    };
                    let note = if t.ok == Some(false) {
                        "   ⟵ this call FAILED — see the chat for why"
                    } else if t.duration_ms >= SLOW_MS {
                        "   ⟵ long wall-clock wait on something external (command / closed process / slow read), not a stall or error"
                    } else {
                        ""
                    };
                    out.push(format!("  {:<18} {:>6} at {:<7} {} {}{}", t.name, dur(t.duration_ms), at, verdict, first_line(&t.summary, 80), note));
                }
                Part::Notice(n) => out.push(format!("  — {n}")),
                _ => {}
            }
        }
        let n = m.parts.iter().filter(|p| matches!(p, Part::Tool(_))).count();
        if n > 0 {
            let f = if fails > 0 { format!(", {fails} failed") } else { String::new() };
            out.push(format!("  └ {n} calls, tool-time {}, slowest {} {}{}", dur(tool_ms), slowest.1, dur(slowest.0), f));
        }
        out.push(String::new());
    }
    out.join("\n")
}

/// `format` is one of md, json, txt, html, and this app's own `read` and `trace`.
pub fn render(conv: &Conversation, format: &str) -> String {
    let now = date(crate::store::now_ms());
    let count = conv.messages.len();
    match format {
        "read" => return read(conv),
        "trace" => return trace(conv),
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
                        let items: String = m.search_results.iter().map(|r| {
                            // Only web addresses become links; anything else is plain text.
                            let title = if crate::search::followable(&r.url, false) { format!("<a href=\"{}\" rel=\"noopener noreferrer\">{}</a>", escape(&r.url), escape(&r.title)) } else { escape(&r.title) };
                            format!("<li>{title} <span>{}</span></li>", escape(&r.domain))
                        }).collect();
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
    let base = if safe.is_empty() { "conversation" } else { &safe };
    // `read`/`trace` are this app's own methods, not file types: both are plain text, named so downloading both does not collide.
    match format {
        "read" | "trace" => format!("{base}-{format}.txt"),
        _ => format!("{base}.{format}"),
    }
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

    #[test]
    fn dur_formats() {
        assert_eq!(dur(0), "—");
        assert_eq!(dur(850), "850ms");
        assert_eq!(dur(2340), "2.3s");
        assert_eq!(dur(15_100), "15.1s");
    }

    /// Trace names a long wait as external so a reading model does not read it as a failure; a fast ok call gets no note,
    /// and a real failure is marked FAIL. Read shows every tool step inline, which the `md` export drops.
    #[test]
    fn read_and_trace_show_steps_and_timing() {
        use crate::store::{Part, ToolEvent};
        let mut conv = Conversation::new();
        conv.title = "run".into();
        conv.messages.push(Message::new(Role::User, "launch the client"));
        let mut a = Message::new(Role::Assistant, "Built it and launched the client.");
        a.parts = vec![
            Part::Thinking { text: "plan the build".into(), ms: 3200 },
            Part::Tool(ToolEvent { name: "run_command".into(), summary: "built the loader".into(), ok: Some(true), started_at: 1000, duration_ms: 2340, ..Default::default() }),
            Part::Text("Build done, now starting the client.".into()),
            Part::Tool(ToolEvent { name: "read_process".into(), summary: "waited for client output".into(), ok: Some(true), started_at: 3340, duration_ms: 15_100, ..Default::default() }),
            Part::Notice("Continued after a stop".into()),
            Part::Tool(ToolEvent { name: "verify_file".into(), summary: "missing".into(), ok: Some(false), started_at: 18_440, duration_ms: 120, ..Default::default() }),
        ];
        conv.messages.push(a);

        let trace = render(&conv, "trace");
        assert!(trace.contains("WAITING on something outside the model"), "{trace}"); // the defusing header
        assert!(trace.contains("read_process") && trace.contains("15.1s") && trace.contains("long wall-clock wait"), "{trace}");
        assert!(trace.contains("run_command") && trace.contains("2.3s"));
        assert!(!trace.lines().find(|l| l.contains("run_command")).unwrap().contains("long wall-clock wait")); // fast call: no wait note
        assert!(trace.contains("FAIL") && trace.contains("this call FAILED"));
        assert!(trace.contains("+0.0s") && trace.contains("3 calls"));

        // A chat with no recorded durations says so once, instead of showing a bare `—` that reads as a bug.
        let mut old = Conversation::new();
        let mut m = Message::new(Role::Assistant, "ok");
        m.parts = vec![Part::Tool(ToolEvent { name: "read_file".into(), ok: Some(true), ..Default::default() })];
        old.messages.push(m);
        assert!(render(&old, "trace").contains("predates per-tool timing"));
        assert!(!trace.contains("predates per-tool timing")); // the timed chat does not carry the note

        let read = render(&conv, "read");
        assert!(read.contains("⚙ run_command (2.3s) — built the loader"), "{read}");
        assert!(read.contains("⚙ verify_file (120ms · FAILED) — missing"));
        // `md` drops tool steps; `read` keeps them — that is the difference.
        assert!(!render(&conv, "md").contains("run_command"));
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

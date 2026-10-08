//! Recall tools: list_snapshots, restore_snapshot and search_conversation. Thin cases around crate::snapshots and
//! crate::find, worded as the web words them (their cases in src/lib/tools.ts).

use crate::find::{RECALL_DEFAULT_LIMIT, Turn, search_turns};
use crate::tools::{Output, str_arg};
use serde_json::Value;
use std::path::Path;

/// A stored ISO time the way the web shows one (`toLocaleString()`): local time, 10/8/2026, 3:04:05 PM.
fn local_time(iso: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(iso).map_or("Invalid Date".into(), |t| t.with_timezone(&chrono::Local).format("%-m/%-d/%Y, %-I:%M:%S %p").to_string())
}

/// The restore points taken before each of the user's messages, newest first.
pub fn list_snapshots(root: &Path, _args: &Value) -> Output {
    let snapshots = crate::snapshots::list(root);
    if snapshots.is_empty() {
        return Output::ok("There are no restore points for this workspace yet.", "No snapshots");
    }
    let listing: Vec<String> = snapshots.iter().map(|s| format!("{} — {} ({} files, {})", s.id, s.label, s.file_count, local_time(&s.created_at))).collect();
    Output::ok(format!("{} restore point(s), newest first:\n{}", snapshots.len(), listing.join("\n")), format!("Listed {} snapshot(s)", snapshots.len()))
}

/// Puts the whole workspace back to a restore point. The state before the restore is saved first.
pub fn restore_snapshot(root: &Path, args: &Value) -> Output {
    let id = str_arg(args, "id");
    match crate::snapshots::restore(root, id, None) {
        // Any file may have changed: the web marks that with an empty changed path.
        Ok(done) => Output::ok(
            format!("Restored the workspace to {id}: {} file(s) put back, {} created since then removed. A snapshot of the state before this restore was taken first, so it is itself reversible.", done.restored, done.removed),
            format!("Restored {} file(s)", done.restored),
        )
        .changed(""),
        Err(e) => Output { ok: false, text: format!("Error: {e}"), summary: e, ..Default::default() },
    }
}

/// Searches the full stored text of THIS chat for exact earlier wording. `turns` are the chat's stored turns,
/// oldest first, and `roles` names who wrote each ("user", "assistant"): `Turn` carries no role, and the web's
/// result says whose turn matched. A turn without a role is listed without one.
pub fn search_conversation(_root: &Path, args: &Value, turns: &[Turn], roles: &[&str]) -> Output {
    let query = args["query"].as_str().unwrap_or("").trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if query.is_empty() {
        return Output { ok: false, text: "Error: a search query is required.".into(), summary: "Empty search query".into(), ..Default::default() };
    }
    let limit = args["limit"].as_f64().map_or(RECALL_DEFAULT_LIMIT, |n| n.floor().clamp(1.0, 10.0) as usize);
    let found = search_turns(turns, query, args["whole_word"].as_bool().unwrap_or(true), limit);
    if found.total_matches == 0 {
        return Output::ok(
            format!("No matches for \"{}\" in this conversation ({} turns searched). Try fewer words, a distinctive fragment, or whole_word false.", found.query, found.turns_searched),
            format!("Conversation search: no matches for \"{}\"", found.query),
        );
    }
    let hits: Vec<String> = found
        .hits
        .iter()
        .map(|h| {
            let role = roles.get(h.turn - 1).map_or(String::new(), |role| format!("{role}, "));
            format!("Turn {} of {} ({role}{} match{}):\n{}", h.turn, found.turns_searched, h.matches, if h.matches == 1 { "" } else { "es" }, h.excerpt)
        })
        .collect();
    let (total, shown) = (found.total_matches, found.hits.len());
    Output::ok(
        format!(
            "\"{}\" matches {total} time{} in this conversation (this chat only):\n\n{}{}",
            found.query,
            if total == 1 { "" } else { "s" },
            hits.join("\n\n"),
            if found.truncated { "\n\n…more turns matched than shown; narrow the query." } else { "" }
        ),
        format!("Conversation search: {total} match{} in {shown} turn{}", if total == 1 { "" } else { "es" }, if shown == 1 { "" } else { "s" }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshots_are_listed_and_restored() {
        let ws = std::env::temp_dir().join(format!("apim-recall-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&ws);
        std::fs::create_dir_all(&ws).unwrap();
        assert_eq!(list_snapshots(&ws, &json!({})).text, "There are no restore points for this workspace yet.");

        std::fs::write(ws.join("a.txt"), "one").unwrap();
        let snap = crate::snapshots::create(&ws, "before the change", &[]).unwrap().unwrap();
        std::fs::write(ws.join("a.txt"), "two").unwrap();
        std::fs::write(ws.join("b.txt"), "new").unwrap();
        let listed = list_snapshots(&ws, &json!({}));
        assert!(listed.text.starts_with(&format!("1 restore point(s), newest first:\n{} — before the change (1 files, ", snap.id)) && listed.text.ends_with("M)"), "{}", listed.text);
        assert_eq!(local_time("2026-01-02T03:04:05.000Z").matches(':').count(), 2);

        let out = restore_snapshot(&ws, &json!({ "id": snap.id }));
        assert!(out.ok && out.text.starts_with(&format!("Restored the workspace to {}: 1 file(s) put back, 1 created since then removed.", snap.id)), "{}", out.text);
        assert_eq!((out.summary.as_str(), out.changed.as_deref()), ("Restored 1 file(s)", Some("")));
        assert!(std::fs::read_to_string(ws.join("a.txt")).unwrap() == "one" && !ws.join("b.txt").exists());
        assert_eq!(restore_snapshot(&ws, &json!({ "id": "../x" })).text, "Error: Invalid snapshot id");
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn search_conversation_words_the_hits() {
        let turns = [Turn { content: "how do I start this?", attachments: Vec::new() }, Turn { content: "run docker-compose up, then docker-compose logs", attachments: Vec::new() }, Turn { content: "see attached", attachments: vec![("err.png", "red out-of-memory trace")] }];
        let roles = ["user", "assistant", "user"];
        let out = search_conversation(Path::new("."), &json!({ "query": " docker-compose " }), &turns, &roles);
        assert_eq!(out.text, "\"docker-compose\" matches 2 times in this conversation (this chat only):\n\nTurn 2 of 3 (assistant, 2 matches):\nrun docker-compose up, then docker-compose logs");
        assert_eq!(out.summary, "Conversation search: 2 matches in 1 turn");
        let out = search_conversation(Path::new("."), &json!({ "query": "memory" }), &turns, &[]);
        assert_eq!(out.text, "\"memory\" matches 1 time in this conversation (this chat only):\n\nTurn 3 of 3 (1 match):\nShared: err.png: red out-of-memory trace");
        let none = search_conversation(Path::new("."), &json!({ "query": "calc" }), &turns, &roles);
        assert!(none.ok && none.text.starts_with("No matches for \"calc\" in this conversation (3 turns searched)."));
        assert!(!search_conversation(Path::new("."), &json!({ "query": "  " }), &turns, &roles).ok);
        let all = search_conversation(Path::new("."), &json!({ "query": "o", "whole_word": false, "limit": 1 }), &turns, &roles);
        assert!(all.text.ends_with("…more turns matched than shown; narrow the query.") && all.summary.ends_with("in 1 turn"), "{}", all.text);
    }
}

//! Finding text in chats. Three searches, each with the web's own rules:
//! - the find bar inside one chat: src/lib/chat-search.ts;
//! - the Search modal across every chat: `searchConversations` in src/lib/store.ts, with the
//!   highlighting of src/components/SearchModal.tsx;
//! - the agent's `search_conversation` recall tool: src/lib/conversation-search.ts.

use regex::Regex;
use std::ops::Range;
use std::sync::LazyLock;

/// What JS's `trim` and `\s` call whitespace: Rust's set without NEL, with the BOM.
fn space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// Length in UTF-16 units, the web's `.length`: its excerpt windows are measured in these.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Byte offset of UTF-16 position `unit`, moved back to the start of its character and capped at the end.
fn js_index(s: &str, unit: usize) -> usize {
    let mut seen = 0;
    s.char_indices()
        .find(|(_, c)| {
            seen += c.len_utf16();
            seen > unit
        })
        .map_or(s.len(), |(i, _)| i)
}

// ------------------------------------------------------------ find in chat

/// A letter, a digit or "_": what a whole-word match may not touch. Case-folded because the
/// web's pattern carries its `i` flag over this class too.
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)[\p{L}\p{N}_]").expect("word class"));

/// The web stops counting matches in one text here.
const MAX_MATCHES: usize = 100_000;

/// A find-bar query, compiled once and run over every message.
///
/// Whole word (the bar's default): the query must line up with a complete word, so "calc" does not
/// match "calculator". That keeps results tight, which is what makes a find-in-page useful rather
/// than noisy. Partial: plain substring, for when you only remember part of a word. Both ignore case.
pub struct Matcher {
    re: Regex,
    whole_word: bool,
}

impl Matcher {
    /// None for a blank query.
    pub fn new(query: &str, whole_word: bool) -> Option<Matcher> {
        let query = query.trim_matches(space);
        if query.is_empty() {
            return None;
        }
        // `(?i)` folds case one character at a time, as the web's /iu flags do.
        // ponytail: a query too big to compile (megabytes) finds nothing; the web would fall back to a plain scan.
        Regex::new(&format!("(?i){}", regex::escape(query))).ok().map(|re| Matcher { re, whole_word })
    }

    /// Byte ranges of every match in `text`: in order, never overlapping, always on character boundaries.
    pub fn ranges(&self, text: &str) -> Vec<Range<usize>> {
        let touches = |c: Option<char>| c.is_some_and(|c| WORD.is_match(c.encode_utf8(&mut [0; 4])));
        let (mut out, mut from) = (Vec::new(), 0);
        while out.len() < MAX_MATCHES {
            let Some(m) = self.re.find_at(text, from) else { break };
            // Checked by hand against the neighbours, not with `\b`: that fails when the query
            // starts or ends with punctuation (searching "c++" would never match).
            if self.whole_word && (touches(text[..m.start()].chars().next_back()) || touches(text[m.end()..].chars().next())) {
                // A rejected candidate may overlap a real match, so look again one character on.
                from = m.start() + text[m.start()..].chars().next().map_or(1, char::len_utf8);
            } else {
                from = m.end();
                out.push(m.range());
            }
        }
        out
    }
}

/// The one-off form of `Matcher`: where `query` occurs in `text`.
pub fn find_matches(text: &str, query: &str, whole_word: bool) -> Vec<Range<usize>> {
    Matcher::new(query, whole_word).map_or(Vec::new(), |m| m.ranges(text))
}

/// Which message holds match number `active` of the whole chat, and which of that message's
/// matches it is, so next/previous can address one occurrence. `counts` is each message's
/// `ranges(text).len()`, over the reply text only: thinking is collapsed by default, so counting
/// it would produce matches the user cannot see.
///
/// The bar's stepping: next is `(active + 1) % total`, previous `(active + total - 1) % total`,
/// and `active` is clamped to `total - 1` when an edit of the query leaves fewer matches.
pub fn locate(counts: &[usize], active: usize) -> Option<(usize, usize)> {
    let mut before = 0;
    let message = counts.iter().position(|n| {
        before += n;
        active < before
    })?;
    Some((message, active + counts[message] - before))
}

// ------------------------------------------------------------ search all chats

/// Chats the modal lists at most.
const CHAT_HITS: usize = 30;
/// Excerpts shown under one chat.
const SNIPPETS: usize = 3;

/// As much of a stored chat as the search reads.
pub struct Chat<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub updated_at_ms: u64,
    pub archived: bool,
    /// `(is_user, text)` of each message, oldest first.
    pub messages: &'a [(bool, &'a str)],
}

#[derive(Clone, Debug, PartialEq)]
pub struct Snippet {
    /// Labelled "you" when true, "ai" otherwise.
    pub is_user: bool,
    pub text: String,
    /// Where the query sits in `text`, for highlighting.
    pub marks: Vec<Range<usize>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChatHit {
    pub id: String,
    pub title: String,
    /// Shown as "archived · " before the time.
    pub archived: bool,
    pub updated_at_ms: u64,
    /// Messages containing the query (messages, not occurrences). When there are more than
    /// `snippets`, the modal adds "+N more matches" for the rest.
    pub match_count: usize,
    /// Where the query sits in the title, for highlighting. Not empty means the title itself matched.
    pub title_marks: Vec<Range<usize>>,
    /// Excerpts around the first few matching messages.
    pub snippets: Vec<Snippet>,
}

/// Byte offset in `text` of the character whose lower-case form holds byte `at` of `text.to_lowercase()`.
/// Lower-casing can change a character's length ("İ" becomes two), so a position found in the
/// lower-cased copy is not a position in the text. The web uses it as one, and its highlight and
/// excerpt land one character late after every "İ"; here they stay on the match.
fn unlowered(text: &str, at: usize) -> usize {
    let mut seen = 0;
    text.char_indices()
        .find(|(_, c)| {
            seen += c.to_lowercase().map(char::len_utf8).sum::<usize>();
            seen > at
        })
        .map_or(text.len(), |(i, _)| i)
}

/// Every occurrence of `needle` (lower case) in `text`, ignoring case, as byte ranges of `text`.
fn marks(text: &str, needle: &str) -> Vec<Range<usize>> {
    let lower = text.to_lowercase();
    lower.match_indices(needle).map(|(at, found)| unlowered(text, at)..unlowered(text, at + found.len())).collect()
}

/// 45 characters before the match at `at` and 75 after it, on one line, with "…" where the message was cut.
fn snippet(content: &str, at: usize, needle_len: usize) -> String {
    let (start, end) = (js_index(content, at.saturating_sub(45)), js_index(content, at + needle_len + 75));
    let words: Vec<&str> = content[start..end].split(space).filter(|w| !w.is_empty()).collect();
    format!("{}{}{}", if start > 0 { "…" } else { "" }, words.join(" "), if end < content.len() { "…" } else { "" })
}

/// Full-text search across stored chats, for the Search modal. A linear scan on purpose: a personal
/// chat history stays small enough that an index would add complexity without a measurable gain.
///
/// Ignores case and matches anywhere in a word (no whole-word mode here). Under two characters
/// nothing is searched and the modal says "Type at least 2 characters to search titles and messages";
/// with no hits it says `No matches for “query”`. Best first: a matching title, then more matching
/// messages, then most recently updated. 30 chats at most.
pub fn search_chats(chats: &[Chat], query: &str) -> Vec<ChatHit> {
    let query = query.trim_matches(space);
    if js_len(query) < 2 {
        return Vec::new();
    }
    let needle = query.to_lowercase();
    let mut hits = Vec::new();
    for chat in chats {
        let title_marks = marks(chat.title, &needle);
        let (mut match_count, mut snippets) = (0, Vec::new());
        for &(is_user, text) in chat.messages {
            let lower = text.to_lowercase();
            let Some(at) = lower.find(&needle) else { continue };
            match_count += 1;
            if snippets.len() < SNIPPETS {
                let text = snippet(text, js_len(&text[..unlowered(text, at)]), js_len(&needle));
                snippets.push(Snippet { is_user, marks: marks(&text, &needle), text });
            }
        }
        if !title_marks.is_empty() || match_count > 0 {
            hits.push(ChatHit { id: chat.id.to_string(), title: chat.title.to_string(), archived: chat.archived, updated_at_ms: chat.updated_at_ms, match_count, title_marks, snippets });
        }
    }
    hits.sort_by(|a, b| a.title_marks.is_empty().cmp(&b.title_marks.is_empty()).then(b.match_count.cmp(&a.match_count)).then(b.updated_at_ms.cmp(&a.updated_at_ms)));
    hits.truncate(CHAT_HITS);
    hits
}

// ------------------------------------------------------------ recall within one chat

/// Hits the recall tool returns unless the model asks for fewer or more (1 to 10).
pub const RECALL_DEFAULT_LIMIT: usize = 5;

/// One stored turn of the chat being searched.
pub struct Turn<'a> {
    pub content: &'a str,
    /// `(name, helper description or "")` of each attachment.
    pub attachments: Vec<(&'a str, &'a str)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TurnHit {
    /// 1-based position of the turn in the chat.
    pub turn: usize,
    /// The first match with 140 characters either side, "…" marking a trimmed edge.
    pub excerpt: String,
    pub matches: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Recall {
    /// The query as searched: trimmed.
    pub query: String,
    pub turns_searched: usize,
    pub total_matches: usize,
    pub hits: Vec<TurnHit>,
    /// More turns matched than `hits` holds.
    pub truncated: bool,
}

/// Searches one chat's turns, oldest first: the model's way to pull exact earlier wording back
/// after a summary dropped it. Whole word is the tool's default. Strictly one chat: the caller
/// passes the current one, so a search cannot leak another chat's transcript.
///
/// The text is searched first; a turn whose text does not match falls back to its attachment
/// names and descriptions, so "the screenshot of the red error" still resolves after the pixels
/// left context.
pub fn search_turns(turns: &[Turn], query: &str, whole_word: bool, limit: usize) -> Recall {
    let query = query.trim_matches(space);
    let mut out = Recall { query: query.to_string(), turns_searched: turns.len(), total_matches: 0, hits: Vec::new(), truncated: false };
    let Some(matcher) = Matcher::new(query, whole_word) else { return out };
    for (i, turn) in turns.iter().enumerate() {
        let shared;
        let (mut text, mut lead, mut found) = (turn.content, "", matcher.ranges(turn.content));
        if found.is_empty() {
            let named: Vec<String> = turn.attachments.iter().map(|(name, about)| if about.is_empty() { name.to_string() } else { format!("{name}: {about}") }).collect();
            shared = named.join("\n");
            (text, lead, found) = (shared.as_str(), "Shared: ", matcher.ranges(&shared));
        }
        let Some(first) = found.first() else { continue };
        out.total_matches += found.len();
        // A search is a pointer, not a replay: past the limit only the count grows.
        if out.hits.len() < limit.clamp(1, 10) {
            let at = js_len(&text[..first.start]);
            let (from, to) = (js_index(text, at.saturating_sub(140)), js_index(text, at + js_len(&text[first.clone()]) + 140));
            let excerpt = format!("{lead}{}{}{}", if from > 0 { "…" } else { "" }, &text[from..to], if to < text.len() { "…" } else { "" });
            out.hits.push(TurnHit { turn: i + 1, excerpt, matches: found.len() });
        } else {
            out.truncated = true;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found<'a>(text: &'a str, query: &str, whole_word: bool) -> Vec<&'a str> {
        find_matches(text, query, whole_word).into_iter().map(|r| &text[r]).collect()
    }

    fn turn(content: &str) -> Turn<'_> {
        Turn { content, attachments: Vec::new() }
    }

    #[test]
    fn whole_word_lines_up_with_words() {
        assert_eq!(found("open the calculator, then calc it", "calc", true), ["calc"]);
        assert_eq!(found("open the Calculator, then CALC it", " calc ", false), ["Calc", "CALC"]);
        // Punctuation at the edge of the query is why `\b` is not used.
        assert_eq!(found("c++ and c++11, also (C++)", "c++", true), ["c++", "C++"]);
        assert_eq!(found("c++ and c++11, also (C++)", "c++", false).len(), 3);
        let starts = |text, query| find_matches(text, query, true).iter().map(|r| (r.start, r.end)).collect::<Vec<_>>();
        assert_eq!(starts("snake_case 2case case, CASE", "case"), [(17, 21), (23, 27)]);
        // A rejected candidate must not hide the real match that overlaps it.
        assert_eq!(starts("ba.a.a", "a.a"), [(3, 6)]);
        assert!(found("anything", "   ", true).is_empty());
    }

    #[test]
    fn unicode_words_and_case() {
        let text = "Привет, мир! приветик. NAÏVE naïveté 東京 😀ok";
        assert_eq!(found(text, "привет", true), ["Привет"]);
        assert_eq!(found(text, "ПРИВЕТ", false), ["Привет", "привет"]);
        assert_eq!(found(text, "naïve", true), ["NAÏVE"]);
        assert!(found(text, "東", true).is_empty());
        assert_eq!(found(text, "東京", true), ["東京"]);
        // An emoji is not a word character, and ranges never split one.
        assert_eq!(found(text, "OK", true), ["ok"]);
        assert_eq!(found(text, "😀", false), ["😀"]);
    }

    #[test]
    fn locate_maps_the_running_number_to_a_message() {
        let counts = [2, 0, 3];
        assert_eq!((0..6).map(|n| locate(&counts, n)).collect::<Vec<_>>(), [Some((0, 0)), Some((0, 1)), Some((2, 0)), Some((2, 1)), Some((2, 2)), None]);
    }

    #[test]
    fn chat_search_ranks_and_excerpts() {
        let long = format!("{} Deploy   with\n docker-compose up {}", "p".repeat(100), "q".repeat(100));
        let a = [(true, "how do I deploy?"), (false, long.as_str())];
        let b = [(true, "deploy"), (false, "deploy"), (true, "DEPLOY"), (false, "redeployed")];
        let c = [(true, "nothing here")];
        let chats = [
            Chat { id: "a", title: "Old chat", updated_at_ms: 1, archived: false, messages: &a },
            Chat { id: "b", title: "Busy chat", updated_at_ms: 2, archived: true, messages: &b },
            Chat { id: "c", title: "My Deploy notes", updated_at_ms: 0, archived: false, messages: &c },
            Chat { id: "d", title: "New chat", updated_at_ms: 9, archived: false, messages: &a },
            Chat { id: "e", title: "Unrelated", updated_at_ms: 9, archived: false, messages: &c },
        ];
        let hits = search_chats(&chats, " Deploy ");
        // A matching title first, then more matching messages, then newest.
        assert_eq!(hits.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), ["c", "b", "d", "a"]);
        assert_eq!((&hits[0].title[hits[0].title_marks[0].clone()], hits[0].match_count, hits[0].snippets.len()), ("Deploy", 0, 0));
        assert_eq!((hits[1].match_count, hits[1].snippets.len(), hits[1].archived, hits[1].title_marks.len()), (4, 3, true, 0));
        let s = &hits[2].snippets;
        assert_eq!((s[0].is_user, s[0].text.as_str(), &s[0].text[s[0].marks[0].clone()]), (true, "how do I deploy?", "deploy"));
        assert_eq!(s[1].text, format!("…{} Deploy with docker-compose up {}…", "p".repeat(44), "q".repeat(48)));
        assert_eq!((s[1].is_user, &s[1].text[s[1].marks[0].clone()]), (false, "Deploy"));

        // Lower-casing "İ" lengthens it; the highlight must still land on the match.
        let turkish = [Chat { id: "t", title: "İstanbul'da DEPLOY", updated_at_ms: 0, archived: false, messages: &[(true, "İyi: İstanbul deploy")] }];
        let hit = &search_chats(&turkish, "deploy")[0];
        assert_eq!((&hit.title[hit.title_marks[0].clone()], &hit.snippets[0].text[hit.snippets[0].marks[0].clone()]), ("DEPLOY", "deploy"));

        assert!(search_chats(&chats, " d ").is_empty());
        let titles: Vec<String> = (0..40).map(|i| format!("deploy {i}")).collect();
        let many: Vec<Chat> = titles.iter().map(|t| Chat { id: t, title: t, updated_at_ms: 0, archived: false, messages: &[] }).collect();
        assert_eq!(search_chats(&many, "DEPLOY").len(), 30);
    }

    #[test]
    fn recall_searches_one_chat() {
        let turns = [turn("open the calculator app"), turn("the token"), Turn { content: "see attached", attachments: vec![("err.png", "red out-of-memory trace"), ("b.txt", "")] }];
        assert_eq!(search_turns(&turns, "calc", true, RECALL_DEFAULT_LIMIT).total_matches, 0);
        assert_eq!(search_turns(&turns, "calc", false, RECALL_DEFAULT_LIMIT).hits[0].turn, 1);
        let out = search_turns(&turns, " Token ", true, RECALL_DEFAULT_LIMIT);
        assert_eq!(out, Recall { query: "Token".into(), turns_searched: 3, total_matches: 1, hits: vec![TurnHit { turn: 2, excerpt: "the token".into(), matches: 1 }], truncated: false });
        assert_eq!(search_turns(&turns, "out-of-memory", true, RECALL_DEFAULT_LIMIT).hits[0].excerpt, "Shared: err.png: red out-of-memory trace\nb.txt");
        assert_eq!(search_turns(&turns, "  ", true, RECALL_DEFAULT_LIMIT).turns_searched, 3);

        let long = format!("{} NEEDLE needle {}", "p".repeat(500), "q".repeat(500));
        let turns: Vec<Turn> = (0..12).map(|_| turn(&long)).collect();
        let out = search_turns(&turns, "needle", true, 99);
        assert_eq!((out.hits.len(), out.truncated, out.total_matches, out.hits[0].matches), (10, true, 24, 2));
        assert_eq!(out.hits[0].excerpt, format!("…{} NEEDLE needle {}…", "p".repeat(139), "q".repeat(132)));
        assert_eq!(search_turns(&turns, "needle", true, 0).hits.len(), 1);
    }
}

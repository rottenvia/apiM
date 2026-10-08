//! Port of `src/lib/continuation-dedup.ts`: a reply cut mid-sentence is asked to
//! "carry straight on from the last character", and models often restart the
//! sentence instead. The start of the continuation is held back until it either
//! diverges from the text already shown (any repeated prefix is dropped) or
//! proves to be new.

use super::tail;

/// A repeat shorter than this is coincidence, not an echo.
const MIN_OVERLAP: usize = 24;
/// The new stream is released once this many characters have buffered.
const BUFFER_CAP: usize = 240;
/// Decide early once this many new characters follow the echoed part.
const NEW_TEXT_TO_RELEASE: usize = 24;

/// How many leading characters of `new_text` were already shown: the longest prefix that occurs within the last 80 characters of `shown`.
fn echoed_prefix(shown: &str, new_text: &str) -> usize {
    let ends: Vec<usize> = new_text.char_indices().map(|(i, c)| i + c.len_utf8()).collect();
    for len in (MIN_OVERLAP..=ends.len().min(shown.chars().count())).rev() {
        let head = &new_text[..ends[len - 1]];
        // The restart happens at the last sentence: an older match is prose repeating itself.
        if shown.rfind(head).is_some_and(|at| shown[at + head.len()..].chars().count() <= 80) {
            return len;
        }
    }
    0
}

pub struct ContinuationDedup {
    shown: String,
    buffer: String,
    decided: bool,
}

impl ContinuationDedup {
    /// `existing`: everything the reply has shown so far.
    pub fn new(existing: &str) -> ContinuationDedup {
        ContinuationDedup { shown: tail(existing, 2048).to_string(), buffer: String::new(), decided: false }
    }

    /// Adds a raw delta; returns what is safe to show ("" while it is still being held back).
    pub fn push(&mut self, delta: &str) -> String {
        if self.decided {
            return delta.to_string();
        }
        self.buffer.push_str(delta);
        let held = self.buffer.chars().count();
        if held >= MIN_OVERLAP {
            let overlap = echoed_prefix(&self.shown, &self.buffer);
            // Not an echo: release at once. Inside one: wait until enough new text follows it to see where it ends.
            if overlap < MIN_OVERLAP || held - overlap >= NEW_TEXT_TO_RELEASE || held >= BUFFER_CAP {
                return self.finish();
            }
        }
        String::new()
    }

    /// Stops holding back: what is buffered, minus the echoed prefix. Call it when the stream ends.
    pub fn finish(&mut self) -> String {
        let overlap = echoed_prefix(&self.shown, &self.buffer);
        self.decided = true;
        std::mem::take(&mut self.buffer).chars().skip(overlap).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::cases;

    #[test]
    fn matches_the_web() {
        for (i, o) in cases("dedup") {
            let mut dedup = ContinuationDedup::new(i[0].as_str().unwrap());
            let out: Vec<String> = i[1].as_array().unwrap().iter().map(|delta| dedup.push(delta.as_str().unwrap())).collect();
            assert_eq!(serde_json::json!(out), o, "{}", i[1]);
        }
    }

    #[test]
    fn a_short_ending_comes_out_at_the_end() {
        let mut dedup = ContinuationDedup::new("First we open the file. Then we read every line of the configuration file");
        assert_eq!(dedup.push("Then we read every line of the configuration file"), "");
        assert_eq!(dedup.push(" and parse it."), "");
        assert_eq!(dedup.finish(), " and parse it.");
        assert_eq!(dedup.push(" More."), " More.");
    }
}

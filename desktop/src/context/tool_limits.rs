//! Per-model tool ceilings: port of src/lib/tool-limits.ts.
//! The defaults keep a runaway call from dumping a whole project into one round. A model can opt into the open
//! ceilings (the `open_limits` flag on a custom model in Settings); no catalog model does. The safety rails
//! (path sandbox, private LAN, command approval) are the same either way.

use serde::Serialize;

pub const DEFAULT_READ_FILES: u64 = 60;
pub const DEFAULT_WRITE_FILES: u64 = 30;
pub const DEFAULT_BATCH_EDITS: u64 = 40;
pub const DEFAULT_READ_CHARS: u64 = 400_000;
pub const DEFAULT_SEARCH_HITS: u64 = 60;
pub const DEFAULT_SEARCHABLE_BYTES: u64 = 512 * 1024;
pub const DEFAULT_FETCH_CHARS: u64 = 200_000;
pub const DEFAULT_FETCH_BYTES: u64 = 5 * 1024 * 1024;
pub const DEFAULT_DOC_CHARS: u64 = 800_000;
pub const DEFAULT_SEARCH_RESULTS: u64 = 8;
pub const DEFAULT_SEARCH_SNIPPET: u64 = 700;
pub const DEFAULT_FETCH_FIND_MATCHES: u64 = 20;
/// Lines of context one search hit may carry: deep enough that a whole function body comes back with the match.
pub const DEFAULT_SEARCH_CONTEXT: u64 = 40;
/// How many agent rounds one reply may take: a guard against a model that never stops calling tools, not a work budget.
pub const DEFAULT_AGENT_ROUNDS: u64 = 64;

pub const OPEN_READ_FILES: u64 = 10_000;
pub const OPEN_WRITE_FILES: u64 = 10_000;
pub const OPEN_BATCH_EDITS: u64 = 10_000;
pub const OPEN_READ_CHARS: u64 = 8_000_000;
pub const OPEN_SEARCH_HITS: u64 = 10_000;
pub const OPEN_SEARCHABLE_BYTES: u64 = 32 * 1024 * 1024;
pub const OPEN_FETCH_CHARS: u64 = 4_000_000;
pub const OPEN_FETCH_BYTES: u64 = 32 * 1024 * 1024;
pub const OPEN_DOC_CHARS: u64 = 8_000_000;
pub const OPEN_SEARCH_RESULTS: u64 = 20;
pub const OPEN_SEARCH_SNIPPET: u64 = 4_000;
pub const OPEN_FETCH_FIND_MATCHES: u64 = 200;
pub const OPEN_SEARCH_CONTEXT: u64 = 200;
/// Rounds for a model with open ceilings and a 1M window: one that reads a file per call still runs out of task before rounds.
pub const OPEN_AGENT_ROUNDS: u64 = 256;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolLimits {
    pub read_files: u64,
    pub write_files: u64,
    pub batch_edits: u64,
    pub read_chars: u64,
    pub search_hits: u64,
    pub searchable_bytes: u64,
    pub fetch_chars: u64,
    pub fetch_bytes: u64,
    pub doc_chars: u64,
    pub search_results: u64,
    pub search_snippet: u64,
    pub fetch_find_matches: u64,
    pub search_context: u64,
    pub agent_rounds: u64,
    pub open: bool,
}

pub const DEFAULT_TOOL_LIMITS: ToolLimits = ToolLimits {
    read_files: DEFAULT_READ_FILES,
    write_files: DEFAULT_WRITE_FILES,
    batch_edits: DEFAULT_BATCH_EDITS,
    read_chars: DEFAULT_READ_CHARS,
    search_hits: DEFAULT_SEARCH_HITS,
    searchable_bytes: DEFAULT_SEARCHABLE_BYTES,
    fetch_chars: DEFAULT_FETCH_CHARS,
    fetch_bytes: DEFAULT_FETCH_BYTES,
    doc_chars: DEFAULT_DOC_CHARS,
    search_results: DEFAULT_SEARCH_RESULTS,
    search_snippet: DEFAULT_SEARCH_SNIPPET,
    fetch_find_matches: DEFAULT_FETCH_FIND_MATCHES,
    search_context: DEFAULT_SEARCH_CONTEXT,
    agent_rounds: DEFAULT_AGENT_ROUNDS,
    open: false,
};

pub const OPEN_TOOL_LIMITS: ToolLimits = ToolLimits {
    read_files: OPEN_READ_FILES,
    write_files: OPEN_WRITE_FILES,
    batch_edits: OPEN_BATCH_EDITS,
    read_chars: OPEN_READ_CHARS,
    search_hits: OPEN_SEARCH_HITS,
    searchable_bytes: OPEN_SEARCHABLE_BYTES,
    fetch_chars: OPEN_FETCH_CHARS,
    fetch_bytes: OPEN_FETCH_BYTES,
    doc_chars: OPEN_DOC_CHARS,
    search_results: OPEN_SEARCH_RESULTS,
    search_snippet: OPEN_SEARCH_SNIPPET,
    fetch_find_matches: OPEN_FETCH_FIND_MATCHES,
    search_context: OPEN_SEARCH_CONTEXT,
    agent_rounds: OPEN_AGENT_ROUNDS,
    open: true,
};

/// Strict: an unknown model is capped. `open` is the custom model's `open_limits` flag (`false` for every catalog model).
// ponytail: the web also looks the id up in its model catalog for `openToolLimits`; no catalog model sets it, so the desktop passes the flag alone.
pub fn tool_limits_for(open: bool) -> &'static ToolLimits {
    if open { &OPEN_TOOL_LIMITS } else { &DEFAULT_TOOL_LIMITS }
}

/// Round guard for this model.
pub fn agent_rounds_for(open: bool) -> u64 {
    tool_limits_for(open).agent_rounds
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::testkit::check;
    use serde_json::json;

    #[test]
    fn replays_the_web_functions() {
        check("tool_limits.toolLimitsFor", |i| serde_json::to_value(tool_limits_for(i["open"].as_bool().unwrap_or(false))).unwrap());
        check("tool_limits.agentRoundsFor", |i| json!(agent_rounds_for(i["open"].as_bool().unwrap_or(false))));
    }

    #[test]
    fn open_ceilings_are_far_above_the_defaults() {
        assert!(OPEN_TOOL_LIMITS.read_chars > DEFAULT_TOOL_LIMITS.read_chars && tool_limits_for(true).open && !tool_limits_for(false).open);
    }
}

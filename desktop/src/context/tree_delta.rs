//! Telling the model what changed instead of re-telling it everything: port of src/lib/tree-delta.ts.
//! The provider's prompt cache matches a prefix of the request, so the first listing is sent once and left alone; each
//! later change is a short message appended at the end, which costs about 15 tokens instead of a full-price re-read of
//! the conversation behind a moved listing. After enough deltas the listing is re-baselined: one deliberate cache miss.

use super::{format_size, locale_cmp};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// One file as the workspace listing sees it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TreeEntry {
    pub path: String,
    pub size: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Modified,
    Removed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TreeChange {
    pub kind: ChangeKind,
    pub path: String,
    /// Absent for a removal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// Re-baseline after this many accumulated changes: about where a delta list stops being cheaper to read than a fresh listing.
pub const REBASELINE_AFTER_CHANGES: usize = 40;
/// Re-baseline if the deltas themselves grow past this many characters (a bulk unzip or build makes the delta the tree).
pub const REBASELINE_AFTER_CHARS: usize = 8_000;

/// Compares two listings by path and size. An edit that keeps the byte count is invisible here; that is fine, the
/// model made that edit itself. Sorted by path so identical changes always serialise the same way (cache-stable).
pub fn diff_trees(before: &[TreeEntry], after: &[TreeEntry]) -> Vec<TreeChange> {
    let before_map: HashMap<&str, u64> = before.iter().map(|f| (f.path.as_str(), f.size)).collect();
    let after_map: HashMap<&str, u64> = after.iter().map(|f| (f.path.as_str(), f.size)).collect();
    let mut changes = Vec::new();
    for (path, size) in &after_map {
        match before_map.get(path) {
            None => changes.push(TreeChange { kind: ChangeKind::Added, path: path.to_string(), size: Some(*size) }),
            Some(prev) if prev != size => changes.push(TreeChange { kind: ChangeKind::Modified, path: path.to_string(), size: Some(*size) }),
            _ => {}
        }
    }
    changes.extend(before_map.keys().filter(|p| !after_map.contains_key(*p)).map(|p| TreeChange { kind: ChangeKind::Removed, path: p.to_string(), size: None }));
    changes.sort_by(|a, b| locale_cmp(&a.path, &b.path));
    changes
}

/// The short message appended to the transcript ("" for no changes).
pub fn format_changes(changes: &[TreeChange]) -> String {
    if changes.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = changes
        .iter()
        .map(|c| {
            let symbol = match c.kind {
                ChangeKind::Added => "+",
                ChangeKind::Modified => "~",
                ChangeKind::Removed => "-",
            };
            format!("  {symbol} {}{}", c.path, c.size.map_or(String::new(), |s| format!("  ({})", format_size(s))))
        })
        .collect();
    format!("Workspace changes since the last full listing (+ added, ~ modified, - removed):\n{}", lines.join("\n"))
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StepKind {
    /// Nothing changed; append nothing.
    None,
    /// Append `text` as a new trailing message.
    Delta,
    /// Replace the listing with a full tree.
    Baseline,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Step {
    pub kind: StepKind,
    pub text: String,
    pub changes: usize,
}

/// Tracks the listing across one agent run and decides, each time the workspace changes, between a small delta and a fresh full tree.
/// Holds no transcript and does no I/O: it is given a listing and says what to append.
#[derive(Debug, Default)]
pub struct TreeTracker {
    baseline: Vec<TreeEntry>,
    pending_changes: usize,
    pending_chars: usize,
    started: bool,
}

impl TreeTracker {
    pub fn new() -> TreeTracker {
        TreeTracker::default()
    }

    /// Changes appended since the last full listing.
    pub fn pending(&self) -> usize {
        self.pending_changes
    }

    /// Records a fresh listing. The first call only baselines (seed it with the listing the model was just shown).
    pub fn update(&mut self, files: &[TreeEntry]) -> Step {
        if !self.started {
            self.started = true;
            self.baseline = files.to_vec();
            return Step { kind: StepKind::Baseline, text: String::new(), changes: 0 };
        }
        let changes = diff_trees(&self.baseline, files);
        if changes.is_empty() {
            return Step { kind: StepKind::None, text: String::new(), changes: 0 };
        }
        let text = format_changes(&changes);
        let (would_be_changes, would_be_chars) = (self.pending_changes + changes.len(), self.pending_chars + super::js_len(&text));
        self.baseline = files.to_vec();
        if would_be_changes > REBASELINE_AFTER_CHANGES || would_be_chars > REBASELINE_AFTER_CHARS {
            self.pending_changes = 0;
            self.pending_chars = 0;
            return Step { kind: StepKind::Baseline, text: String::new(), changes: changes.len() };
        }
        // Each delta is the step from the previous state, so the full listing plus every delta below it, in order, is the current workspace.
        self.pending_changes = would_be_changes;
        self.pending_chars = would_be_chars;
        Step { kind: StepKind::Delta, text, changes: changes.len() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::testkit::check;
    use serde_json::{Value, json};

    fn entries(v: &Value) -> Vec<TreeEntry> {
        serde_json::from_value(v.clone()).unwrap()
    }

    #[test]
    fn replays_the_web_functions() {
        check("tree_delta.diffTrees", |i| serde_json::to_value(diff_trees(&entries(&i["before"]), &entries(&i["after"]))).unwrap());
        check("tree_delta.formatChanges", |i| {
            let changes: Vec<TreeChange> = i
                .as_array()
                .unwrap()
                .iter()
                .map(|c| TreeChange {
                    kind: match c["kind"].as_str().unwrap() {
                        "added" => ChangeKind::Added,
                        "modified" => ChangeKind::Modified,
                        _ => ChangeKind::Removed,
                    },
                    path: c["path"].as_str().unwrap().to_string(),
                    size: c["size"].as_u64(),
                })
                .collect();
            json!(format_changes(&changes))
        });
        check("tree_delta.tracker", |steps| {
            let mut t = TreeTracker::new();
            Value::Array(steps.as_array().unwrap().iter().map(|s| {
                let step = t.update(&entries(s));
                let mut v = serde_json::to_value(step).unwrap();
                v["pending"] = json!(t.pending());
                v
            }).collect())
        });
    }
}

//! Line diff for the workspace panel's Changes tab: src/lib/diff.ts, and the rows
//! src/components/DiffView.tsx derives from it, so the UI only paints.

/// Guard against a pathological file making the O(n·m) table enormous.
const MAX_LINES: usize = 5000;
/// Unchanged lines kept either side of a change. Without the fold, a one-line change
/// in a 500-line file renders 500 lines and the change is impossible to find.
const CONTEXT: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Same,
    Added,
    Removed,
    /// Stands in for a run of unchanged lines. `text` is its label: "… 12 unchanged lines".
    Skipped,
}

impl Kind {
    /// The gutter mark. Removed is U+2212, the web's minus, not a hyphen.
    pub fn sign(self) -> &'static str {
        match self {
            Kind::Added => "+",
            Kind::Removed => "−",
            Kind::Same => " ",
            Kind::Skipped => "",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub kind: Kind,
    /// 1-based line in the old file. None for added lines and markers.
    pub old: Option<usize>,
    /// 1-based line in the new file. None for removed lines and markers.
    pub new: Option<usize>,
    /// The line without its ending. (The web paints an empty one as U+00A0 so the row keeps its height.)
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diff {
    /// The changes with three unchanged lines either side, longer unchanged runs folded into a
    /// `Skipped` row above the next change. Empty when nothing changed.
    pub rows: Vec<Row>,
    /// Header counts, shown as `+N` and `−N` (U+2212).
    pub added: usize,
    pub removed: usize,
}

impl Diff {
    /// The words beside the counts: "3 lines changed". With nothing changed the web shows only "No changes.".
    pub fn summary(&self) -> String {
        match self.added + self.removed {
            0 => "No changes.".into(),
            1 => "1 line changed".into(),
            n => format!("{n} lines changed"),
        }
    }
}

/// Every line of both versions, in order. CRLF counts as LF (`str::lines`), so a file saved on
/// Windows does not look changed on every line, and a final newline adds no empty line.
/// O(old × new) time and memory: run it once per file version, not once per frame.
pub fn lines(old: &str, new: &str) -> Vec<Row> {
    let (a, b): (Vec<&str>, Vec<&str>) = (old.lines().collect(), new.lines().collect());
    let row = |kind, text: &str, old, new| Row { kind, old, new, text: text.to_string() };
    let removed = |i: usize| row(Kind::Removed, a[i], Some(i + 1), None);
    let added = |j: usize| row(Kind::Added, b[j], None, Some(j + 1));
    // Too large to diff properly: report a wholesale replacement rather than build a 25-million-cell table.
    if a.len() > MAX_LINES || b.len() > MAX_LINES {
        return (0..a.len()).map(removed).chain((0..b.len()).map(added)).collect();
    }
    // lcs[i * w + j]: the longest common subsequence of a[i..] and b[j..]. At most MAX_LINES, so u16 holds it.
    let w = b.len() + 1;
    let mut lcs = vec![0u16; (a.len() + 1) * w];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i * w + j] = if a[i] == b[j] { lcs[(i + 1) * w + j + 1] + 1 } else { lcs[(i + 1) * w + j].max(lcs[i * w + j + 1]) };
        }
    }
    let (mut i, mut j, mut out) = (0, 0, Vec::new());
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            out.push(row(Kind::Same, a[i], Some(i + 1), Some(j + 1)));
            (i, j) = (i + 1, j + 1);
        } else if j == b.len() || (i < a.len() && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
            // On a tie the removal comes first, so a changed line reads "old, then new".
            out.push(removed(i));
            i += 1;
        } else {
            out.push(added(j));
            j += 1;
        }
    }
    out
}

/// What the Changes tab shows for a file that went from `old` to `new`.
pub fn diff(old: &str, new: &str) -> Diff {
    let all = lines(old, new);
    let count = |kind| all.iter().filter(|l| l.kind == kind).count();
    let (added, removed) = (count(Kind::Added), count(Kind::Removed));
    let mut keep = vec![false; all.len()];
    for (i, line) in all.iter().enumerate() {
        if line.kind != Kind::Same {
            keep[i.saturating_sub(CONTEXT)..(i + CONTEXT + 1).min(all.len())].fill(true);
        }
    }
    // Unchanged lines after the last change are dropped without a marker, as the web does.
    let (mut rows, mut skipped, mut in_hunk) = (Vec::new(), 0, false);
    for (line, keep) in all.into_iter().zip(keep) {
        if !keep {
            skipped += 1;
            in_hunk = false;
            continue;
        }
        if !in_hunk && skipped > 0 {
            rows.push(Row { kind: Kind::Skipped, old: None, new: None, text: format!("… {skipped} unchanged line{}", if skipped == 1 { "" } else { "s" }) });
        }
        (skipped, in_hunk) = (0, true);
        rows.push(line);
    }
    Diff { rows, added, removed }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numbered(n: usize) -> String {
        (1..=n).map(|i| format!("line {i}\n")).collect()
    }

    /// One row as "sign old new text", so a whole diff reads as a list.
    fn shown(d: &Diff) -> Vec<String> {
        let n = |v: Option<usize>| v.map_or("-".to_string(), |v| v.to_string());
        d.rows.iter().map(|r| format!("{}|{}|{}|{}", r.kind.sign(), n(r.old), n(r.new), r.text)).collect()
    }

    #[test]
    fn a_changed_line_is_a_removal_then_an_addition() {
        let d = diff("a\nb\nc\n", "a\nB\nc\n");
        assert_eq!((d.added, d.removed, d.summary().as_str()), (1, 1, "2 lines changed"));
        assert_eq!(shown(&d), [" |1|1|a", "−|2|-|b", "+|-|2|B", " |3|3|c"]);
        assert_eq!(diff("", "hello\n").summary(), "1 line changed");
        // Two equal alignments: the web keeps the first line and drops the second.
        assert_eq!(shown(&diff("A\nA", "A")), [" |1|1|A", "−|2|-|A"]);
    }

    #[test]
    fn unchanged_runs_fold_to_three_lines_of_context() {
        let old = numbered(20);
        let d = diff(&old, &old.replace("line 10\n", "line ten\n").replace("line 15\n", ""));
        assert_eq!(
            shown(&d),
            [
                "|-|-|… 6 unchanged lines",
                " |7|7|line 7", " |8|8|line 8", " |9|9|line 9", "−|10|-|line 10", "+|-|10|line ten", " |11|11|line 11", " |12|12|line 12", " |13|13|line 13",
                " |14|14|line 14", "−|15|-|line 15", " |16|15|line 16", " |17|16|line 17", " |18|17|line 18",
            ]
        );
        // Two changes far apart: the gap between them gets its own marker, singular when it is one line.
        let d = diff(&old, &old.replace("line 2\n", "").replace("line 10\n", ""));
        let marks: Vec<&str> = d.rows.iter().filter(|r| r.kind == Kind::Skipped).map(|r| r.text.as_str()).collect();
        assert_eq!(marks, ["… 1 unchanged line"]);
        assert_eq!(d.rows.last().unwrap().text, "line 13");
    }

    #[test]
    fn line_endings_alone_are_not_a_change() {
        let d = diff("a\r\nb\r\n", "a\nb");
        assert!(d.rows.is_empty());
        assert_eq!((d.added, d.removed, d.summary().as_str()), (0, 0, "No changes."));
        // A bare CR is part of the line, and only one final newline is ignored.
        assert_eq!(diff("a\r", "a").removed, 1);
        assert_eq!(lines("a\n\n", "").len(), 2);
    }

    #[test]
    fn a_huge_file_is_a_wholesale_replacement() {
        let old = numbered(MAX_LINES + 1);
        let d = diff(&old, "line 1\n");
        assert_eq!((d.removed, d.added, d.rows.len()), (MAX_LINES + 1, 1, MAX_LINES + 2));
        assert!(d.rows.iter().all(|r| r.kind != Kind::Same));
        // At the cap it is still a real diff: the shared first line survives.
        let d = diff(&numbered(MAX_LINES), "line 1\n");
        assert_eq!((d.removed, d.added, d.rows[0].kind), (MAX_LINES - 1, 0, Kind::Same));
    }
}

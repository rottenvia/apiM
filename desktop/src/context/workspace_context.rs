//! The file tree the model is given before it does anything: port of src/lib/workspace-context.ts.
//! Without it a request starts blind and "add dark mode to settings" can produce a second settings file.
//! The caller supplies the listing (`tools::files::walk` already lists a workspace with the web's ignore rules).

use super::{format_size, js_len, locale_cmp};
use std::collections::HashMap;

/// A listing of 2000 files at 60000 characters is under 2% of a 1M window and covers essentially every project dropped into a chat.
pub const MAX_CONTEXT_FILES: usize = 2_000;
pub const MAX_CONTEXT_CHARS: usize = 60_000;

/// Groups paths by directory so a project reads as a structure: root first, then directories alphabetically, files in listing order.
fn render_tree(files: &[&(String, u64)]) -> String {
    let mut by_dir: HashMap<&str, Vec<(&str, u64)>> = HashMap::new();
    for (path, size) in files.iter().copied() {
        let (dir, name) = path.rsplit_once('/').unwrap_or(("", path.as_str()));
        by_dir.entry(dir).or_default().push((name, *size));
    }
    let mut dirs: Vec<&str> = by_dir.keys().copied().collect();
    dirs.sort_by(|a, b| match (a.is_empty(), b.is_empty()) {
        (true, true) => std::cmp::Ordering::Equal,
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => locale_cmp(a, b),
    });
    let mut lines: Vec<String> = Vec::new();
    for dir in dirs {
        if !dir.is_empty() {
            lines.push(format!("{dir}/"));
        }
        for (name, size) in &by_dir[dir] {
            lines.push(format!("{}{name}  ({})", if dir.is_empty() { "" } else { "  " }, format_size(*size)));
        }
    }
    lines.join("\n")
}

/// The workspace section of the system prompt. `None` is a listing that failed (missing or unreadable workspace): "",
/// because the model still has list_files. LESSONS.md is left out: it is already in the prompt as text.
pub fn build_workspace_context(listing: Option<&[(String, u64)]>) -> String {
    let Some(listing) = listing else { return String::new() };
    let files: Vec<&(String, u64)> = listing.iter().filter(|f| f.0 != "LESSONS.md").collect();
    if files.is_empty() {
        return "\n\nThe workspace is currently empty.".to_string();
    }
    let shown = &files[..files.len().min(MAX_CONTEXT_FILES)];
    let mut tree = render_tree(shown);
    if js_len(&tree) > MAX_CONTEXT_CHARS {
        // Trim on a line boundary so the tree never ends mid-filename, which would read as a file that does not exist.
        let units: Vec<u16> = tree.encode_utf16().collect();
        let end = match units[..=MAX_CONTEXT_CHARS].iter().rposition(|&u| u == 10) {
            Some(cut) if cut > 0 => cut,
            _ => MAX_CONTEXT_CHARS,
        };
        tree = String::from_utf16_lossy(&units[..end]);
        tree.push_str("\n… (list truncated — use list_files to see the rest)");
    } else if files.len() > shown.len() {
        tree.push_str(&format!("\n… and {} more (use list_files)", files.len() - shown.len()));
    }
    format!("\n\nFiles already in the workspace:\n\n{tree}\n\nThese exist right now. Edit the relevant one rather than creating a near-duplicate, and read a file before editing it so your replacement matches exactly. Sizes are shown so you can tell a stub from a real file.")
}

/// Past this many files a listing names folders, not files. A tree of 2,268 files was 60,000 characters in every
/// round of a reply: 17,000 tokens a round, 842,000 for a one-line fix. `list_files` then added 2,000 lines to it.
pub const FOLD_FILES: usize = 400;
/// The most folders a folded listing names; the deepest levels are left out first.
const FOLD_FOLDERS: usize = 150;
const FOLD_ROOT_FILES: usize = 60;

/// A large tree as its folders: up to `own` of the files right inside `base` (a folder from the workspace's root,
/// "" for the workspace itself), then the folders under it, each with the files in it and below it.
pub fn fold_listing(files: &[(String, u64)], base: &str, own: usize) -> String {
    let prefix = if base.is_empty() { String::new() } else { format!("{}/", base.trim_end_matches('/')) };
    let (mut lines, mut direct) = (Vec::new(), 0);
    let mut folders: std::collections::BTreeMap<&str, (usize, u64)> = Default::default();
    for (path, size) in files {
        let Some(rest) = path.strip_prefix(prefix.as_str()) else { continue };
        if !rest.contains('/') {
            direct += 1;
            if direct <= own {
                lines.push(format!("{path}  ({})", format_size(*size)));
            }
        }
        for (cut, _) in rest.match_indices('/') {
            let folder = folders.entry(&path[..prefix.len() + cut]).or_default();
            *folder = (folder.0 + 1, folder.1 + size);
        }
    }
    if direct > own {
        lines.push(format!("… and {} more files right here", direct - own));
    }
    let depth = |folder: &str| folder[prefix.len()..].matches('/').count() + 1;
    let levels = (2..=12).take_while(|level| folders.keys().filter(|f| depth(f) <= *level).count() <= FOLD_FOLDERS).last().unwrap_or(1);
    lines.extend(folders.iter().filter(|(folder, _)| depth(folder) <= levels).map(|(folder, (count, bytes))| format!("{folder}/  ({count} file{}, {})", if *count == 1 { "" } else { "s" }, format_size(*bytes))));
    lines.join("\n")
}

/// The workspace section of a request: every file, or the folders of a tree too large to name each file of.
pub fn workspace_listing(files: &[(String, u64)]) -> String {
    if files.len() <= FOLD_FILES {
        return build_workspace_context(Some(files));
    }
    format!(
        "\n\nFiles already in the workspace: {}, too many to name each. Here are the files right under it, then every folder with the files in it and below it:\n\n{}\n\nThese exist right now. list_files with a folder as path names the files in it; search_files finds a file by what it holds. Read a file before editing it so your replacement matches exactly.",
        files.len(),
        fold_listing(files, "", FOLD_ROOT_FILES)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::testkit::check;
    use serde_json::json;

    #[test]
    fn replays_the_web_function() {
        check("workspace_context.build", |input| {
            let files: Option<Vec<(String, u64)>> = input["files"].as_array().map(|a| a.iter().map(|f| (f[0].as_str().unwrap().to_string(), f[1].as_u64().unwrap())).collect());
            json!(build_workspace_context(files.as_deref()))
        });
    }

    #[test]
    fn root_files_sit_unindented_above_their_folders() {
        let files = vec![("b/x.rs".to_string(), 10), ("a.txt".to_string(), 2048), ("LESSONS.md".to_string(), 1)];
        let out = build_workspace_context(Some(&files));
        assert!(out.contains("Files already in the workspace:\n\na.txt  (2KB)\nb/\n  x.rs  (10B)\n\nThese exist"), "{out}");
        assert!(!out.contains("LESSONS"));
        assert_eq!(build_workspace_context(None), "");
    }

    #[test]
    fn a_large_tree_is_listed_by_its_folders() {
        let mut files: Vec<(String, u64)> = (0..500).map(|n| (format!("Lib/test/t{n:03}.py"), 1000)).collect();
        files.extend([("README.md".to_string(), 408), ("Lib/glob.py".to_string(), 2048), ("Lib/email/utils.py".to_string(), 1024)]);
        files.sort();
        let out = workspace_listing(&files);
        assert!(out.contains("503, too many to name each") && out.contains("\n\nREADME.md  (408B)\nLib/  (502 files, ") && out.contains("\nLib/email/  (1 file, 1KB)\nLib/test/  (500 files, "), "{out}");
        assert!(!out.contains("t001.py") && out.len() < 900, "{}", out.len());
        // Asked for by name, a folder shows its own files and the folders under it.
        let inside = fold_listing(&files, "Lib", 2_000);
        assert!(inside.starts_with("Lib/glob.py  (2KB)\nLib/email/  (1 file, 1KB)\nLib/test/  (500 files, "), "{inside}");
        assert_eq!(fold_listing(&files, "Lib/test", 3).lines().last(), Some("… and 497 more files right here"));
        // A small tree is listed whole, as before.
        assert!(workspace_listing(&files[..3]).contains("utils.py"));
    }
}

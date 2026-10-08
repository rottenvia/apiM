//! Turning the workspace's flat list of paths into a tree: src/lib/file-tree.ts.
//! The panel shows `collapse_chains(build(files))`. A list is fine for five files at
//! the root and useless the moment anything is nested.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Node {
    /// Just the last segment, since the path is implied by where the row sits. A collapsed chain reads "a/b/c".
    pub name: String,
    /// Full path: opens a file, and is the key for a folder's open/closed state.
    pub path: String,
    pub is_dir: bool,
    /// Empty for a file.
    pub children: Vec<Node>,
    /// Files anywhere beneath a folder, so a collapsed one can still say what is inside. 0 for a file.
    pub file_count: usize,
    /// A file's bytes, or every byte beneath a folder.
    pub size: u64,
}

fn node(name: &str, path: &str, is_dir: bool, size: u64) -> Node {
    Node { name: name.to_string(), path: path.to_string(), is_dir, children: Vec::new(), file_count: 0, size }
}

/// The part after the last "/".
fn last(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, name)| name)
}

/// Folders before files, then alphabetical ignoring case: what every file browser does.
/// Sorting by byte value would hoist every capitalised name above the lowercase ones.
fn sort(nodes: &mut [Node]) {
    // ponytail: the web's localeCompare is ICU collation; this is lower-cased code points with lower case first on a
    // tie. Same for letters and digits, different for accents ("é" lands after "z") and for "_", "~" and friends
    // against digits. Use a collation crate if such names ever sort visibly wrong.
    nodes.sort_by_cached_key(|n| (!n.is_dir, n.name.to_lowercase(), std::cmp::Reverse(n.name.clone())));
    nodes.iter_mut().for_each(|n| sort(&mut n.children));
}

/// Builds the tree from `(path, size)` pairs with "/" separators.
pub fn build(files: &[(String, u64)]) -> Vec<Node> {
    let mut root = node("", "", true, 0);
    for (path, size) in files {
        let mut at = &mut root;
        // Every stretch of the path that ends before a "/" is a folder on the way down.
        for (slash, _) in path.match_indices('/') {
            let dir = &path[..slash];
            if dir.is_empty() {
                continue;
            }
            // ponytail: scans the siblings for the folder. A path -> index map if one folder ever holds thousands of folders.
            let i = at.children.iter().position(|c| c.is_dir && c.path == dir).unwrap_or_else(|| {
                at.children.push(node(last(dir), dir, true, 0));
                at.children.len() - 1
            });
            at = &mut at.children[i];
            // Totals roll up through every ancestor.
            at.file_count += 1;
            at.size += size;
        }
        at.children.push(node(last(path), path, false, *size));
    }
    sort(&mut root.children);
    root.children
}

/// Shows a folder that holds nothing but one folder as a single row, the way a file browser does.
/// A zip usually wraps its contents in a folder of its own name, so an unpacked archive reads
/// `uploads/EXT-Faceit/EXT/src/…` and takes three clicks to reach anything.
///
/// `uploads` itself never folds into what is inside it: it is the answer to "where did my zip go",
/// and merging it away would put the archive's name at the top level beside the user's own files.
pub fn collapse_chains(nodes: Vec<Node>) -> Vec<Node> {
    nodes
        .into_iter()
        .map(|mut node| {
            if !node.is_dir {
                return node;
            }
            let mut name = std::mem::take(&mut node.name);
            while name != "uploads" && node.children.len() == 1 && node.children[0].is_dir {
                node = node.children.remove(0);
                name = format!("{name}/{}", node.name);
            }
            node.name = name;
            node.children = collapse_chains(std::mem::take(&mut node.children));
            node
        })
        .collect()
}

/// Every folder path in a tree, parents first, for expanding or collapsing all at once.
/// (The web starts with every folder closed.)
pub fn dir_paths(nodes: &[Node]) -> Vec<String> {
    nodes.iter().filter(|n| n.is_dir).flat_map(|n| std::iter::once(n.path.clone()).chain(dir_paths(&n.children))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(paths: &[(&str, u64)]) -> Vec<(String, u64)> {
        paths.iter().map(|(p, s)| (p.to_string(), *s)).collect()
    }

    /// "name/" for folders, in display order.
    fn names(nodes: &[Node]) -> Vec<String> {
        nodes.iter().map(|n| format!("{}{}", n.name, if n.is_dir { "/" } else { "" })).collect()
    }

    #[test]
    fn folders_first_then_names_ignoring_case() {
        let tree = build(&files(&[("main.py", 400), ("src/util.py", 200), ("src/lib/deep.py", 100), ("README.md", 50), ("Zed/a", 1), ("apple.txt", 1), ("Apple.txt", 1)]));
        assert_eq!(names(&tree), ["src/", "Zed/", "apple.txt", "Apple.txt", "main.py", "README.md"]);
        let src = &tree[0];
        assert_eq!(names(&src.children), ["lib/", "util.py"]);
        assert_eq!((src.file_count, src.size, src.children[0].file_count), (2, 300, 1));
        let deep = &src.children[0].children[0];
        assert_eq!((deep.name.as_str(), deep.path.as_str(), deep.size, deep.is_dir), ("deep.py", "src/lib/deep.py", 100, false));
    }

    #[test]
    fn single_folder_chains_become_one_row_but_uploads_stays() {
        let flat = files(&[("uploads/EXT-Faceit/EXT/manifest.json", 3000), ("uploads/EXT-Faceit/EXT/src/a.js", 10), ("pkg/inner/only/x.rs", 5), ("notes.md", 1)]);
        let tree = collapse_chains(build(&flat));
        assert_eq!(names(&tree), ["pkg/inner/only/", "uploads/", "notes.md"]);
        // The merged row keeps the innermost folder's path, so opening it opens the right thing.
        assert_eq!((tree[0].path.as_str(), tree[0].file_count, tree[0].size), ("pkg/inner/only", 1, 5));
        let uploads = &tree[1];
        assert_eq!((names(&uploads.children), uploads.file_count, uploads.size), (vec!["EXT-Faceit/EXT/".to_string()], 2, 3010));
        // A branch stops the merge.
        assert_eq!(names(&uploads.children[0].children), ["src/", "manifest.json"]);
        // Only a chain that starts at `uploads` is held back: one that passes through it merges.
        assert_eq!(names(&collapse_chains(build(&files(&[("a/uploads/b/f", 1)])))), ["a/uploads/b/"]);
        assert_eq!(dir_paths(&tree), ["pkg/inner/only", "uploads", "uploads/EXT-Faceit/EXT", "uploads/EXT-Faceit/EXT/src"]);
    }

    #[test]
    fn odd_paths_follow_the_web() {
        // A leading slash adds no nameless folder; a file and a folder may share a name.
        let tree = build(&files(&[("/a/b", 1), ("x", 1), ("x/y", 2)]));
        assert_eq!(names(&tree), ["a/", "x/", "x"]);
        assert_eq!((tree[0].path.as_str(), tree[0].children[0].path.as_str()), ("/a", "/a/b"));
        assert_eq!(dir_paths(&build(&files(&[("a/b/c/f", 1), ("a/d/f", 1)]))), ["a", "a/b", "a/b/c", "a/d"]);
    }
}

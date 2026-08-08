/**
 * Checks the workspace file tree.
 *
 * Run:  npm run test:tree
 *
 * The panel printed the full path on every row, so an archive unpacked into
 * uploads/ showed a column of identical truncated strings — the segment that
 * identified each file was exactly the segment cut off. These check that a
 * flat list of paths becomes a structure you can actually read.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const T = await import(pathToFileURL(path.join(ROOT, "src/lib/file-tree.ts")).href);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0,
  fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

/** Find a node by name at a given level. */
const at = (nodes, name) => nodes.find((n) => n.name === name);

console.log("\napiM file tree checks\n");

// ---------------------------------------------------------------- building

console.log("1. Building the tree");

const flat = [
  { path: "main.py", size: 400 },
  { path: "src/util.py", size: 200 },
  { path: "src/lib/deep.py", size: 100 },
  { path: "README.md", size: 50 },
];

const tree = T.buildFileTree(flat);

check("root files appear at the root", Boolean(at(tree, "main.py")));
check("folders appear at the root", Boolean(at(tree, "src")));
check(
  "a file's name is its last segment, not its path",
  at(tree, "main.py")?.name === "main.py"
);
check(
  "the full path is kept for opening it",
  at(tree, "main.py")?.path === "main.py"
);

const src = at(tree, "src");
check("nested files sit under their folder", Boolean(at(src.children, "util.py")));
check(
  "the nested file shows only its own name",
  at(src.children, "util.py")?.name === "util.py",
  "printing the path on every row is what made every row look identical"
);
check("folders nest arbitrarily deep", Boolean(at(src.children, "lib")));
check(
  "the deepest file is reachable",
  at(at(src.children, "lib").children, "deep.py")?.path === "src/lib/deep.py"
);

// ---------------------------------------------------------------- ordering

console.log("\n2. Ordering");

check(
  "folders come before files",
  tree[0].kind === "dir",
  tree.map((n) => `${n.name}${n.kind === "dir" ? "/" : ""}`).join(", ")
);
// Case-insensitive, like every file browser: sorting by byte value would
// hoist every capitalised name above the lowercase ones.
check(
  "files are alphabetical, ignoring case",
  tree.filter((n) => n.kind === "file").map((n) => n.name).join(",") ===
    "main.py,README.md",
  "README.md would jump above everything under ASCII ordering"
);

// ------------------------------------------------------------------ totals

console.log("\n3. Totals roll up");

check("a folder counts its own files", src.fileCount === 2, `${src.fileCount}`);
check(
  "and its descendants' bytes",
  src.size === 300,
  `${src.size} — 200 direct + 100 nested`
);
check(
  "a collapsed folder can still say what is inside",
  at(src.children, "lib").fileCount === 1
);

// -------------------------------------------------------------- collapsing

console.log("\n4. Collapsing single-folder chains");

const archive = T.collapseChains(
  T.buildFileTree([
    { path: "uploads/EXT-Faceit/EXT/manifest.json", size: 3000 },
    { path: "uploads/EXT-Faceit/EXT/content.js", size: 164000 },
    { path: "uploads/EXT-Faceit/EXT/css/popup.css", size: 10000 },
  ])
);

const uploads = at(archive, "uploads");
check(
  "uploads stays its own level",
  Boolean(uploads),
  "it answers 'where did my zip go' and must not be merged away"
);
check(
  "the archive's folders below it are merged into one row",
  uploads.children[0].name === "EXT-Faceit/EXT",
  uploads.children[0].name
);
check(
  "so the contents are two clicks away, not four",
  Boolean(at(uploads.children[0].children, "content.js"))
);
check(
  "a folder that branches is not merged",
  Boolean(at(uploads.children[0].children, "css")),
  "css sits beside two files, so it is a real branch"
);
check(
  "merging does not lose the real path",
  at(uploads.children[0].children, "content.js").path ===
    "uploads/EXT-Faceit/EXT/content.js",
  "the row is a display name; opening it still needs the truth"
);

// A single file at the root must not be swallowed by a chain.
const mixed = T.collapseChains(
  T.buildFileTree([
    { path: "uploads/a/b/c.txt", size: 1 },
    { path: "notes.md", size: 1 },
  ])
);
check("root files survive collapsing", Boolean(at(mixed, "notes.md")));

// ----------------------------------------------------------------- helpers

console.log("\n5. Expanding");

const paths = T.allDirPaths(tree);
check(
  "every folder path is listed",
  paths.includes("src") && paths.includes("src/lib"),
  paths.join(", ")
);
check("files are not listed as folders", !paths.includes("main.py"));

// ------------------------------------------------------------------- edges

console.log("\n6. Edges");

check("an empty workspace produces an empty tree", T.buildFileTree([]).length === 0);
check(
  "collapsing an empty tree is harmless",
  T.collapseChains([]).length === 0
);

const single = T.buildFileTree([{ path: "only.txt", size: 1 }]);
check("a lone file needs no folder", single.length === 1 && single[0].kind === "file");

const deep = T.buildFileTree([{ path: "a/b/c/d/e/f.txt", size: 1 }]);
check("a deep path builds every level", T.allDirPaths(deep).length === 5);

const dotted = T.buildFileTree([{ path: "uploads/.hidden/file.txt", size: 1 }]);
check(
  "a dot-prefixed folder is still a folder",
  at(at(dotted, "uploads").children, ".hidden")?.kind === "dir"
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

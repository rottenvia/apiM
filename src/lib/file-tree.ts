/**
 * Turning a flat list of paths into a tree.
 *
 * The panel rendered `file.path` on every row, so a project unpacked from a
 * zip showed fourteen rows all reading "uploads/EXT---Faceit-In…" — the part
 * that identified each file was exactly the part cut off. A list is fine for
 * five files at the root and useless the moment anything is nested.
 */

export interface TreeFile {
  kind: "file";
  /** Just the filename, since the path is implied by where it sits. */
  name: string;
  /** Full path, for opening and for the tooltip. */
  path: string;
  size: number;
}

export interface TreeDir {
  kind: "dir";
  name: string;
  /** Full path, used as the key for open/closed state. */
  path: string;
  children: TreeNode[];
  /** Files anywhere beneath this folder. */
  fileCount: number;
  /** Bytes anywhere beneath this folder. */
  size: number;
}

export type TreeNode = TreeFile | TreeDir;

interface Input {
  path: string;
  size: number;
}

/**
 * Build a tree from paths.
 *
 * Folders sort before files, then alphabetically — which is what makes a
 * directory listing scannable, and matches every file browser people already
 * know.
 */
export function buildFileTree(files: Input[]): TreeNode[] {
  const root: TreeDir = {
    kind: "dir",
    name: "",
    path: "",
    children: [],
    fileCount: 0,
    size: 0,
  };

  // Directories are looked up by path so each is created once, however many
  // files land inside it.
  const dirs = new Map<string, TreeDir>([["", root]]);

  const dirAt = (path: string): TreeDir => {
    const found = dirs.get(path);
    if (found) return found;

    const slash = path.lastIndexOf("/");
    const parentPath = slash === -1 ? "" : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);

    const dir: TreeDir = {
      kind: "dir",
      name,
      path,
      children: [],
      fileCount: 0,
      size: 0,
    };
    dirs.set(path, dir);
    dirAt(parentPath).children.push(dir);
    return dir;
  };

  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    const parentPath = slash === -1 ? "" : file.path.slice(0, slash);
    const name = slash === -1 ? file.path : file.path.slice(slash + 1);

    dirAt(parentPath).children.push({
      kind: "file",
      name,
      path: file.path,
      size: file.size,
    });

    // Roll the totals up every ancestor, so a collapsed folder can still say
    // how much is inside it.
    let at: string | null = parentPath;
    while (at !== null) {
      const dir = dirs.get(at);
      if (dir) {
        dir.fileCount += 1;
        dir.size += file.size;
      }
      if (at === "") break;
      const slashAt = at.lastIndexOf("/");
      at = slashAt === -1 ? "" : at.slice(0, slashAt);
    }
  }

  const sort = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) if (node.kind === "dir") sort(node.children);
    return nodes;
  };

  return sort(root.children);
}

/**
 * Collapse folders that contain only one folder.
 *
 * A zip usually wraps its contents in a folder of the same name, so an
 * unpacked archive reads `uploads/EXT-Faceit/EXT/src/…` and takes three
 * clicks to reach anything. Chains with no branch in them are shown as one
 * row, the way a file browser does, since expanding them individually
 * reveals nothing.
 *
 * `uploads` itself is never folded into its children. It is the answer to
 * "where did my zip go", and merging it away would put the archive's name at
 * the top level next to the user's own files, which is exactly the flat list
 * this replaces.
 */
const NEVER_COLLAPSE = new Set(["uploads"]);

export function collapseChains(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.kind !== "dir") return node;

    let current = node;
    let name = node.name;

    while (
      !NEVER_COLLAPSE.has(name) &&
      current.children.length === 1 &&
      current.children[0].kind === "dir"
    ) {
      const only = current.children[0] as TreeDir;
      name = `${name}/${only.name}`;
      current = only;
    }

    return {
      ...current,
      name,
      children: collapseChains(current.children),
    };
  });
}

/** Every folder path in a tree, for expanding or collapsing all at once. */
export function allDirPaths(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      if (node.kind !== "dir") continue;
      out.push(node.path);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

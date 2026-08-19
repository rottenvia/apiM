import { listFiles } from "@/lib/workspace";

/**
 * The file tree the model is given before it does anything.
 *
 * Without this it starts every request blind: it does not know which files
 * exist, so "add dark mode to the settings page" can produce a second
 * settings file next to the real one. Listing costs one directory walk and
 * removes an entire class of wrong-file mistakes.
 */

/**
 * Keep the summary well under the point where it crowds out the reply.
 *
 * A tree is cheap: one line per file, no contents. The cap here is the
 * amount of STANDING context paid on every single round, so it is kept
 * conservative — 30k chars is roughly 8k tokens, which is small against a
 * million-token window but compounds across a 40-round task.
 */
export const MAX_CONTEXT_FILES = 2_000;
export const MAX_CONTEXT_CHARS = 30_000;

/** Files larger than this are summarised rather than listed individually
 *  when a directory is very full, so a single 46MB memory dump cannot
 *  dominate the tree. They still appear (with size), just grouped. */
const LARGE_FILE_BYTES = 5 * 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface DirEntries {
  files: { name: string; size: number }[];
  large: { name: string; size: number }[];
}

/**
 * Groups paths by directory so a project reads as a structure rather than a
 * flat list of slash-separated strings.
 *
 * Large files (dumps, ISOs, built artifacts) are listed separately and
 * capped per directory so one binary cannot blow the token budget.
 */
function renderTree(files: { path: string; size: number }[]): string {
  const byDir = new Map<string, DirEntries>();

  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    const dir = slash === -1 ? "" : file.path.slice(0, slash);
    const name = slash === -1 ? file.path : file.path.slice(slash + 1);
    let list = byDir.get(dir);
    if (!list) {
      list = { files: [], large: [] };
      byDir.set(dir, list);
    }
    if (file.size >= LARGE_FILE_BYTES) list.large.push({ name, size: file.size });
    else list.files.push({ name, size: file.size });
  }

  const dirs = [...byDir.keys()].sort((a, b) => {
    if (a === "") return -1;
    if (b === "") return 1;
    return a.localeCompare(b);
  });

  const lines: string[] = [];
  let largeCount = 0;
  let largeBytes = 0;

  for (const dir of dirs) {
    if (dir) lines.push(`${dir}/`);
    const prefix = dir ? "  " : "";
    const entry = byDir.get(dir)!;

    for (const f of entry.files) {
      lines.push(`${prefix}${f.name}  (${formatSize(f.size)})`);
    }
    for (const f of entry.large) {
      largeCount += 1;
      largeBytes += f.size;
      lines.push(`${prefix}${f.name}  (${formatSize(f.size)}, large binary)`);
    }
  }

  if (largeCount > 0) {
    lines.push(
      `\n${largeCount} large file(s) totalling ${formatSize(largeBytes)} are listed above. ` +
        "Do not read them whole unless the user explicitly asks — use inspect_binary, strings, or read a byte range."
    );
  }

  return lines.join("\n");
}

/**
 * Builds the workspace section of the system prompt.
 *
 * Returns an empty string when there is nothing to say, so an empty
 * workspace does not spend tokens announcing its own emptiness beyond one
 * line the model needs in order to know it may create files.
 */
export async function buildWorkspaceContext(
  workspaceId: string
): Promise<string> {
  let files: { path: string; size: number }[];
  try {
    files = await listFiles(workspaceId);
    // The lessons file is already injected into the system prompt as text.
    // Listing it here as well invites the model to read it a second time,
    // paying for the same content twice in one request.
    files = files.filter((f) => f.path !== "LESSONS.md");
  } catch {
    // A missing or unreadable workspace is not worth failing the request
    // over — the model still has list_files if it wants to look.
    return "";
  }

  if (files.length === 0) {
    return "\n\nThe workspace is currently empty.";
  }

  const shown = files.slice(0, MAX_CONTEXT_FILES);
  let tree = renderTree(shown);

  if (tree.length > MAX_CONTEXT_CHARS) {
    // Trim on a line boundary so the tree never ends mid-filename, which
    // would read as a file that does not exist.
    const cut = tree.lastIndexOf("\n", MAX_CONTEXT_CHARS);
    tree = tree.slice(0, cut > 0 ? cut : MAX_CONTEXT_CHARS);
    tree += "\n… (list truncated — use list_files to see the rest)";
  } else if (files.length > shown.length) {
    tree += `\n… and ${files.length - shown.length} more (use list_files)`;
  }

  return (
    `\n\nFiles already in the workspace:\n\n${tree}\n\n` +
    `These exist right now. Edit the relevant one rather than creating a ` +
    `near-duplicate, and read a file before editing it so your replacement ` +
    `matches exactly. Sizes are shown so you can tell a stub from a real file. ` +
    `Large binaries are marked as such — do not read them fully; use inspect_binary or read_file with a line/byte range.`
  );
}

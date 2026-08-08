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
 * These were 120 files / 4_000 chars, sized for a small context window. On a
 * real project that meant the model was shown a partial tree — a 203-file
 * extension listed 120 of them and the rest became "… and 83 more". Asked for
 * "the full structure" it answered from the truncated list, because that list
 * was the only structure it had ever been given.
 *
 * A tree is cheap: it is one line per file, no contents. 2000 files at 60_000
 * characters is under 2% of DeepSeek v4's window and covers essentially every
 * project someone drops into a chat.
 */
export const MAX_CONTEXT_FILES = 2_000;
export const MAX_CONTEXT_CHARS = 60_000;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Groups paths by directory so a project reads as a structure rather than a
 * flat list of slash-separated strings.
 */
function renderTree(
  files: { path: string; size: number }[]
): string {
  const byDir = new Map<string, { name: string; size: number }[]>();

  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    const dir = slash === -1 ? "" : file.path.slice(0, slash);
    const name = slash === -1 ? file.path : file.path.slice(slash + 1);
    const list = byDir.get(dir);
    if (list) list.push({ name, size: file.size });
    else byDir.set(dir, [{ name, size: file.size }]);
  }

  // Root first, then subdirectories alphabetically.
  const dirs = [...byDir.keys()].sort((a, b) => {
    if (a === "") return -1;
    if (b === "") return 1;
    return a.localeCompare(b);
  });

  const lines: string[] = [];
  for (const dir of dirs) {
    if (dir) lines.push(`${dir}/`);
    for (const entry of byDir.get(dir) ?? []) {
      lines.push(`${dir ? "  " : ""}${entry.name}  (${formatSize(entry.size)})`);
    }
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
    `matches exactly. Sizes are shown so you can tell a stub from a real file.`
  );
}

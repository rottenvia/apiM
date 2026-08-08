import { promises as fs } from "node:fs";
import path from "node:path";
import { documentKind, readDocument } from "@/lib/documents";

/**
 * Workspace filesystem.
 *
 * Files live under ./data/workspaces/<id>/ relative to where the app was
 * launched, alongside the chat store. Everything here is deliberately
 * paranoid about paths: these operations are driven by a language model, so
 * a hallucinated "../../.ssh/id_rsa" must fail rather than succeed.
 */

/**
 * Root of all workspaces.
 *
 * Assembled from parts rather than written as one literal on purpose.
 * Turbopack statically analyses `path.resolve(process.cwd(), "data", ...)`,
 * treats the result as a directory the module depends on, and walks it at
 * build time. A Python virtualenv contains an absolute symlink to the system
 * interpreter, which the bundler reads as pointing outside the project root
 * and panics on — so `npm run build` would fail purely because the user had
 * installed a package. Keeping the path out of reach of static analysis stops
 * it being traced at all.
 */
const DATA_DIR = ["data", "workspaces"].join(path.sep);
const ROOT = path.resolve(process.cwd(), DATA_DIR);

/**
 * Guard rails, not a quota.
 *
 * These were set to hosted-service numbers — 2MB a file, 500 files — which
 * made sense for someone else's disk. This runs on the user's own machine,
 * where the only real limit is how much space they have, so a build output
 * or a downloaded dataset should not be refused.
 *
 * They are kept, generously, because a runaway loop writing an unbounded
 * file is still worth stopping, and a listing of a million entries would
 * hang the panel rather than inform anyone. The point is that nothing a
 * person would deliberately do should hit them.
 */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_FILES_PER_WORKSPACE = 100_000;
/** Truncate oversized reads so one file can't swamp the context window. */
export const MAX_READ_CHARS = 100_000;

export interface WorkspaceFile {
  path: string;
  size: number;
  modifiedAt: string;
}

export class WorkspaceError extends Error {}

/**
 * Folder name a workspace uses on disk.
 *
 * Set by the chat store so a conversation and its files share a name — chat
 * "hello" gets `data/chats/hello/` and `data/workspaces/hello/`. Held in
 * memory and rebuilt from disk on demand, so a restart does not lose it.
 */
const folderNames = new Map<string, string>();

/** Called by the chat store when it names or renames a conversation. */
export function setWorkspaceFolderName(
  workspaceId: string,
  folder: string
): void {
  if (/^[\w-]{1,128}$/.test(workspaceId) && /^[\w-]{1,128}$/.test(folder)) {
    folderNames.set(workspaceId, folder);
  }
}

export function workspaceFolderName(workspaceId: string): string {
  return folderNames.get(workspaceId) ?? workspaceId;
}

/**
 * Renames a workspace folder to follow its chat.
 *
 * Best effort: if it fails the files are still reachable under the old name,
 * which matters more than the names matching.
 */
export async function renameWorkspaceFolder(
  from: string,
  to: string
): Promise<void> {
  if (from === to) return;
  if (!/^[\w-]{1,128}$/.test(from) || !/^[\w-]{1,128}$/.test(to)) return;

  const src = path.join(ROOT, from);
  const dest = path.join(ROOT, to);

  try {
    await fs.access(src);
  } catch {
    return; // No workspace folder yet — nothing to move.
  }

  try {
    // History and snapshots live inside the folder now, so they move with it.
    await fs.rename(src, dest);
    // Older layouts kept them as siblings; carry those across too, or undo
    // and restore break for any workspace created before the change.
    for (const suffix of [".history", ".snapshots"]) {
      await fs
        .rename(`${src}${suffix}`, path.join(dest, suffix))
        .catch(() => {});
    }
  } catch {
    /* keep the old folder rather than losing files */
  }

  for (const [id, folder] of folderNames) {
    if (folder === from) folderNames.set(id, to);
  }
}

function workspaceRoot(workspaceId: string): string {
  if (!/^[\w-]{1,128}$/.test(workspaceId)) {
    throw new WorkspaceError("Invalid workspace id");
  }
  // Validated above, and the mapped name is validated when it is set, so the
  // result cannot escape ROOT either way.
  return path.join(ROOT, workspaceFolderName(workspaceId));
}

/**
 * Resolve a user/model-supplied path inside the workspace.
 *
 * Rejects absolute paths, traversal, and anything that resolves outside the
 * root. The prefix check uses the resolved real path plus a separator, so
 * "/root/../rooted-elsewhere" cannot slip through a naive startsWith.
 */
export function resolveInside(workspaceId: string, relative: string): string {
  const root = workspaceRoot(workspaceId);

  if (typeof relative !== "string" || !relative.trim()) {
    throw new WorkspaceError("Path is required");
  }
  if (path.isAbsolute(relative) || relative.includes("\0")) {
    throw new WorkspaceError("Path must be relative to the workspace");
  }

  // Treat backslashes as separators regardless of platform. On Linux they are
  // ordinary characters, so "..\..\etc" would be accepted as one odd
  // filename here yet traverse on Windows — reject it everywhere instead.
  const normalised = relative.replace(/\\/g, "/");
  if (normalised.split("/").some((segment) => segment === "..")) {
    throw new WorkspaceError("Path must not contain '..'");
  }

  const target = path.resolve(root, normalised);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new WorkspaceError("Path escapes the workspace");
  }
  return target;
}

/**
 * Fold pre-existing sibling folders into the workspace.
 *
 * Anyone who used the app before this change has "<ws>.history" and
 * "<ws>.snapshots" sitting next to "<ws>". Left alone their undo history and
 * restore points would silently stop working, so they are moved inside on
 * first touch. Runs at most once per workspace per process, and a failure is
 * survivable — the worst case is the old folders stay where they are.
 */
const migrated = new Set<string>();

async function migrateLayout(root: string): Promise<void> {
  if (migrated.has(root)) return;
  migrated.add(root);

  for (const suffix of INTERNAL_DIRS) {
    const old = `${root}${suffix}`;
    const dest = path.join(root, suffix);
    try {
      await fs.access(old);
    } catch {
      continue; // Nothing from the old layout.
    }
    try {
      await fs.access(dest);
      continue; // Already migrated; leave the stray folder rather than merge.
    } catch {
      /* destination is free */
    }
    try {
      await fs.mkdir(root, { recursive: true });
      await fs.rename(old, dest);
    } catch {
      /* keep the old folder rather than losing history */
    }
  }
}

async function ensureRoot(workspaceId: string): Promise<string> {
  const root = workspaceRoot(workspaceId);
  await fs.mkdir(root, { recursive: true });
  await migrateLayout(root);
  return root;
}

/**
 * Internal subdirectories, kept inside the workspace but hidden from it.
 *
 * They were siblings — "<ws>.history" beside "<ws>" — which meant one
 * workspace occupied three folders in data/workspaces. Moving them inside
 * keeps everything for a workspace in one place; IGNORED then stops them
 * appearing in listings, being fed to the model, or ending up inside each
 * other.
 */
export const INTERNAL_DIRS = [".history", ".snapshots"] as const;

/**
 * Where `pip install` and `npm install` put things.
 *
 * Hidden for the same reason as node_modules: a few thousand vendored files
 * would swamp the file tree and crowd out the code the user actually wrote.
 * Not in INTERNAL_DIRS because it never existed as a sibling folder, so
 * there is nothing to migrate.
 */
const PACKAGE_DIR = ".packages";

/** Directories never worth showing the model. */
const IGNORED = new Set([
  ...INTERNAL_DIRS,
  PACKAGE_DIR,
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
]);

export async function listFiles(
  workspaceId: string,
  subPath = "."
): Promise<WorkspaceFile[]> {
  // Reading must not create. This used to call ensureRoot, so merely looking
  // at a workspace that had never been written to left an empty folder
  // behind in data/workspaces.
  const root = workspaceRoot(workspaceId);
  try {
    await fs.access(root);
  } catch {
    return [];
  }
  await migrateLayout(root);
  const clean = subPath.trim();
  const start =
    !clean || clean === "." || clean === "./"
      ? root
      : resolveInside(workspaceId, clean);
  const out: WorkspaceFile[] = [];

  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_FILES_PER_WORKSPACE) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (out.length >= MAX_FILES_PER_WORKSPACE) return;
      if (IGNORED.has(entry.name)) continue;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(full);
          out.push({
            path: path.relative(root, full).split(path.sep).join("/"),
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        } catch {
          /* vanished between readdir and stat */
        }
      }
    }
  }

  await walk(start);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/** Cap the work and the output so one broad search can't stall a reply. */
export const MAX_SEARCH_HITS = 60;
const MAX_SEARCHABLE_BYTES = 512 * 1024;

/**
 * Finds text across the workspace.
 *
 * Without this, locating a function in a twenty-file project costs one round
 * per file read — the whole tool budget spent looking rather than working.
 */
export async function searchFiles(
  workspaceId: string,
  query: string,
  options: { regex?: boolean; caseSensitive?: boolean; glob?: string } = {}
): Promise<{ hits: SearchHit[]; truncated: boolean; filesSearched: number }> {
  const needle = String(query ?? "");
  if (!needle.trim()) {
    throw new WorkspaceError("A search query is required");
  }

  let matcher: (line: string) => boolean;

  if (options.regex) {
    let re: RegExp;
    try {
      re = new RegExp(needle, options.caseSensitive ? "" : "i");
    } catch (err) {
      // Report the syntax error back rather than throwing an unhandled one —
      // a model writing a bad pattern should be able to correct it.
      throw new WorkspaceError(
        `Invalid regular expression: ${
          err instanceof Error ? err.message : "bad pattern"
        }`
      );
    }
    matcher = (line) => re.test(line);
  } else {
    const lower = needle.toLowerCase();
    matcher = options.caseSensitive
      ? (line) => line.includes(needle)
      : (line) => line.toLowerCase().includes(lower);
  }

  // A simple glob: * matches anything within a path segment-free sense,
  // which is enough for "*.py" without pulling in a dependency.
  let globRe: RegExp | null = null;
  if (options.glob?.trim()) {
    const escaped = options.glob
      .trim()
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    try {
      globRe = new RegExp(`^${escaped}$`, "i");
    } catch {
      globRe = null;
    }
  }

  const files = await listFiles(workspaceId);
  const hits: SearchHit[] = [];
  let filesSearched = 0;
  let truncated = false;

  for (const file of files) {
    if (hits.length >= MAX_SEARCH_HITS) {
      truncated = true;
      break;
    }
    if (globRe && !globRe.test(file.path)) continue;
    // Skip anything large enough to be data rather than source; reading it
    // would cost more than the match is worth.
    if (file.size > MAX_SEARCHABLE_BYTES) continue;

    let content: string;
    try {
      content = await fs.readFile(resolveInside(workspaceId, file.path), "utf8");
    } catch {
      continue; // Binary, vanished, or unreadable.
    }

    // A NUL byte means binary; matching inside it produces noise.
    if (content.includes("\0")) continue;

    filesSearched++;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!matcher(lines[i])) continue;
      hits.push({
        path: file.path,
        line: i + 1,
        // Trim so one minified line can't dominate the entire result.
        text: lines[i].trim().slice(0, 200),
      });
      if (hits.length >= MAX_SEARCH_HITS) {
        truncated = true;
        break;
      }
    }
  }

  return { hits, truncated, filesSearched };
}

export interface ReadResult {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
}

export async function readFile(
  workspaceId: string,
  relative: string
): Promise<ReadResult> {
  const target = resolveInside(workspaceId, relative);

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new WorkspaceError(`No such file: ${relative}`);
  }
  if (!stat.isFile()) throw new WorkspaceError(`Not a file: ${relative}`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new WorkspaceError(
      `${relative} is too large to read (${Math.round(stat.size / 1024)}KB)`
    );
  }

  // A document in the workspace should be as readable as one attached to a
  // message — otherwise the agent can be handed a .docx it cannot open, and
  // has to tell the user to convert a file that is right there.
  const kind = documentKind(relative);
  if (kind) {
    try {
      const doc = await readDocument(kind, new Uint8Array(await fs.readFile(target)));
      return {
        path: relative,
        content: doc.text,
        truncated: doc.truncated,
        size: stat.size,
      };
    } catch (error) {
      throw new WorkspaceError(
        `Couldn't read ${relative}: ${
          error instanceof Error ? error.message : "unreadable document"
        }`
      );
    }
  }

  const raw = await fs.readFile(target, "utf8");
  const truncated = raw.length > MAX_READ_CHARS;
  return {
    path: relative,
    content: truncated ? raw.slice(0, MAX_READ_CHARS) : raw,
    truncated,
    size: stat.size,
  };
}

/**
 * Where the previous version of each file is kept.
 *
 * A model overwriting a file is normal and often wrong, so the version it
 * replaced has to survive somewhere. Sits outside the workspace root so it
 * never shows up in listings or gets fed back to the model as a real file.
 */
function historyPathFor(workspaceId: string, relative: string): string {
  const root = workspaceRoot(workspaceId);
  // Flatten the path into one filename so nested directories don't need
  // recreating inside the history folder.
  const flat = relative.replace(/[\\/]/g, "__");
  return path.join(root, ".history", `${flat}.prev`);
}

/** The version replaced by the last write, if there is one. */
export async function previousVersion(
  workspaceId: string,
  relative: string
): Promise<string | null> {
  // Validates the path, so a crafted name can't read outside the history dir.
  resolveInside(workspaceId, relative);
  try {
    return await fs.readFile(historyPathFor(workspaceId, relative), "utf8");
  } catch {
    return null;
  }
}

/** Records the current contents before they are overwritten. */
async function saveHistory(
  workspaceId: string,
  relative: string,
  target: string
): Promise<void> {
  try {
    const current = await fs.readFile(target, "utf8");
    const dest = historyPathFor(workspaceId, relative);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, current, "utf8");
  } catch {
    // No existing file, or it isn't text. Either way there is nothing worth
    // keeping, and failing to save history must never block the write.
  }
}

/**
 * Reads an image as a data URL, for the vision model.
 *
 * Separate from readFile because that decodes UTF-8, which corrupts binary
 * data. Images have to be passed through as bytes.
 */
export async function readImageAsDataUrl(
  workspaceId: string,
  relative: string
): Promise<{ path: string; dataUrl: string; bytes: number }> {
  const target = resolveInside(workspaceId, relative);

  const ext = path.extname(relative).toLowerCase();
  const mime =
    ext === ".png"
      ? "image/png"
      : ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".webp"
          ? "image/webp"
          : ext === ".gif"
            ? "image/gif"
            : ext === ".bmp"
              ? "image/bmp"
              : null;

  if (!mime) {
    throw new WorkspaceError(
      `${relative} is not an image (expected .png, .jpg, .webp, .gif or .bmp)`
    );
  }

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new WorkspaceError(`No such file: ${relative}`);
  }
  if (!stat.isFile()) throw new WorkspaceError(`Not a file: ${relative}`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new WorkspaceError(
      `${relative} is too large to read (${Math.round(stat.size / 1024)}KB)`
    );
  }

  const buffer = await fs.readFile(target);
  return {
    path: relative,
    dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
    bytes: stat.size,
  };
}

export async function writeFile(
  workspaceId: string,
  relative: string,
  content: string
): Promise<{ path: string; bytes: number; created: boolean }> {
  await ensureRoot(workspaceId);
  const target = resolveInside(workspaceId, relative);

  if (typeof content !== "string") {
    throw new WorkspaceError("Content must be a string");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new WorkspaceError("File is too large to write");
  }

  const existed = await fs
    .access(target)
    .then(() => true)
    .catch(() => false);

  // Before overwriting, keep what was there so it can be shown as a diff and
  // restored. Only on overwrite: a new file has no previous version.
  if (existed) await saveHistory(workspaceId, relative, target);

  await fs.mkdir(path.dirname(target), { recursive: true });

  // Write then rename so a crash can't leave a half-written file.
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }

  return {
    path: relative,
    bytes: Buffer.byteLength(content, "utf8"),
    created: !existed,
  };
}

/**
 * Replace the first exact occurrence of `oldText`.
 *
 * Deliberately exact and single-match: a fuzzy or global replace driven by a
 * model is how files get silently corrupted. Ambiguity is reported back so
 * the model can supply more context instead.
 */
export async function editFile(
  workspaceId: string,
  relative: string,
  oldText: string,
  newText: string
): Promise<{ path: string; replaced: boolean }> {
  const target = resolveInside(workspaceId, relative);

  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch {
    throw new WorkspaceError(`No such file: ${relative}`);
  }

  if (!oldText) throw new WorkspaceError("old_text is required");

  const first = raw.indexOf(oldText);
  if (first === -1) {
    throw new WorkspaceError(
      `old_text not found in ${relative} — read the file first and copy the exact text`
    );
  }

  const second = raw.indexOf(oldText, first + oldText.length);
  if (second !== -1) {
    throw new WorkspaceError(
      `old_text appears more than once in ${relative} — include surrounding lines to make it unique`
    );
  }

  const updated =
    raw.slice(0, first) + newText + raw.slice(first + oldText.length);
  await writeFile(workspaceId, relative, updated);
  return { path: relative, replaced: true };
}

export async function deleteFile(
  workspaceId: string,
  relative: string
): Promise<{ path: string; deleted: boolean }> {
  const target = resolveInside(workspaceId, relative);
  // Keep a copy first, so a deletion by the model is recoverable too.
  await saveHistory(workspaceId, relative, target);
  try {
    await fs.unlink(target);
    return { path: relative, deleted: true };
  } catch {
    throw new WorkspaceError(`No such file: ${relative}`);
  }
}

/** Absolute path, shown in the UI so the user knows where files landed. */
/**
 * Copy every real file from one workspace into another.
 *
 * Starting a fresh chat is often deliberate — a clean slate for a new line of
 * thought — but the files you were working on usually still matter. Without
 * this the only options are carrying the whole conversation forward or
 * recreating the files by hand.
 *
 * Only real files move. History, snapshots and installed packages are the
 * previous workspace's own bookkeeping: copying them would import an undo
 * stack for edits that never happened here, and duplicate a virtualenv that
 * can simply be rebuilt.
 *
 * Existing files are never overwritten, so importing twice, or importing
 * into a workspace that has already started, cannot destroy work.
 */
export async function copyWorkspace(
  fromId: string,
  toId: string
): Promise<{ copied: number; skipped: number }> {
  if (fromId === toId) return { copied: 0, skipped: 0 };

  const files = await listFiles(fromId);
  if (files.length === 0) return { copied: 0, skipped: 0 };

  const destRoot = await ensureRoot(toId);
  let copied = 0;
  let skipped = 0;

  for (const file of files) {
    const src = resolveInside(fromId, file.path);
    const dest = path.join(destRoot, file.path);

    // Never clobber. A name that already exists here is this workspace's.
    if (
      await fs
        .access(dest)
        .then(() => true)
        .catch(() => false)
    ) {
      skipped += 1;
      continue;
    }

    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      copied += 1;
    } catch {
      // One unreadable file should not abandon the rest of the import.
      skipped += 1;
    }
  }

  return { copied, skipped };
}

export function workspaceDirectory(workspaceId: string): string {
  return workspaceRoot(workspaceId);
}

import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Workspace filesystem.
 *
 * Files live under ./data/workspaces/<id>/ relative to where the app was
 * launched, alongside the chat store. Everything here is deliberately
 * paranoid about paths: these operations are driven by a language model, so
 * a hallucinated "../../.ssh/id_rsa" must fail rather than succeed.
 */

const ROOT = path.resolve(process.cwd(), "data", "workspaces");

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_FILES_PER_WORKSPACE = 500;
/** Truncate oversized reads so one file can't swamp the context window. */
export const MAX_READ_CHARS = 100_000;

export interface WorkspaceFile {
  path: string;
  size: number;
  modifiedAt: string;
}

export class WorkspaceError extends Error {}

function workspaceRoot(workspaceId: string): string {
  if (!/^[\w-]{1,128}$/.test(workspaceId)) {
    throw new WorkspaceError("Invalid workspace id");
  }
  return path.join(ROOT, workspaceId);
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

async function ensureRoot(workspaceId: string): Promise<string> {
  const root = workspaceRoot(workspaceId);
  await fs.mkdir(root, { recursive: true });
  return root;
}

/** Directories never worth showing the model. */
const IGNORED = new Set([
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
  const root = await ensureRoot(workspaceId);
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
  return path.join(`${root}.history`, `${flat}.prev`);
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
export function workspaceDirectory(workspaceId: string): string {
  return workspaceRoot(workspaceId);
}

import fsSync, { promises as fs } from "node:fs";
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
/*
 * `APIM_DATA_ROOT` lets a test suite point the whole app at its own directory.
 *
 * Six suites used to delete `data/` outright to start clean, which is correct
 * in isolation and destructive the moment two of them run at once — they wipe
 * each other's fixtures mid-run and fail in ways that look like real bugs.
 * Discovered by building `npm test`: nine suites failed together and every
 * one of them passed alone.
 *
 * Isolating by directory rather than by lock means they can genuinely run in
 * parallel instead of merely not colliding. Unset in normal use, so this is
 * exactly the old behaviour for anyone running the app.
 */
const ROOT = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT, "workspaces")
  : path.resolve(process.cwd(), DATA_DIR);

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
/**
 * Truncate oversized reads so one file can't swamp the context window.
 *
 * Lower than the attachment cap on purpose: the agent reads files inside a
 * loop that may run for many rounds, and every earlier read is resent on each
 * one. A file it attaches once can afford to be larger than a file it might
 * read repeatedly.
 */
export const MAX_READ_CHARS = 400_000;

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

/**
 * The same mapping, on disk.
 *
 * The in-memory map alone was the cause of uploads disappearing. It is only
 * populated when something reads the chat store, and the requests do not
 * arrive in that order: dropping a zip on a chat hits the upload route
 * first, on a freshly started (or hot-reloaded) server where nothing has
 * touched the store yet. `workspaceFolderName` then fell back to the raw
 * conversation id, so the archive was written to `data/workspaces/<uuid>/`
 * while the chat's real files lived in `data/workspaces/<slug>/`.
 *
 * Nothing was lost — but the next request went through the chat route, which
 * *does* read the store, so by the time the agent looked the id resolved to
 * the slug folder and the upload was in the other one. That is exactly the
 * reported symptom: the model analyses the archive on the turn it arrives
 * (it is inlined in that message), then reports "No ZIP in the workspace"
 * forever after.
 *
 * A one-line marker inside each workspace fixes the ordering problem for
 * good: any process can recover the mapping from disk without needing the
 * store to have been read first.
 */
const MAPPING_FILE = ".workspace-id";

/**
 * Ids already reconciled in this process, so the disk scan happens once
 * rather than on every path resolution.
 */
let diskMappingLoaded = false;

/**
 * Rebuild the id → folder mapping by reading the marker in each workspace.
 *
 * Synchronous on purpose. Every path in this module resolves through
 * `workspaceRoot`, which is used by synchronous callers too, and an async
 * lookup there would change every signature in the file. The scan is one
 * readdir over a handful of small folders and happens once per process.
 */
function loadDiskMapping(): void {
  if (diskMappingLoaded) return;
  diskMappingLoaded = true;

  let entries: string[];
  try {
    entries = fsSync.readdirSync(ROOT);
  } catch {
    return; // No workspaces yet.
  }

  for (const name of entries) {
    try {
      const id = fsSync
        .readFileSync(path.join(ROOT, name, MAPPING_FILE), "utf8")
        .trim();
      // Only fill gaps. An explicit setWorkspaceFolderName from the store is
      // the more recent truth and must win over a stale marker.
      if (id && !folderNames.has(id) && /^[\w-]{1,128}$/.test(id)) {
        folderNames.set(id, name);
      }
    } catch {
      // Not a workspace, or no marker — nothing to recover.
    }
  }
}

/** Record which id a folder belongs to, so a cold process can find it again. */
async function writeMarker(workspaceId: string, root: string): Promise<void> {
  try {
    await fs.writeFile(path.join(root, MAPPING_FILE), workspaceId, "utf8");
  } catch {
    // Best effort: the in-memory map still works for this process.
  }
}

/** Called by the chat store when it names or renames a conversation. */
export function setWorkspaceFolderName(
  workspaceId: string,
  folder: string
): void {
  if (/^[\w-]{1,128}$/.test(workspaceId) && /^[\w-]{1,128}$/.test(folder)) {
    const previous = folderNames.get(workspaceId);
    if (previous && previous !== folder) verifiedFolders.delete(previous);
    folderNames.set(workspaceId, folder);

    // Keep the marker in step, or a restart would resurrect the old name.
    // Only if the folder is already there — writing it would otherwise
    // create an empty workspace for a chat that has no files yet, which is
    // the "reading must not create" rule listFiles exists to honour.
    void fs
      .access(path.join(ROOT, folder))
      .then(() =>
        fs.writeFile(path.join(ROOT, folder, MAPPING_FILE), workspaceId, "utf8")
      )
      .catch(() => {});
  }
}

/**
 * Folders confirmed to exist, so the check below costs one stat per folder
 * per process rather than one per file operation.
 */
const verifiedFolders = new Set<string>();

export function workspaceFolderName(workspaceId: string): string {
  const known = folderNames.get(workspaceId);

  if (known) {
    // A cached name can go stale: another process may have renamed the
    // folder when the chat was titled. Pointing at a folder that no longer
    // exists reports the workspace as empty, which looks exactly like the
    // bug this map was added to fix.
    if (verifiedFolders.has(known)) return known;
    if (fsSync.existsSync(path.join(ROOT, known))) {
      verifiedFolders.add(known);
      return known;
    }

    // The name does not exist on disk. That is normal and correct for a
    // workspace nobody has written to yet — the chat store names the folder
    // before any file is created, and honouring that name is how the first
    // write lands in the right place. It is only wrong if the files turn up
    // somewhere else, so look for a folder that claims this id and prefer
    // that; otherwise keep the name we were given.
    const elsewhere = findFolderOnDisk(workspaceId);
    if (elsewhere && elsewhere !== known) {
      folderNames.set(workspaceId, elsewhere);
      return elsewhere;
    }
    return known;
  }

  // Cold process: recover the mapping from disk before falling back to the
  // raw id, which is what used to split one workspace across two folders.
  loadDiskMapping();
  const recovered = folderNames.get(workspaceId);
  if (recovered) return recovered;

  // About to fall back to the raw id. That is right for a workspace nobody
  // has created yet, but wrong if this id was renamed by another process
  // since the last scan — the id-named folder is gone and the files sit
  // under the new name. Only worth rescanning when the fallback itself does
  // not exist, so the common path still costs nothing.
  if (!fsSync.existsSync(path.join(ROOT, workspaceId))) {
    const found = findFolderOnDisk(workspaceId);
    if (found) {
      folderNames.set(workspaceId, found);
      return found;
    }
  }

  return workspaceId;
}

/** Rescan for the folder whose marker claims this id. */
function findFolderOnDisk(workspaceId: string): string | null {
  diskMappingLoaded = false;
  const before = folderNames.get(workspaceId);
  folderNames.delete(workspaceId);
  loadDiskMapping();
  const found = folderNames.get(workspaceId) ?? null;
  // loadDiskMapping only fills gaps, so restore what was there if the scan
  // found nothing — the caller decides whether to keep using it.
  if (!found && before) folderNames.set(workspaceId, before);
  return found;
}

/**
 * Move everything in `src` into `dest`, then remove `src`.
 *
 * Used when a workspace ended up split across two folders. Existing files in
 * `dest` win: they are the ones the chat has been using, and silently
 * overwriting them with an older copy would be worse than skipping.
 */
async function mergeInto(src: string, dest: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(src, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await fs.mkdir(to, { recursive: true }).catch(() => {});
      await mergeInto(from, to);
      continue;
    }

    // Never clobber a file the chat is already using.
    const taken = await fs
      .access(to)
      .then(() => true)
      .catch(() => false);
    if (taken) continue;

    await fs.rename(from, to).catch(() => {});
  }

  // Only succeeds once everything has been moved out, which is the check we
  // want: a leftover file means something was skipped and is worth keeping.
  await fs.rmdir(src).catch(() => {});
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

  // Does the destination already exist? A plain rename onto a non-empty
  // directory fails, and that failure is the second half of the vanishing
  // upload: the chat already had a slug folder, the zip landed in a
  // uuid-named one, and moving the second onto the first was refused — so
  // the files stayed somewhere nothing would ever look again.
  const destExists = await fs
    .access(dest)
    .then(() => true)
    .catch(() => false);

  try {
    if (destExists) {
      // Fold the stray folder into the real one instead of giving up.
      await mergeInto(src, dest);
    } else {
      // History and snapshots live inside the folder now, so they move with it.
      await fs.rename(src, dest);
    }
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

  // The old name is gone, so anything that cached it as "exists" is wrong.
  verifiedFolders.delete(from);
  verifiedFolders.delete(to);

  for (const [id, folder] of folderNames) {
    if (folder === from) folderNames.set(id, to);
  }

  // The marker travelled with the folder, but it may name the id whose
  // mapping just changed — rewrite it so a cold process agrees.
  for (const [id, folder] of folderNames) {
    if (folder === to) {
      await fs
        .writeFile(path.join(dest, MAPPING_FILE), id, "utf8")
        .catch(() => {});
      break;
    }
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

export async function ensureRoot(workspaceId: string): Promise<string> {
  const root = workspaceRoot(workspaceId);
  await fs.mkdir(root, { recursive: true });
  await migrateLayout(root);
  // Stamp the folder with the id that owns it. This is what lets a later,
  // colder process resolve the same id to the same folder instead of
  // inventing a second one next to it.
  await writeMarker(workspaceId, root);
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
  // Machine-maintained analysis ledger; injected via the system prompt, never
  // listed as a user file or read back as source.
  ".analysis",
  // Bookkeeping, not the user's file — it must never reach the model or the
  // file panel, or every workspace would appear to contain a stray dotfile.
  MAPPING_FILE,
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

    /*
     * Directories in order, files all at once.
     *
     * Every file needed its own `stat`, and awaiting them one after another
     * turned a 600-file workspace into 600 sequential syscalls — 51ms per
     * listing, and this runs whenever the panel refreshes. The calls do not
     * depend on each other, so waiting for each before starting the next was
     * pure latency.
     *
     * Subdirectories are still walked in order, which keeps the recursion
     * bounded rather than fanning out across a whole tree at once.
     */
    const files: string[] = [];

    for (const entry of entries) {
      if (out.length >= MAX_FILES_PER_WORKSPACE) return;
      if (IGNORED.has(entry.name)) continue;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }

    const stats = await Promise.all(
      files.map((full) =>
        fs
          .stat(full)
          .then((stat) => ({ full, stat }))
          // Vanished between readdir and stat — skip it rather than failing
          // the whole listing.
          .catch(() => null)
      )
    );

    for (const found of stats) {
      if (!found) continue;
      if (out.length >= MAX_FILES_PER_WORKSPACE) return;
      out.push({
        path: path.relative(root, found.full).split(path.sep).join("/"),
        size: found.stat.size,
        modifiedAt: found.stat.mtime.toISOString(),
      });
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
  /** Lines immediately before the hit, when context was requested. */
  before?: string[];
  /** Lines immediately after it. */
  after?: string[];
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
/**
 * A simple glob, compiled once.
 *
 * `*` matches anything and `?` matches one character, which is enough for
 * "*.py" or "src/*" without pulling in a dependency. Shared by search and by
 * read_files so a pattern that selects files in one selects the same files in
 * the other — a glob that quietly means two different things is worse than no
 * glob at all.
 */
export function globPattern(glob?: string | null): RegExp | null {
  if (!glob?.trim()) return null;
  const escaped = glob
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp(`^${escaped}$`, "i");
  } catch {
    return null;
  }
}

/** Does this look like a pattern rather than one literal path? */
export function looksLikeGlob(value: string): boolean {
  return /[*?]/.test(value);
}

export async function searchFiles(
  workspaceId: string,
  query: string,
  options: {
    regex?: boolean;
    caseSensitive?: boolean;
    glob?: string;
    /** Lines of surrounding code to include with each hit. */
    context?: number;
    /** Override the default hit cap (Ox Alpha lifts this). */
    maxHits?: number;
    /** Override the per-file size skip (Ox Alpha lifts this). */
    maxFileBytes?: number;
  } = {}
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

  const globRe = globPattern(options.glob);

  const files = await listFiles(workspaceId);
  const hits: SearchHit[] = [];
  let filesSearched = 0;
  let truncated = false;
  const hitCap = options.maxHits ?? MAX_SEARCH_HITS;
  const fileCap = options.maxFileBytes ?? MAX_SEARCHABLE_BYTES;

  for (const file of files) {
    if (hits.length >= hitCap) {
      truncated = true;
      break;
    }
    if (globRe && !globRe.test(file.path)) continue;
    // Skip anything large enough to be data rather than source; reading it
    // would cost more than the match is worth.
    if (file.size > fileCap) continue;

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
    /*
     * Surrounding lines, when asked for.
     *
     * A bare matching line often is not enough to decide anything: `return
     * null;` tells you nothing without the `if` above it, so the agent had to
     * spend a second round reading the file to find out whether the hit was
     * the one it wanted. Two or three lines either side usually answers the
     * question in the search result itself, and one extra round costs far
     * more than a few lines of text.
     */
    const context = Math.max(0, Math.min(10, options.context ?? 0));

    for (let i = 0; i < lines.length; i++) {
      if (!matcher(lines[i])) continue;
      const hit: SearchHit = {
        path: file.path,
        line: i + 1,
        // Trim so one minified line can't dominate the entire result.
        text: lines[i].trim().slice(0, 200),
      };
      if (context > 0) {
        hit.before = lines
          .slice(Math.max(0, i - context), i)
          .map((l) => l.slice(0, 200));
        hit.after = lines
          .slice(i + 1, Math.min(lines.length, i + 1 + context))
          .map((l) => l.slice(0, 200));
      }
      hits.push(hit);
      if (hits.length >= hitCap) {
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
  relative: string,
  options: { maxChars?: number } = {}
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
  const maxChars = options.maxChars ?? MAX_READ_CHARS;

  const kind = documentKind(relative);
  if (kind) {
    try {
      const doc = await readDocument(
        kind,
        new Uint8Array(await fs.readFile(target)),
        { maxChars }
      );
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
  const truncated = raw.length > maxChars;
  return {
    path: relative,
    content: truncated ? raw.slice(0, maxChars) : raw,
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

/**
 * A previous version of a file. `steps` of 1 is the last write, 2 the one
 * before it, and so on.
 */
export async function previousVersion(
  workspaceId: string,
  relative: string,
  steps = 1
): Promise<string | null> {
  // Validates the path, so a crafted name can't read outside the history dir.
  resolveInside(workspaceId, relative);
  const slot = Math.max(0, Math.min(MAX_HISTORY_VERSIONS - 1, steps - 1));
  try {
    return await fs.readFile(
      historySlotPath(workspaceId, relative, slot),
      "utf8"
    );
  } catch {
    return null;
  }
}

/**
 * How many previous versions of a file are kept.
 *
 * One was not enough, and the shortfall showed up in a specific way: the
 * agent edits a file, the edit is wrong, it edits again to fix it, that is
 * also wrong — and now undo_file can only reach the second attempt. The
 * version the user actually wants back is gone.
 *
 * Ten is far more than a single reply ever writes to one file, and the cost
 * is a few kilobytes of text per file in a hidden folder.
 */
export const MAX_HISTORY_VERSIONS = 10;

/** Path of the Nth previous version. 0 is the most recent. */
function historySlotPath(
  workspaceId: string,
  relative: string,
  slot: number
): string {
  const base = historyPathFor(workspaceId, relative);
  return slot === 0 ? base : `${base}.${slot}`;
}

/**
 * Records the current contents before they are overwritten.
 *
 * Versions shift down a slot each time, so `.prev` is always the most recent
 * and `.prev.9` the oldest. Shifting rather than appending keeps the naming
 * stable, which matters because the original single-slot layout is still on
 * disk in existing workspaces — `.prev` means the same thing it always did,
 * so nothing has to be migrated.
 */
async function saveHistory(
  workspaceId: string,
  relative: string,
  target: string
): Promise<void> {
  try {
    const current = await fs.readFile(target, "utf8");
    const dest = historyPathFor(workspaceId, relative);
    await fs.mkdir(path.dirname(dest), { recursive: true });

    // Shift older versions down, oldest first so nothing is overwritten
    // before it has been moved.
    for (let slot = MAX_HISTORY_VERSIONS - 1; slot >= 0; slot--) {
      const from = historySlotPath(workspaceId, relative, slot);
      const to = historySlotPath(workspaceId, relative, slot + 1);
      try {
        await fs.rename(from, to);
      } catch {
        // That slot does not exist yet, which is normal for a young file.
      }
    }

    await fs.writeFile(dest, current, "utf8");

    // Drop anything that fell off the end.
    await fs
      .rm(historySlotPath(workspaceId, relative, MAX_HISTORY_VERSIONS), {
        force: true,
      })
      .catch(() => {});
  } catch {
    // No existing file, or it isn't text. Either way there is nothing worth
    // keeping, and failing to save history must never block the write.
  }
}

/** How many previous versions are available for a file. */
export async function historyDepth(
  workspaceId: string,
  relative: string
): Promise<number> {
  resolveInside(workspaceId, relative);
  let depth = 0;
  for (let slot = 0; slot < MAX_HISTORY_VERSIONS; slot++) {
    try {
      await fs.access(historySlotPath(workspaceId, relative, slot));
      depth++;
    } catch {
      break;
    }
  }
  return depth;
}

/**
 * Reads an image as a data URL, for the vision model.
 *
 * Separate from readFile because that decodes UTF-8, which corrupts binary
 * data. Images have to be passed through as bytes.
 */
/**
 * Raw bytes of a workspace file.
 *
 * readFile decodes as UTF-8, which corrupts anything that is not text. A
 * .docx is a zip archive, so reading one through readFile produced mojibake
 * and then failed to parse. The document reader needs the bytes untouched.
 */
export async function readFileBytes(
  workspaceId: string,
  relative: string
): Promise<Uint8Array> {
  const target = resolveInside(workspaceId, relative);

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new WorkspaceError(`No such file: ${relative}`);
  }
  if (!stat.isFile()) {
    throw new WorkspaceError(`${relative} is not a file`);
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new WorkspaceError(`${relative} is too large to read`);
  }

  return new Uint8Array(await fs.readFile(target));
}

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

/**
 * Write raw bytes.
 *
 * `writeFile` takes a string, which is correct for source code and wrong for
 * anything else: a PNG round-tripped through a UTF-8 string is corrupt by the
 * time it reaches disk. Screenshots need this; so would any future tool that
 * saves an image or an archive.
 *
 * Shares the same containment and size rules — `resolveInside` is what stops
 * a path escaping the workspace, and it is applied here identically.
 */
export async function writeFileBytes(
  workspaceId: string,
  relative: string,
  data: Buffer
): Promise<{ path: string; bytes: number }> {
  await ensureRoot(workspaceId);
  const target = resolveInside(workspaceId, relative);

  if (!Buffer.isBuffer(data)) {
    throw new WorkspaceError("Binary content must be a Buffer");
  }
  if (data.byteLength > MAX_FILE_BYTES) {
    throw new WorkspaceError("File is too large to write");
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
  return { path: relative, bytes: data.byteLength };
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

  const match = findEditTarget(raw, oldText);

  if (match.kind === "none") {
    throw new WorkspaceError(
      `old_text not found in ${relative} — read the file first and copy the exact text`
    );
  }
  if (match.kind === "ambiguous") {
    throw new WorkspaceError(
      `old_text appears more than once in ${relative} — include surrounding lines to make it unique`
    );
  }

  const updated =
    raw.slice(0, match.start) +
    // Re-indent the replacement by however much the match was shifted, so a
    // whitespace-tolerant match does not flatten the file it lands in.
    (match.indent ? reindent(newText, match.indent) : newText) +
    raw.slice(match.end);
  await writeFile(workspaceId, relative, updated);
  return { path: relative, replaced: true };
}

/**
 * Find where an edit should land, tolerating whitespace differences.
 *
 * Measured, not assumed: `edit_file` was the least reliable of the file tools
 * at roughly 90%, and every failure looked the same — "old_text not found",
 * on a file the model had just read. The cause is that a model reproducing a
 * snippet from context reliably gets the *characters* right and unreliably
 * gets the *indentation* right, especially after the snippet has been through
 * a diff view or its own summary. A four-space body copied back as two spaces
 * is not a wrong edit; it is the right edit written slightly differently, and
 * refusing it costs a full round to re-read and try again.
 *
 * Three passes, strictest first, so exact matches behave exactly as before:
 *
 *   1. Exact substring. Unchanged semantics, including the duplicate check.
 *   2. Line-by-line with each line's leading whitespace ignored. Catches the
 *      re-indented copy, which is the overwhelmingly common failure.
 *   3. Line-by-line with all internal whitespace collapsed. Catches
 *      `foo( a, b )` against `foo(a, b)`.
 *
 * Every pass still refuses an ambiguous match. Tolerance here means accepting
 * a differently-formatted description of ONE place in the file; it never
 * means guessing between two candidates.
 */
type EditMatch =
  | { kind: "exact"; start: number; end: number; indent: string }
  | { kind: "fuzzy"; start: number; end: number; indent: string }
  | { kind: "none" }
  | { kind: "ambiguous" };

function findEditTarget(raw: string, oldText: string): EditMatch {
  // --- Pass 1: exactly as written -----------------------------------------
  const first = raw.indexOf(oldText);
  if (first !== -1) {
    if (raw.indexOf(oldText, first + oldText.length) !== -1) {
      return { kind: "ambiguous" };
    }
    return {
      kind: "exact",
      start: first,
      end: first + oldText.length,
      indent: "",
    };
  }

  const fileLines = raw.split("\n");
  const wanted = oldText.split("\n");
  // A trailing newline in old_text produces an empty final element that would
  // never match a real line.
  while (wanted.length > 1 && wanted[wanted.length - 1].trim() === "") {
    wanted.pop();
  }
  if (wanted.length === 0) return { kind: "none" };

  // Offset of the start of each line, so a line index can become a character
  // index without re-scanning the file.
  const lineStarts: number[] = [];
  let at = 0;
  for (const line of fileLines) {
    lineStarts.push(at);
    at += line.length + 1;
  }

  const attempt = (normalise: (s: string) => string): EditMatch => {
    const target = wanted.map(normalise);
    const found: { start: number; end: number; indent: string }[] = [];

    for (let i = 0; i + target.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < target.length; j++) {
        if (normalise(fileLines[i + j]) !== target[j]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      const start = lineStarts[i];
      const lastIndex = i + target.length - 1;
      const end = lineStarts[lastIndex] + fileLines[lastIndex].length;
      // Whatever the file indents this block by — the replacement is shifted
      // to match it.
      const indent = /^[ \t]*/.exec(fileLines[i])?.[0] ?? "";
      found.push({ start, end, indent });
      if (found.length > 1) return { kind: "ambiguous" };
    }

    if (found.length === 1) {
      return { kind: "fuzzy", ...found[0] };
    }
    return { kind: "none" };
  };

  // --- Pass 2: same lines, different indentation ---------------------------
  const trimmed = attempt((s) => s.trim());
  if (trimmed.kind !== "none") return trimmed;

  /*
   * Pass 3: same tokens, different spacing.
   *
   * Collapsing runs of whitespace is not enough on its own — `add( a , b )`
   * and `add(a, b)` still differ, because the spaces sit *next to
   * punctuation* rather than between words. Dropping whitespace that is
   * adjacent to a non-word character handles that, while spaces between two
   * words (`return a`, `else if`) are preserved, since removing those would
   * make genuinely different code compare equal.
   */
  return attempt((s) =>
    s
      .trim()
      .replace(/\s+/g, " ")
      .replace(/\s*([^\w\s])\s*/g, "$1")
  );
}

/**
 * Shift a replacement block to a given indentation.
 *
 * The model wrote its replacement against the indentation it *thought* the
 * file had. Inserting that verbatim where the file is indented differently
 * produces valid-looking output that is wrong in Python and ugly everywhere
 * else. The block's own internal relative indentation is preserved; only the
 * common leading whitespace is replaced.
 */
function reindent(text: string, indent: string): string {
  const lines = text.split("\n");
  const meaningful = lines.filter((l) => l.trim().length > 0);
  if (meaningful.length === 0) return text;

  let common: string | null = null;
  for (const line of meaningful) {
    const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (common === null || lead.length < common.length) common = lead;
  }
  const base = common ?? "";

  return lines
    .map((line) =>
      line.trim().length === 0
        ? line
        : indent + (line.startsWith(base) ? line.slice(base.length) : line.trimStart())
    )
    .join("\n");
}

/**
 * Move or rename a file inside the workspace.
 *
 * Without this the agent had to read, write and delete — three round trips
 * for one filesystem operation, each resending the whole conversation. A
 * rename during a refactor is common enough that the cost was a steady tax
 * for no reason.
 *
 * Both paths go through resolveInside, so neither the source nor the
 * destination can point outside the workspace.
 */
export async function moveFile(
  workspaceId: string,
  from: string,
  to: string
): Promise<{ from: string; to: string; bytes: number }> {
  const source = resolveInside(workspaceId, from);
  const destination = resolveInside(workspaceId, to);

  if (source === destination) {
    throw new WorkspaceError("The source and destination are the same file");
  }

  let stat;
  try {
    stat = await fs.stat(source);
  } catch {
    throw new WorkspaceError(`No such file: ${from}`);
  }
  if (!stat.isFile()) {
    throw new WorkspaceError(`${from} is not a file`);
  }

  // Refuse rather than clobber. Overwriting silently is how a rename loses
  // the file it was supposed to preserve, and the model can delete first if
  // that is genuinely what it means.
  const occupied = await fs
    .access(destination)
    .then(() => true)
    .catch(() => false);
  if (occupied) {
    throw new WorkspaceError(
      `${to} already exists — delete it first if you mean to replace it`
    );
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });

  try {
    await fs.rename(source, destination);
  } catch {
    // Across devices rename fails; copy and unlink is the fallback.
    await fs.copyFile(source, destination);
    await fs.unlink(source).catch(() => {});
  }

  return { from, to, bytes: stat.size };
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

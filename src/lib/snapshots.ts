import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { listFiles, resolveInside, workspaceDirectory } from "@/lib/workspace";

/**
 * Point-in-time copies of a whole workspace.
 *
 * Per-file undo only goes back one step, which is useless when a reply
 * refactored four files and got it wrong — undoing each one individually is
 * not the same as putting everything back. A snapshot before each reply gives
 * "return to how it was before that message".
 *
 * Stored as plain copies rather than diffs: a workspace is capped at 500
 * files of 2MB, so the space is bounded, and a restore that cannot fail
 * halfway is worth more than the saved bytes.
 */

/** Enough to undo a bad session without growing without limit. */
export const MAX_SNAPSHOTS = 20;

export interface SnapshotInfo {
  id: string;
  label: string;
  createdAt: string;
  fileCount: number;
  totalBytes: number;
}

interface SnapshotManifest {
  id: string;
  label: string;
  createdAt: string;
  /**
   * `hash` is absent on snapshots taken before content-addressed storage.
   * Those kept a flattened copy inside the snapshot folder, so restore has to
   * handle both shapes or every existing snapshot would break.
   */
  files: { path: string; size: number; hash?: string; mtime?: string }[];
}

function snapshotRoot(workspaceId: string): string {
  // Inside the workspace, so everything for it lives in one folder, but
  // dot-prefixed and listed in INTERNAL_DIRS so it never appears in listings,
  // reaches the model as a real file, or ends up inside another snapshot.
  return path.join(workspaceDirectory(workspaceId), ".snapshots");
}

/**
 * Shared file contents, keyed by hash.
 *
 * Sits beside the snapshots rather than inside any one of them, because the
 * whole point is that several snapshots reference the same object.
 */
function objectDir(workspaceId: string): string {
  return path.join(snapshotRoot(workspaceId), "objects");
}

function snapshotDir(workspaceId: string, snapshotId: string): string {
  if (!/^[\w-]{1,64}$/.test(snapshotId)) {
    throw new Error("Invalid snapshot id");
  }
  return path.join(snapshotRoot(workspaceId), snapshotId);
}

/** Sortable and unique, so listing by name is listing by time. */
function newSnapshotId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Copies the current state of a workspace.
 *
 * Returns null when there is nothing to save — snapshotting an empty
 * workspace before the very first message would just be clutter.
 */
export async function createSnapshot(
  workspaceId: string,
  label: string
): Promise<SnapshotInfo | null> {
  let files;
  try {
    files = await listFiles(workspaceId);
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  const id = newSnapshotId();
  const dir = snapshotDir(workspaceId, id);
  await fs.mkdir(dir, { recursive: true });

  const manifest: SnapshotManifest = {
    id,
    label: label.slice(0, 120),
    createdAt: new Date().toISOString(),
    files: [],
  };

  /*
   * Files are stored once by content hash, not copied per snapshot.
   *
   * Every message takes a snapshot, and a snapshot used to be a full copy of
   * the workspace. Unpack a 200-file zip and each message re-copied all of it
   * — about 90ms and 1.6MB of pure duplication before the model was even
   * called, twenty times over for twenty snapshots.
   *
   * Almost nothing changes between two consecutive messages, so the same
   * bytes were being written again and again. Hashing the content means an
   * unchanged file is stored once and simply referenced by every snapshot
   * that contains it. Restores are unaffected: the manifest still names every
   * file, it just points at shared content.
   */
  const objects = objectDir(workspaceId);
  await fs.mkdir(objects, { recursive: true });

  /*
   * Reuse the previous snapshot's hash when a file has not been touched.
   *
   * Hashing still requires reading every byte, so without this a snapshot of
   * an unchanged 200-file project costs a full re-read even though it writes
   * nothing. Size and modification time together are what every build tool
   * uses to decide a file is unchanged, and the cost of being wrong here is
   * bounded: a snapshot would reference slightly stale content, not corrupt
   * anything.
   */
  const previous = new Map<string, { hash: string; size: number; mtime: string }>();
  try {
    const [latest] = await listSnapshots(workspaceId);
    if (latest) {
      const raw = await fs.readFile(
        path.join(snapshotDir(workspaceId, latest.id), "manifest.json"),
        "utf8"
      );
      for (const f of (JSON.parse(raw) as SnapshotManifest).files) {
        if (f.hash && f.mtime) {
          previous.set(f.path, { hash: f.hash, size: f.size, mtime: f.mtime });
        }
      }
    }
  } catch {
    // No usable previous snapshot; every file gets hashed the slow way.
  }

  for (const file of files) {
    try {
      const unchanged = previous.get(file.path);
      if (
        unchanged &&
        unchanged.size === file.size &&
        unchanged.mtime === file.modifiedAt
      ) {
        // Same size, same mtime, and the content is already in the store.
        const stored = path.join(objects, unchanged.hash);
        try {
          await fs.access(stored);
          manifest.files.push({
            path: file.path,
            size: file.size,
            hash: unchanged.hash,
            mtime: file.modifiedAt,
          });
          continue;
        } catch {
          // The object was swept or lost — fall through and rewrite it.
        }
      }

      const data = await fs.readFile(resolveInside(workspaceId, file.path));
      const hash = createHash("sha256").update(data).digest("hex");
      const stored = path.join(objects, hash);

      // Written only if this exact content has never been seen. Two files
      // with identical contents also share one object, which is common in a
      // project full of small config and index files.
      try {
        await fs.access(stored);
      } catch {
        // Same write-then-rename as everywhere else: a half-written object
        // would be silently wrong, and every snapshot referencing that hash
        // would restore corrupt data.
        const tmp = `${stored}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        await fs.writeFile(tmp, data);
        await fs.rename(tmp, stored);
      }

      manifest.files.push({
        path: file.path,
        size: data.length,
        hash,
        mtime: file.modifiedAt,
      });
    } catch {
      // Skip anything unreadable rather than abandoning the whole snapshot.
    }
  }

  if (manifest.files.length === 0) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    return null;
  }

  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );

  await pruneSnapshots(workspaceId);

  return {
    id,
    label: manifest.label,
    createdAt: manifest.createdAt,
    fileCount: manifest.files.length,
    totalBytes: manifest.files.reduce((n, f) => n + f.size, 0),
  };
}

export async function listSnapshots(
  workspaceId: string
): Promise<SnapshotInfo[]> {
  const root = snapshotRoot(workspaceId);

  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }

  const out: SnapshotInfo[] = [];
  for (const name of names) {
    try {
      const raw = await fs.readFile(
        path.join(root, name, "manifest.json"),
        "utf8"
      );
      const manifest = JSON.parse(raw) as SnapshotManifest;
      out.push({
        id: manifest.id,
        label: manifest.label,
        createdAt: manifest.createdAt,
        fileCount: manifest.files.length,
        totalBytes: manifest.files.reduce((n, f) => n + f.size, 0),
      });
    } catch {
      // A directory without a readable manifest isn't a snapshot.
    }
  }

  // Newest first: the one you want back is almost always the most recent.
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

/**
 * Puts the workspace back to a snapshot.
 *
 * Takes a snapshot of the current state first, so restoring is itself
 * undoable — otherwise a mistaken restore destroys work with no way back.
 */
export async function restoreSnapshot(
  workspaceId: string,
  snapshotId: string
): Promise<{ restored: number; removed: number }> {
  const dir = snapshotDir(workspaceId, snapshotId);

  const raw = await fs.readFile(path.join(dir, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw) as SnapshotManifest;

  await createSnapshot(workspaceId, "Before restoring");

  // Delete files that did not exist at snapshot time. Without this a restore
  // leaves behind anything created since, which is not "how it was".
  const wanted = new Set(manifest.files.map((f) => f.path));
  let removed = 0;
  for (const file of await listFiles(workspaceId)) {
    if (wanted.has(file.path)) continue;
    try {
      await fs.unlink(resolveInside(workspaceId, file.path));
      removed++;
    } catch {
      /* already gone */
    }
  }

  let restored = 0;
  for (const file of manifest.files) {
    try {
      // Content-addressed when the snapshot has a hash; the old flattened
      // copy otherwise. Both shapes have to work, or upgrading the app would
      // quietly break every snapshot taken before it.
      const data = await fs.readFile(
        file.hash
          ? path.join(objectDir(workspaceId), file.hash)
          : path.join(dir, encodeURIComponent(file.path))
      );
      const target = resolveInside(workspaceId, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
      restored++;
    } catch {
      /* skip rather than abandon the rest */
    }
  }

  return { restored, removed };
}

export async function deleteSnapshot(
  workspaceId: string,
  snapshotId: string
): Promise<boolean> {
  try {
    await fs.rm(snapshotDir(workspaceId, snapshotId), {
      recursive: true,
      force: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** Drops the oldest snapshots once there are too many. */
export async function pruneSnapshots(workspaceId: string): Promise<void> {
  const all = await listSnapshots(workspaceId);
  for (const snapshot of all.slice(MAX_SNAPSHOTS)) {
    await deleteSnapshot(workspaceId, snapshot.id);
  }
  await collectGarbage(workspaceId);
}

/**
 * Delete file contents no surviving snapshot refers to.
 *
 * Shared objects outlive the snapshot that created them, so deleting a
 * snapshot cannot delete its files — another may still need them. Without a
 * sweep the object store would only ever grow, which would trade one disk
 * problem for a subtler one.
 *
 * Mark-and-sweep rather than reference counting: counts drift when a write is
 * interrupted, and a drifted count either leaks forever or, far worse, frees
 * an object a snapshot still needs. Reading the manifests is authoritative.
 */
async function collectGarbage(workspaceId: string): Promise<void> {
  const objects = objectDir(workspaceId);

  let stored: string[];
  try {
    stored = await fs.readdir(objects);
  } catch {
    return; // No object store yet.
  }

  const live = new Set<string>();
  for (const snapshot of await listSnapshots(workspaceId)) {
    try {
      const raw = await fs.readFile(
        path.join(snapshotDir(workspaceId, snapshot.id), "manifest.json"),
        "utf8"
      );
      for (const file of (JSON.parse(raw) as SnapshotManifest).files) {
        if (file.hash) live.add(file.hash);
      }
    } catch {
      // An unreadable manifest means unknown references. Abort the sweep
      // rather than risk deleting something it needed — leaked bytes are
      // recoverable, a broken restore is not.
      return;
    }
  }

  for (const name of stored) {
    // Leftover temp files from an interrupted write are always safe to drop.
    if (name.endsWith(".tmp")) {
      await fs.unlink(path.join(objects, name)).catch(() => {});
      continue;
    }
    if (!live.has(name)) {
      await fs.unlink(path.join(objects, name)).catch(() => {});
    }
  }
}

/** Removes every snapshot, for when a conversation is deleted. */
export async function deleteAllSnapshots(workspaceId: string): Promise<void> {
  try {
    await fs.rm(snapshotRoot(workspaceId), { recursive: true, force: true });
  } catch {
    /* nothing to remove */
  }
}

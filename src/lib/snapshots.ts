import { promises as fs } from "node:fs";
import path from "node:path";
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
  files: { path: string; size: number }[];
}

function snapshotRoot(workspaceId: string): string {
  // Beside the workspace, not inside it — otherwise snapshots would appear in
  // listings, be fed to the model as real files, and end up inside each other.
  return `${workspaceDirectory(workspaceId)}.snapshots`;
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

  for (const file of files) {
    try {
      const data = await fs.readFile(resolveInside(workspaceId, file.path));
      // Flattened so nested directories don't need recreating; the real path
      // lives in the manifest.
      const stored = path.join(dir, encodeURIComponent(file.path));
      await fs.writeFile(stored, data);
      manifest.files.push({ path: file.path, size: data.length });
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
      const data = await fs.readFile(
        path.join(dir, encodeURIComponent(file.path))
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
}

/** Removes every snapshot, for when a conversation is deleted. */
export async function deleteAllSnapshots(workspaceId: string): Promise<void> {
  try {
    await fs.rm(snapshotRoot(workspaceId), { recursive: true, force: true });
  } catch {
    /* nothing to remove */
  }
}

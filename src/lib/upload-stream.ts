/**
 * Stream a request body into a workspace file with a hard byte cap.
 *
 * Shared by every upload route. The body goes to a temp file on the same
 * volume and is renamed into place only once it is complete and within the
 * cap, so a dropped connection or an oversized upload never leaves half a
 * file where the agent would read it.
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { ensureRoot, resolveInside, workspaceDirectory, WorkspaceError } from "@/lib/workspace";

export class UploadTooLarge extends Error {}

/** Next free name: `a.json`, `a-2.json`, `a-3.json`… */
export async function freeName(workspaceId: string, rel: string): Promise<string> {
  const ext = path.posix.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? rel : `${stem}-${n}${ext}`;
    try {
      await stat(resolveInside(workspaceId, candidate));
    } catch {
      return candidate;
    }
  }
  throw new WorkspaceError(`Too many files named like ${rel}`);
}

export async function streamToWorkspace(
  body: ReadableStream<Uint8Array>,
  workspaceId: string,
  target: string,
  maxBytes: number,
  check?: (tmpPath: string) => Promise<void>
): Promise<{ path: string; bytes: number }> {
  await ensureRoot(workspaceId);
  const dest = resolveInside(workspaceId, target);
  await mkdir(path.dirname(dest), { recursive: true });
  const tmpPath = path.join(
    workspaceDirectory(workspaceId),
    `.upload-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  );
  let received = 0;
  const writer = createWriteStream(tmpPath);
  const reader = body.getReader();
  let tooLarge = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        tooLarge = true;
        break;
      }
      await new Promise<void>((resolve, reject) =>
        writer.write(value, (err) => (err ? reject(err) : resolve()))
      );
    }
  } catch (e) {
    reader.releaseLock();
    await new Promise<void>((resolve) => writer.end(resolve));
    await unlink(tmpPath).catch(() => {});
    throw e;
  }
  reader.releaseLock();
  await new Promise<void>((resolve) => writer.end(resolve));
  if (tooLarge) {
    await unlink(tmpPath).catch(() => {});
    throw new UploadTooLarge(
      `${path.basename(target)} is larger than the ${Math.round(maxBytes / 1024 / 1024)}MB upload limit.`
    );
  }
  try {
    await check?.(tmpPath);
  } catch (e) {
    await unlink(tmpPath).catch(() => {});
    throw e;
  }
  await rename(tmpPath, dest);
  return { path: target, bytes: received };
}

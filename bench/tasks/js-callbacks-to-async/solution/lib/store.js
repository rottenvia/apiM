import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NotFoundError, ValidationError } from "./errors.js";
import { parseRecord } from "./parse.js";

const ID = /^[\w-]+$/;

/** Resolves to the parsed record; rejects with NotFoundError if there is no such record. */
export async function readRecord(dir, id) {
  if (!ID.test(id)) throw new ValidationError(`bad id: ${id}`);
  let text;
  try {
    text = await readFile(path.join(dir, `${id}.json`), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") throw new NotFoundError(id);
    throw err;
  }
  return parseRecord(text);
}

/** Atomically writes data as <dir>/<id>.json. */
export async function writeRecord(dir, id, data) {
  if (!ID.test(id)) throw new ValidationError(`bad id: ${id}`);
  const file = path.join(dir, `${id}.json`);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  try {
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Ids of the records in dir, sorted: every "<id>.json" file except the ones
 * whose name starts with "_" (those are ours, e.g. _report.json).
 */
export async function listIds(dir) {
  const names = await readdir(dir);
  return names
    .filter((n) => n.endsWith(".json") && !n.startsWith("_"))
    .map((n) => n.slice(0, -".json".length))
    .sort();
}

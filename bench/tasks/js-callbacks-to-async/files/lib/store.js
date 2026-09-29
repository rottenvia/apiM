import fs from "node:fs";
import path from "node:path";
import { NotFoundError, ValidationError } from "./errors.js";
import { parseRecord } from "./parse.js";

const ID = /^[\w-]+$/;

/** callback(err, record) — NotFoundError if there is no such record. */
export function readRecord(dir, id, callback) {
  if (!ID.test(id)) return callback(new ValidationError(`bad id: ${id}`));
  fs.readFile(path.join(dir, `${id}.json`), "utf8", (err, text) => {
    if (err) {
      if (err.code === "ENOENT") return callback(new NotFoundError(id));
      return callback(err);
    }
    parseRecord(text, callback);
  });
}

/** Atomically writes data as <dir>/<id>.json. callback(err) */
export function writeRecord(dir, id, data, callback) {
  if (!ID.test(id)) return callback(new ValidationError(`bad id: ${id}`));
  const file = path.join(dir, `${id}.json`);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", (err) => {
    if (err) return callback(err);
    fs.rename(tmp, file, (err2) => {
      if (err2) {
        fs.unlink(tmp, () => callback(err2));
        return;
      }
      callback(null);
    });
  });
}

/**
 * Ids of the records in dir, sorted: every "<id>.json" file except the ones
 * whose name starts with "_" (those are ours, e.g. _report.json).
 * callback(err, ids)
 */
export function listIds(dir, callback) {
  fs.readdir(dir, (err, names) => {
    if (err) return callback(err);
    const ids = names
      .filter((n) => n.endsWith(".json") && !n.startsWith("_"))
      .map((n) => n.slice(0, -".json".length))
      .sort();
    callback(null, ids);
  });
}

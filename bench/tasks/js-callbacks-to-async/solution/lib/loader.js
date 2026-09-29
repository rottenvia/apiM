import { listIds, readRecord } from "./store.js";
import { mapLimit } from "./pool.js";

/**
 * Reads and validates every record in dir, at most `concurrency` files at a
 * time. Resolves to the records in id order.
 */
export async function loadAll(dir, { concurrency = 4 } = {}) {
  const ids = await listIds(dir);
  return mapLimit(ids, concurrency, (id) => readRecord(dir, id));
}

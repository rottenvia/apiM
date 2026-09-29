import { listIds, readRecord } from "./store.js";
import { mapLimit } from "./pool.js";

/**
 * Reads and validates every record in dir, at most `concurrency` files at a
 * time. callback(err, records) with records in id order.
 */
export function loadAll(dir, { concurrency = 4 } = {}, callback) {
  listIds(dir, (err, ids) => {
    if (err) return callback(err);
    mapLimit(ids, concurrency, (id, _index, cb) => readRecord(dir, id, cb), callback);
  });
}

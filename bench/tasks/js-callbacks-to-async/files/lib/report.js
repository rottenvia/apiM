import { loadAll } from "./loader.js";
import { writeRecord } from "./store.js";
import { withRetry } from "./retry.js";

function summarize(records) {
  const byCategory = new Map();
  let totalCents = 0;
  for (const r of records) {
    totalCents += r.amountCents;
    const c = byCategory.get(r.category) ?? { category: r.category, count: 0, totalCents: 0 };
    c.count++;
    c.totalCents += r.amountCents;
    byCategory.set(r.category, c);
  }
  const categories = [...byCategory.values()].sort(
    (a, b) => b.totalCents - a.totalCents || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0),
  );
  return { count: records.length, totalCents, categories, ids: records.map((r) => r.id) };
}

/**
 * Loads every record in dir, summarizes them, saves the summary as
 * <dir>/_report.json (retrying the write if it fails) and returns it.
 * callback(err, report)
 */
export function buildReport(dir, { concurrency = 4, writeRetries = 2 } = {}, callback) {
  loadAll(dir, { concurrency }, (err, records) => {
    if (err) return callback(err);
    const report = summarize(records);
    withRetry((cb) => writeRecord(dir, "_report", report, cb), { retries: writeRetries, delayMs: 20 }, (err2) => {
      if (err2) return callback(err2);
      callback(null, report);
    });
  });
}

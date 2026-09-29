// Example / smoke test: node example.js
import path from "node:path";
import { buildReport, readRecord, withRetry, mapLimit } from "./index.js";

const dir = path.join(import.meta.dirname, "samples");
const money = (cents) => (cents / 100).toFixed(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let report;
try {
  report = await buildReport(dir, { concurrency: 2 });
} catch (err) {
  console.error("report failed:", err.message);
  process.exit(1);
}
console.log(`records: ${report.count}`);
console.log(`total: ${money(report.totalCents)}`);
for (const c of report.categories) console.log(`  ${c.category}: ${c.count} / ${money(c.totalCents)}`);

try {
  await readRecord(dir, "no-such-record");
  console.log("missing record: found?!");
} catch (err) {
  console.log(`missing record: ${err.name}`);
}

// A flaky operation that fails twice before it works.
let attempts = 0;
const flaky = async () => {
  attempts++;
  await sleep(5);
  if (attempts < 3) throw new Error(`flaky failure ${attempts}`);
  return "ok";
};
try {
  const result = await withRetry(flaky, { retries: 3, delayMs: 10 });
  console.log(`flaky: ${result} after ${attempts} attempts`);
} catch (err) {
  console.log(`flaky: failed (${err.message})`);
}

const words = ["alpha", "beta", "gamma", "delta"];
try {
  const upper = await mapLimit(words, 2, async (w, i) => {
    await sleep((words.length - i) * 5);
    return `${i}:${w.toUpperCase()}`;
  });
  console.log(`mapLimit: ${upper.join(" ")}`);
} catch (err) {
  console.log(`mapLimit failed: ${err.message}`);
}

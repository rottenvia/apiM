// Example / smoke test: node example.js
import path from "node:path";
import { buildReport, readRecord, withRetry, mapLimit } from "./index.js";

const dir = path.join(import.meta.dirname, "samples");
const money = (cents) => (cents / 100).toFixed(2);

buildReport(dir, { concurrency: 2 }, (err, report) => {
  if (err) {
    console.error("report failed:", err.message);
    process.exitCode = 1;
    return;
  }
  console.log(`records: ${report.count}`);
  console.log(`total: ${money(report.totalCents)}`);
  for (const c of report.categories) console.log(`  ${c.category}: ${c.count} / ${money(c.totalCents)}`);

  readRecord(dir, "no-such-record", (err2) => {
    console.log(`missing record: ${err2 ? err2.name : "found?!"}`);

    // A flaky operation that fails twice before it works.
    let attempts = 0;
    const flaky = (cb) => {
      attempts++;
      setTimeout(() => (attempts < 3 ? cb(new Error(`flaky failure ${attempts}`)) : cb(null, "ok")), 5);
    };
    withRetry(flaky, { retries: 3, delayMs: 10 }, (err3, result) => {
      if (err3) return console.log(`flaky: failed (${err3.message})`);
      console.log(`flaky: ${result} after ${attempts} attempts`);

      const words = ["alpha", "beta", "gamma", "delta"];
      mapLimit(
        words,
        2,
        (w, i, cb) => setTimeout(() => cb(null, `${i}:${w.toUpperCase()}`), (words.length - i) * 5),
        (err4, upper) => {
          if (err4) return console.log(`mapLimit failed: ${err4.message}`);
          console.log(`mapLimit: ${upper.join(" ")}`);
        },
      );
    });
  });
});

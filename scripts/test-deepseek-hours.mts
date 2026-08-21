/**
 * DeepSeek peak/off-peak hours.
 * Run: npx tsx scripts/test-deepseek-hours.mjs
 */
import assert from "node:assert";
import {
  getDeepSeekPeriod,
  formatCountdown,
} from "../src/lib/deepseek-hours.ts";

// Beijing is UTC+8. Construct UTC dates whose Beijing wall-clock is known.
const atBeijing = (hh: number, mm = 0) =>
  new Date(Date.UTC(2025, 0, 1, (hh - 8 + 24) % 24, mm));

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
};

// 12:00 Beijing -> peak (00:30-16:30 peak)
let r = getDeepSeekPeriod(atBeijing(12, 0));
check("noon Beijing is peak", r.period === "peak", r.period);
check("noon switches to off-peak at 16:30", r.nextChangeAtBeijing === "16:30 Beijing");
check(
  "noon countdown to 16:30 is 4h30m",
  r.nextChangeInMinutes === 4 * 60 + 30,
  String(r.nextChangeInMinutes)
);

// 16:00 Beijing -> still peak, 30m to off-peak
r = getDeepSeekPeriod(atBeijing(16, 0));
check("16:00 Beijing is peak", r.period === "peak");
check(
  "16:00 countdown is 30m",
  r.nextChangeInMinutes === 30,
  String(r.nextChangeInMinutes)
);

// 17:00 Beijing -> off-peak (16:30-00:30)
r = getDeepSeekPeriod(atBeijing(17, 0));
check("17:00 Beijing is off-peak", r.period === "offpeak", r.period);
check("17:00 switches to peak at 00:30", r.nextChangeAtBeijing === "00:30 Beijing");
check(
  "17:00 countdown to 00:30 is 7h30m",
  r.nextChangeInMinutes === 7 * 60 + 30,
  String(r.nextChangeInMinutes)
);

// 00:00 Beijing -> still off-peak (16:30-00:30)
r = getDeepSeekPeriod(atBeijing(0, 0));
check("00:00 Beijing is off-peak", r.period === "offpeak");
check("00:00 countdown to 00:30 is 30m", r.nextChangeInMinutes === 30);

// 01:00 Beijing -> peak (after 00:30)
r = getDeepSeekPeriod(atBeijing(1, 0));
check("01:00 Beijing is peak", r.period === "peak");
check(
  "01:00 countdown to 16:30 is 15h30m",
  r.nextChangeInMinutes === 15 * 60 + 30
);

// formatCountdown sanity
check("countdown 0 -> now", formatCountdown(0) === "now");
check("countdown 45 -> 45m", formatCountdown(45) === "45m");
check("countdown 90 -> 1h 30m", formatCountdown(90) === "1h 30m");
check("countdown 60 -> 1h", formatCountdown(60) === "1h");

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll DeepSeek-hours checks passed.");

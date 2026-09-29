// Runs inside a child process with a specific TZ; prints the results as JSON.
import path from "node:path";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(path.resolve("dates.js")).href);
const out = {};
function run(key, fn) {
  try {
    out[key] = { ok: fn() };
  } catch (e) {
    out[key] = { err: String(e?.message ?? e) };
  }
}
const fields = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];

for (const s of ["2024-03-10", "2024-11-03", "2024-03-31", "2024-10-27", "2024-01-01", "2024-12-31", "2024-09-29", "2024-04-07"]) {
  run(`parseDate(${s})`, () => fields(mod.parseDate(s)));
  run(`formatDate(parseDate(${s}))`, () => mod.formatDate(mod.parseDate(s)));
}
run("parseDate(2018-11-04) day", () => fields(mod.parseDate("2018-11-04")).slice(0, 3));
run("formatDate(parseDate(2018-11-04))", () => mod.formatDate(mod.parseDate("2018-11-04")));
for (const [h, mi] of [[0, 0], [0, 30], [8, 0], [12, 0], [23, 59]]) {
  run(`formatDate(local 2024-01-05 ${h}:${mi})`, () => mod.formatDate(new Date(2024, 0, 5, h, mi)));
  run(`formatDate(local 2024-07-05 ${h}:${mi})`, () => mod.formatDate(new Date(2024, 6, 5, h, mi)));
}
for (const [s, n] of [["2024-11-02", 1], ["2024-11-03", 1], ["2024-10-27", 1], ["2024-10-26", 2], ["2024-03-09", 2], ["2024-03-31", -1], ["2024-01-01", 365], ["2024-04-06", 2], ["2024-09-29", 1], ["2024-12-31", 1], ["2018-11-03", 1], ["2024-03-15", -30]]) {
  run(`addDays(${s},${n})`, () => mod.addDays(s, n));
}
for (const [a, b] of [["2024-03-09", "2024-03-11"], ["2024-03-30", "2024-04-02"], ["2024-10-26", "2024-10-28"], ["2024-11-04", "2024-11-01"], ["2024-01-01", "2025-01-01"], ["2024-09-28", "2024-09-30"], ["2018-11-03", "2018-11-05"], ["2024-06-01", "2024-06-01"]]) {
  run(`daysBetween(${a},${b})`, () => mod.daysBetween(a, b));
}
for (const s of ["2024-03-11", "2024-03-17", "2024-11-03", "2024-10-30", "2024-03-10", "2024-10-27", "2025-01-01"]) {
  run(`startOfWeek(${s})`, () => mod.startOfWeek(s));
  run(`weekdayName(${s})`, () => mod.weekdayName(s));
}
for (const [a, b] of [
  ["2024-06-01T22:00", "2024-06-02T06:15"],
  ["2024-03-10T00:30", "2024-03-10T03:30"],
  ["2024-11-03T00:30", "2024-11-03T03:30"],
  ["2024-03-31T00:30", "2024-03-31T03:30"],
  ["2024-10-27T00:30", "2024-10-27T03:30"],
  ["2024-09-29T01:00", "2024-09-29T04:00"],
  ["2024-04-07T01:00", "2024-04-07T04:00"],
]) {
  run(`elapsedHours(${a},${b})`, () => mod.elapsedHours(a, b));
}
for (const [a, b] of [["2024-10-26", "2024-10-29"], ["2024-11-02", "2024-11-05"], ["2024-03-09", "2024-03-12"], ["2024-04-06", "2024-04-08"], ["2018-11-03", "2018-11-05"]]) {
  run(`eachDay(${a},${b})`, () => mod.eachDay(a, b));
}
process.stdout.write(JSON.stringify(out));

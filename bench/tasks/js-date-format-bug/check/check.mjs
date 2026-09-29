// Hidden grader for js-date-format-bug. cwd = copy of the agent's workspace.
// Runs the module under several TZ settings in child processes and compares
// every helper with the correct local-calendar answer.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const ZONES = ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Europe/London", "Pacific/Auckland", "America/Sao_Paulo", "Asia/Kolkata"];

// Expected values that do not depend on the zone.
const E = {};
const days = (a, b) => {
  const out = [];
  for (let t = Date.UTC(...a.split("-").map((x, i) => Number(x) - (i === 1 ? 1 : 0))); ; t += 864e5) {
    const s = new Date(t).toISOString().slice(0, 10);
    out.push(s);
    if (s === b) return out;
  }
};
for (const s of ["2024-03-10", "2024-11-03", "2024-03-31", "2024-10-27", "2024-01-01", "2024-12-31", "2024-09-29", "2024-04-07"]) {
  const [y, m, d] = s.split("-").map(Number);
  E[`parseDate(${s})`] = [y, m, d, 0, 0];
  E[`formatDate(parseDate(${s}))`] = s;
}
E["parseDate(2018-11-04) day"] = [2018, 11, 4];
E["formatDate(parseDate(2018-11-04))"] = "2018-11-04";
for (const [h, mi] of [[0, 0], [0, 30], [8, 0], [12, 0], [23, 59]]) {
  E[`formatDate(local 2024-01-05 ${h}:${mi})`] = "2024-01-05";
  E[`formatDate(local 2024-07-05 ${h}:${mi})`] = "2024-07-05";
}
Object.assign(E, {
  "addDays(2024-11-02,1)": "2024-11-03",
  "addDays(2024-11-03,1)": "2024-11-04",
  "addDays(2024-10-27,1)": "2024-10-28",
  "addDays(2024-10-26,2)": "2024-10-28",
  "addDays(2024-03-09,2)": "2024-03-11",
  "addDays(2024-03-31,-1)": "2024-03-30",
  "addDays(2024-01-01,365)": "2024-12-31",
  "addDays(2024-04-06,2)": "2024-04-08",
  "addDays(2024-09-29,1)": "2024-09-30",
  "addDays(2024-12-31,1)": "2025-01-01",
  "addDays(2018-11-03,1)": "2018-11-04",
  "addDays(2024-03-15,-30)": "2024-02-14",
  "daysBetween(2024-03-09,2024-03-11)": 2,
  "daysBetween(2024-03-30,2024-04-02)": 3,
  "daysBetween(2024-10-26,2024-10-28)": 2,
  "daysBetween(2024-11-04,2024-11-01)": -3,
  "daysBetween(2024-01-01,2025-01-01)": 366,
  "daysBetween(2024-09-28,2024-09-30)": 2,
  "daysBetween(2018-11-03,2018-11-05)": 2,
  "daysBetween(2024-06-01,2024-06-01)": 0,
  "startOfWeek(2024-03-11)": "2024-03-11",
  "startOfWeek(2024-03-17)": "2024-03-11",
  "startOfWeek(2024-11-03)": "2024-10-28",
  "startOfWeek(2024-10-30)": "2024-10-28",
  "startOfWeek(2024-03-10)": "2024-03-04",
  "startOfWeek(2024-10-27)": "2024-10-21",
  "startOfWeek(2025-01-01)": "2024-12-30",
  "weekdayName(2024-03-11)": "Mon",
  "weekdayName(2024-03-17)": "Sun",
  "weekdayName(2024-11-03)": "Sun",
  "weekdayName(2024-10-30)": "Wed",
  "weekdayName(2024-03-10)": "Sun",
  "weekdayName(2024-10-27)": "Sun",
  "weekdayName(2025-01-01)": "Wed",
  "elapsedHours(2024-06-01T22:00,2024-06-02T06:15)": 8.25,
  "eachDay(2024-10-26,2024-10-29)": days("2024-10-26", "2024-10-29"),
  "eachDay(2024-11-02,2024-11-05)": days("2024-11-02", "2024-11-05"),
  "eachDay(2024-03-09,2024-03-12)": days("2024-03-09", "2024-03-12"),
  "eachDay(2024-04-06,2024-04-08)": days("2024-04-06", "2024-04-08"),
  "eachDay(2018-11-03,2018-11-05)": days("2018-11-03", "2018-11-05"),
});

// Elapsed hours across DST changes depend on the zone.
const DST_SHIFTS = {
  "elapsedHours(2024-03-10T00:30,2024-03-10T03:30)": { "America/Los_Angeles": 2 },
  "elapsedHours(2024-11-03T00:30,2024-11-03T03:30)": { "America/Los_Angeles": 4 },
  "elapsedHours(2024-03-31T00:30,2024-03-31T03:30)": { "Europe/London": 2 },
  "elapsedHours(2024-10-27T00:30,2024-10-27T03:30)": { "Europe/London": 4 },
  "elapsedHours(2024-09-29T01:00,2024-09-29T04:00)": { "Pacific/Auckland": 2 },
  "elapsedHours(2024-04-07T01:00,2024-04-07T04:00)": { "Pacific/Auckland": 4 },
};

let cases = 0;
let passed = 0;
const failures = [];
for (const tz of ZONES) {
  const r = spawnSync(process.execPath, [path.join(".bench_check", "probe.mjs")], {
    encoding: "utf8",
    timeout: 20000,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TZ: tz },
  });
  let got = null;
  try {
    got = JSON.parse(r.stdout);
  } catch {
    failures.push(`[${tz}] module did not load/run: ${(r.stderr || r.stdout || r.error?.message || "").trim().split("\n").slice(-3).join(" ")}`);
  }
  const expected = { ...E };
  for (const [k, byZone] of Object.entries(DST_SHIFTS)) expected[k] = byZone[tz] ?? 3;
  for (const [k, want] of Object.entries(expected)) {
    cases++;
    const g = got?.[k];
    if (g && "ok" in g && isDeepStrictEqual(g.ok, want)) passed++;
    else if (got) failures.push(`[${tz}] ${k}: got ${g && "ok" in g ? JSON.stringify(g.ok) : `error ${g?.err}`}, want ${JSON.stringify(want)}`);
  }
}

for (const f of failures.slice(0, 25)) console.log(`FAIL ${f}`);
if (failures.length > 25) console.log(`... and ${failures.length - 25} more failures`);
console.log(`SCORE ${passed}/${cases}`);
process.exit(passed === cases ? 0 : 1);

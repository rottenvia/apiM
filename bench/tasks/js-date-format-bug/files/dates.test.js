import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDate, formatDate, addDays, daysBetween, startOfWeek, weekdayName, elapsedHours, eachDay } from "./dates.js";

test("round trip", () => {
  assert.equal(formatDate(parseDate("2024-03-10")), "2024-03-10");
});

test("addDays", () => {
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2024-03-01", -1), "2024-02-29");
  assert.equal(addDays("2024-12-31", 1), "2025-01-01");
});

test("daysBetween", () => {
  assert.equal(daysBetween("2024-01-01", "2024-01-08"), 7);
  assert.equal(daysBetween("2024-01-08", "2024-01-01"), -7);
});

test("startOfWeek / weekdayName", () => {
  assert.equal(startOfWeek("2024-03-14"), "2024-03-11");
  assert.equal(weekdayName("2024-03-14"), "Thu");
});

test("elapsedHours", () => {
  assert.equal(elapsedHours("2024-03-10T09:00", "2024-03-10T17:30"), 8.5);
});

test("eachDay", () => {
  assert.deepEqual(eachDay("2024-02-27", "2024-03-01"), ["2024-02-27", "2024-02-28", "2024-02-29", "2024-03-01"]);
});

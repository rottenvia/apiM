// Date helpers for the booking app.
//
// A "date string" is a calendar date in the user's local time zone written as
// "YYYY-MM-DD". A "local date-time" is a wall-clock time in the user's local
// time zone written as "YYYY-MM-DDTHH:mm".

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function ymd(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) throw new RangeError(`bad date: ${str}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** "YYYY-MM-DD" -> Date at local midnight at the start of that calendar day. */
export function parseDate(str) {
  const [y, m, d] = ymd(str);
  const date = new Date(y, m - 1, d);
  date.setFullYear(y); // years 0-99
  return date;
}

/** Date -> "YYYY-MM-DD" of the local calendar day that instant falls on. */
export function formatDate(date) {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Calendar arithmetic is done on UTC dates, which have no DST. */
function toDayNumber(str) {
  const [y, m, d] = ymd(str);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}
function fromDayNumber(n) {
  const d = new Date(n * DAY_MS);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Date string + n calendar days (n may be negative) -> date string. */
export function addDays(str, n) {
  return fromDayNumber(toDayNumber(str) + n);
}

/** Number of calendar days from date string a to date string b (b - a); e.g. nights of a stay. */
export function daysBetween(a, b) {
  return toDayNumber(b) - toDayNumber(a);
}

/** Date string -> date string of the Monday of the week containing it. */
export function startOfWeek(str) {
  const n = toDayNumber(str);
  const sinceMonday = (new Date(n * DAY_MS).getUTCDay() + 6) % 7;
  return fromDayNumber(n - sinceMonday);
}

/** Short weekday name of a date string: "Mon", "Tue", ... */
export function weekdayName(str) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(toDayNumber(str) * DAY_MS).getUTCDay()];
}

/**
 * Real time elapsed, in hours, between two local date-times (end - start),
 * e.g. the paid length of a shift.
 */
export function elapsedHours(start, end) {
  return (toLocalMs(end) - toLocalMs(start)) / HOUR_MS;
}

function toLocalMs(localDateTime) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localDateTime);
  if (!m) throw new RangeError(`bad date-time: ${localDateTime}`);
  const [, y, mo, d, h, mi] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi).getTime();
}

/** Every date string from a to b inclusive. */
export function eachDay(a, b) {
  const out = [];
  for (let n = toDayNumber(a), end = toDayNumber(b); n <= end; n++) out.push(fromDayNumber(n));
  return out;
}

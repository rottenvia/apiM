// Date helpers for the booking app.
//
// A "date string" is a calendar date in the user's local time zone written as
// "YYYY-MM-DD". A "local date-time" is a wall-clock time in the user's local
// time zone written as "YYYY-MM-DDTHH:mm".

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** "YYYY-MM-DD" -> Date at local midnight at the start of that calendar day. */
export function parseDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) throw new RangeError(`bad date: ${str}`);
  return new Date(str);
}

/** Date -> "YYYY-MM-DD" of the local calendar day that instant falls on. */
export function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

/** Date string + n calendar days (n may be negative) -> date string. */
export function addDays(str, n) {
  return formatDate(new Date(parseDate(str).getTime() + n * DAY_MS));
}

/** Number of calendar days from date string a to date string b (b - a); e.g. nights of a stay. */
export function daysBetween(a, b) {
  return Math.floor((parseDate(b) - parseDate(a)) / DAY_MS);
}

/** Date string -> date string of the Monday of the week containing it. */
export function startOfWeek(str) {
  const d = parseDate(str);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return addDays(str, -sinceMonday);
}

/** Short weekday name of a date string: "Mon", "Tue", ... */
export function weekdayName(str) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parseDate(str).getDay()];
}

/**
 * Real time elapsed, in hours, between two local date-times (end - start),
 * e.g. the paid length of a shift.
 */
export function elapsedHours(start, end) {
  return (toUtcMs(end) - toUtcMs(start)) / HOUR_MS;
}

function toUtcMs(localDateTime) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localDateTime);
  if (!m) throw new RangeError(`bad date-time: ${localDateTime}`);
  const [, y, mo, d, h, mi] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi);
}

/** Every date string from a to b inclusive. */
export function eachDay(a, b) {
  const out = [];
  for (let t = parseDate(a).getTime(); t <= parseDate(b).getTime(); t += DAY_MS) {
    out.push(formatDate(new Date(t)));
  }
  return out;
}

/**
 * DeepSeek peak / off-peak hours.
 *
 * DeepSeek is a Chinese provider; its API discount hours are based on
 * Beijing time (UTC+8): off-peak runs 16:30 to 00:30 Beijing time, peak
 * is the rest of the day. During off-peak the cache-hit / miss token
 * prices are roughly half. This is evaluated on the client (it only needs
 * the user's clock and a fixed offset) so no round-trip is required.
 *
 * Schedule (Beijing time, UTC+8):
 *   00:30 - 16:30  -> peak
 *   16:30 - 00:30  -> off-peak (discount)
 */

export type DeepSeekPeriod = "peak" | "offpeak";

const BEIJING_OFFSET_MIN = 8 * 60; // UTC+8

/** Current Beijing time as minutes since midnight. */
function beijingMinutesNow(date = new Date()): number {
  // Convert the instant to the wall-clock components in UTC+8 without relying
  // on Intl (available everywhere in modern browsers/Node, but the arithmetic
  // is deterministic and cheap).
  const utcMin =
    date.getUTCHours() * 60 + date.getUTCMinutes();
  return (utcMin + BEIJING_OFFSET_MIN + 24 * 60) % (24 * 60);
}

const PEAK_START = 30; // 00:30
const OFFPEAK_START = 16 * 60 + 30; // 16:30

export function getDeepSeekPeriod(date = new Date()): {
  period: DeepSeekPeriod;
  /** Minutes until the next peak/off-peak transition (in Beijing time). */
  nextChangeInMinutes: number;
  /** Wall-clock label for the next transition, e.g. "16:30 Beijing". */
  nextChangeAt: string;
} {
  const m = beijingMinutesNow(date);
  let period: DeepSeekPeriod;
  let nextMin: number;

  if (m >= PEAK_START && m < OFFPEAK_START) {
    // Currently peak (00:30 -> 16:30); next is off-peak at 16:30.
    period = "peak";
    nextMin = OFFPEAK_START;
  } else {
    // Currently off-peak (16:30 -> 00:30); next is peak at 00:30.
    period = "offpeak";
    nextMin = PEAK_START;
  }

  let delta = nextMin - m;
  if (delta <= 0) delta += 24 * 60; // wraps past midnight

  const hh = Math.floor(nextMin / 60)
    .toString()
    .padStart(2, "0");
  const mm = (nextMin % 60).toString().padStart(2, "0");

  return {
    period,
    nextChangeInMinutes: delta,
    nextChangeAt: `${hh}:${mm} Beijing`,
  };
}

/** "16:30 Beijing" style label, and a human countdown. */
export function formatCountdown(minutes: number): string {
  if (minutes <= 0) return "now";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h <= 0) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

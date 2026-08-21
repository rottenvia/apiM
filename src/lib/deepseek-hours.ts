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
  nextChangeInMinutes: number;
  nextChangeAtLocal: string;
  nextChangeAtBeijing: string;
  localTimezone: string;
} {
  const m = beijingMinutesNow(date);
  let period: DeepSeekPeriod;
  let nextMin: number;

  if (m >= PEAK_START && m < OFFPEAK_START) {
    period = "peak";
    nextMin = OFFPEAK_START;
  } else {
    period = "offpeak";
    nextMin = PEAK_START;
  }

  let delta = nextMin - m;
  if (delta <= 0) delta += 24 * 60;

  // The transition is 'delta' minutes from now; show it in the user's local
  // wall-clock so anyone in any timezone sees their own time.
  const changeDate = new Date(date.getTime() + delta * 60_000);
  const localLabel = changeDate.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const bh = Math.floor(nextMin / 60).toString().padStart(2, "0");
  const bm = (nextMin % 60).toString().padStart(2, "0");

  return {
    period,
    nextChangeInMinutes: delta,
    nextChangeAtLocal: localLabel,
    nextChangeAtBeijing: `${bh}:${bm} Beijing`,
    localTimezone:
      (typeof Intl !== "undefined" &&
        Intl.DateTimeFormat().resolvedOptions().timeZone) ||
      "local",
  };
}

export function formatCountdown(minutes: number): string {
  if (minutes <= 0) return "now";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h <= 0) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

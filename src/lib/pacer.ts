/**
 * Steady reveal for streamed text.
 *
 * Reported after the first smoothing pass: "not laggy but freezy — it can
 * freeze for 0.4 seconds and then go smooth again", in thinking and in
 * prose. The first pass drained every burst in a fixed 200ms. Providers do
 * not send a steady trickle: a 16 tok/s endpoint delivers a handful of
 * tokens, then nothing for half a second, then another handful. Draining
 * each handful in 200ms and waiting out the rest of the gap IS the freeze —
 * type, stop, type, stop.
 *
 * So the reveal runs at the rate text is actually arriving (measured over
 * the last couple of seconds), holding back a small buffer sized to the
 * gaps between bursts. The buffer carries the text through a gap, the next
 * burst refills it before it runs dry, and the visible speed stays nearly
 * constant. A proportional correction keeps the buffer near its target:
 * above it the reveal speeds up, below it slows down — but never to a
 * stop while anything is waiting.
 *
 * Pure and clock-injected, so it is tested without a browser.
 */

/** Arrivals remembered for the rate estimate. */
const RATE_WINDOW_MS = 2_500;
/** Buffer target is this many typical gaps' worth of text. */
const GAP_COVER = 1.6;
const MIN_TARGET_MS = 120;
const MAX_TARGET_MS = 1_400;
/** Speed bounds as multiples of the arrival rate. */
const MIN_SPEED_FACTOR = 0.35;
const MAX_SPEED_FACTOR = 4;
/** A backlog this many targets deep is a dump (resume, a big burst): catch up. */
const DUMP_FACTOR = 6;
const DUMP_DRAIN_MS = 350;

export class StreamPacer {
  private arrivals: { t: number; n: number }[] = [];
  private gapMs = 250;
  private lastArrival = -1;
  private carry = 0;

  /** Text arrived: `chars` characters at `now` (ms). */
  arrive(chars: number, now: number): void {
    if (chars <= 0) return;
    if (this.lastArrival >= 0) {
      const gap = now - this.lastArrival;
      // Sub-frame gaps are one burst split across socket reads, not a gap.
      if (gap >= 8) {
        const clamped = Math.min(2_000, gap);
        this.gapMs = this.gapMs * 0.8 + clamped * 0.2;
      }
    }
    this.lastArrival = now;
    this.arrivals.push({ t: now, n: chars });
    while (this.arrivals.length && now - this.arrivals[0].t > RATE_WINDOW_MS) {
      this.arrivals.shift();
    }
  }

  /** Chars per ms currently arriving (0 before there is a measurement). */
  rate(now: number): number {
    if (this.arrivals.length < 2) return 0;
    const span = Math.max(now - this.arrivals[0].t, this.gapMs, 300);
    const total = this.arrivals.reduce((sum, a) => sum + a.n, 0);
    return total / span;
  }

  /** How long the buffer should be able to carry the reveal. */
  targetMs(): number {
    return Math.min(MAX_TARGET_MS, Math.max(MIN_TARGET_MS, this.gapMs * GAP_COVER));
  }

  /**
   * How many of `backlog` waiting characters to reveal in a frame `dt` ms
   * long. Returns at least 1 whenever something is waiting and the reveal
   * has been owed a character — the text slows, it never stalls.
   */
  take(backlog: number, now: number, dt: number): number {
    if (backlog <= 0) {
      this.carry = 0;
      return 0;
    }
    const target = this.targetMs();
    const rate = this.rate(now);
    let speed: number;
    if (rate <= 0) {
      // First burst, nothing measured yet: spread it over the target.
      speed = backlog / target;
    } else {
      const desired = rate * target;
      if (backlog > desired * DUMP_FACTOR) {
        speed = backlog / DUMP_DRAIN_MS;
      } else {
        const factor = Math.min(
          MAX_SPEED_FACTOR,
          Math.max(MIN_SPEED_FACTOR, 1 + (backlog - desired) / Math.max(desired, 1))
        );
        speed = rate * factor;
      }
    }
    const exact = speed * dt + this.carry;
    let n = Math.floor(exact);
    this.carry = exact - n;
    if (n > backlog) {
      n = backlog;
      this.carry = 0;
    }
    return n;
  }

  reset(): void {
    this.arrivals = [];
    this.gapMs = 250;
    this.lastArrival = -1;
    this.carry = 0;
  }
}

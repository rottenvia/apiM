//! Steady reveal for streamed text. Began as a port of src/lib/pacer.ts and of the queue around it in
//! src/app/page.tsx.
//!
//! Providers do not send a steady trickle: a batch of tokens, nothing for a few hundred milliseconds,
//! another batch (GLM through OpenRouter: some 30 characters every 125 ms, gaps up to 350). Showing each
//! batch as it lands is type, stop, type, stop ("it freezes while printing"). So text is let out at the
//! rate it is arriving, measured over the last couple of seconds, behind a small buffer sized to the gaps
//! between batches: the buffer carries the text through a gap and the next batch refills it before it
//! runs dry.
//!
//! Where it parts from the web: the buffer is worth its delay only while text comes quickly. A reply
//! from a busy provider (a word a second) cannot be made fluent; held back to be smoothed, it crawled
//! letter by letter a second and a half behind the model and the rest jumped in when the reply ended. So
//! waiting text is never shown slower than `FLOOR`, a reply that comes whole is typed out at one speed,
//! and the wait before a reply (thinking, a tool) is not taken for a gap to be covered.

use std::collections::VecDeque;
use std::time::Instant;

/// Arrivals remembered for the rate estimate. A silence longer than this starts the measuring afresh.
const RATE_WINDOW_MS: f64 = 2_500.0;
/// The buffer is this many typical gaps' worth of text.
const GAP_COVER: f64 = 1.6;
/// The gap assumed before any has been seen.
const FRESH_GAP_MS: f64 = 250.0;
const MIN_TARGET_MS: f64 = 120.0;
const MAX_TARGET_MS: f64 = 700.0;
/// Speed bounds as multiples of the arrival rate.
const MIN_SPEED_FACTOR: f64 = 0.35;
const MAX_SPEED_FACTOR: f64 = 4.0;
/// A backlog this many targets deep is a dump (a resume, one big burst): catch up.
const DUMP_FACTOR: f64 = 6.0;
const DUMP_DRAIN_MS: f64 = 350.0;
/// Characters per millisecond that waiting text is shown at, at the least: eight words a second. Under
/// this a reader waits for the text; smoothing a slower stream only delays words that are already here.
const FLOOR: f64 = 0.04;
/// Before a row or the end of the reply, the text still waiting is typed out in at most this long.
const DRAIN_MAX_MS: f64 = 220.0;

/// How many characters to show per frame. Times are milliseconds on any clock that only goes forward.
pub struct StreamPacer {
    arrivals: VecDeque<(f64, usize)>,
    gap_ms: f64,
    last_arrival: Option<f64>,
    carry: f64,
}

impl Default for StreamPacer {
    fn default() -> Self {
        StreamPacer { arrivals: VecDeque::new(), gap_ms: FRESH_GAP_MS, last_arrival: None, carry: 0.0 }
    }
}

impl StreamPacer {
    /// `chars` characters arrived at `now`.
    pub fn arrive(&mut self, chars: usize, now: f64) {
        if chars == 0 {
            return;
        }
        match self.last_arrival.map(|last| now - last) {
            // A silence this long is the model thinking or a tool at work, not a gap between batches: what
            // was measured before it says nothing about the text that comes now.
            Some(gap) if gap > RATE_WINDOW_MS => {
                self.arrivals.clear();
                self.gap_ms = FRESH_GAP_MS;
            }
            // Gaps under a frame are one batch split across socket reads, not a gap.
            Some(gap) if gap >= 8.0 => self.gap_ms = self.gap_ms * 0.8 + gap * 0.2,
            _ => {}
        }
        self.last_arrival = Some(now);
        self.arrivals.push_back((now, chars));
        while self.arrivals.front().is_some_and(|(at, _)| now - at > RATE_WINDOW_MS) {
            self.arrivals.pop_front();
        }
    }

    /// Characters per millisecond now arriving: 0 before there is a measurement.
    fn rate(&self, now: f64) -> f64 {
        if self.arrivals.len() < 2 {
            return 0.0;
        }
        let span = (now - self.arrivals[0].0).max(self.gap_ms).max(300.0);
        self.arrivals.iter().map(|(_, n)| *n as f64).sum::<f64>() / span
    }

    /// How long the buffer should be able to carry the reveal.
    fn target_ms(&self) -> f64 {
        (self.gap_ms * GAP_COVER).clamp(MIN_TARGET_MS, MAX_TARGET_MS)
    }

    /// How many of `backlog` waiting characters to show in a frame `dt` ms long. The text slows, it never stalls:
    /// what a frame is owed and cannot show whole is carried to the next.
    pub fn take(&mut self, backlog: usize, now: f64, dt: f64) -> usize {
        if backlog == 0 {
            self.carry = 0.0;
            return 0;
        }
        let (waiting, target, rate) = (backlog as f64, self.target_ms(), self.rate(now));
        let speed = if rate <= 0.0 {
            // One batch and nothing measured yet (a short answer often comes whole): typed out over the target
            // at one speed. Sized by what is left instead, its last words took as long as all the rest.
            waiting.max(self.arrivals.back().map_or(0.0, |(_, n)| *n as f64)) / target
        } else {
            let desired = rate * target;
            if waiting > desired * DUMP_FACTOR {
                waiting / DUMP_DRAIN_MS
            } else {
                // Above its target the buffer empties faster, below it slower.
                rate * (1.0 + (waiting - desired) / desired.max(1.0)).clamp(MIN_SPEED_FACTOR, MAX_SPEED_FACTOR)
            }
        };
        let exact = speed.max(FLOOR) * dt + self.carry;
        let n = exact.floor();
        self.carry = exact - n;
        if n as usize > backlog {
            self.carry = 0.0;
            return backlog;
        }
        n as usize
    }
}

/// Text on its way into a reply: thinking and prose in one line, in the order they came, so the turn from
/// one to the other does not dump what was left of the thought.
pub struct Typing {
    pacer: StreamPacer,
    /// (is prose, text) still to be shown.
    queue: VecDeque<(bool, String)>,
    chars: usize,
    /// Where the pacer's clock starts.
    born: Instant,
    last: Instant,
    /// A row or the end of the reply is waiting behind this text since then.
    draining: Option<Instant>,
    /// When the text not shown yet came in, oldest first: (ms, characters).
    owed: VecDeque<(f64, usize)>,
    /// The longest any text has waited to be shown, in ms. Over a second or two, the pacing is at fault.
    pub worst_wait: f64,
}

impl Default for Typing {
    fn default() -> Self {
        let now = Instant::now();
        Typing { pacer: StreamPacer::default(), queue: VecDeque::new(), chars: 0, born: now, last: now, draining: None, owed: VecDeque::new(), worst_wait: 0.0 }
    }
}

impl Typing {
    fn ms(&self, at: Instant) -> f64 {
        at.duration_since(self.born).as_secs_f64() * 1000.0
    }

    /// Text came from the model. It counts for the pace from now, wherever it stands in line.
    pub fn arrived(&mut self, text: &str) {
        let (now, chars) = (self.ms(Instant::now()), text.chars().count());
        self.pacer.arrive(chars, now);
        self.owed.push_back((now, chars));
    }

    /// Its turn has come: it joins what is being typed out.
    pub fn push(&mut self, prose: bool, text: String) {
        self.chars += text.chars().count();
        match self.queue.back_mut() {
            Some((kind, so_far)) if *kind == prose => so_far.push_str(&text),
            _ => self.queue.push_back((prose, text)),
        }
    }

    pub fn waiting(&self) -> bool {
        self.chars > 0
    }

    /// What to write into the reply this frame. `held`: something waits behind the text, which is then typed
    /// out quickly rather than at its own pace (and not dumped: a second of text in one frame reads as a skip).
    pub fn release(&mut self, held: bool) -> Vec<(bool, String)> {
        let now = Instant::now();
        let since = now.duration_since(self.last).as_secs_f64() * 1000.0;
        if since > 500.0 {
            // No frame was drawn for a while (the window was out of sight): that wait is not the pacing's.
            let at = self.ms(now);
            self.owed.iter_mut().for_each(|(came, _)| *came = at);
        }
        let dt = since.clamp(1.0, 120.0);
        self.last = now;
        if !held {
            self.draining = None;
        }
        let n = match (held, self.chars) {
            (_, 0) => 0,
            (false, _) => self.pacer.take(self.chars, self.ms(now), dt),
            (true, _) => {
                let left = DRAIN_MAX_MS - now.duration_since(*self.draining.get_or_insert(now)).as_secs_f64() * 1000.0;
                if left <= 16.0 { self.chars } else { ((self.chars as f64 * dt / left).ceil() as usize).max(1) }
            }
        };
        self.take(n)
    }

    /// Everything at once: nobody is watching, or the reply was stopped.
    pub fn release_all(&mut self) -> Vec<(bool, String)> {
        self.draining = None;
        self.take(self.chars)
    }

    /// The first `n` characters in line, in order.
    fn take(&mut self, mut n: usize) -> Vec<(bool, String)> {
        let mut out = Vec::new();
        let mut shown = 0;
        while n > 0 {
            let Some((prose, text)) = self.queue.front_mut() else { break };
            let cut = text.char_indices().nth(n).map(|(at, _)| at);
            let piece: String = match cut {
                Some(at) => text.drain(..at).collect(),
                None => std::mem::take(text),
            };
            let count = piece.chars().count();
            out.push((*prose, piece));
            if cut.is_none() {
                self.queue.pop_front();
            }
            self.chars -= count;
            n -= count;
            shown += count;
        }
        // How long what was just shown had waited.
        let now = self.ms(Instant::now());
        while shown > 0 {
            let Some((came, chars)) = self.owed.front_mut() else { break };
            self.worst_wait = self.worst_wait.max(now - *came);
            let settled = shown.min(*chars);
            *chars -= settled;
            shown -= settled;
            if *chars == 0 {
                self.owed.pop_front();
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// How the text of a real reply came in (GLM 5.3 Flash through OpenRouter, 2,058 characters in 6.3 s):
    /// milliseconds since the first of it, characters.
    const RECORDED: &[(f64, usize)] = &[
        (0.0, 15), (1.0, 11), (93.0, 44), (221.0, 65), (347.0, 60), (476.0, 46), (599.0, 52), (729.0, 71), (1010.0, 31), (1134.0, 66), (1259.0, 54),
        (1382.0, 54), (1509.0, 45), (1866.0, 13), (1867.0, 10), (1877.0, 37), (2086.0, 67), (2335.0, 37), (2505.0, 13), (2516.0, 64), (2764.0, 30),
        (2777.0, 7), (2778.0, 3), (2788.0, 30), (2907.0, 28), (3068.0, 6), (3069.0, 24), (3256.0, 45), (3503.0, 6), (3504.0, 22), (3510.0, 12),
        (3545.0, 15), (3705.0, 33), (3706.0, 19), (3850.0, 58), (3985.0, 41), (4118.0, 24), (4119.0, 23), (4250.0, 48), (4532.0, 33), (4535.0, 24),
        (4536.0, 3), (4855.0, 8), (4912.0, 5), (4913.0, 64), (4942.0, 41), (5062.0, 55), (5199.0, 9), (5200.0, 27), (5335.0, 50), (5473.0, 23),
        (5474.0, 42), (5608.0, 52), (5758.0, 64), (5878.0, 45), (6015.0, 17), (6016.0, 35), (6148.0, 91), (6280.0, 31), (6341.0, 10),
    ];

    /// Shows text that came in as `arrivals` (ms, characters) at 60 frames a second. Returns the longest any
    /// of it waited to be shown and, after `settle` ms, the longest the text stood still before its last
    /// batch came, both in ms.
    fn replay(arrivals: &[(f64, usize)], settle: f64) -> (f64, f64) {
        let mut pacer = StreamPacer::default();
        let mut owed: VecDeque<(f64, usize)> = VecDeque::new();
        let (mut next, mut now, mut moved, mut wait, mut stop) = (0, arrivals[0].0, arrivals[0].0, 0.0_f64, 0.0_f64);
        let end = arrivals[arrivals.len() - 1].0;
        while next < arrivals.len() || !owed.is_empty() {
            while next < arrivals.len() && arrivals[next].0 <= now {
                pacer.arrive(arrivals[next].1, now);
                owed.push_back(arrivals[next]);
                next += 1;
            }
            let mut n = pacer.take(owed.iter().map(|(_, chars)| chars).sum(), now, 16.0);
            if n > 0 {
                if now > arrivals[0].0 + settle && now <= end {
                    stop = stop.max(now - moved);
                }
                moved = now;
            }
            while n > 0 {
                let (came, chars) = owed.front_mut().unwrap();
                wait = wait.max(now - *came);
                let shown = n.min(*chars);
                *chars -= shown;
                n -= shown;
                if *chars == 0 {
                    owed.pop_front();
                }
            }
            now += 16.0;
            assert!(now < end + 10_000.0, "text was left waiting");
        }
        (wait, stop)
    }

    #[test]
    fn a_recorded_reply_reads_without_stops() {
        let (wait, stop) = replay(RECORDED, 500.0);
        assert!(stop <= 150.0, "the text stood still for {stop} ms");
        assert!(wait <= 500.0, "text waited {wait} ms");
    }

    /// The web's own check (scripts/test-ux.mjs): a 16 tok/s endpoint sending a handful of tokens every
    /// 150-900 ms is shown with no pause over 150 ms, and never runs more than a second and a half behind.
    #[test]
    fn bursts_are_shown_without_pauses() {
        for seed in [1_u64, 7, 42] {
            let mut x = seed;
            let mut rnd = || {
                x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
                x as f64 / 2_147_483_648.0
            };
            let (mut arrivals, mut t) = (Vec::new(), 0.0);
            while t < 30_000.0 {
                let gap = 150.0 + rnd() * 750.0;
                t += gap;
                arrivals.push((t, (64.0 * gap / 1000.0 * (0.7 + rnd() * 0.6)).round() as usize));
            }
            let (wait, stop) = replay(&arrivals, 2_000.0);
            assert!(stop <= 150.0, "seed {seed}: the text stood still for {stop} ms");
            assert!(wait <= 1_500.0, "seed {seed}: text waited {wait} ms");
        }
    }

    /// A busy provider: a word every 700 ms. Each is on screen at once, so nothing is left to jump in at the end.
    #[test]
    fn a_slow_reply_is_shown_as_it_comes() {
        let slow: Vec<(f64, usize)> = (0..17).map(|word| (word as f64 * 700.0, 5)).collect();
        let (wait, _) = replay(&slow, 0.0);
        assert!(wait <= 200.0, "a word waited {wait} ms");
    }

    #[test]
    fn a_reply_that_comes_whole_is_typed_out_at_once() {
        for chars in [5, 69, 2_000] {
            let (wait, _) = replay(&[(0.0, chars)], 0.0);
            assert!(wait <= 450.0, "{chars} characters took {wait} ms");
        }
        // Seven seconds of thinking before it are not a gap between batches to be covered.
        let (wait, _) = replay(&[(0.0, 30), (7_000.0, 69)], 0.0);
        assert!(wait <= 450.0, "after a silence the text took {wait} ms");
    }

    #[test]
    fn the_line_keeps_its_order_and_knows_how_long_it_waited() {
        let mut typing = Typing::default();
        typing.push(false, "thinking é".into());
        typing.push(false, "!".into());
        typing.push(true, "prose".into());
        assert_eq!(typing.take(9), [(false, "thinking ".to_string())]);
        // A piece ends on a whole character, and the turn from thought to prose keeps its place.
        assert_eq!(typing.take(4), [(false, "é!".to_string()), (true, "pr".to_string())]);
        assert!(typing.waiting());
        assert_eq!(typing.release_all(), [(true, "ose".to_string())]);
        assert!(!typing.waiting() && typing.release(true).is_empty());

        let mut typing = Typing::default();
        typing.arrived("late");
        typing.push(true, "late".into());
        std::thread::sleep(std::time::Duration::from_millis(30));
        typing.release_all();
        assert!(typing.worst_wait >= 30.0 && typing.owed.is_empty());
    }
}

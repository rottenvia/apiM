//! Steady reveal for streamed text. Port of src/lib/pacer.ts and of the queue around it in src/app/page.tsx.
//!
//! Providers do not send a steady trickle: a handful of tokens, then nothing for half a second, then
//! another handful. Showing each handful as it lands, or draining it in a fixed fifth of a second, is
//! type, stop, type, stop ("it freezes while printing"). So text is let out at the rate it is arriving,
//! measured over the last couple of seconds, behind a small buffer sized to the gaps between bursts: the
//! buffer carries the text through a gap and the next burst refills it before it runs dry.

use std::collections::VecDeque;
use std::time::Instant;

/// Arrivals remembered for the rate estimate.
const RATE_WINDOW_MS: f64 = 2_500.0;
/// The buffer is this many typical gaps' worth of text.
const GAP_COVER: f64 = 1.6;
const MIN_TARGET_MS: f64 = 120.0;
const MAX_TARGET_MS: f64 = 1_400.0;
/// Speed bounds as multiples of the arrival rate.
const MIN_SPEED_FACTOR: f64 = 0.35;
const MAX_SPEED_FACTOR: f64 = 4.0;
/// A backlog this many targets deep is a dump (a resume, one big burst): catch up.
const DUMP_FACTOR: f64 = 6.0;
const DUMP_DRAIN_MS: f64 = 350.0;
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
        StreamPacer { arrivals: VecDeque::new(), gap_ms: 250.0, last_arrival: None, carry: 0.0 }
    }
}

impl StreamPacer {
    /// `chars` characters arrived at `now`.
    pub fn arrive(&mut self, chars: usize, now: f64) {
        if chars == 0 {
            return;
        }
        // Gaps under a frame are one burst split across socket reads, not a gap.
        if let Some(gap) = self.last_arrival.map(|last| now - last).filter(|gap| *gap >= 8.0) {
            self.gap_ms = self.gap_ms * 0.8 + gap.min(2_000.0) * 0.2;
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
            // The first burst, nothing measured yet: spread over the target.
            waiting / target
        } else {
            let desired = rate * target;
            if waiting > desired * DUMP_FACTOR {
                waiting / DUMP_DRAIN_MS
            } else {
                // Above its target the buffer empties faster, below it slower.
                rate * (1.0 + (waiting - desired) / desired.max(1.0)).clamp(MIN_SPEED_FACTOR, MAX_SPEED_FACTOR)
            }
        };
        let exact = speed * dt + self.carry;
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
}

impl Default for Typing {
    fn default() -> Self {
        let now = Instant::now();
        Typing { pacer: StreamPacer::default(), queue: VecDeque::new(), chars: 0, born: now, last: now, draining: None }
    }
}

impl Typing {
    fn ms(&self, at: Instant) -> f64 {
        at.duration_since(self.born).as_secs_f64() * 1000.0
    }

    /// Text came from the model. It counts for the pace from now, wherever it stands in line.
    pub fn arrived(&mut self, text: &str) {
        self.pacer.arrive(text.chars().count(), self.ms(Instant::now()));
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
        let dt = (now.duration_since(self.last).as_secs_f64() * 1000.0).clamp(1.0, 120.0);
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
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The web's own check (scripts/test-ux.mjs): a 16 tok/s endpoint sending a handful of tokens every
    /// 150-900 ms is shown with no pause over 150 ms, and the buffer held back stays small.
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
                if rnd() < 0.03 {
                    t += 900.0;
                }
            }
            let mut pacer = StreamPacer::default();
            let (mut backlog, mut next, mut last, mut longest, mut now) = (0, 0, 0.0, 0.0_f64, 0.0);
            while now < arrivals[arrivals.len() - 1].0 {
                while next < arrivals.len() && arrivals[next].0 <= now {
                    backlog += arrivals[next].1;
                    pacer.arrive(arrivals[next].1, arrivals[next].0);
                    next += 1;
                }
                let n = pacer.take(backlog, now, 24.0);
                backlog -= n;
                if n > 0 {
                    if last > 0.0 && now > 2000.0 {
                        longest = longest.max(now - last);
                    }
                    last = now;
                }
                now += 24.0;
            }
            assert!(longest <= 150.0, "seed {seed}: paused {longest} ms");
            assert!(backlog < 200, "seed {seed}: {backlog} characters left waiting");
        }
    }

    #[test]
    fn nothing_waits_forever_and_the_line_keeps_its_order() {
        let mut pacer = StreamPacer::default();
        pacer.arrive(5, 0.0);
        let mut got = 0;
        for frame in 0..84 {
            got += pacer.take(5 - got, frame as f64 * 24.0, 24.0);
        }
        assert_eq!(got, 5);

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
    }
}

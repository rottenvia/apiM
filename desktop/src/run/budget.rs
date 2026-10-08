//! Port of `src/lib/budget.ts`: a hard ceiling on what one reply may cost.
//!
//! It stops between rounds, never mid-stream, so the work so far is kept. It
//! predicts the next round from the last one rather than only checking the total,
//! warns at 80%, and caps `max_tokens` so a single round cannot sail past the limit.

use super::fixed;

/// Warn once the run passes this share of its cap.
pub const WARN_AT_FRACTION: f64 = 0.8;
/// Below this, a capped reply is a fragment rather than an answer; stopping is better.
pub const MIN_USEFUL_OUTPUT_TOKENS: u64 = 1_000;

pub struct Budget {
    /// Ceiling in USD. None means no cap.
    pub limit: Option<f64>,
    /// Spent so far on this reply.
    pub spent: f64,
    warned: bool,
}

#[derive(Debug, PartialEq)]
pub enum Verdict {
    Continue,
    /// Past 80% of the cap. Said once.
    Warn,
    /// The run ends here, and why.
    Stop(&'static str),
}

impl Budget {
    /// A zero or negative cap reads as "no cap": it would stop the very first round.
    pub fn new(limit: Option<f64>) -> Budget {
        Budget { limit: limit.filter(|l| *l > 0.0), spent: 0.0, warned: false }
    }

    /// May the loop run another step? `last_round_cost` stands in for what the next one will cost.
    pub fn check(&mut self, last_round_cost: f64) -> Verdict {
        let Some(limit) = self.limit else { return Verdict::Continue };
        if self.spent >= limit {
            return Verdict::Stop("the spending limit for this reply was reached");
        }
        if last_round_cost > 0.0 && self.spent + last_round_cost > limit {
            return Verdict::Stop("the next step would cost more than the remaining budget for this reply");
        }
        if !self.warned && self.spent >= limit * WARN_AT_FRACTION {
            self.warned = true;
            return Verdict::Warn;
        }
        Verdict::Continue
    }

    /// The largest reply the remaining budget can pay for, in tokens. `output_rate` is USD per million output
    /// tokens at list price; unknown or free pricing leaves the model's own ceiling.
    pub fn max_tokens(&self, output_rate: Option<f64>, ceiling: u64) -> u64 {
        let (Some(limit), Some(rate)) = (self.limit, output_rate.filter(|r| *r > 0.0)) else { return ceiling };
        let remaining = limit - self.spent;
        if remaining <= 0.0 {
            return MIN_USEFUL_OUTPUT_TOKENS;
        }
        MIN_USEFUL_OUTPUT_TOKENS.max(ceiling.min((remaining / rate * 1e6).floor() as u64))
    }
}

/// What the reply says when the cap stops it.
pub fn budget_stop_message(spent: f64, limit: f64, resumable: bool) -> String {
    let resume = if resumable { ", and you can carry on with Resume (or by typing \"resume\"), which continues from here instead of starting again." } else { "." };
    format!("Stopped at your spending limit — this reply has cost ${} of ${}. Everything done so far is saved{resume} Raise or remove the limit in Settings if you want it to keep going.", fixed(spent, 4), fixed(limit, 2))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::cases;

    #[test]
    fn matches_the_web() {
        for (i, o) in cases("check_budget") {
            let mut budget = Budget::new(i[0].as_f64());
            for (step, want) in i[1].as_array().unwrap().iter().zip(o.as_array().unwrap()) {
                budget.spent = step[0].as_f64().unwrap();
                let verdict = budget.check(step[1].as_f64().unwrap());
                let name = match verdict {
                    Verdict::Continue => "continue",
                    Verdict::Warn => "warn",
                    Verdict::Stop(reason) => {
                        assert_eq!(reason, want["reason"].as_str().unwrap());
                        "stop"
                    }
                };
                assert_eq!(name, want["action"].as_str().unwrap(), "{i} at {step}");
            }
        }
        for (i, o) in cases("budget_stop_message") {
            assert_eq!(budget_stop_message(i[0].as_f64().unwrap(), i[1].as_f64().unwrap(), i[2].as_bool().unwrap()), o.as_str().unwrap());
        }
        for (i, o) in cases("max_tokens_for") {
            // The web's list prices for the models the fixture names.
            let rate = match i[2].as_str().unwrap() {
                "deepseek-v4-pro" => Some(0.87),
                "glm-5.3-flash" => Some(0.5),
                "nvidia-nemotron-3-ultra-free" => Some(0.0),
                _ => None,
            };
            let mut budget = Budget::new(i[0].as_f64());
            budget.spent = i[1].as_f64().unwrap();
            assert_eq!(budget.max_tokens(rate, i[3].as_u64().unwrap()), o.as_u64().unwrap(), "{i}");
        }
    }
}

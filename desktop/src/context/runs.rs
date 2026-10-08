//! Keeping a reply alive after the window that asked for it has gone: port of src/lib/runs.ts.
//! "The user pressed Stop" must halt the work; "nobody is watching" (tab closed, window minimised, laptop asleep) must not:
//! the agent is writing files into a workspace on the user's own machine, and those files are the point. A run is keyed by
//! the assistant message id so a Stop from anywhere can reach it. In-memory only, like the web: nothing is persisted.
//! Time-dependent methods have an `_at(…, now_ms)` twin for tests.

use super::{now_ms, Stop};
use std::sync::Mutex;

/// How long a run may live without being stopped: a safety net, not a policy.
pub const MAX_RUN_MS: u64 = 8 * 60 * 60 * 1000;
/// How long a run may sit with NO activity before the safety net stops it. Wedged means idle, not old: the run is
/// touched on every model chunk and tool result, so a slow endpoint's 40-minute task is not killed by starting another chat.
pub const MAX_IDLE_MS: u64 = 30 * 60 * 1000;

struct ActiveRun {
    /// Stopped only by an explicit stop, never by a dropped connection.
    stop: Stop,
    conversation_id: String,
    started_at: u64,
    /// Last time the run showed life: a chunk from the model, a tool result.
    last_activity: u64,
}

/// The registry. Entries keep the order they were first registered in (a retry of the same message replaces its entry in place).
#[derive(Default)]
pub struct RunRegistry {
    runs: Mutex<Vec<(String, ActiveRun)>>,
}

/// Aborts and drops anything idle or older than the ceilings.
fn sweep(runs: &mut Vec<(String, ActiveRun)>, now: u64) {
    runs.retain(|(_, r)| {
        let dead = now.saturating_sub(r.last_activity) > MAX_IDLE_MS || now.saturating_sub(r.started_at) > MAX_RUN_MS;
        if dead {
            r.stop.stop();
        }
        !dead
    });
}

impl RunRegistry {
    pub fn new() -> RunRegistry {
        RunRegistry::default()
    }

    /// Registers a run and returns the signal the work should watch. A retry of the same message replaces the old entry rather than leaking it.
    pub fn begin(&self, message_id: &str, conversation_id: &str) -> Stop {
        self.begin_at(message_id, conversation_id, now_ms())
    }

    pub fn begin_at(&self, message_id: &str, conversation_id: &str, now: u64) -> Stop {
        let mut runs = self.runs.lock().unwrap();
        let stop = Stop::new();
        let run = ActiveRun { stop: stop.clone(), conversation_id: conversation_id.to_string(), started_at: now, last_activity: now };
        match runs.iter().position(|(id, _)| id == message_id) {
            Some(i) => {
                runs[i].1.stop.stop();
                runs[i].1 = run;
            }
            None => runs.push((message_id.to_string(), run)),
        }
        sweep(&mut runs, now);
        stop
    }

    /// Records that a run is alive (a chunk arrived, a tool finished).
    pub fn touch(&self, message_id: &str) {
        self.touch_at(message_id, now_ms());
    }

    pub fn touch_at(&self, message_id: &str, now: u64) {
        if let Some((_, r)) = self.runs.lock().unwrap().iter_mut().find(|(id, _)| id == message_id) {
            r.last_activity = now;
        }
    }

    /// Called when the run finishes, however it finished. Only the route that owns the CURRENT entry may remove it: a
    /// retry can replace a run under the same id before the old one has unwound, and the old one must not delete its replacement.
    pub fn end(&self, message_id: &str, stop: &Stop) {
        let mut runs = self.runs.lock().unwrap();
        if let Some(i) = runs.iter().position(|(id, r)| id == message_id && r.stop.same(stop)) {
            runs.remove(i);
        }
    }

    /// Stops a run on purpose. False when there is nothing to stop: reported rather than pretending it worked.
    pub fn stop_run(&self, message_id: &str) -> bool {
        let mut runs = self.runs.lock().unwrap();
        // Removed before aborting, so cleanup from the old work can never race a replacement registered under the same id.
        match runs.iter().position(|(id, _)| id == message_id) {
            Some(i) => {
                runs.remove(i).1.stop.stop();
                true
            }
            None => false,
        }
    }

    /// Stops every run in a conversation (Stop must work before the reply's `meta` arrives); how many.
    pub fn stop_conversation(&self, conversation_id: &str) -> usize {
        if conversation_id.is_empty() {
            return 0;
        }
        let mut n = 0;
        self.runs.lock().unwrap().retain(|(_, r)| {
            let hit = r.conversation_id == conversation_id;
            if hit {
                r.stop.stop();
                n += 1;
            }
            !hit
        });
        n
    }

    /// Runs still going in a conversation, so a reopened window can find them.
    pub fn active_runs(&self, conversation_id: &str) -> Vec<String> {
        self.active_runs_at(conversation_id, now_ms())
    }

    pub fn active_runs_at(&self, conversation_id: &str, now: u64) -> Vec<String> {
        let mut runs = self.runs.lock().unwrap();
        sweep(&mut runs, now);
        runs.iter().filter(|(_, r)| r.conversation_id == conversation_id).map(|(id, _)| id.clone()).collect()
    }

    pub fn is_running(&self, message_id: &str) -> bool {
        self.runs.lock().unwrap().iter().any(|(id, _)| id == message_id)
    }

    pub fn run_count(&self) -> usize {
        self.runs.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::testkit::check;
    use serde_json::{json, Value};

    #[test]
    fn replays_the_web_registry() {
        check("runs.ops", |ops| {
            let reg = RunRegistry::new();
            let (t0, mut now) = (1_000_000_000_000u64, 1_000_000_000_000u64);
            let mut signals: Vec<Stop> = Vec::new();
            let s = |o: &Value, i: usize| o[i].as_str().unwrap_or("").to_string();
            Value::Array(
                ops.as_array()
                    .unwrap()
                    .iter()
                    .map(|o| match o[0].as_str().unwrap() {
                        "time" => { now = t0 + o[1].as_u64().unwrap(); Value::Null }
                        "begin" => { signals.push(reg.begin_at(&s(o, 1), &s(o, 2), now)); json!(signals.len() - 1) }
                        "touch" => { reg.touch_at(&s(o, 1), now); Value::Null }
                        "end" => { reg.end(&s(o, 1), &signals[o[2].as_u64().unwrap() as usize]); Value::Null }
                        "stop" => json!(reg.stop_run(&s(o, 1))),
                        "stopConv" => json!(reg.stop_conversation(&s(o, 1))),
                        "active" => json!(reg.active_runs_at(&s(o, 1), now)),
                        "running" => json!(reg.is_running(&s(o, 1))),
                        "aborted" => json!(signals[o[1].as_u64().unwrap() as usize].is_stopped()),
                        "count" => json!(reg.run_count()),
                        other => panic!("{other}"),
                    })
                    .collect(),
            )
        });
        check("runs.consts", |_| json!({ "maxRunMs": MAX_RUN_MS, "maxIdleMs": MAX_IDLE_MS }));
    }
}

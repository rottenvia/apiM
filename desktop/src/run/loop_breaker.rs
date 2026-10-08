//! Port of `src/lib/loop-breaker.ts`: stops a run that sends the same failing
//! tool call again and again. Strikes are counted per call, not in a row: the real
//! loop reads a file between two identical failing edits.

use super::head;
use serde_json::Value;
use std::collections::HashMap;

/// Identical failures before the model gets warned.
pub const LOOP_WARN_REPEATS: u32 = 2;
/// Identical failures before the run halts.
pub const LOOP_TRIP_REPEATS: u32 = 3;

/// The name plus the arguments with keys sorted at every depth: `{a:1,b:2}` and `{b:2,a:1}` are one call,
/// any changed value is another. Arguments that never parsed are passed as a JSON string and match byte for byte.
pub fn fingerprint(name: &str, args: &Value) -> String {
    fn stable(value: &Value, out: &mut String) {
        match value {
            Value::Array(items) => {
                out.push('[');
                for item in items {
                    stable(item, out);
                    out.push(',');
                }
                out.push(']');
            }
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                out.push('{');
                for key in keys {
                    out.push_str(&format!("{key:?}:"));
                    stable(&map[key], out);
                    out.push(',');
                }
                out.push('}');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    let mut out = format!("{name}\n");
    stable(args, &mut out);
    out
}

#[derive(Debug, PartialEq)]
pub struct LoopObservation {
    /// Strikes against this call, this one included.
    pub repeats: u32,
    /// True exactly on the warning strike.
    pub warn: bool,
    /// True on the trip strike and while the strikes continue.
    pub trip: bool,
}

/// One per reply. Only the call itself succeeding clears its strikes.
#[derive(Default)]
pub struct LoopBreaker(HashMap<String, u32>);

impl LoopBreaker {
    pub fn observe(&mut self, name: &str, args: &Value, ok: bool) -> LoopObservation {
        let key = fingerprint(name, args);
        if ok {
            self.0.remove(&key);
            return LoopObservation { repeats: 0, warn: false, trip: false };
        }
        let repeats = self.0.entry(key).or_insert(0);
        *repeats += 1;
        LoopObservation { repeats: *repeats, warn: *repeats == LOOP_WARN_REPEATS, trip: *repeats >= LOOP_TRIP_REPEATS }
    }
}

/// Appended to the tool result carrying the second strike: the text the model reads next.
pub fn loop_warning_text(tool: &str) -> String {
    format!("\n\n[Harness: this exact `{tool}` call has now failed twice with identical arguments. Do NOT send it again unchanged — a third identical failure stops the run. Read the error, change the approach (inspect the file first, use a different anchor, or ask the user), then act.]")
}

/// Appended to the tool result carrying the third strike, so a later run sees why this one stopped there.
pub fn loop_trip_marker(tool: &str) -> String {
    format!("\n\n[Harness: the run was stopped after this third identical `{tool}` failure. On Resume, try a different approach — the details are in the reply text.]")
}

/// The note the user reads: names the call and its last error.
pub fn loop_trip_user_note(tool: &str, last_error: &str) -> String {
    let error = last_error.trim();
    let error = if error.chars().count() > 300 { format!("{}…", head(error, 300)) } else { error.to_string() };
    let quoted = if error.is_empty() { String::new() } else { format!(" (last error: {error})") };
    format!("Stopped by the loop breaker: `{tool}` failed three times with identical arguments{quoted}. The run was halted instead of burning more rounds — say what to try differently and Resume to carry on.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run::cases;

    #[test]
    fn matches_the_web() {
        let mut breaker = LoopBreaker::default();
        for (i, o) in cases("loop_observe") {
            let seen = breaker.observe(i[0].as_str().unwrap(), &i[1], i[2].as_bool().unwrap());
            let want = LoopObservation { repeats: o["repeats"].as_u64().unwrap() as u32, warn: o["warn"].as_bool().unwrap(), trip: o["trip"].as_bool().unwrap() };
            assert_eq!(seen, want, "{i}");
        }
        for (i, o) in cases("loop_texts") {
            let tool = i.as_str().unwrap();
            assert_eq!(loop_warning_text(tool), o[0].as_str().unwrap());
            assert_eq!(loop_trip_marker(tool), o[1].as_str().unwrap());
            assert_eq!(loop_trip_user_note(tool, "Could not find the text to replace"), o[2].as_str().unwrap());
            assert_eq!(loop_trip_user_note(tool, &format!("  {}", "e".repeat(400))), o[3].as_str().unwrap());
            assert_eq!(loop_trip_user_note(tool, " "), o[4].as_str().unwrap());
        }
    }
}

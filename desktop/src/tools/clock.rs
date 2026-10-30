//! Time, told to the model. A model has no clock: it read "count 15 minutes" and could not tell when they were up,
//! could not say how long the user had been away or had run, and took the year it remembered for this one (other
//! agents bought a transit ticket for the wrong hour and wrote last year's date into a mail, with the date in front of
//! them). The app has the times, so it says them: when each message was sent, how long since the last one, the time
//! as a run goes on, and the timers it was asked for.

use super::{ChatState, Ctx, Output};
use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// A countdown (`length_ms`) or a stopwatch the model started for the user. Times are ms since the epoch.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timer {
    pub label: String,
    pub from: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped: Option<u64>,
}

/// Timers kept with a chat; starting another drops the oldest.
const KEPT: usize = 8;

impl Timer {
    pub fn ends(&self) -> Option<u64> {
        self.length_ms.map(|length| self.from + length)
    }

    /// Still counting at `now`: not stopped, and a countdown not over.
    pub fn running(&self, now: u64) -> bool {
        self.stopped.is_none() && self.ends().is_none_or(|end| now < end)
    }

    /// What the chip shows: a countdown's time left, a stopwatch's time so far.
    pub fn shown(&self, now: u64) -> u64 {
        match self.ends() {
            Some(end) => end.saturating_sub(self.stopped.unwrap_or(now).max(self.from)),
            None => self.stopped.unwrap_or(now).saturating_sub(self.from),
        }
    }

    /// One line for the model, with every time it needs to answer exactly.
    pub fn describe(&self, now: u64) -> String {
        let name = &self.label;
        let Some(length) = self.length_ms else {
            return match self.stopped {
                Some(end) => format!("Stopwatch \"{name}\": {} to {}, {}.", fine(self.from, now), fine(end, now), span(end.saturating_sub(self.from))),
                None if now < self.from => format!("Stopwatch \"{name}\": starts at {}, in {}.", fine(self.from, now), span(self.from - now)),
                None => format!("Stopwatch \"{name}\": started {}, running for {}.", fine(self.from, now), span(now - self.from)),
            };
        };
        let (end, head) = (self.from + length, format!("Timer \"{name}\" ({})", span(length)));
        match self.stopped {
            Some(stop) if stop < end => format!("{head}: stopped at {} with {} left.", at(stop, now), span(end - stop.max(self.from))),
            _ if now >= end => format!("{head}: ended at {}, {} ago.", at(end, now), span(now - end)),
            _ => format!("{head}: started {}, ends {}, {} left.", at(self.from, now), at(end, now), span(end - now.max(self.from))),
        }
    }
}

fn local(ms: u64) -> DateTime<Local> {
    DateTime::from_timestamp_millis(ms as i64).unwrap_or_default().with_timezone(&Local)
}

/// When a message was sent, as the history shows it: `[2026-10-30 Thu 15:20:07]`.
pub fn stamp(ms: u64) -> String {
    local(ms).format("[%Y-%m-%d %a %H:%M:%S]").to_string()
}

/// A time of day, with the day when it is not today's.
fn at(ms: u64, now: u64) -> String {
    let (t, today) = (local(ms), local(now));
    t.format(if t.date_naive() == today.date_naive() { "%H:%M:%S" } else { "%a %-d %b %H:%M:%S" }).to_string()
}

/// `at` to the tenth of a second, for a stopwatch.
fn fine(ms: u64, now: u64) -> String {
    format!("{}.{}", at(ms, now), ms % 1000 / 100)
}

/// A span as a person says it: 44.3 s, 12 min 40 s, 2 h 5 min, 3 days 4 h.
pub fn span(ms: u64) -> String {
    let s = ms / 1000;
    let two = |big: u64, a: &str, small: u64, b: &str| if small == 0 { format!("{big} {a}") } else { format!("{big} {a} {small} {b}") };
    match s {
        0..60 => format!("{:.1} s", ms as f64 / 1000.0),
        60..3600 => two(s / 60, "min", s % 60, "s"),
        3600..86_400 => two(s / 3600, "h", s % 3600 / 60, "min"),
        _ => two(s / 86_400, if s < 172_800 { "day" } else { "days" }, s % 86_400 / 3600, "h"),
    }
}

/// The time now with the user's offset from UTC, for the note before the question: not their city, their clock.
pub fn now_line(now: u64) -> String {
    local(now).format("The time is %H:%M:%S (UTC%:z).").to_string()
}

/// The date and the time in full, for a reply resumed later than it began: its saved note has the day it began.
pub fn now_full(now: u64) -> String {
    local(now).format("It is now %Y-%m-%d, %A, %H:%M:%S (UTC%:z).").to_string()
}

/// The rest of the note's time: when the question was sent if not just now, and how long since the user's previous
/// message and since the answer to it ended.
pub fn note(state: &ChatState, now: u64) -> String {
    let asked = if state.asked_at == 0 { now } else { state.asked_at };
    let mut out = String::new();
    // A retried or resumed question was asked earlier than now.
    if now.saturating_sub(asked) >= 60_000 {
        out += &format!(" This question was sent at {}, {} ago.", at(asked, now), span(now - asked));
    }
    if state.previous_at > 0 && state.previous_at <= asked {
        out += &format!(" The user's previous message was sent {} before this one", span(asked - state.previous_at));
        if state.answered_at > state.previous_at && state.answered_at <= asked {
            out += &format!(", and your answer to it ended {} before it", span(asked - state.answered_at));
        }
        out += ".";
    }
    out
}

/// Every timer the chat keeps, a line each, for the end of the note.
pub fn timers(state: &ChatState, now: u64) -> String {
    state.timers.iter().map(|t| format!("\n{}", t.describe(now))).collect()
}

/// The line the tool results carry as a run goes on: the time, how long the run has taken, and the timers still
/// counting or over since the run began. `None` when nothing is worth the tokens yet.
pub fn tick(state: &ChatState, started: u64, last: u64, now: u64) -> Option<String> {
    // A countdown that ran out since the last line is said once more, as over.
    let live: Vec<String> = state.timers.iter().filter(|t| t.running(now) || (t.stopped.is_none() && t.ends().is_some_and(|end| end > last && end <= now))).map(|t| t.describe(now)).collect();
    // Once a minute, or every round while a timer counts: a deadline is kept by seeing it come.
    if live.is_empty() && now.saturating_sub(last) < 60_000 {
        return None;
    }
    let mut line = format!("[Clock: {}, {} since the question.", at(now, started), span(now.saturating_sub(started)));
    for timer in live {
        line += " ";
        line += &timer;
    }
    Some(line + "]")
}

/// When the user's last message in `messages` was sent, and when the answer to it ended (0: none, or not known).
pub fn last_exchange(messages: &[crate::store::Message]) -> (u64, u64) {
    use crate::store::Role;
    let Some(i) = messages.iter().rposition(|m| m.role == Role::User && !m.note) else { return (0, 0) };
    let answered = messages[i + 1..].iter().rev().find(|m| m.role == Role::Assistant && m.duration_ms > 0).map_or(0, |m| m.created_at + m.duration_ms);
    (messages[i].created_at, answered)
}

pub fn schema() -> Value {
    json!({ "type": "function", "function": {
        "name": "timer",
        "description": "Count time for the user: a countdown (\"count 15 minutes\", \"I'll be back in an hour\") or a stopwatch (\"time my run, I start in 3 seconds\"). It counts from when the user's message was sent, not from when you call it. `stop` ends a stopwatch at the user's newest message (their \"done\"), or now if it started after that. Every timer's exact times come back, and the note before each question repeats them: tell the user what it counted when they return.",
        "parameters": { "type": "object", "properties": {
            "action": { "type": "string", "enum": ["start", "stop", "check"], "description": "`check` (the default) lists the timers." },
            "label": { "type": "string", "description": "A short name, e.g. \"run\" or \"back in 15\". The same label replaces that timer." },
            "minutes": { "type": "number", "description": "A countdown's length. Leave out minutes and seconds for a stopwatch." },
            "seconds": { "type": "number", "description": "Added to minutes." },
            "after_seconds": { "type": "number", "description": "Start this long after the user's message (\"I start in 3 seconds\": 3)." }
        }, "required": [] }
    }})
}

pub fn timer(ctx: &Ctx, args: &Value) -> Output {
    let now = crate::store::now_ms();
    let mut chat = ctx.chat.lock().unwrap();
    let out = run(&mut chat, args, now);
    drop(chat);
    if out.ok {
        ctx.emit.state(ctx.chat.lock().unwrap().clone());
    }
    out
}

fn run(chat: &mut ChatState, args: &Value, now: u64) -> Output {
    let asked = if chat.asked_at == 0 { now } else { chat.asked_at };
    let label = args["label"].as_str().map(str::trim).filter(|label| !label.is_empty());
    let number = |key: &str| args[key].as_f64().or_else(|| args[key].as_str().and_then(|s| s.trim().parse().ok())).unwrap_or(0.0).max(0.0);
    let summary = match args["action"].as_str().unwrap_or("check") {
        "start" => {
            let length = (number("minutes") * 60_000.0 + number("seconds") * 1000.0) as u64;
            let label = label.unwrap_or(if length > 0 { "timer" } else { "stopwatch" }).to_string();
            let timer = Timer { label: label.clone(), from: asked + (number("after_seconds") * 1000.0) as u64, length_ms: (length > 0).then_some(length), stopped: None };
            chat.timers.retain(|t| t.label != label);
            chat.timers.push(timer);
            let extra = chat.timers.len().saturating_sub(KEPT);
            chat.timers.drain(..extra);
            format!("Timer started: {label}")
        }
        "stop" => {
            let found = chat.timers.iter_mut().rev().find(|t| t.running(now) && label.is_none_or(|l| t.label == l));
            let Some(timer) = found else {
                return Output::fail(format!("No running timer{}. Running or not, they are:\n{}", label.map(|l| format!(" called \"{l}\"")).unwrap_or_default(), list(chat, now)));
            };
            // The user's "done" is the moment, not the moment this call came.
            timer.stopped = Some(if timer.from <= asked { asked } else { now });
            format!("Timer stopped: {}", timer.label)
        }
        _ => "Timers checked".to_string(),
    };
    Output::ok(list(chat, now), summary)
}

fn list(chat: &ChatState, now: u64) -> String {
    if chat.timers.is_empty() {
        return "No timers.".into();
    }
    chat.timers.iter().map(|t| t.describe(now)).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60_000;

    #[test]
    fn spans_read_as_people_say_them() {
        assert_eq!(span(44_300), "44.3 s");
        assert_eq!(span(15 * MIN), "15 min");
        assert_eq!(span(12 * MIN + 40_000), "12 min 40 s");
        assert_eq!(span(125 * MIN), "2 h 5 min");
        assert_eq!(span(26 * 60 * MIN), "1 day 2 h");
        assert_eq!(span(72 * 60 * MIN), "3 days");
    }

    /// "I start running in 3 seconds" at T, "finished" at T + 47.3 s: 44.3 s, however late either call came.
    #[test]
    fn a_stopwatch_counts_between_the_users_messages() {
        let t = 1_800_000_000_000;
        let mut chat = ChatState { asked_at: t, ..Default::default() };
        assert!(run(&mut chat, &json!({ "action": "start", "label": "run", "after_seconds": 3 }), t + 5_000).ok);
        chat.asked_at = t + 47_300;
        let stopped = run(&mut chat, &json!({ "action": "stop" }), t + 52_000);
        assert!(stopped.ok && stopped.text.ends_with(", 44.3 s."), "{}", stopped.text);
        assert!(!run(&mut chat, &json!({ "action": "stop" }), t + 53_000).ok, "nothing is left running");
    }

    #[test]
    fn a_countdown_counts_from_the_message_and_says_when_it_ended() {
        let t = 1_800_000_000_000;
        let mut chat = ChatState { asked_at: t, ..Default::default() };
        run(&mut chat, &json!({ "action": "start", "label": "back", "minutes": 15 }), t + 9_000);
        let timer = &chat.timers[0];
        assert!(timer.describe(t + 9_000).ends_with("14 min 51 s left."), "{}", timer.describe(t + 9_000));
        assert_eq!(timer.shown(t + 9_000), 15 * MIN - 9_000);
        assert!(timer.describe(t + 17 * MIN).ends_with(", 2 min ago."));
        assert!(!timer.running(t + 15 * MIN));
        // Started again under the same name, it replaces the first.
        run(&mut chat, &json!({ "action": "start", "label": "back", "minutes": "5" }), t);
        assert_eq!((chat.timers.len(), chat.timers[0].length_ms), (1, Some(5 * MIN)));
    }

    #[test]
    fn the_note_says_how_long_the_user_was_away() {
        let t = 1_800_000_000_000;
        let state = ChatState { asked_at: t + 15 * MIN + 12_000, previous_at: t, answered_at: t + 20_000, ..Default::default() };
        let note = note(&state, t + 15 * MIN + 13_000);
        assert_eq!(note, " The user's previous message was sent 15 min 12 s before this one, and your answer to it ended 14 min 52 s before it.");
        assert!(super::note(&state, t + 20 * MIN).contains("This question was sent at"), "a retried question says when it was asked");
    }

    #[test]
    fn the_run_hears_the_clock_once_a_minute_or_while_a_timer_counts() {
        let t = 1_800_000_000_000;
        let mut state = ChatState::default();
        assert_eq!(tick(&state, t, t, t + 30_000), None);
        assert!(tick(&state, t, t, t + 61_000).unwrap().contains(", 1 min 1 s since the question."));
        state.timers.push(Timer { label: "task".into(), from: t, length_ms: Some(10 * MIN), stopped: None });
        assert!(tick(&state, t, t, t + 30_000).unwrap().contains("9 min 30 s left"));
        // Over during the run: said once more, as over, and then only with the minute's line.
        assert!(tick(&state, t, t + 9 * MIN, t + 10 * MIN + 5_000).unwrap().contains("ended at"));
        assert_eq!(tick(&state, t, t + 10 * MIN + 5_000, t + 10 * MIN + 30_000), None);
    }
}

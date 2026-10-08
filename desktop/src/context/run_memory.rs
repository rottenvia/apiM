//! A short-lived memory of what THIS run just wrote: port of src/lib/run-memory.ts.
//! After writing a file the agent often asks read_file for the exact file it just produced, a whole round to "see"
//! text it already holds verbatim. Routing that read back to the bytes it wrote is faster and cheaper. Correctness first:
//! only whole-file reads of a path the agent wrote ITSELF are answered from here, and any tool that can change files
//! behind the writers' backs (run_command, run_tests, build_project, start_process) must call `invalidate_all`.
//! One per reply; never touches disk, so it cannot serve stale content across chats. Share it as `Arc<RunFileMemory>`.

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
struct Inner {
    /// Path (normalised) -> exact content the agent wrote.
    written: HashMap<String, String>,
    /// Path -> exact content last handed over WHOLE by a read.
    served_whole: HashMap<String, String>,
}

#[derive(Default)]
pub struct RunFileMemory(Mutex<Inner>);

/// The same path normalisation the workspace tools compare with.
fn key(path: &str) -> String {
    let p = super::js_trim(path).replace('\\', "/");
    p.strip_prefix("./").unwrap_or(&p).trim_end_matches('/').to_string()
}

impl RunFileMemory {
    pub fn new() -> RunFileMemory {
        RunFileMemory::default()
    }

    /// The agent wrote `content` to `path`.
    pub fn record_write(&self, path: &str, content: &str) {
        self.0.lock().unwrap().written.insert(key(path), content.to_string());
    }

    /// Forgets everything a shell command, test run or build could have changed on disk.
    pub fn invalidate_all(&self) {
        let mut m = self.0.lock().unwrap();
        m.written.clear();
        m.served_whole.clear();
    }

    /// Forgets one file (renamed or deleted).
    pub fn invalidate(&self, path: &str) {
        let mut m = self.0.lock().unwrap();
        m.written.remove(&key(path));
        m.served_whole.remove(&key(path));
    }

    /// A read returned this file's complete content.
    pub fn record_whole_read(&self, path: &str, content: &str) {
        self.0.lock().unwrap().served_whole.insert(key(path), content.to_string());
    }

    /// Was this exact content already handed over whole in this run?
    pub fn already_served_whole(&self, path: &str, content: &str) -> bool {
        self.0.lock().unwrap().served_whole.get(&key(path)).is_some_and(|c| c == content)
    }

    /// Exact content the agent wrote to `path`, if known.
    pub fn get(&self, path: &str) -> Option<String> {
        self.0.lock().unwrap().written.get(&key(path)).cloned()
    }
}

/// Drops everything a run remembers, after anything that may have written files without going through the file tools.
/// Safe on a missing memory. read_file also checks remembered bytes against the disk before serving them, so a missed call costs a disk read, not a stale answer.
pub fn invalidate_run_memory(memory: Option<&RunFileMemory>) {
    if let Some(m) = memory {
        m.invalidate_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::testkit::check;
    use serde_json::{Value, json};

    #[test]
    fn replays_the_web_class() {
        check("run_memory.ops", |ops| {
            let m = RunFileMemory::new();
            let s = |o: &Value, i: usize| o[i].as_str().unwrap_or("").to_string();
            Value::Array(
                ops.as_array()
                    .unwrap()
                    .iter()
                    .map(|o| match o[0].as_str().unwrap() {
                        "recordWrite" => { m.record_write(&s(o, 1), &s(o, 2)); Value::Null }
                        "get" => json!(m.get(&s(o, 1))),
                        "recordWholeRead" => { m.record_whole_read(&s(o, 1), &s(o, 2)); Value::Null }
                        "served" => json!(m.already_served_whole(&s(o, 1), &s(o, 2))),
                        "invalidate" => { m.invalidate(&s(o, 1)); Value::Null }
                        "invalidateAll" => { m.invalidate_all(); Value::Null }
                        "invalidateRun" => { invalidate_run_memory(Some(&m)); invalidate_run_memory(None); Value::Null }
                        other => panic!("{other}"),
                    })
                    .collect(),
            )
        });
    }
}

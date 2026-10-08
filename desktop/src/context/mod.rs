//! Context management for the agent loop, ported from the web app's src/lib (prune, tool-limits, workspace-context,
//! tree-delta, goal-pin, run-memory, findings, history-summary, refine, subagent, runs, rebuild-resume, resume-target).
//! Pure functions over plain data (strings, OpenAI-shaped `serde_json::Value` messages, paths); the few that must call a
//! model take a `&reqwest::Client` and endpoint strings. Nothing here depends on the UI or on agent.rs, and nothing is
//! called yet: the integration guide lists where each piece plugs into the round loop.
//! `fixtures.json` holds inputs and outputs recorded from the real TypeScript; every module's tests replay them.
#![allow(dead_code)]

pub mod findings;
pub mod goal_pin;
pub mod history_summary;
pub mod prune;
pub mod rebuild_resume;
pub mod refine;
pub mod run_memory;
pub mod runs;
pub mod subagent;
pub mod tool_limits;
pub mod tree_delta;
pub mod workspace_context;

use serde_json::Value;
use std::cmp::Ordering;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

// ---- JavaScript string semantics the web code leans on ----

/// JS `s.length`: UTF-16 code units, not bytes or chars. Every size threshold in the web code is in these.
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `s.slice(0, n)`. A cut that would split a surrogate pair drops the whole character (JS keeps a lone half, which a Rust string cannot hold).
pub fn js_head(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// JS `s.slice(n)`. A pair split by `n` goes whole to the tail, so head and tail never lose a character between them.
pub fn js_tail(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        if units + c.len_utf16() > n {
            return &s[i..];
        }
        units += c.len_utf16();
    }
    ""
}

/// JS `s.trim()`: Rust's whitespace set minus U+0085 plus the byte-order mark.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// JS `Math.round` for the non-negative numbers used here: halves round up.
pub fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// JS `String(v)` for a JSON value (`null` is "null"; the callers handle their own `??` first).
// ponytail: floats print the Rust way, which differs from JS only for exponent forms (1e21 and up, below 1e-6); stored findings never hold those.
pub fn js_str(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match (n.as_i64(), n.as_f64()) {
            (Some(i), _) => i.to_string(),
            (_, Some(f)) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{}", f as i128),
            (_, Some(f)) => f.to_string(),
            _ => n.to_string(),
        },
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_str(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// JS truthiness of a JSON value.
pub fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// What JS regex `\s` matches, for use inside a character class.
pub const JS_SPACE: &str = r"\t-\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

/// A JSON string literal exactly as `JSON.stringify` writes it.
pub fn jstr(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

/// ICU root collation order of printable ASCII, from V8's `localeCompare` (punctuation, symbols, digits, then letters, lower before upper).
const COLLATION: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ";

fn primary(c: char) -> u32 {
    COLLATION.find(c.to_ascii_lowercase()).map_or(0, |i| i as u32)
}

/// Base letters of U+00C0..U+00FF ('.' where there is none), and of Latin Extended-A U+0100..U+017F.
const LATIN1: &[u8; 64] = b"AAAAAAACEEEEIIIIDNOOOOO.OUUUUYTsaaaaaaaceeeeiiiidnooooo.ouuuuyty";
const LATIN_A: &str = concat!("aaaaaa", "cccccccc", "dddd", "eeeeeeeeee", "gggggggg", "hhhh", "iiiiiiiiii", "ii", "jj", "kkk", "llllllllll", "nnnnnnnnn", "oooooooo", "rrrrrr", "ssssssss", "tttttt", "uuuuuuuuuuuu", "ww", "yyy", "zzzzzz", "s");

/// (primary, secondary) weight of a character: the letter with its accent stripped, then which accent (0 for none).
fn weights(c: char) -> (u32, u32) {
    if c.is_ascii() {
        return (primary(c), 0);
    }
    let cp = c as u32;
    let base = match cp {
        0xC0..=0xFF => LATIN1[(cp - 0xC0) as usize],
        0x100..=0x17F => LATIN_A.as_bytes()[(cp - 0x100) as usize],
        _ => b'.',
    };
    if base == b'.' { (1000 + cp, 0) } else { (primary(base as char), cp) }
}

/// JS `a.localeCompare(b)` for the paths and ISO timestamps the web sorts: the whole string by primary weight, then by accent, then case (lower before upper).
// ponytail: exact for ASCII and for Latin-1 / Latin Extended-A letters (they sort beside their base letter, "ß" as "s", "æ" as "a"). Other scripts sort by code point after every Latin letter, where ICU interleaves them differently. A collation crate fixes it.
pub fn locale_cmp(a: &str, b: &str) -> Ordering {
    a.chars().map(|c| weights(c).0).cmp(b.chars().map(|c| weights(c).0)).then_with(|| a.chars().map(|c| weights(c).1).cmp(b.chars().map(|c| weights(c).1))).then_with(|| {
        a.chars().zip(b.chars()).find(|(x, y)| x != y).map_or(Ordering::Equal, |(x, _)| if x.is_lowercase() { Ordering::Less } else { Ordering::Greater })
    })
}

/// File size as the model's listings print it: `512B`, `12KB`, `1.3MB` (JS `toFixed` rounds halves up, which `format!` does not).
pub fn format_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes}B")
    } else if bytes < 1024 * 1024 {
        format!("{}KB", (bytes + 512) / 1024)
    } else {
        let tenths = (bytes as u128 * 10 + 524_288) / 1_048_576;
        format!("{}.{}MB", tenths / 10, tenths % 10)
    }
}

/// Milliseconds since the Unix epoch: `Date.now()`.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// `new Date(ms).toISOString()`.
pub fn iso_ms(ms: u64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms as i64).map_or_else(String::new, |d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// `n.toString(36)`.
pub fn radix36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

// ---- stopping, and one POST helper for the model calls ----

/// A cancel flag a run, a helper and a request can all watch: the web's AbortSignal. Cloning shares it.
#[derive(Clone)]
pub struct Stop {
    tx: Arc<watch::Sender<bool>>,
    parents: Vec<Stop>,
}

impl Default for Stop {
    fn default() -> Self {
        Stop::new()
    }
}

impl Stop {
    pub fn new() -> Stop {
        Stop { tx: Arc::new(watch::channel(false).0), parents: Vec::new() }
    }
    /// A stop that also fires when any of `parents` does: `AbortSignal.any`.
    pub fn any(parents: &[&Stop]) -> Stop {
        Stop { tx: Arc::new(watch::channel(false).0), parents: parents.iter().map(|p| (*p).clone()).collect() }
    }
    pub fn stop(&self) {
        self.tx.send_replace(true);
    }
    pub fn is_stopped(&self) -> bool {
        *self.tx.borrow() || self.parents.iter().any(Stop::is_stopped)
    }
    /// Same flag, not merely an equal one.
    pub fn same(&self, other: &Stop) -> bool {
        Arc::ptr_eq(&self.tx, &other.tx)
    }
    /// Resolves once this or any parent is stopped.
    pub fn stopped(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let mut rx = self.tx.subscribe();
            let mut waits: Vec<Pin<Box<dyn Future<Output = ()> + Send + '_>>> = vec![Box::pin(async move {
                let _ = rx.wait_for(|v| *v).await;
            })];
            waits.extend(self.parents.iter().map(Stop::stopped));
            futures_util::future::select_all(waits).await;
        })
    }
}

/// POST a JSON body. Ok is the HTTP status and body text (any status); Err is a transport failure, a timeout, or "stopped".
pub async fn post_json(client: &reqwest::Client, url: &str, headers: &[(String, String)], body: &Value, timeout: Option<Duration>, stop: Option<&Stop>) -> Result<(u16, String), String> {
    let mut req = client.post(url).body(serde_json::to_vec(body).map_err(|e| e.to_string())?);
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
        req = req.header("Content-Type", "application/json");
    }
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(t) = timeout {
        req = req.timeout(t);
    }
    let go = async {
        let res = req.send().await.map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        Ok::<_, String>((status, res.text().await.unwrap_or_default()))
    };
    match stop {
        Some(s) => tokio::select! { r = go => r, _ = s.stopped() => Err("stopped".to_string()) },
        None => go.await,
    }
}

/// Test support: fixture replay and a throwaway HTTP server on 127.0.0.1.
#[cfg(test)]
pub(crate) mod testkit {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{LazyLock, Mutex};

    static FIXTURES: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(include_str!("fixtures.json")).expect("fixtures.json parses"));

    /// Strings the fixture file spells as markers are written out in full: `{"$rep":[s,n]}`, `{"$cat":[parts]}`, `{"$files":{dirs,per,pad}}`.
    pub fn expand(v: &Value) -> Value {
        match v {
            Value::Array(a) => Value::Array(a.iter().map(expand).collect()),
            Value::Object(o) => {
                if o.len() == 1 {
                    if let Some(r) = o.get("$rep") {
                        return Value::String(r[0].as_str().unwrap().repeat(r[1].as_f64().unwrap() as usize));
                    }
                    if let Some(c) = o.get("$cat") {
                        return Value::String(c.as_array().unwrap().iter().map(|p| expand(p).as_str().unwrap().to_string()).collect());
                    }
                    if let Some(f) = o.get("$files") {
                        let (dirs, per, pad) = (f["dirs"].as_u64().unwrap(), f["per"].as_u64().unwrap(), f["pad"].as_u64().unwrap() as usize);
                        return Value::Array((0..dirs).flat_map(|d| (0..per).map(move |j| json!([format!("d{d:02}/{}{j:04}.txt", "n".repeat(pad)), (j * j * 131 + d * 7) % 3_000_000]))).collect());
                    }
                }
                Value::Object(o.iter().map(|(k, x)| (k.clone(), expand(x))).collect())
            }
            _ => v.clone(),
        }
    }

    pub fn sha_marker(s: &str) -> Value {
        json!({ "$sha256": format!("{:x}", Sha256::digest(s.as_bytes())), "len": js_len(s) })
    }

    /// Long strings become `{$sha256, len}`, the way the generator wrote the recorded outputs.
    pub fn compact(v: &Value) -> Value {
        match v {
            Value::String(s) if js_len(s) > 300 => sha_marker(s),
            Value::Array(a) => Value::Array(a.iter().map(compact).collect()),
            Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), compact(x))).collect()),
            _ => v.clone(),
        }
    }

    /// A request body the way the generator recorded it: the system prompt (first message) as a hash.
    pub fn sys0(body: &Value) -> Value {
        let mut b = body.clone();
        if let Some(c) = b["messages"][0]["content"].as_str().map(str::to_string) {
            b["messages"][0]["content"] = sha_marker(&c);
        }
        b
    }

    pub fn cases(name: &str) -> Vec<(Value, Value)> {
        let all = FIXTURES[name].as_array().unwrap_or_else(|| panic!("no fixtures named {name}"));
        assert!(!all.is_empty(), "{name} has no cases");
        all.iter().map(|p| (p[0].clone(), p[1].clone())).collect()
    }

    /// Replays every recorded case of `name` through `f` and compares exactly.
    pub fn check(name: &str, f: impl Fn(&Value) -> Value) {
        for (i, (spec, want)) in cases(name).iter().enumerate() {
            let got = f(&expand(spec));
            if compact(&got) != *want {
                eprintln!("{name} case {i} got: {}", got.to_string().chars().take(4000).collect::<String>());
            }
            assert_eq!(&compact(&got), want, "{name} case {i}: input {}", spec.to_string().chars().take(300).collect::<String>());
        }
    }

    pub fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    pub struct Seen {
        pub path: String,
        pub headers: HashMap<String, String>,
        pub body: Value,
    }

    pub struct Stub {
        pub base: String,
        pub seen: Arc<Mutex<Vec<Seen>>>,
    }

    impl Stub {
        pub fn requests(&self) -> Vec<Value> {
            self.seen.lock().unwrap().iter().map(|s| json!({ "url": s.path, "headers": s.headers, "body": s.body })).collect()
        }
    }

    fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len()).position(|w| w == needle)
    }

    /// Serves `replies` in order (the last one repeats) on a loopback port. Status 0 closes the connection without answering.
    pub fn stub(replies: Vec<(u16, String)>) -> Stub {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for (k, conn) in listener.incoming().enumerate() {
                let Ok(mut s) = conn else { continue };
                let (status, reply) = replies[k.min(replies.len() - 1)].clone();
                let (mut buf, mut chunk) = (Vec::new(), [0u8; 4096]);
                let head_end = loop {
                    let n = s.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break None;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(p) = find(&buf, b"\r\n\r\n") {
                        break Some(p);
                    }
                };
                let Some(p) = head_end else { continue };
                let head = String::from_utf8_lossy(&buf[..p]).to_string();
                let mut lines = head.lines();
                let path = lines.next().unwrap_or("").split(' ').nth(1).unwrap_or("").to_string();
                let headers: HashMap<String, String> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string())).collect();
                let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
                let mut body = buf[p + 4..].to_vec();
                while body.len() < len {
                    let n = s.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    body.extend_from_slice(&chunk[..n]);
                }
                log.lock().unwrap().push(Seen { path, headers, body: serde_json::from_slice(&body).unwrap_or(Value::Null) });
                if status == 0 {
                    continue;
                }
                let _ = write!(s, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len());
            }
        });
        Stub { base, seen }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_lengths_and_cuts() {
        assert_eq!(js_len("a😀日"), 4);
        assert_eq!(js_head("a😀b", 2), "a");
        assert_eq!(js_head("a😀b", 3), "a😀");
        assert_eq!(js_tail("a😀b", 2), "😀b");
        assert_eq!(js_tail("abc", 5), "");
        assert_eq!(js_head("abc", 9), "abc");
        assert_eq!(js_trim("\u{feff} x\u{85}\n"), "x\u{85}");
    }

    #[test]
    fn rounding_and_sizes() {
        assert_eq!((js_round(2.5), js_round(2.4999), js_round(0.0)), (3.0, 2.0, 0.0));
        let sizes: Vec<String> = [0, 1023, 1024, 1535, 1536, 1048575, 1048576, 1310720, 3145728].iter().map(|&b| format_size(b)).collect();
        assert_eq!(sizes, ["0B", "1023B", "1KB", "1KB", "2KB", "1024KB", "1.0MB", "1.3MB", "3.0MB"]);
        assert_eq!((radix36(0), radix36(35), radix36(36)), ("0".to_string(), "z".to_string(), "10".to_string()));
        assert_eq!(iso_ms(1767323045678), "2026-01-02T03:04:05.678Z");
        assert_eq!(js_str(&serde_json::json!([1, null, "a", [2, 3]])), "1,,a,2,3");
        assert_eq!(LATIN_A.len(), 128);
    }

    #[test]
    fn locale_compare_matches_v8() {
        testkit::check("mod.localeCompare", |input| serde_json::json!(locale_cmp(input[0].as_str().unwrap(), input[1].as_str().unwrap()) as i32));
    }

    #[tokio::test]
    async fn stop_wakes_waiters_and_children() {
        let (parent, child) = (Stop::new(), Stop::new());
        let both = Stop::any(&[&parent, &child]);
        assert!(!both.is_stopped());
        let waiter = tokio::spawn({
            let both = both.clone();
            async move { both.stopped().await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        child.stop();
        tokio::time::timeout(Duration::from_secs(2), waiter).await.unwrap().unwrap();
        assert!(both.is_stopped() && !parent.is_stopped() && both.same(&both.clone()) && !both.same(&child));
    }

    #[tokio::test]
    async fn post_json_reports_status_and_transport_failures() {
        let stub = testkit::stub(vec![(200, "{\"a\":1}".into()), (429, "slow".into()), (0, String::new())]);
        let url = format!("{}/x", stub.base);
        let c = testkit::client();
        let hdr = [("Authorization".to_string(), "Bearer k".to_string())];
        assert_eq!(post_json(&c, &url, &hdr, &serde_json::json!({"q": 1}), None, None).await, Ok((200, "{\"a\":1}".to_string())));
        assert_eq!(post_json(&c, &url, &[], &serde_json::json!({}), Some(Duration::from_secs(5)), None).await, Ok((429, "slow".to_string())));
        assert!(post_json(&c, &url, &[], &serde_json::json!({}), None, None).await.is_err());
        let seen = stub.requests();
        assert_eq!((seen[0]["url"].as_str(), seen[0]["headers"]["authorization"].as_str(), seen[0]["headers"]["content-type"].as_str()), (Some("/v1/x"), Some("Bearer k"), Some("application/json")));
        let stopped = Stop::new();
        stopped.stop();
        assert_eq!(post_json(&c, "http://127.0.0.1:9/never", &[], &serde_json::json!({}), None, Some(&stopped)).await, Err("stopped".to_string()));
    }
}

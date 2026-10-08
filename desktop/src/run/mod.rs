//! What the agent loop does around each model round, ported from the web app's
//! `src/lib` one file per module. Everything here is pure logic: `fixtures.json`
//! holds input/output pairs printed by the TypeScript originals, and each
//! module's tests replay them.

pub mod budget;
pub mod dedup;
pub mod loop_breaker;
pub mod plan;
pub mod reasoning_stream;
pub mod retry;
pub mod revive;
pub mod stall;
pub mod transcript;

/// `n` characters from the start (JS `slice(0, n)`, counted in characters).
pub fn head(text: &str, n: usize) -> &str {
    text.char_indices().nth(n).map_or(text, |(i, _)| &text[..i])
}

/// The last `n` characters (JS `slice(-n)`).
pub fn tail(text: &str, n: usize) -> &str {
    let total = text.chars().count();
    if total <= n { text } else { &text[text.char_indices().nth(total - n).map_or(0, |(i, _)| i)..] }
}

/// JS `toFixed`: ties round up, where Rust's `{:.N}` rounds them to even.
pub fn fixed(value: f64, digits: usize) -> String {
    let scale = 10f64.powi(digits as i32);
    format!("{:.digits$}", (value * scale + 0.5).floor() / scale)
}

/// The recorded (input, output) pairs of one TypeScript function.
#[cfg(test)]
pub fn cases(name: &str) -> Vec<(serde_json::Value, serde_json::Value)> {
    static ALL: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
    let all = ALL.get_or_init(|| serde_json::from_str(include_str!("fixtures.json")).unwrap());
    all[name].as_array().unwrap_or_else(|| panic!("no fixture named {name}")).iter().map(|pair| (pair[0].clone(), pair[1].clone())).collect()
}

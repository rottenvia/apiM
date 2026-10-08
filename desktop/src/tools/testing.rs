//! Running the project's tests and reporting only what matters. Ported from src/lib/testing.ts:
//! finds the runner from what is in the workspace, parses its output for counts and failing
//! tests, and renders a short summary for the model. Output nobody recognised is shown raw
//! (last 40 lines) rather than summarised, so an unknown format never reads as a clean pass.

use regex::{Captures, Regex};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::LazyLock;

/// How this project runs its tests.
#[derive(Debug, Clone, PartialEq)]
pub struct TestRunner {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    /// Why this runner was picked, so a wrong guess is debuggable.
    pub because: String,
}

/// One failing test, as the runner named it.
#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub name: String,
    pub detail: String,
}

/// The verdict and failures parsed from one run.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Summary {
    pub runner: String,
    pub passed: usize,
    pub failed: usize,
    pub skipped: usize,
    /// True when the exit code is zero and nothing failed.
    pub ok: bool,
    pub failures: Vec<Failure>,
    /// The output format was not recognised, so nothing was counted.
    pub unparsed: bool,
}

static PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)no test specified"));
static ANSI: LazyLock<Regex> = LazyLock::new(|| re(r"\x1b\[[0-9;]*m"));
static PY_TOTALS: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(?:^|\n)=*\s*(?:(\d+) failed)?[,\s]*(?:(\d+) passed)?[,\s]*(?:(\d+) skipped)?[^\n]*in [\d.]+s"));
static PY_FAILED: LazyLock<Regex> = LazyLock::new(|| re(r"(?mR)^FAILED\s+(\S+)\s*(?:-\s*(.*))?$"));
static PY_HEADER: LazyLock<Regex> = LazyLock::new(|| re(r"(?mR)^_+ (\S+) _+$"));
static VITEST: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed"));
static JEST: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)Tests:\s+(?:(\d+) failed,\s*)?(?:(\d+) skipped,\s*)?(\d+) passed"));
static JS_FAIL_LINE: LazyLock<Regex> = LazyLock::new(|| re(r"(?mR)^\s*(?:FAIL|×|✕)\s+(.+)$"));
static NODE_NOT_OK: LazyLock<Regex> = LazyLock::new(|| re(r"(?mR)^not ok \d+ - (.+)$"));
static NODE_DIRECTIVE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\s*#\s*(SKIP|TODO).*$"));
static NODE_SPEC_FAIL: LazyLock<Regex> = LazyLock::new(|| re(r"(?imR)^\s*[\x{2716}\x{00d7}x\x{2717}]\s+(.+?)\s+\([\d.]+m?s\)\s*$"));
static CARGO: LazyLock<Regex> = LazyLock::new(|| re(r"test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored"));
static CARGO_FAIL: LazyLock<Regex> = LazyLock::new(|| re(r"(?mR)^\s{4}(\S+)$"));
static GO_LINE: LazyLock<Regex> = LazyLock::new(|| re(r"(?mR)^(ok|FAIL|---)\s"));
static GO_FAIL: LazyLock<Regex> = LazyLock::new(|| re(r"(?mR)^--- FAIL: (\S+)"));
static GO_PASS: LazyLock<Regex> = LazyLock::new(|| re(r"(?mR)^--- PASS"));

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("testing pattern is valid")
}

/// A capture group as a count; a group that did not take part counts as zero.
fn num(c: &Captures, i: usize) -> usize {
    c.get(i).and_then(|m| m.as_str().parse().ok()).unwrap_or(0)
}

fn runner(name: &str, command: &str, args: &[&str], because: String) -> TestRunner {
    TestRunner { name: name.into(), command: command.into(), args: args.iter().map(|a| a.to_string()).collect(), because }
}

/// Works out how this project runs its tests. A package.json test script wins, because it may set
/// environment variables the bare binary would not.
pub fn detect_runner(dir: &Path) -> Option<TestRunner> {
    let exists = |rel: &str| dir.join(rel).exists();
    if exists("package.json") {
        // An unreadable package.json is not fatal: fall through to the other markers.
        if let Some(pkg) = std::fs::read_to_string(dir.join("package.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            let scripts = &pkg["scripts"];
            let script = scripts["test"].as_str().unwrap_or("");
            // The default `npm init` placeholder is not a test suite.
            if !script.is_empty() && !PLACEHOLDER.is_match(script) {
                return Some(runner("npm test", "npm", &["test", "--silent"], "package.json has a \"test\" script".into()));
            }
            if scripts["vitest"].as_str().is_some_and(|s| !s.is_empty()) || exists("vitest.config.ts") {
                return Some(runner("vitest", "npx", &["vitest", "run", "--reporter=verbose"], "a vitest config is present".into()));
            }
            if exists("jest.config.js") {
                return Some(runner("jest", "npx", &["jest", "--ci"], "a jest config is present".into()));
            }
        }
    }
    for marker in ["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"] {
        if exists(marker) {
            return Some(runner("pytest", "pytest", &["-q", "--no-header", "-rN"], format!("{marker} is present")));
        }
    }
    for d in ["tests", "test"] {
        if exists(d) {
            return Some(runner("pytest", "pytest", &["-q", "--no-header", "-rN", d], format!("a {d}/ directory exists")));
        }
    }
    if exists("Cargo.toml") {
        return Some(runner("cargo test", "cargo", &["test"], "Cargo.toml is present".into()));
    }
    if exists("go.mod") {
        return Some(runner("go test", "go", &["test", "./..."], "go.mod is present".into()));
    }
    None
}

/// Pulls the verdict and the failures out of one run's output. Every parser falls back to `unparsed` rather than
/// guessing: a summary that reads "0 failed" for output it did not recognise would tell the agent the suite passed.
pub fn parse_output(runner: &str, stdout: &str, stderr: &str, exit_code: i32) -> Summary {
    let text = ANSI.replace_all(&format!("{stdout}\n{stderr}"), "").into_owned();
    let mut s = Summary { runner: runner.into(), ok: exit_code == 0, ..Default::default() };

    // pytest: "5 passed, 2 failed, 1 skipped in 0.42s"
    if let Some(c) = PY_TOTALS.captures(&text) {
        if c.get(1).or(c.get(2)).or(c.get(3)).is_some() {
            s.failed = num(&c, 1);
            s.passed = num(&c, 2);
            s.skipped = num(&c, 3);
            s.ok = s.failed == 0 && exit_code == 0;
            // "FAILED tests/test_app.py::test_login - AssertionError: expected 200"
            for m in PY_FAILED.captures_iter(&text) {
                let detail = m.get(2).map_or("", |d| d.as_str()).trim();
                s.failures.push(Failure { name: m[1].to_string(), detail: if detail.is_empty() { "failed".into() } else { detail.to_string() } });
            }
            // Older pytest prints a header block instead of a FAILED line.
            if s.failures.is_empty() {
                for m in PY_HEADER.captures_iter(&text) {
                    s.failures.push(Failure { name: m[1].to_string(), detail: "see output".into() });
                }
            }
            return s;
        }
    }

    // vitest / jest: "Tests  2 failed | 5 passed (7)" or "Tests:  1 failed, 2 passed, 3 total"
    let vitest = VITEST.captures(&text);
    let jest = JEST.captures(&text);
    if vitest.is_some() || jest.is_some() {
        if let Some(v) = &vitest {
            s.failed = num(v, 1);
            s.passed = num(v, 2);
        } else if let Some(j) = &jest {
            s.failed = num(j, 1);
            s.skipped = num(j, 2);
            s.passed = num(j, 3);
        }
        s.ok = s.failed == 0 && exit_code == 0;
        for m in JS_FAIL_LINE.captures_iter(&text) {
            let name = m[1].trim();
            if !name.is_empty() {
                s.failures.push(Failure { name: name.to_string(), detail: "failed".into() });
            }
        }
        return s;
    }

    // node --test: TAP ("# pass 1") or spec ("ℹ pass 1"), told apart only by the counter lines both share.
    let node_count = |label: &str| -> Option<usize> {
        let p = re(&format!(r"(?mR)^\s*\S?\s*{label}\s+(\d+)\s*$"));
        p.captures(&text).and_then(|c| c[1].parse().ok())
    };
    if let (Some(_), Some(pass), Some(fail)) = (node_count("tests"), node_count("pass"), node_count("fail")) {
        s.passed = pass;
        s.failed = fail;
        s.skipped = node_count("skipped").unwrap_or(0);
        s.ok = s.failed == 0 && exit_code == 0;
        for m in NODE_NOT_OK.captures_iter(&text) {
            let name = NODE_DIRECTIVE.replace(&m[1], "").trim().to_string();
            if !name.is_empty() && s.failures.len() < 20 {
                s.failures.push(Failure { name, detail: "failed".into() });
            }
        }
        if s.failures.is_empty() {
            // Spec prints each failure twice (inline, then in the closing block): keep one.
            let mut seen: Vec<String> = Vec::new();
            for m in NODE_SPEC_FAIL.captures_iter(&text) {
                let name = m[1].trim().to_string();
                if !name.is_empty() && !seen.contains(&name) && s.failures.len() < 20 {
                    seen.push(name.clone());
                    s.failures.push(Failure { name, detail: "failed".into() });
                }
            }
        }
        return s;
    }

    // cargo test: "test result: ok. 3 passed; 0 failed; 1 ignored"
    if let Some(c) = CARGO.captures(&text) {
        s.passed = num(&c, 1);
        s.failed = num(&c, 2);
        s.skipped = num(&c, 3);
        s.ok = s.failed == 0 && exit_code == 0;
        for m in CARGO_FAIL.captures_iter(&text) {
            if s.failures.len() < 20 {
                s.failures.push(Failure { name: m[1].to_string(), detail: "failed".into() });
            }
        }
        return s;
    }

    // go test: "--- FAIL: TestAdd" and "--- PASS"
    if GO_LINE.is_match(&text) {
        for m in GO_FAIL.captures_iter(&text) {
            s.failures.push(Failure { name: m[1].to_string(), detail: "failed".into() });
        }
        s.failed = s.failures.len();
        s.passed = GO_PASS.find_iter(&text).count();
        s.ok = s.failed == 0 && exit_code == 0;
        return s;
    }

    // Recognised nothing: say so rather than reporting a clean run.
    s.unparsed = true;
    s.ok = exit_code == 0;
    s
}

/// The one-line headline the step row shows.
pub fn headline(s: &Summary) -> String {
    if s.unparsed {
        format!("Ran {} — output not recognised", s.runner)
    } else if s.ok {
        format!("All {} tests passed", s.passed)
    } else {
        format!("{} failed, {} passed", s.failed, s.passed)
    }
}

/// Renders the summary for the model. A passing run is one line; a failing run is the failures and nothing else.
pub fn format_summary(s: &Summary, raw: &str) -> String {
    if s.unparsed {
        // Never claim a result that was not understood: the raw tail is included because the structured path failed.
        let lines: Vec<&str> = raw.split('\n').collect();
        let tail = lines[lines.len().saturating_sub(40)..].join("\n");
        return format!("Ran {}. The output format was not recognised, so here are the last 40 lines verbatim — read them rather than trusting a summary:\n\n{tail}", s.runner);
    }
    let mut counts = format!("{} passed", s.passed);
    if s.failed > 0 {
        counts.push_str(&format!(", {} failed", s.failed));
    }
    if s.skipped > 0 {
        counts.push_str(&format!(", {} skipped", s.skipped));
    }
    if s.ok {
        return format!("{}: {counts}. Everything passed.", s.runner);
    }
    let mut lines = vec![format!("{}: {counts}.", s.runner), String::new()];
    if s.failures.is_empty() {
        lines.push("The runner exited non-zero but named no failing test — this is usually a collection error or a crash before the suite ran. Use run_command to see the full output.".into());
    } else {
        lines.push("Failing:".into());
        for f in s.failures.iter().take(25) {
            lines.push(if f.detail.is_empty() { format!("  {}", f.name) } else { format!("  {} — {}", f.name, f.detail) });
        }
        if s.failures.len() > 25 {
            lines.push(format!("  … and {} more", s.failures.len() - 25));
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn section(name: &str) -> Value {
        let all: Value = serde_json::from_str(include_str!("build_fixtures.json")).expect("fixtures parse");
        all["tests"][name].clone()
    }

    #[test]
    fn parsing_and_rendering_match_the_web() {
        for case in section("parse").as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let (stdout, stderr) = (case["stdout"].as_str().unwrap(), case["stderr"].as_str().unwrap());
            let s = parse_output(case["runner"].as_str().unwrap(), stdout, stderr, case["exit"].as_i64().unwrap() as i32);
            let want = &case["summary"];
            assert_eq!(s.passed as u64, want["passed"].as_u64().unwrap(), "{name}");
            assert_eq!(s.failed as u64, want["failed"].as_u64().unwrap(), "{name}");
            assert_eq!(s.skipped as u64, want["skipped"].as_u64().unwrap(), "{name}");
            assert_eq!(s.ok, want["ok"].as_bool().unwrap(), "{name}");
            assert_eq!(s.unparsed, want["unparsed"].as_bool().unwrap_or(false), "{name}");
            let got: Vec<Value> = s.failures.iter().map(|f| json!({ "name": f.name, "detail": f.detail })).collect();
            let wanted: Vec<Value> = want["failures"].as_array().unwrap().iter().map(|f| json!({ "name": f["name"], "detail": f["detail"] })).collect();
            assert_eq!(got, wanted, "{name}");
            assert_eq!(format_summary(&s, &format!("{stdout}\n{stderr}")), case["text"].as_str().unwrap(), "{name}");
        }
    }

    #[test]
    fn detection_matches_the_web() {
        for case in section("detect").as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let dir = std::env::temp_dir().join(format!("apim-tests-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            for (rel, content) in case["tree"].as_object().unwrap() {
                let p = dir.join(rel);
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::fs::write(&p, content.as_str().unwrap()).unwrap();
            }
            let got = detect_runner(&dir).map(|r| json!({ "name": r.name, "command": r.command, "args": r.args, "because": r.because }));
            assert_eq!(got.unwrap_or(Value::Null), case["expect"], "{name}");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn crlf_output_keeps_names() {
        // Windows line endings: JavaScript's `$` also stops before a carriage return, so the names must survive.
        let pytest = parse_output("pytest", "___ test_old ___\r\nE   boom\r\n1 failed, 2 passed in 0.10s\r\n", "", 1);
        assert_eq!(pytest.failures.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["test_old"]);
        let cargo = parse_output("cargo test", "test result: FAILED. 1 passed; 1 failed; 0 ignored\r\n    tests::a\r\n", "", 101);
        assert_eq!(cargo.failures.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["tests::a"]);
    }

    #[test]
    fn headline_wording() {
        let mut s = Summary { runner: "pytest".into(), passed: 4, ok: true, ..Default::default() };
        assert_eq!(headline(&s), "All 4 tests passed");
        s.ok = false;
        s.failed = 2;
        assert_eq!(headline(&s), "2 failed, 4 passed");
        s.unparsed = true;
        assert_eq!(headline(&s), "Ran pytest — output not recognised");
    }
}

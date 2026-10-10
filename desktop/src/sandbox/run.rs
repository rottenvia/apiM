//! Port of src/lib/sandbox-run.ts: running a shell command in the sandbox distro, starting a
//! background one, and screenshotting the sandbox display. Takes the wsl program path so tests can use a fake.

use super::wsl::{self, capture_invocation, pick_display, wrap_for_sandbox, LINUX_CWD};
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};

pub const SANDBOX_RUN_MS: u64 = 120_000;
pub const SANDBOX_MAX_MS: u64 = 20 * 60_000;
pub const MAX_OUTPUT: usize = 20_000;
const SHOT_MS: u64 = 90_000;
/// Output kept in memory while a command runs; the reply is cut to MAX_OUTPUT anyway.
const KEEP_BYTES: usize = 1 << 20;

/// What the model reads when the sandbox cannot run. Verbatim from the web.
// ponytail: the text names start_process hidden=true and screenshot_window, which this Rust build does not offer.
pub const WINDOWS_FALLBACK: &str = "Do not retry the sandbox and do not ask the user to repair Windows. Work on Windows directly instead: run code with run_command, start a GUI with start_process (hidden=true, so it opens on a hidden desktop the user never sees), then capture it with screenshot_window (process_id) and look with view_image. Use Windows builds of tools (Python, Node, Lua) there.";

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct RunResult {
    pub ok: bool,
    pub content: String,
    pub summary: String,
}

/// The sandbox distro and the off-screen display this process started for it.
#[derive(Clone, Debug, PartialEq)]
pub struct Sandbox {
    pub distro: String,
    pub display: String,
}

/// Current sandbox and the Xvfb wsl.exe launcher this process started (kept so it can be killed).
static STATE: Mutex<Option<(Sandbox, Option<std::process::Child>)>> = Mutex::new(None);

pub fn active() -> Option<Sandbox> {
    STATE.lock().unwrap().as_ref().map(|(s, _)| s.clone())
}

/// WSL failing to start an instance at all, as opposed to the command inside it failing.
pub fn wsl_cannot_start(output: &str) -> bool {
    let t = output.to_lowercase();
    t.contains("wsl/service/createinstance/") || t.contains("wsl/service/createvm/") || t.contains("0xd0000034") || t.contains("hcs_e_")
}

fn not_ready(error: &str, needs_setup: bool) -> RunResult {
    let content = if needs_setup {
        format!("The Linux sandbox is not set up on this PC. {error}\n{WINDOWS_FALLBACK}")
    } else {
        format!("The Linux sandbox is not available on this PC: {error}\n{WINDOWS_FALLBACK}")
    };
    RunResult { ok: false, content, summary: "Sandbox not available".into() }
}

/// Starts (once) the off-screen display inside the sandbox distro and returns the sandbox. Err is (reason, needs setup).
pub fn ensure(wsl: &Path) -> Result<Sandbox, (String, bool)> {
    if let Some(s) = active() {
        return Ok(s);
    }
    let distro = wsl::choose_distro(&wsl::probe(wsl))?;
    let display = pick_display(&[]);
    let inv = wsl::build_invocation(Some(&distro), Some("root"), Some(LINUX_CWD), &[], "Xvfb", &wsl::xvfb_launch_args(&display));
    // Detached and silent: Xvfb keeps running in the distro after this wsl.exe returns.
    let xvfb = detached(wsl, &inv.args).ok();
    let sb = Sandbox { distro, display };
    *STATE.lock().unwrap() = Some((sb.clone(), xvfb));
    Ok(sb)
}

fn detached(program: &Path, args: &[String]) -> std::io::Result<std::process::Child> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Not DETACHED_PROCESS: with no console at all, wsl.exe opens one of its own, on top of whatever the user is doing.
        cmd.creation_flags(0x0800_0000 | 0x0000_0200); // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    }
    cmd.spawn()
}

/// Kills the display's Xvfb and forgets the sandbox. The next use starts a fresh one.
pub fn close(wsl: &Path) {
    let Some((sb, xvfb)) = STATE.lock().unwrap().take() else { return };
    let inv = wsl::build_invocation(Some(&sb.distro), Some("root"), Some(LINUX_CWD), &[], "pkill", &["-f".into(), format!("Xvfb {}", sb.display)]);
    wsl::run_timed(wsl, &inv.args, Duration::from_secs(5), None);
    if let Some(mut c) = xvfb {
        let _ = c.kill();
    }
}

fn hide(cmd: &mut Command) {
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Reads one pipe into a shared buffer, keeping at most KEEP_BYTES, so stdout and stderr stay in arrival order.
fn pump(mut pipe: impl tokio::io::AsyncRead + Unpin + Send + 'static, into: Arc<Mutex<Vec<u8>>>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut buf).await {
            if n == 0 {
                break;
            }
            let mut out = into.lock().unwrap();
            if out.len() < KEEP_BYTES {
                out.extend_from_slice(&buf[..n]);
            }
        }
    })
}

fn or_no_output(text: &str) -> &str {
    if text.is_empty() { "(no output)" } else { text }
}

/// Cuts the reply to MAX_OUTPUT characters and marks the cut, as the web does.
fn cut(text: String) -> String {
    if text.chars().count() > MAX_OUTPUT {
        let head: String = text.chars().take(MAX_OUTPUT).collect();
        format!("{head}\n…(truncated)")
    } else {
        text
    }
}

/// Runs a shell command in the sandbox and waits. The caller has already had it approved.
pub async fn run_command(wsl: &Path, workspace_id: &str, workspace_win_dir: &Path, script: &str, timeout_ms: Option<u64>) -> RunResult {
    let sb = match ensure(wsl) {
        Ok(s) => s,
        Err((e, needs)) => return not_ready(&e, needs),
    };
    let (inv, stdin) = wrap_for_sandbox(&sb.distro, &sb.display, workspace_id, &workspace_win_dir.to_string_lossy(), script, &[]);
    let limit = timeout_ms.unwrap_or(SANDBOX_RUN_MS).max(1_000).min(SANDBOX_MAX_MS);
    let started = std::time::Instant::now();

    let mut cmd = Command::new(wsl);
    cmd.args(&inv.args).stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    hide(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return RunResult { ok: false, content: format!("Could not run in the sandbox: {e}"), summary: "Sandbox launch failed".into() },
    };
    let log = Arc::new(Mutex::new(Vec::new()));
    let readers: Vec<_> = [child.stdout.take().map(|p| pump(p, log.clone())), child.stderr.take().map(|p| pump(p, log.clone()))].into_iter().flatten().collect();
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let _ = pipe.write_all(text.as_bytes()).await;
    }

    let (code, timed_out) = match tokio::time::timeout(Duration::from_millis(limit), child.wait()).await {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(_)) => (None, false),
        Err(_) => {
            // ponytail: only wsl.exe is killed; a Linux process it started keeps running in the distro (as in the web).
            let _ = child.start_kill();
            let _ = child.wait().await;
            (None, true)
        }
    };
    for r in readers {
        let _ = tokio::time::timeout(Duration::from_secs(2), r).await;
    }
    let trimmed = cut(String::from_utf8_lossy(&log.lock().unwrap()).into_owned());

    if timed_out {
        return RunResult {
            ok: false,
            content: format!(
                "The sandbox command was stopped after {}s.\n{}\n{}If it is a server or watcher, start it in the background instead.",
                (limit as f64 / 1000.0).round() as u64,
                or_no_output(&trimmed),
                // A model waited out a dozen of these, five minutes once, before it saw why nothing came back.
                if trimmed.trim().is_empty() { "Nothing it printed reached here: a program writing to a pipe holds its output in a buffer, and being stopped loses it. Run it bounded and line-buffered (timeout 60 stdbuf -oL …), or writing to a file you then read (… > out.log 2>&1). " } else { "" }
            ),
            summary: "Sandbox command timed out".into(),
        };
    }
    if code != Some(0) && wsl_cannot_start(&trimmed) {
        return RunResult {
            ok: false,
            content: format!("The Linux sandbox cannot start on this PC (WSL failed before running anything):\n{}\n{WINDOWS_FALLBACK}", trimmed.trim()),
            summary: "Sandbox cannot start on this PC".into(),
        };
    }
    let code_text = code.map_or("null".to_string(), |c| (c as u32).to_string());
    // The step's row says what the command said last: its answer, or the error it died of.
    let last: Option<String> = trimmed.lines().rev().map(str::trim).find(|line| !line.is_empty() && *line != "…(truncated)").map(|line| line.chars().take(100).collect());
    RunResult {
        ok: code == Some(0),
        content: format!("[sandbox {}] exit {code_text}{}\n{}", sb.distro, took(started.elapsed()), or_no_output(&trimmed)),
        summary: match (code == Some(0), last) {
            (true, Some(last)) => last,
            (true, None) => "Sandbox command finished".into(),
            (false, Some(last)) => format!("Sandbox exit {code_text}: {last}"),
            (false, None) => format!("Sandbox exit {code_text}"),
        },
    }
}

/// " · took 42s" for a run of ten seconds or more: the model has no clock, and how long one experiment takes
/// decides how many it can afford.
pub fn took(elapsed: Duration) -> String {
    if elapsed.as_secs() >= 10 { format!(" · took {}s", elapsed.as_secs()) } else { String::new() }
}

/// Starts a long-running command (a server, a watcher, a window) in the sandbox and hands back its process with
/// its output pipes untaken: the process list keeps it (`exec::Procs::adopt`), so read_process and stop_process
/// work on it. The child is not killed on drop.
pub async fn start_background(wsl: &Path, workspace_id: &str, workspace_win_dir: &Path, script: &str) -> Result<Child, (String, bool)> {
    let sb = ensure(wsl)?;
    let (inv, stdin) = wrap_for_sandbox(&sb.distro, &sb.display, workspace_id, &workspace_win_dir.to_string_lossy(), script, &[]);
    let mut cmd = Command::new(wsl);
    cmd.args(&inv.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| (format!("Could not run in the sandbox: {e}"), false))?;
    // Too long for the command line: the script goes in through stdin, which then has to close, so this one
    // process cannot be written to later.
    if let Some(text) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            let _ = pipe.write_all(text.as_bytes()).await;
        }
    }
    Ok(child)
}

/// The file name a screenshot is saved under: the last path part, cleaned, else sandbox-<ms>.png. Mirrors the web.
pub fn screenshot_file_name(requested: Option<&str>, now_ms: u128) -> String {
    let fallback = format!("sandbox-{now_ms}.png");
    let raw = requested.map_or_else(|| fallback.clone(), str::to_string);
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    if !base.to_ascii_lowercase().ends_with(".png") {
        return fallback;
    }
    let mut clean = String::new();
    for c in base.chars() {
        if c.is_ascii_alphanumeric() || "._-".contains(c) {
            clean.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                clean.push('_');
            }
        }
    }
    let clean = clean.trim_start_matches('.').to_string();
    if clean.is_empty() { fallback } else { clean }
}

pub struct Shot {
    /// Path relative to the workspace, e.g. "screenshots/sandbox-1.png".
    pub file_name: String,
    pub display: String,
    /// The "[sandbox] ..." lines the capture printed, for the reply.
    pub note: String,
}

/// Captures the sandbox display into <workspace>/screenshots. Err is (message, needs setup).
pub async fn screenshot(wsl: &Path, workspace_id: &str, workspace_win_dir: &Path, requested: Option<&str>, now_ms: u128, full_screen: bool, wait_seconds: Option<f64>) -> Result<Shot, (String, bool)> {
    let sb = ensure(wsl).map_err(|(e, n)| (format!("{e}\n{WINDOWS_FALLBACK}"), n))?;
    let safe = screenshot_file_name(requested, now_ms);
    let (inv, _) = capture_invocation(&sb.distro, &sb.display, workspace_id, &workspace_win_dir.to_string_lossy(), full_screen, wait_seconds);
    let mut cmd = Command::new(wsl);
    cmd.args(&inv.args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    hide(&mut cmd);
    let (code, out, err) = match cmd.spawn() {
        Err(e) => (None, Vec::new(), e.to_string()),
        Ok(child) => match tokio::time::timeout(Duration::from_millis(SHOT_MS), child.wait_with_output()).await {
            Ok(Ok(o)) => (o.status.code(), o.stdout, String::from_utf8_lossy(&o.stderr).into_owned()),
            Ok(Err(e)) => (None, Vec::new(), e.to_string()),
            Err(_) => (None, Vec::new(), String::new()),
        },
    };
    let out_text: String = out.iter().map(|&b| b as char).collect();
    let Some(png) = wsl::decode_capture(&out_text) else {
        let why: String = format!("{err}\n{out_text}").trim().chars().take(600).collect();
        let why = if why.is_empty() { format!("exit {}", code.map_or("null".to_string(), |c| (c as u32).to_string())) } else { why };
        let error = if wsl_cannot_start(&why) {
            format!("The Linux sandbox cannot start on this PC:\n{why}\n{WINDOWS_FALLBACK}")
        } else {
            format!("The capture failed: {why}")
        };
        return Err((error, false));
    };
    let dir = workspace_win_dir.join("screenshots");
    std::fs::create_dir_all(&dir).map_err(|e| (format!("The capture failed: {e}"), false))?;
    std::fs::write(dir.join(&safe), &png).map_err(|e| (format!("The capture failed: {e}"), false))?;
    let note = err.lines().filter(|l| l.starts_with("[sandbox]")).collect::<Vec<_>>().join("\n");
    Ok(Shot { file_name: format!("screenshots/{safe}"), display: sb.display, note })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cannot_start_is_recognised_in_any_case() {
        assert!(wsl_cannot_start("Error: Wsl/Service/CreateInstance/0xd0000034"));
        assert!(wsl_cannot_start("wsl/service/createvm/ failed"));
        assert!(wsl_cannot_start("HCS_E_SERVICE_NOT_AVAILABLE"));
        assert!(!wsl_cannot_start("exit 1: no such file"));
    }

    #[test]
    fn screenshot_names_are_cleaned_like_the_web() {
        assert_eq!(screenshot_file_name(Some("../../x.png"), 5), "x.png");
        assert_eq!(screenshot_file_name(Some("..\\..\\evil.png"), 5), "evil.png");
        assert_eq!(screenshot_file_name(Some("a b.PNG"), 5), "a_b.PNG");
        assert_eq!(screenshot_file_name(Some("x.txt"), 7), "sandbox-7.png");
        assert_eq!(screenshot_file_name(None, 9), "sandbox-9.png");
        assert_eq!(screenshot_file_name(Some("...png"), 1), "png");
        assert_eq!(screenshot_file_name(Some("x😀.png"), 1), "x__.png");
        assert_eq!(screenshot_file_name(Some("/"), 2), "sandbox-2.png");
    }

    #[test]
    fn reply_is_cut_with_its_marker() {
        let long = "x".repeat(MAX_OUTPUT + 5);
        let cut_text = cut(long);
        assert!(cut_text.ends_with("\n…(truncated)"));
        assert_eq!(cut("short".into()), "short");
        assert_eq!(or_no_output(""), "(no output)");
    }

    /// One test drives the whole path, because the sandbox state is process-wide.
    #[tokio::test]
    async fn runs_through_the_fake_distro() {
        let _turn = crate::sandbox::test_lock();
        let wsl = crate::sandbox::fake_wsl();
        let dir = std::env::temp_dir().join("asb-run-test");
        std::fs::create_dir_all(&dir).unwrap();
        let ok = run_command(&wsl, "chat-1", &dir, "echo hi", None).await;
        assert!(ok.ok, "{}", ok.content);
        assert_eq!(ok.content, "[sandbox apim-sandbox] exit 0\nhello from fake\n");
        assert_eq!(ok.summary, "hello from fake");
        assert_eq!((took(Duration::from_secs(9)), took(Duration::from_secs(124))), (String::new(), " · took 124s".to_string()));
        let failed = run_command(&wsl, "chat-1", &dir, "FAIL now", None).await;
        assert!(!failed.ok);
        assert!(failed.summary.starts_with("Sandbox exit 3"), "{}", failed.summary);
        let cannot = run_command(&wsl, "chat-1", &dir, "CANNOT", None).await;
        assert_eq!(cannot.summary, "Sandbox cannot start on this PC");
        assert!(cannot.content.ends_with(WINDOWS_FALLBACK));
        let slow = run_command(&wsl, "chat-1", &dir, "SLEEP", Some(1_000)).await;
        assert_eq!(slow.summary, "Sandbox command timed out");
        assert!(slow.content.starts_with("The sandbox command was stopped after 1s.\n(no output)\nNothing it printed reached here") && slow.content.ends_with("start it in the background instead."));
        let big = run_command(&wsl, "chat-1", &dir, "BIG", None).await;
        assert!(big.content.ends_with("\n…(truncated)"));
        let shot = screenshot(&wsl, "chat-1", &dir, Some("../gui.png"), 1, false, Some(0.0)).await.unwrap();
        assert_eq!(shot.file_name, "screenshots/gui.png");
        assert_eq!(shot.note, "[sandbox] cropped to the visible window(s), 300x200+0+0 of the screen. full_screen:true captures everything.");
        assert!(dir.join("screenshots").join("gui.png").is_file());
        assert_eq!(active().map(|s| s.distro), Some("apim-sandbox".to_string()));
        close(&wsl);
        assert!(active().is_none());
    }

    #[test]
    fn not_ready_names_the_fallback_and_setup() {
        let r = not_ready("WSL is not turned on.", true);
        assert!(r.content.starts_with("The Linux sandbox is not set up on this PC. WSL is not turned on.\n"));
        assert_eq!(r.summary, "Sandbox not available");
        assert!(not_ready("x", false).content.starts_with("The Linux sandbox is not available on this PC: x\n"));
    }
}

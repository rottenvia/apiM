//! Running programs: one-shot commands, tests, and background processes.
//! There is no shell by default; every launch goes through the approval rules.

use super::{Ctx, Output, clip, list_arg, num_arg, str_arg};
use crate::store::Approval;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};

/// Developer programs that run without a prompt in Auto mode.
const ALLOWED: &[&str] = &[
    "python", "python3", "py", "node", "npm", "npx", "pip", "pip3", "tsc", "go", "cargo", "rustc", "java", "javac", "ruby", "php", "dotnet",
    "pytest", "jest", "vitest", "pnpm", "yarn", "bun", "deno", "tsx", "eslint", "prettier", "vite", "next", "git", "make", "cmake", "msbuild",
    "cl", "clang", "clang++", "clang-cl", "gcc", "g++", "csc", "vbc", "link", "rc", "uv", "poetry", "ruff", "black", "mypy", "curl", "wget",
    "which", "where", "unzip", "tar", "grep", "rg", "find", "diff", "cat", "wc", "head", "tail", "ls", "echo",
];
/// A shell runs arbitrary text, so it always asks, even in Auto mode.
const SHELLS: &[&str] = &["sh", "bash", "zsh", "fish", "dash", "cmd", "powershell", "pwsh"];
const SLOW_COMMANDS: &[&str] = &["npm", "npx", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "poetry", "cargo", "go", "dotnet", "make", "gcc", "g++", "tsc", "next", "vite", "msbuild", "cmake"];
const INFO_FLAGS: &[&str] = &["--version", "-v", "-V", "--help", "-h"];

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
const SLOW_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_OUTPUT: usize = 20_000;
const MAX_PROCESS_LOG: usize = 1_000_000;

fn base_name(command: &str) -> String {
    let name = command.rsplit(['/', '\\']).next().unwrap_or(command).to_ascii_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".com"] {
        if let Some(stripped) = name.strip_suffix(ext) {
            return stripped.to_string();
        }
    }
    name
}

/// Commands that only look, never change: these never need a prompt.
fn read_only(name: &str, args: &[String]) -> bool {
    let first = args.iter().map(String::as_str).find(|a| !a.starts_with('-')).unwrap_or("");
    if matches!(name, "which" | "where") || (args.len() == 1 && INFO_FLAGS.contains(&args[0].as_str())) {
        return true;
    }
    match name {
        "git" => matches!(first, "status" | "log" | "diff" | "show" | "branch" | "remote" | "ls-files" | "rev-parse" | "describe" | "blame") && !args.iter().any(|a| matches!(a.as_str(), "-d" | "-D" | "-m" | "-M" | "add" | "remove" | "set-url" | "--output")),
        "npm" => matches!(first, "ls" | "list" | "view" | "outdated" | "why" | "root" | "prefix"),
        "pnpm" => matches!(first, "ls" | "list" | "why" | "outdated"),
        "pip" | "pip3" => matches!(first, "list" | "show" | "freeze"),
        "go" => matches!(first, "version" | "env" | "list"),
        "cargo" => first == "tree",
        _ => false,
    }
}

/// Finds the program the way a terminal would. Rust's own lookup misses `npm.cmd` and friends on Windows.
fn find_program(root: &Path, command: &str) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into()).split(';').map(str::to_string).chain([String::new()]).collect()
    } else {
        vec![String::new()]
    };
    let try_at = |base: PathBuf| exts.iter().map(|e| PathBuf::from(format!("{}{e}", base.display()))).find(|p| p.is_file());
    if command.contains(['/', '\\']) {
        let p = Path::new(command);
        return try_at(if p.is_absolute() { p.to_path_buf() } else { root.join(p) });
    }
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| try_at(dir.join(command)))
}

/// Stops a process and everything it started. A plain kill on Windows leaves `npm`'s `node` child running.
pub fn kill_tree(pid: u32) {
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]);
        c
    } else {
        let mut c = std::process::Command::new("kill");
        c.arg(pid.to_string());
        c
    };
    hide_window_std(&mut cmd);
    let _ = cmd.stdout(Stdio::null()).stderr(Stdio::null()).status();
}

#[cfg(windows)]
fn hide_window_std(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
}
#[cfg(not(windows))]
fn hide_window_std(_: &mut std::process::Command) {}

/// A command ready to start, with the line shown on the approval prompt.
struct Launch {
    program: PathBuf,
    args: Vec<String>,
    display: String,
    name: String,
    /// Needs a prompt in this approval mode.
    ask: bool,
}

fn prepare(ctx: &Ctx, args: &Value) -> Result<Launch, String> {
    let command = str_arg(args, "command").trim();
    if command.is_empty() {
        return Err("command is required.".into());
    }
    let argv = list_arg(args, "args");
    let name = base_name(command);
    let program = find_program(&ctx.root, command).ok_or_else(|| format!("`{command}` was not found on this machine (not on PATH and not in the workspace)."))?;
    let own_build = program.starts_with(&ctx.root);
    let known = ALLOWED.contains(&name.as_str()) && !own_build;
    let ask = if read_only(&name, &argv) {
        false
    } else if SHELLS.contains(&name.as_str()) || !known {
        // Shells, unknown programs and freshly built binaries always go to the prompt.
        true
    } else {
        ctx.settings.approval == Approval::Manual
    };
    let display = std::iter::once(command.to_string()).chain(argv.iter().map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() })).collect::<Vec<_>>().join(" ");
    Ok(Launch { program, args: argv, display, name, ask })
}

fn command(ctx: &Ctx, launch: &Launch) -> Command {
    let mut cmd = Command::new(&launch.program);
    cmd.args(&launch.args).current_dir(&ctx.root).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    // Colour codes and pagers only add noise to captured output.
    cmd.env("NO_COLOR", "1").env("FORCE_COLOR", "0").env("GIT_PAGER", "cat").env("PAGER", "cat").env("PYTHONUNBUFFERED", "1").env("PYTHONIOENCODING", "utf-8");
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd
}

async fn approved(ctx: &Ctx, launch: &Launch, reason: &str) -> bool {
    !launch.ask || ctx.emit.approve(&launch.display, reason).await
}

/// Reads a pipe to the end into a shared buffer, keeping only the newest part of a huge log.
fn pump(mut pipe: impl tokio::io::AsyncRead + Unpin + Send + 'static, into: Arc<Mutex<String>>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut buf).await {
            if n == 0 {
                break;
            }
            let mut log = into.lock().unwrap();
            log.push_str(&String::from_utf8_lossy(&buf[..n]));
            if log.len() > MAX_PROCESS_LOG {
                let cut = (log.len() - MAX_PROCESS_LOG / 2..log.len()).find(|&i| log.is_char_boundary(i)).unwrap_or(0);
                log.drain(..cut);
            }
        }
    })
}

/// Runs to completion or to the timeout. Returns (exit code, combined output, timed out).
async fn run_to_end(mut child: Child, limit: Duration) -> (Option<i32>, String, bool) {
    let log = Arc::new(Mutex::new(String::new()));
    let readers = [child.stdout.take().map(|p| pump(p, log.clone())), child.stderr.take().map(|p| pump(p, log.clone()))];
    let pid = child.id();
    let (code, timed_out) = match tokio::time::timeout(limit, child.wait()).await {
        Ok(status) => (status.ok().and_then(|s| s.code()), false),
        Err(_) => {
            if let Some(pid) = pid {
                tokio::task::block_in_place(|| kill_tree(pid));
            }
            let _ = child.kill().await;
            (None, true)
        }
    };
    for r in readers.into_iter().flatten() {
        let _ = tokio::time::timeout(Duration::from_secs(2), r).await;
    }
    let out = log.lock().unwrap().clone();
    (code, out, timed_out)
}

pub async fn run_command(ctx: &Ctx, args: &Value) -> Output {
    let launch = match prepare(ctx, args) {
        Ok(l) => l,
        Err(e) => return Output::fail(e),
    };
    if !approved(ctx, &launch, str_arg(args, "reason")).await {
        return Output::fail(format!("The user declined to run `{}`. Do not retry it; continue another way or ask what they would prefer.", launch.display));
    }
    let slow = SLOW_COMMANDS.contains(&launch.name.as_str());
    let limit = num_arg(args, "timeout_ms").map(Duration::from_millis).unwrap_or(if slow { SLOW_TIMEOUT } else { DEFAULT_TIMEOUT }).min(SLOW_TIMEOUT);
    let child = match command(ctx, &launch).stdin(Stdio::null()).spawn() {
        Ok(c) => c,
        Err(e) => return Output::fail(format!("Could not start `{}`: {e}", launch.display)),
    };
    let (code, out, timed_out) = run_to_end(child, limit).await;
    let out = clip(out.trim_end(), MAX_OUTPUT);
    if timed_out {
        return Output::fail(format!(
            "`{}` was stopped after {}s without finishing. For something that keeps running, use start_process; for a slow job pass timeout_ms.\n{out}",
            launch.display,
            limit.as_secs()
        ));
    }
    let code = code.unwrap_or(-1);
    let text = format!("$ {}\nExit code {code}\n{}", launch.display, if out.is_empty() { "(no output)" } else { &out });
    Output { ok: code == 0, ..Output::ok(text, format!("{} (exit {code})", launch.display)) }
}

pub async fn run_tests(ctx: &Ctx, args: &Value) -> Output {
    let has = |f: &str| ctx.root.join(f).exists();
    let filter = str_arg(args, "filter");
    let (cmd, mut argv): (&str, Vec<&str>) = if has("Cargo.toml") {
        ("cargo", vec!["test"])
    } else if has("package.json") {
        ("npm", vec!["test", "--silent"])
    } else if has("go.mod") {
        ("go", vec!["test", "./..."])
    } else if has("pyproject.toml") || has("pytest.ini") || has("tests") || has("setup.py") {
        (if find_program(&ctx.root, "pytest").is_some() { "pytest" } else { "python" }, vec![])
    } else {
        return Output::fail("No test setup found (looked for Cargo.toml, package.json, go.mod, pytest files). Run the tests with run_command instead.");
    };
    if cmd == "python" {
        argv.extend(["-m", "pytest"]);
    }
    if cmd.contains("py") {
        argv.push("-q");
    }
    if !filter.is_empty() {
        if cmd == "npm" {
            argv.push("--");
        }
        argv.push(filter);
    }
    let call = serde_json::json!({ "command": cmd, "args": argv, "timeout_ms": 300_000, "reason": "Run the project's tests" });
    let mut out = run_command(ctx, &call).await;
    // Only the verdict and the failures matter: keep the end of the runner's output.
    let tail: String = { let lines: Vec<&str> = out.text.lines().collect(); lines[lines.len().saturating_sub(80)..].join("\n") };
    out.text = format!("{}\n{tail}", if out.ok { "TESTS PASSED" } else { "TESTS FAILED" });
    out.summary = if out.ok { "Tests passed".into() } else { "Tests failed".into() };
    out
}

// ---------------------------------------------------------------- background processes

struct Proc {
    display: String,
    pid: u32,
    log: Arc<Mutex<String>>,
    /// Set once the process has exited.
    exit: Arc<Mutex<Option<i32>>>,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
}

/// Background processes the agent started. Everything still running is stopped when the app closes.
#[derive(Default)]
pub struct Procs {
    next: AtomicU32,
    map: Mutex<HashMap<String, Arc<Proc>>>,
}

impl Procs {
    fn get(&self, id: &str) -> Option<Arc<Proc>> {
        self.map.lock().unwrap().get(id).cloned()
    }

    pub fn stop_all(&self) -> usize {
        let running: Vec<Arc<Proc>> = self.map.lock().unwrap().values().filter(|p| p.exit.lock().unwrap().is_none()).cloned().collect();
        for p in &running {
            kill_tree(p.pid);
        }
        running.len()
    }

    /// How many are still running, for the header badge.
    pub fn running(&self) -> usize {
        self.map.lock().unwrap().values().filter(|p| p.exit.lock().unwrap().is_none()).count()
    }
}

impl Drop for Procs {
    fn drop(&mut self) {
        self.stop_all();
    }
}

fn status_line(id: &str, p: &Proc) -> String {
    match *p.exit.lock().unwrap() {
        None => format!("{id}: running (pid {}): {}", p.pid, p.display),
        Some(code) => format!("{id}: exited with code {code}: {}", p.display),
    }
}

fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

pub async fn start_process(ctx: &Ctx, args: &Value) -> Output {
    let launch = match prepare(ctx, args) {
        Ok(l) => l,
        Err(e) => return Output::fail(e),
    };
    if !approved(ctx, &launch, str_arg(args, "reason")).await {
        return Output::fail(format!("The user declined to start `{}`.", launch.display));
    }
    let mut child = match command(ctx, &launch).stdin(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => return Output::fail(format!("Could not start `{}`: {e}", launch.display)),
    };
    let log = Arc::new(Mutex::new(String::new()));
    if let Some(p) = child.stdout.take() {
        pump(p, log.clone());
    }
    if let Some(p) = child.stderr.take() {
        pump(p, log.clone());
    }
    let exit = Arc::new(Mutex::new(None));
    let proc = Arc::new(Proc { display: launch.display.clone(), pid: child.id().unwrap_or(0), log, exit: exit.clone(), stdin: tokio::sync::Mutex::new(child.stdin.take()) });
    let id = format!("p{}", ctx.procs.next.fetch_add(1, Ordering::Relaxed) + 1);
    ctx.procs.map.lock().unwrap().insert(id.clone(), proc.clone());
    let wake = ctx.emit.clone();
    tokio::spawn(async move {
        let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
        *exit.lock().unwrap() = Some(code);
        wake.wake();
    });
    // The first moments show whether it actually started.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let early = clip(&proc.log.lock().unwrap(), 4_000);
    let text = format!("{}\n{}\nRead more with read_process, wait with wait_for_output, and stop it with stop_process when you are done.", status_line(&id, &proc), if early.is_empty() { "(no output yet)" } else { &early });
    let ok = proc.exit.lock().unwrap().is_none_or(|c| c == 0);
    Output { ok, ..Output::ok(text, format!("Started {} as {id}", launch.display)) }
}

pub fn read_process(ctx: &Ctx, args: &Value) -> Output {
    let id = str_arg(args, "id");
    if id.is_empty() {
        let map = ctx.procs.map.lock().unwrap();
        if map.is_empty() {
            return Output::ok("No background processes.", "0 processes");
        }
        let mut lines: Vec<String> = map.iter().map(|(id, p)| status_line(id, p)).collect();
        lines.sort();
        return Output::ok(lines.join("\n"), format!("{} processes", lines.len()));
    }
    let Some(p) = ctx.procs.get(id) else { return Output::fail(format!("No process {id}. Call read_process without an id to list them.")) };
    let log = p.log.lock().unwrap().clone();
    let body = match num_arg(args, "tail") {
        Some(n) => last_lines(&log, n as usize),
        None => clip(&log, MAX_OUTPUT),
    };
    Output::ok(format!("{}\n{}", status_line(id, &p), if body.is_empty() { "(no output)" } else { &body }), status_line(id, &p))
}

pub async fn write_process(ctx: &Ctx, args: &Value) -> Output {
    let id = str_arg(args, "id");
    let Some(p) = ctx.procs.get(id) else { return Output::fail(format!("No process {id}.")) };
    let mut stdin = p.stdin.lock().await;
    let Some(pipe) = stdin.as_mut() else { return Output::fail(format!("{id} is not accepting input.")) };
    let line = format!("{}\n", str_arg(args, "input"));
    match pipe.write_all(line.as_bytes()).await {
        Ok(()) => {
            let _ = pipe.flush().await;
            Output::ok(format!("Sent to {id}. Read its output to see what it did with the answer."), format!("Typed into {id}"))
        }
        Err(e) => Output::fail(format!("Could not write to {id}: {e}")),
    }
}

pub fn stop_process(ctx: &Ctx, args: &Value) -> Output {
    let id = str_arg(args, "id");
    if id == "all" {
        let n = tokio::task::block_in_place(|| ctx.procs.stop_all());
        return Output::ok(format!("Stopped {n} process(es)."), format!("Stopped {n} processes"));
    }
    let Some(p) = ctx.procs.get(id) else { return Output::fail(format!("No process {id}.")) };
    if p.exit.lock().unwrap().is_some() {
        return Output::ok(format!("{id} had already exited."), format!("{id} already exited"));
    }
    tokio::task::block_in_place(|| kill_tree(p.pid));
    Output::ok(format!("Stopped {id}: {}", p.display), format!("Stopped {id}"))
}

pub async fn wait_for_output(ctx: &Ctx, args: &Value) -> Output {
    let id = str_arg(args, "id");
    let Some(p) = ctx.procs.get(id) else { return Output::fail(format!("No process {id}.")) };
    let pattern = str_arg(args, "pattern");
    // Text first: most patterns are plain words, and `listening on (` is not a valid regex.
    let re = if pattern.is_empty() { None } else { Some(Regex::new(pattern).unwrap_or_else(|_| Regex::new(&regex::escape(pattern)).unwrap())) };
    let limit = Duration::from_millis(num_arg(args, "timeout_ms").unwrap_or(30_000).min(120_000));
    let started = std::time::Instant::now();
    loop {
        let log = p.log.lock().unwrap().clone();
        let exited = *p.exit.lock().unwrap();
        let matched = re.as_ref().is_some_and(|r| r.is_match(&log) || log.contains(pattern));
        if matched || exited.is_some() || started.elapsed() >= limit {
            let verdict = if matched {
                format!("`{pattern}` appeared after {:.1}s.", started.elapsed().as_secs_f32())
            } else if let Some(code) = exited {
                format!("The process exited with code {code}{}.", if re.is_some() { " before the pattern appeared" } else { "" })
            } else {
                format!("Timed out after {}s; the process is still running.", limit.as_secs())
            };
            let ok = matched || (re.is_none() && exited == Some(0));
            return Output { ok, ..Output::ok(format!("{verdict}\n{}", last_lines(&log, 40)), verdict) };
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification() {
        assert_eq!(base_name("C:\\tools\\Python.EXE"), "python");
        assert_eq!(base_name("npm.cmd"), "npm");
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert!(read_only("git", &s(&["status"])));
        assert!(read_only("git", &s(&["--no-pager", "log", "-5"])));
        assert!(!read_only("git", &s(&["push"])));
        assert!(!read_only("git", &s(&["branch", "-D", "main"])));
        assert!(read_only("node", &s(&["--version"])));
        assert!(!read_only("node", &s(&["app.js"])));
        assert!(read_only("pip", &s(&["list"])));
    }

    #[test]
    fn finds_programs_on_path() {
        let root = std::env::temp_dir();
        assert!(find_program(&root, "git").is_some() || find_program(&root, "cargo").is_some());
        assert!(find_program(&root, "definitely-not-a-real-program-xyz").is_none());
    }
}

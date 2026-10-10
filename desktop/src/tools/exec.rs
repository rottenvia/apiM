//! Running programs: one-shot commands, tests, and background processes.
//! There is no shell by default; every launch goes through the approval rules. Ported from src/lib/runner.ts
//! (validation, timeouts, result text) and src/lib/processes.ts (background processes). Gaps are marked `ponytail:`.

use super::build::group;
use super::{Ctx, Output, num_arg, str_arg, testing};
use crate::store::Approval;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};

/// Developer programs that run without a prompt in Auto mode. Anything else is refused.
const ALLOWED: &[&str] = &[
    "python", "python3", "node", "npm", "npx", "pip", "pip3", "tsc", "go", "cargo", "rustc", "java", "javac", "ruby", "php", "dotnet",
    "pytest", "jest", "vitest", "pnpm", "yarn", "bun", "deno", "tsx", "eslint", "prettier", "vite", "next", "git", "make", "cmake", "msbuild",
    "cl", "clang", "clang++", "clang-cl", "gcc", "g++", "csc", "vbc", "link", "rc", "uv", "poetry", "ruff", "black", "mypy", "curl", "wget",
    "which", "where", "unzip", "tar", "grep", "rg", "find", "diff", "cat", "wc", "head", "tail", "ls", "echo",
];
/// The system's own tools for questions about the computer: what runs, what is installed, what its logs say.
const SYSTEM: &[&str] = &["tasklist", "systeminfo", "whoami", "hostname", "driverquery", "ipconfig", "getmac", "wevtutil", "sc", "reg", "ping", "nslookup", "netstat", "nvidia-smi", "ps", "uname", "df", "uptime", "id", "free", "lscpu", "lsb_release", "sw_vers", "file", "stat", "du"];
/// Those of them that can also change things, with the first words that only look ("" is no argument at all).
const LOOKING_FORMS: &[(&str, &[&str])] = &[
    ("wevtutil", &["qe", "query-events", "el", "enum-logs", "gl", "get-log", "gli", "get-log-info", "ep", "enum-publishers", "gp", "get-publisher"]),
    ("reg", &["query"]),
    ("sc", &["query", "queryex", "qc", "qdescription", "qfailure"]),
    ("ipconfig", &["", "/all", "/displaydns"]),
    ("hostname", &[""]),
];
/// A shell runs arbitrary text, so it is refused outright. (PowerShell on Windows is the exception: see `shell`.)
const SHELLS: &[&str] = &["sh", "bash", "zsh", "fish", "dash", "cmd", "powershell", "pwsh"];
/// Package managers and build tools, where a slow run is normal.
const SLOW_COMMANDS: &[&str] = &["npm", "npx", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "poetry", "cargo", "go", "dotnet", "make", "gcc", "g++", "tsc", "next", "vite"];
/// Subcommands that mean "this will take a while".
const SLOW_SUBCOMMANDS: &[&str] = &["install", "i", "add", "ci", "get", "restore", "build", "mod", "sync", "update", "compile", "bundle"];
const INFO_FLAGS: &[&str] = &["--version", "-v", "-V", "--help", "-h"];
/// git subcommands that only look at the repository.
const GIT_LOOKS: &[&str] = &["status", "log", "diff", "show", "branch", "remote", "ls-files", "rev-parse", "describe", "blame"];
/// The environment a child keeps. Everything else apiM has is withheld, API keys included. Profile paths stay so rustup and npm can find their homes.
const CHILD_ENV: &[&str] = &[
    "COMPUTERNAME", "ALLUSERSPROFILE", "PUBLIC", "HOMEDRIVE", "HOMEPATH", "ProgramW6432", "CommonProgramFiles", "PSModulePath",
    "PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "windir", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "TEMP", "TMP", "USERPROFILE", "USERNAME", "HOME", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "CARGO_HOME", "RUSTUP_HOME", "LANG", "LC_ALL",
];

/// A command with no timeout asked for runs for this long, or the web's default for everything else.
const RUN_LIMIT: Duration = Duration::from_secs(60);
/// Installs and other slow subcommands of the package managers.
const INSTALL_LIMIT: Duration = Duration::from_secs(300);
/// The longest a model may ask for with timeout_ms.
const MAX_ASKED: u64 = 300_000;
/// Results keep the first HEAD_CHARS and the newest part, up to MAX_OUTPUT in all.
const HEAD_CHARS: usize = 2_000;
const MAX_OUTPUT: usize = 20_000;
/// Buffer cap per background process; the buffer keeps the newest part.
const MAX_PROCESS_LOG: usize = 1_000_000;
/// read_process shows at most this much of a log, the newest part.
const SHOWN_LOG: usize = 30_000;
/// Background processes one chat may have running at once.
const MAX_RUNNING: usize = 4;
/// A process that exits inside this window did not start.
const START_GRACE: Duration = Duration::from_millis(4_000);
/// An approval nobody answers in this time is a decline.
const APPROVAL_LIMIT: Duration = Duration::from_secs(5 * 60);

fn base_name(command: &str) -> String {
    let name = command.rsplit(['/', '\\']).next().unwrap_or(command).to_ascii_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".com"] {
        if let Some(stripped) = name.strip_suffix(ext) {
            return stripped.to_string();
        }
    }
    name
}

/// Commands that only look, never change. The caller only asks this of allowed programs.
fn read_only(name: &str, args: &[String]) -> bool {
    let first = args.iter().map(String::as_str).find(|a| !a.starts_with('-')).unwrap_or("");
    if matches!(name, "which" | "where") || (args.len() == 1 && INFO_FLAGS.contains(&args[0].as_str())) {
        return true;
    }
    match name {
        // The forms that change things were refused before this is asked (`LOOKING_FORMS`).
        "tasklist" | "systeminfo" | "whoami" | "hostname" | "driverquery" | "ipconfig" | "getmac" | "wevtutil" | "sc" | "nvidia-smi" | "ps" | "uname" | "df" | "uptime" | "id" | "free" | "lscpu" | "lsb_release" | "sw_vers" => true,
        "git" => git_read_only(first, args),
        "npm" => matches!(first, "ls" | "list" | "view" | "outdated" | "why" | "root" | "prefix"),
        "pnpm" => matches!(first, "ls" | "list" | "why" | "outdated"),
        "pip" | "pip3" => matches!(first, "list" | "show" | "freeze"),
        "go" => matches!(first, "version" | "env" | "list"),
        "cargo" => first == "tree",
        _ => false,
    }
}

/// git looks without a prompt only in listing form, and never with an argument that can write a file, run a helper or reach outside the repo.
// ponytail: git config overrides (core.fsmonitor, hooksPath) are not forced off as the web does; only the argument rules above apply.
fn git_read_only(first: &str, args: &[String]) -> bool {
    if !GIT_LOOKS.contains(&first) {
        return false;
    }
    let risky = args.iter().any(|a| {
        let a = a.as_str();
        ["--output", "-O", "--ext-diff", "--textconv", "--no-index", "--exec-path", "--work-tree", "--git-dir", "--orderfile", "--config-env", "-c", "-C", "-d"].iter().any(|p| a.starts_with(p))
            || matches!(a, "-D" | "-m" | "-M" | "add" | "remove" | "set-url")
            || Path::new(a).is_absolute()
            || a.starts_with('~')
            || a.split(['/', '\\']).any(|p| p == "..")
    });
    if risky {
        return false;
    }
    let positional: Vec<&str> = args.iter().map(String::as_str).filter(|a| !a.starts_with('-')).collect();
    match first {
        // `git branch NAME` creates a branch: only the bare listing is a look.
        "branch" => positional.len() == 1,
        // `git remote add/rename/remove/set-url` change the repo: only the list and get-url look.
        "remote" => positional.len() == 1 || (positional.len() == 3 && positional[1] == "get-url"),
        _ => true,
    }
}

/// Finds the program the way a terminal would. Rust's own lookup misses `npm.cmd` and friends on Windows.
/// A program the agent built in the workspace is also found by its bare .exe name.
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
    let on_path = std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).find_map(|dir| try_at(dir.join(command))));
    on_path.or_else(|| {
        let lower = command.to_ascii_lowercase();
        if lower.ends_with(".exe") || lower.ends_with(".com") { try_at(root.join(command)) } else { None }
    })
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

/// Is there a program of this name to run?
pub fn on_path(name: &str) -> bool {
    find_program(Path::new(""), name).is_some()
}

/// Could this PowerShell text change the computer? Only plain looking passes: every command in it is a cmdlet
/// whose verb looks (Get, Select, Where, Sort, Format, Measure, Test ...) or one of their short names, and nothing
/// in it redirects, starts a program, or calls into .NET to write.
// ponytail: a reading of the text, there to catch a change made in passing. It is not a parser, and code the model
// writes to a file and runs was never held by it. Use PowerShell's own parser (System.Management.Automation.Language)
// if this has to hold against a command written to get past it.
fn shell_changes(script: &str) -> bool {
    use std::sync::LazyLock;
    static STRINGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"'[^']*'|"[^"$`]*""#).unwrap());
    static RISKY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)>|&|`|\.(exe|bat|cmd|ps1|msi|vbs|js)\b|(\.|::)(delete|kill|remove|create|write|move|copy|set|start|invoke|save|terminate|open|append|download|load|exec|run|shellexecute|new)\w*\(").unwrap());
    static CMDLET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^([a-z]+)-[a-z]+$").unwrap());
    const VERBS: &[&str] = &["get", "select", "where", "sort", "format", "measure", "test", "resolve", "compare", "convertto", "convertfrom", "group", "foreach", "split", "join"];
    const WORDS: &[&str] = &[
        "gci", "dir", "ls", "gc", "cat", "type", "gi", "gp", "gps", "ps", "gsv", "gcim", "gwmi", "gcm", "gm", "gv", "gl", "pwd", "select", "where", "sort", "ft", "fl", "fw", "measure", "group", "echo", "sls", "foreach", "%", "?",
        "out-string", "out-null", "out-host", "write-output", "write-host", "hostname", "whoami", "tasklist", "systeminfo", "driverquery", "getmac",
        "if", "else", "elseif", "for", "while", "do", "switch", "try", "catch", "finally", "return", "in", "param",
    ];
    let bare = STRINGS.replace_all(script, "''");
    if RISKY.is_match(&bare) {
        return true;
    }
    // A cmdlet anywhere in it, not only at the start of a command: `$x = Remove-Item a` hides one behind a name.
    let named = |word: &str| !WORDS.contains(&word) && CMDLET.captures(word).is_some_and(|verb| !VERBS.contains(&verb[1].to_ascii_lowercase().as_str()));
    if bare.split(|c: char| c.is_whitespace() || "|;{}(),=".contains(c)).any(|word| named(&word.to_ascii_lowercase())) {
        return true;
    }
    bare.split(['|', ';', '\n', '{', '}', '(', ')']).any(|part| {
        let mut words = part.split_whitespace();
        let (first, second) = (words.next().unwrap_or("").to_ascii_lowercase(), words.next().unwrap_or(""));
        // A value, an operator or a name being given a value is no command.
        let command = first.starts_with(|c: char| c.is_ascii_alphabetic() || c == '%' || c == '?') && second != "=" && !first.contains('=');
        command && !WORDS.contains(&first.as_str()) && !CMDLET.is_match(&first)
    })
}

/// PowerShell on Windows: the one shell let through, for what only it can ask the system (event logs, services,
/// installed programs, hardware). The user is shown its text whole. With commands running automatically it runs
/// unasked only while it looks: text that could change the computer asks in every mode. The web has no such
/// thing, because it runs on a server and not on the user's own computer.
fn shell(ctx: &Ctx, command: &str, argv: Vec<String>) -> Result<Launch, String> {
    let mut words = argv.into_iter().peekable();
    while let Some(flag) = words.peek().map(|word| word.to_ascii_lowercase()) {
        match flag.as_str() {
            "-noprofile" | "-nop" | "-noninteractive" | "-nologo" | "-command" | "-c" => drop(words.next()),
            "-executionpolicy" | "-ep" | "-ex" => drop((words.next(), words.next())),
            flag if flag.starts_with("-e") || flag.starts_with("-f") => return Err("PowerShell is run here from its text alone, which the user reads: pass the command itself, not -EncodedCommand or -File.".into()),
            _ => break,
        }
    }
    let script = words.collect::<Vec<_>>().join(" ");
    if script.trim().is_empty() {
        return Err("No PowerShell command was given. Pass it as one string, e.g. {\"command\":\"powershell\",\"args\":[\"Get-Process | Sort-Object CPU -Descending | Select-Object -First 10\"]}.".into());
    }
    if super::files::closed_text(&script) {
        return Err(format!("The command names a place that is not read: {}", super::files::CLOSED_WHY));
    }
    let Some(program) = find_program(&ctx.root, command) else { return Err(format!("`{command}` was not found on this machine.")) };
    let ask = ctx.settings.approval == Approval::Manual || shell_changes(&script);
    let key = serde_json::to_string(&["powershell", script.as_str()]).unwrap_or_default();
    // Its output is asked for in UTF-8: the console's own code page turns every non-English letter into noise.
    let args = ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command"].iter().map(|flag| flag.to_string()).chain([format!("[Console]::OutputEncoding = [Text.Encoding]::UTF8; {script}")]).collect();
    Ok(Launch { program, args, display: format!("powershell {script}"), key, ask })
}

#[cfg(windows)]
pub(crate) fn hide_window_std(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
}
#[cfg(not(windows))]
pub(crate) fn hide_window_std(_: &mut std::process::Command) {}

/// The `args` list as the web checks it: a list of strings with no NUL bytes.
fn argv_arg(args: &Value, key: &str) -> Result<Vec<String>, String> {
    let v = &args[key];
    if v.is_null() {
        return Ok(Vec::new());
    }
    let Some(items) = v.as_array() else { return Err("args must be a list of strings, not a single string.".into()) };
    items
        .iter()
        .map(|a| match a.as_str() {
            None => Err("Every argument must be a string.".to_string()),
            Some(s) if s.contains('\0') => Err("Arguments must not contain NUL bytes.".to_string()),
            Some(s) => Ok(s.to_string()),
        })
        .collect()
}

/// The time a command may run, as the web's timeoutFor works it out: a caller's timeout_ms is honoured within 5 to 300 seconds.
fn timeout_for(command: &str, args: &[String], asked_ms: Option<u64>) -> Duration {
    if let Some(ms) = asked_ms.filter(|m| *m > 0) {
        return Duration::from_millis(ms.clamp(5_000, MAX_ASKED));
    }
    let slow = SLOW_COMMANDS.contains(&base_name(command).as_str()) && args.iter().any(|a| SLOW_SUBCOMMANDS.contains(&a.as_str()));
    if slow { INSTALL_LIMIT } else { RUN_LIMIT }
}

/// A command ready to start, with the line shown on the approval prompt.
struct Launch {
    program: PathBuf,
    args: Vec<String>,
    display: String,
    /// What "always allow" remembers: the normalised name and its arguments, as JSON.
    key: String,
    /// Needs a prompt in this approval mode.
    ask: bool,
}

/// Decides before anything runs whether a command is refused, asked about, or run.
fn prepare(ctx: &Ctx, command: &str, argv: Vec<String>) -> Result<Launch, String> {
    if command.is_empty() {
        return Err("No command was given. Pass command as a string and args as a list of strings, e.g. {\"command\":\"python3\",\"args\":[\"app.py\"]}. There is no shell, so do not pass \"?\", \"true\", or a full command line in one string.".into());
    }
    // A whole command line in one string, from a model that forgot the list: taken apart when it is plain
    // words and no program of that very name exists (a path may hold a space).
    // PowerShell written as one line keeps its text whole: its quotes are its own.
    let shell_line = command.split_once(char::is_whitespace).filter(|(first, _)| argv.is_empty() && matches!(base_name(first).as_str(), "powershell" | "pwsh"));
    let one_line = argv.is_empty() && command.contains(' ') && !command.contains(['"', '\'']) && find_program(&ctx.root, command).is_none();
    let (command, argv) = if let Some((first, rest)) = shell_line {
        (first, vec![rest.to_string()])
    } else if one_line {
        let mut words = command.split_whitespace();
        (words.next().unwrap_or(""), words.map(str::to_string).collect())
    } else {
        (command, argv)
    };
    let name = base_name(command);
    if cfg!(windows) && matches!(name.as_str(), "powershell" | "pwsh") {
        return shell(ctx, command, argv);
    }
    if SHELLS.contains(&name.as_str()) {
        return Err(format!("Shells are not available. Run the interpreter directly, e.g. `python app.py` rather than `sh -c \"python app.py\"`.{}", if cfg!(windows) { " For a question to the system itself use powershell, with the command as one string in args." } else { "" }));
    }
    // No shell reads `>out.txt` or `|` either: the program gets them as words ("Error opening ./>_NBUF_OUT.txt").
    if let Some(word) = argv.iter().map(|a| a.trim()).find(|a| matches!(*a, "|" | "&&" | "<") || a.starts_with('>') || a.starts_with("2>") || a.starts_with("1>") || a.starts_with("&>")) {
        return Err(format!("There is no shell here, so `{word}` would reach the program as a plain argument and redirect nothing. The output comes back to you as the result. To keep it in a file, have the program write the file itself."));
    }
    if let Some((_, forms)) = LOOKING_FORMS.iter().find(|(tool, _)| *tool == name) {
        let first = argv.first().map(|word| word.to_ascii_lowercase()).unwrap_or_default();
        if !forms.contains(&first.as_str()) {
            let looking: Vec<String> = forms.iter().map(|form| format!("{name} {form}").trim().to_string()).collect();
            return Err(format!("Only the forms of {name} that look are run here: {}.{}", looking.join(", "), if cfg!(windows) { " To change something on this computer use powershell: the user is asked first." } else { "" }));
        }
    }
    // The web's browser rules: the user's own browser is never driven, closed or pointed at their profile.
    let verdict = crate::browser::policy::check_browser_policy(command, &argv, &ctx.root.to_string_lossy());
    let argv = match verdict.action {
        crate::browser::policy::Action::Refuse => {
            let reason = verdict.reason.unwrap_or_default();
            crate::diagnostics::record("browser_blocked", command, &reason);
            return Err(reason);
        }
        crate::browser::policy::Action::Rewrite => verdict.args,
        crate::browser::policy::Action::Allow => argv,
    };
    // On Windows `python3` is a Store stub; the real interpreter is `python`.
    let lookup = if cfg!(windows) && command.eq_ignore_ascii_case("python3") { "python" } else { command };
    let found = find_program(&ctx.root, lookup);
    let own = found.as_ref().is_some_and(|p| p.starts_with(&ctx.root));
    if !own && !ALLOWED.contains(&name.as_str()) && !SYSTEM.contains(&name.as_str()) {
        return Err(format!(
            "\"{name}\" is not an allowed command. Allowed: {}. A program you built yourself can be run by its path inside the workspace, e.g. \"build/app.exe\" — the file has to exist there first. A tool installed with pip runs as `python -m {name}`, one from npm as `npx {name}`.{}",
            ALLOWED.join(", "),
            if cfg!(windows) { " For the computer itself: tasklist, systeminfo, wevtutil, reg query, sc query, or powershell." } else { "" }
        ));
    }
    let Some(program) = found else {
        return Err(format!("`{command}` was not found on this machine (not on PATH and not in the workspace)."));
    };
    // A program given by path must be one apiM located itself (a toolchain) or one built inside the workspace.
    if !own && command.contains(['/', '\\']) && !super::build::is_toolchain(&program) {
        return Err(format!("`{command}` is outside the workspace. Run programs by name, e.g. `node`, or by a path inside the workspace."));
    }
    // "Run automatically" asks about nothing. Otherwise a program from the workspace (built there, or downloaded) always
    // asks, and an allowed program asks unless it merely looks.
    let ask = ctx.settings.approval == Approval::Manual && (own || !read_only(&name, &argv));
    let display = std::iter::once(command.to_string()).chain(argv.iter().map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() })).collect::<Vec<_>>().join(" ");
    let key = serde_json::to_string(&std::iter::once(name).chain(argv.iter().cloned()).collect::<Vec<_>>()).unwrap_or_default();
    Ok(Launch { program, args: argv, display, key, ask })
}

// ponytail: no per-chat venv or pip/npm containment (PYTHONUSERBASE, npm prefix under .packages); installs land in the global toolchain.
/// Why a program could not be started. Windows refuses a starting folder whose path runs past about 250
/// characters with "The directory name is invalid", which reads as a broken runner: the real cause is said instead.
fn start_error(e: &std::io::Error, folder: &Path) -> String {
    let long = folder.as_os_str().len();
    if cfg!(windows) && e.raw_os_error() == Some(267) && long > 240 {
        return format!("the workspace folder's path is {long} characters long, more than Windows allows for the folder a program starts in (about 250). Nothing is wrong with the command: the app's data folder has to sit at a shorter path. Tell the user so.");
    }
    e.to_string()
}

fn command(ctx: &Ctx, launch: &Launch) -> Command {
    let mut cmd = Command::new(&launch.program);
    cmd.args(&launch.args).current_dir(&ctx.root).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    // Only the variables a build or a test needs reach the child: API keys and the rest of apiM's environment stay here.
    cmd.env_clear();
    for key in CHILD_ENV {
        if let Ok(value) = std::env::var(key) {
            cmd.env(key, value);
        }
    }
    // Colour codes and pagers only add noise to captured output.
    cmd.env("NO_COLOR", "1").env("FORCE_COLOR", "0").env("GIT_PAGER", "cat").env("PAGER", "cat").env("PYTHONUNBUFFERED", "1").env("PYTHONIOENCODING", "utf-8");
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd
}

/// Asks for approval when the command needs it. Err is the reason the command was not run.
async fn approved(ctx: &Ctx, launch: &Launch, reason: &str) -> Result<(), &'static str> {
    if !launch.ask {
        return Ok(());
    }
    match tokio::time::timeout(APPROVAL_LIMIT, ctx.emit.approve_keyed(&launch.display, reason, &launch.key)).await {
        Ok(true) => Ok(()),
        Ok(false) => {
            crate::diagnostics::record("command_refused", &launch.display.chars().take(60).collect::<String>(), "The user declined this command.");
            Err("The user declined this command.")
        }
        Err(_) => Err("The user did not respond to the approval prompt within 5 minutes."),
    }
}

/// The refusal text for a command that did not run.
fn not_run(reason: &str) -> String {
    format!("The command was not run. {reason} Do not retry it — explain what you were trying to do, or suggest a different approach.")
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

/// Kills the process tree if a run is abandoned (Stop, or the turn ends) before it finishes.
struct TreeGuard(Option<u32>);

impl Drop for TreeGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            kill_tree(pid);
        }
    }
}

/// Runs to completion or to the limit (None waits as long as it takes). Returns (exit code, combined output, timed out).
async fn run_to_end(mut child: Child, limit: Option<Duration>) -> (Option<i32>, String, bool) {
    let log = Arc::new(Mutex::new(String::new()));
    let readers = [child.stdout.take().map(|p| pump(p, log.clone())), child.stderr.take().map(|p| pump(p, log.clone()))];
    let pid = child.id();
    let mut guard = TreeGuard(pid);
    let waited = match limit {
        Some(limit) => tokio::time::timeout(limit, child.wait()).await.ok(),
        None => Some(child.wait().await),
    };
    // Finished or timed out: the explicit kill below handles the second, so the guard has nothing left to do.
    guard.0 = None;
    let (code, timed_out) = match waited {
        Some(status) => (status.ok().and_then(|s| s.code()), false),
        None => {
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

/// What one finished run left behind.
pub struct Ran {
    /// The command line as the approval card showed it.
    pub display: String,
    /// None when the process ended without an exit code.
    pub code: Option<i32>,
    /// stdout and stderr together, in the order they arrived.
    // ponytail: the web keeps stdout and stderr apart; the two streams are interleaved here.
    pub out: String,
    pub timed_out: bool,
    pub took: Duration,
    /// Set when the program could not be started at all.
    pub error: Option<String>,
}

/// Approves and runs one program to the end, shared by run_command, run_tests and build_project. `limit` None waits as long as it takes.
/// Err is the refusal, ready to return to the model.
/// `stdin` is text for the program's standard input: `python -` runs it as a script, in one call and with no file
/// left behind. A reply wrote some fifty one-off scripts as files and ran each in a second round.
pub async fn execute(ctx: &Ctx, program: &str, argv: Vec<String>, reason: &str, limit: Option<Duration>, stdin: Option<&str>) -> Result<Ran, Output> {
    let mut launch = prepare(ctx, program.trim(), argv).map_err(Output::fail)?;
    let short = match stdin {
        Some(text) => format!("{} <<stdin ({} lines)", launch.display, text.lines().count()),
        None => launch.display.clone(),
    };
    if let Some(text) = stdin {
        // The user approves the script itself, not the dash that stands for it, and "always allow" remembers that script only.
        launch.display = format!("{short}\n{}", text.chars().take(2_000).collect::<String>());
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        std::hash::Hash::hash(text, &mut hasher);
        launch.key.push_str(&format!("#{:x}", std::hash::Hasher::finish(&hasher)));
    }
    approved(ctx, &launch, reason).await.map_err(|why| Output::fail(not_run(why)))?;
    launch.display = short;
    let mut child = match command(ctx, &launch).env("CI", "1").stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).spawn() {
        Ok(child) => child,
        Err(e) => return Ok(Ran { display: launch.display, code: None, out: String::new(), timed_out: false, took: Duration::ZERO, error: Some(start_error(&e, &ctx.root)) }),
    };
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        // Written from the side: a program that prints before it has read everything must not hold the write up.
        let text = text.to_string();
        tokio::spawn(async move {
            let _ = pipe.write_all(text.as_bytes()).await;
        });
    }
    let started = Instant::now();
    let (code, out, timed_out) = run_to_end(child, limit).await;
    Ok(Ran { display: launch.display, code, out, timed_out, took: started.elapsed(), error: None })
}

/// Keeps the first HEAD_CHARS and the newest part of a long output, and counts the middle, as the web's OutputBuffer does.
fn head_tail(text: &str) -> String {
    let total = text.chars().count();
    if total <= MAX_OUTPUT {
        return text.to_string();
    }
    let head: String = text.chars().take(HEAD_CHARS).collect();
    let tail: String = text.chars().skip(total - (MAX_OUTPUT - HEAD_CHARS)).collect();
    format!("{head}\n… [{} chars of output omitted] …\n{tail}", group((total - MAX_OUTPUT) as u64))
}

/// The newest `n` characters of a text.
fn last_chars(text: &str, n: usize) -> String {
    let total = text.chars().count();
    text.chars().skip(total.saturating_sub(n)).collect()
}

fn or_text(text: &str, fallback: &str) -> String {
    if text.is_empty() { fallback.to_string() } else { text.to_string() }
}

/// The line of a failed command's output that says why: the last one naming an error, else the last one at all.
fn telling_line(out: &str) -> Option<String> {
    let lines: Vec<&str> = out.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    let names_error = |line: &&&str| ["error", "failed", "fatal", "panic", "exception", "not found", "cannot", "denied"].iter().any(|word| line.to_lowercase().contains(word));
    let line = lines.iter().rev().find(names_error).or(lines.last())?;
    Some(if line.chars().count() > 240 { format!("{}…", line.chars().take(239).collect::<String>()) } else { line.to_string() })
}

/// Formats a finished run the way the web's formatRunResult does: the status first, then the output.
fn report(ran: &Ran) -> Output {
    let mut parts = vec![format!("$ {}", ran.display)];
    let (ok, summary) = if let Some(err) = &ran.error {
        parts.push(format!("\nSTATUS: could not run - {err}"));
        (false, format!("Could not run: {err}"))
    } else if ran.timed_out {
        parts.push("\nSTATUS: timed out and was stopped after the time limit. If this is a server/watcher use start_process; if it waits for input add a non-interactive flag (-y/--yes/--no-input); if it is genuinely slow pass a larger timeout_ms. What a program had not flushed is lost when it is stopped: have a long job write to a file, and read the file.".to_string());
        (false, format!("Timed out: {}", ran.display))
    } else if ran.code == Some(0) {
        parts.push(format!("\nSTATUS: ok (exit 0){}", crate::sandbox::run::took(ran.took)));
        (true, format!("Ran: {}", ran.display))
    } else {
        let code = ran.code.map_or("unknown".to_string(), |c| c.to_string());
        parts.push(format!("\nSTATUS: failed (exit {code}){}. Read Errors/Output below, fix the actual cause, then re-run. Do not retry the identical command.", crate::sandbox::run::took(ran.took)));
        (false, match telling_line(&ran.out) {
            Some(why) => format!("Exit {code}: {why}"),
            None => format!("Exit {code}"),
        })
    };
    let out = ran.out.trim();
    if !out.is_empty() {
        parts.push(format!("\nOutput:\n{}", head_tail(out)));
    } else if ran.error.is_none() && !ran.timed_out {
        parts.push("\n(no output)".to_string());
    }
    if out.chars().count() > MAX_OUTPUT {
        parts.push("\n(output was long; the start and the end are shown, the middle is omitted)".to_string());
    }
    Output { ok, text: parts.join("\n"), summary, ..Default::default() }
}

pub async fn run_command(ctx: &Ctx, args: &Value) -> Output {
    let command = str_arg(args, "command").trim();
    let mut argv = match argv_arg(args, "args") {
        Ok(argv) => argv,
        Err(e) => return Output::fail(e),
    };
    let mut stdin = str_arg(args, "stdin").to_string();
    // The dash means "the script is on stdin". Written after the dash as one more argument, the script reached
    // nobody: python started its prompt on an empty stdin and "exit 0" came back. The reply read that as stdin being
    // broken and wrote each of its next forty checks to a file, with a second round to run it.
    if stdin.is_empty() && argv.first().is_some_and(|a| a == "-") {
        match argv.get(1) {
            Some(script) if script.contains('\n') => stdin = argv.remove(1),
            _ => return Output::fail("`-` tells the program to read its script from stdin, and no stdin was given. The script goes in \"stdin\": {\"command\":\"python\",\"args\":[\"-\"],\"stdin\":\"print(1)\"}."),
        }
    }
    let limit = timeout_for(command, &argv, num_arg(args, "timeout_ms"));
    match execute(ctx, command, argv, str_arg(args, "reason"), Some(limit), Some(stdin.as_str()).filter(|text| !text.is_empty())).await {
        Ok(ran) => report(&ran),
        Err(refused) => refused,
    }
}

/// The run_tests tool: the runner comes from the workspace, and the output is reduced to the verdict and the failures.
pub async fn run_tests(ctx: &Ctx, args: &Value) -> Output {
    let Some(runner) = testing::detect_runner(&ctx.root) else {
        return Output { ok: false, text: "Error: no test suite found. Looked for a package.json test script, pytest config, a tests/ directory, Cargo.toml and go.mod. If tests live somewhere unusual, run them with run_command instead.".into(), summary: "No test suite found".into(), ..Default::default() };
    };
    let mut argv = runner.args.clone();
    let mut command = runner.command.clone();
    let pytest = runner.name == "pytest";
    // pytest is often there as a module with no program of its own on PATH.
    if pytest && find_program(&ctx.root, "pytest").is_none() {
        command = "python".into();
        argv.splice(0..0, ["-m".to_string(), "pytest".to_string()]);
    }
    let filter = str_arg(args, "filter").trim();
    if !filter.is_empty() {
        // pytest takes a path as it is; a test's name goes behind -k, or it is looked for as a file.
        if pytest && !filter.contains(['/', '\\', ':']) && !filter.ends_with(".py") {
            argv.push("-k".into());
        }
        argv.push(filter.to_string());
    }
    let limit = timeout_for(&command, &argv, None);
    let ran = match execute(ctx, &command, argv, "Run the project's tests", Some(limit), None).await {
        Ok(ran) => ran,
        Err(refused) => return refused,
    };
    if ran.out.contains("No module named pytest") {
        return Output::fail("pytest is not installed on this machine, so the tests could not run. Install it (run_command: pip install pytest), then call run_tests again.");
    }
    let summary = testing::parse_output(&runner.name, &ran.out, "", ran.code.unwrap_or(1));
    // A failing suite is a successful tool call: the agent asked what the state was and got a true answer.
    Output { ok: true, text: testing::format_summary(&summary, &format!("{}\n", ran.out)), summary: testing::headline(&summary), ..Default::default() }
}

// ---------------------------------------------------------------- background processes

struct Proc {
    display: String,
    pid: u32,
    /// The chat that started it: only that chat can see or stop it.
    owner: PathBuf,
    started: Instant,
    log: Arc<Mutex<String>>,
    /// Set once the process has exited.
    exit: Arc<Mutex<Option<i32>>>,
    /// When it exited, for the elapsed time in its status line.
    ended: Arc<Mutex<Option<Instant>>>,
    /// Set when someone stopped it on purpose.
    stopped: AtomicBool,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
}

// ponytail: exited processes are never pruned (the web drops them after 10 minutes) and nothing idles out.
/// Background processes the agent started. Everything still running is stopped when the app closes.
#[derive(Default)]
pub struct Procs {
    next: AtomicU32,
    map: Mutex<HashMap<String, Arc<Proc>>>,
}

impl Procs {
    fn get(&self, id: &str, owner: &Path) -> Option<Arc<Proc>> {
        // "1" for "p1": the number alone is what a model often sends back.
        let id = if !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) { format!("p{id}") } else { id.to_string() };
        self.map.lock().unwrap().get(&id).filter(|p| p.owner.as_path() == owner).cloned()
    }

    /// The processes one chat started, oldest first.
    fn owned(&self, owner: &Path) -> Vec<(String, Arc<Proc>)> {
        let mut out: Vec<(String, Arc<Proc>)> = self.map.lock().unwrap().iter().filter(|(_, p)| p.owner.as_path() == owner).map(|(id, p)| (id.clone(), p.clone())).collect();
        // Ids are "p1", "p2", … "p10": by number, not by text.
        out.sort_by_key(|(id, _)| id[1..].parse::<u32>().unwrap_or(u32::MAX));
        out
    }

    /// Stops the running processes (of one chat, or of all), and returns how many it stopped.
    fn stop_where(&self, owner: Option<&Path>) -> usize {
        let running: Vec<Arc<Proc>> = self.map.lock().unwrap().values().filter(|p| p.exit.lock().unwrap().is_none() && owner.is_none_or(|o| p.owner.as_path() == o)).cloned().collect();
        for p in &running {
            p.stopped.store(true, Ordering::Relaxed);
            kill_tree(p.pid);
        }
        running.len()
    }

    pub fn stop_all(&self) -> usize {
        self.stop_where(None)
    }

    /// Takes a started process into the list, so read_process, write_process and stop_process work on it, and
    /// gives it up to `grace` to show whether it stays up. Returns its id, its exit code when it did not, and
    /// what it has printed so far.
    pub async fn adopt(&self, owner: PathBuf, display: String, mut child: Child, wake: crate::agent::Emitter, grace: Duration) -> (String, Option<i32>, String) {
        let log = Arc::new(Mutex::new(String::new()));
        if let Some(p) = child.stdout.take() {
            pump(p, log.clone());
        }
        if let Some(p) = child.stderr.take() {
            pump(p, log.clone());
        }
        let exit = Arc::new(Mutex::new(None));
        let ended = Arc::new(Mutex::new(None));
        let proc = Arc::new(Proc { display, pid: child.id().unwrap_or(0), owner, started: Instant::now(), log: log.clone(), exit: exit.clone(), ended: ended.clone(), stopped: AtomicBool::new(false), stdin: tokio::sync::Mutex::new(child.stdin.take()) });
        let id = format!("p{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        self.map.lock().unwrap().insert(id.clone(), proc.clone());
        tokio::spawn(async move {
            let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
            *exit.lock().unwrap() = Some(code);
            *ended.lock().unwrap() = Some(Instant::now());
            wake.wake();
        });
        // One that is gone already need not be waited out.
        let until = Instant::now() + grace;
        while Instant::now() < until && proc.exit.lock().unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // Its last words may still be in the pipe.
        if proc.exit.lock().unwrap().is_some() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let shown = log_shown(&log.lock().unwrap().clone());
        (id, *proc.exit.lock().unwrap(), shown)
    }

    /// How many are still running, for the header badge.
    pub fn running(&self) -> usize {
        self.map.lock().unwrap().values().filter(|p| p.exit.lock().unwrap().is_none()).count()
    }

    /// Every process started so far, oldest first, for the header's process list.
    pub fn list(&self) -> Vec<ProcInfo> {
        let mut all: Vec<(String, Arc<Proc>)> = self.map.lock().unwrap().iter().map(|(id, p)| (id.clone(), p.clone())).collect();
        all.sort_by_key(|(id, _)| id[1..].parse::<u32>().unwrap_or(u32::MAX));
        all.iter().map(|(id, p)| info(id, p)).collect()
    }

    /// One chat's processes, for the build's lock report.
    pub fn list_for(&self, owner: &Path) -> Vec<ProcInfo> {
        self.owned(owner).iter().map(|(id, p)| info(id, p)).collect()
    }
}

/// One background process as the header shows it.
#[derive(Clone, Debug, PartialEq)]
pub struct ProcInfo {
    pub id: String,
    pub display: String,
    pub pid: u32,
    /// None while it is still running.
    pub exit: Option<i32>,
    /// The last 2000 characters it printed.
    pub log_tail: String,
}

fn info(id: &str, p: &Proc) -> ProcInfo {
    ProcInfo { id: id.to_string(), display: p.display.clone(), pid: p.pid, exit: *p.exit.lock().unwrap(), log_tail: tail_chars(&p.log.lock().unwrap(), 2000) }
}

/// The last `n` characters of `text`.
fn tail_chars(text: &str, n: usize) -> String {
    let start = text.char_indices().rev().nth(n.saturating_sub(1)).map_or(0, |(at, _)| at);
    text[start..].to_string()
}

impl Drop for Procs {
    fn drop(&mut self) {
        self.stop_all();
        // The sandbox's off-screen display goes with the app; a no-op when it was never started.
        crate::sandbox::run::close(std::path::Path::new("wsl.exe"));
    }
}

/// The status line of one process, as the web's describeProcess words it.
fn describe(id: &str, p: &Proc) -> String {
    let exit = *p.exit.lock().unwrap();
    let end = p.ended.lock().unwrap().unwrap_or_else(Instant::now);
    let seconds = end.duration_since(p.started).as_secs_f64().round() as u64;
    let status = match exit {
        None => format!("running ({seconds}s)"),
        Some(_) if p.stopped.load(Ordering::Relaxed) => "stopped".to_string(),
        Some(code) => format!("exited with code {code} after {seconds}s"),
    };
    format!("{id}: {} — {status}", p.display)
}

fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

pub async fn start_process(ctx: &Ctx, args: &Value) -> Output {
    let program = str_arg(args, "command").trim();
    let argv = match argv_arg(args, "args") {
        Ok(argv) => argv,
        Err(e) => return Output::fail(e),
    };
    let launch = match prepare(ctx, program, argv) {
        Ok(l) => l,
        Err(e) => return Output::fail(e),
    };
    let owner = ctx.state_dir.clone();
    let running: Vec<String> = ctx.procs.owned(&owner).into_iter().filter(|(_, p)| p.exit.lock().unwrap().is_none()).map(|(id, p)| format!("{id} ({})", p.display)).collect();
    if running.len() >= MAX_RUNNING {
        return Output::fail(format!("Already running {} background processes in this workspace, which is the limit. Stop one first: {}", running.len(), running.join(", ")));
    }
    if let Err(why) = approved(ctx, &launch, str_arg(args, "reason")).await {
        return Output::fail(not_run(why));
    }
    let child = match command(ctx, &launch).stdin(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => return Output::fail(format!("Could not start `{}`: {}", launch.display, start_error(&e, &ctx.root))),
    };
    // A process that exits inside the first seconds did not start: that is a failure, not a background job.
    let (id, died, shown) = ctx.procs.adopt(owner, launch.display.clone(), child, ctx.emit.clone(), START_GRACE).await;
    let shown = shown.trim();
    if let Some(code) = died {
        return Output { ok: false, text: format!("{} exited immediately (code {code}).\n\n{}\n\nFix the cause before trying again.", launch.display, or_text(shown, "(no output)")), summary: format!("Failed to start: {}", launch.display), ..Default::default() };
    }
    Output::ok(format!("Started {} — id {id}, still running.\n\n{}\n\nRead more with read_process, and stop it with stop_process when done.", launch.display, or_text(shown, "(no output yet)")), format!("Started {}", launch.display))
}

/// A log as read_process shows it: the newest SHOWN_LOG characters at most.
fn log_shown(log: &str) -> String {
    if log.chars().count() > SHOWN_LOG { last_chars(log, SHOWN_LOG) } else { log.to_string() }
}

pub fn read_process(ctx: &Ctx, args: &Value) -> Output {
    let owner = ctx.state_dir.as_path();
    let id = str_arg(args, "id").trim();
    if id.is_empty() {
        let all = ctx.procs.owned(owner);
        if all.is_empty() {
            return Output::ok("No background processes in this workspace.", "No processes");
        }
        let lines: Vec<String> = all.iter().map(|(id, p)| describe(id, p)).collect();
        return Output::ok(lines.join("\n"), format!("{} process{}", lines.len(), if lines.len() == 1 { "" } else { "es" }));
    }
    let Some(p) = ctx.procs.get(id, owner) else {
        return Output::fail(format!("No process with id \"{id}\" in this workspace."));
    };
    let mut body = p.log.lock().unwrap().trim().to_string();
    let mut dropped_note = "";
    if body.chars().count() > SHOWN_LOG {
        body = last_chars(&body, SHOWN_LOG);
        dropped_note = "\n\n[earlier output dropped — only the most recent is kept]";
    }
    let mut tail_note = String::new();
    if let Some(n) = num_arg(args, "tail").filter(|n| *n > 0) {
        let lines: Vec<&str> = body.split('\n').collect();
        if lines.len() > n as usize {
            tail_note = format!("\n\n[showing the last {n} of {} lines]", lines.len());
            body = lines[lines.len() - n as usize..].join("\n");
        }
    }
    let running = p.exit.lock().unwrap().is_none();
    Output::ok(
        format!("{}\n\n{}{tail_note}{dropped_note}", describe(id, &p), or_text(&body, "(no output)")),
        if running { format!("Read {}", p.display) } else { format!("{} has stopped", p.display) },
    )
}

pub async fn write_process(ctx: &Ctx, args: &Value) -> Output {
    let id = str_arg(args, "id").trim();
    let Some(p) = ctx.procs.get(id, &ctx.state_dir) else {
        return Output::fail(format!("No process with id \"{id}\" in this workspace. Use read_process with no id to list them."));
    };
    let exit = *p.exit.lock().unwrap();
    let refused = if p.stopped.load(Ordering::Relaxed) {
        Some("That process was stopped.".to_string())
    } else {
        exit.map(|code| format!("That process already exited (code {code})."))
    };
    if let Some(reason) = refused {
        return Output::fail(format!("Could not send that: {reason}"));
    }
    let input = str_arg(args, "input");
    let mut stdin = p.stdin.lock().await;
    let Some(pipe) = stdin.as_mut() else {
        return Output::fail("Could not send that: That process is not accepting input.");
    };
    // The line ends with a newline, once.
    let line = if input.ends_with('\n') { input.to_string() } else { format!("{input}\n") };
    if let Err(e) = pipe.write_all(line.as_bytes()).await {
        return Output::fail(format!("Could not send that: {e}"));
    }
    let _ = pipe.flush().await;
    p.log.lock().unwrap().push_str(&format!("> {}\n", input.trim_end()));
    // Give the process a moment to react, so the reply shows its answer.
    tokio::time::sleep(Duration::from_millis(250)).await;
    let tail = last_lines(&p.log.lock().unwrap().clone(), 15);
    let said = input.trim();
    Output::ok(
        format!("Sent to {}: {said}\n\nOutput since (last 15 lines):\n{}\n\nRead it again with read_process if it needed longer to respond.", p.display, or_text(&tail, "(nothing yet)")),
        format!("Sent \"{}\"", said.chars().take(20).collect::<String>()),
    )
}

pub fn stop_process(ctx: &Ctx, args: &Value) -> Output {
    let id = str_arg(args, "id").trim();
    if id == "all" {
        let n = tokio::task::block_in_place(|| ctx.procs.stop_where(Some(ctx.state_dir.as_path())));
        if n == 0 {
            return Output::ok("Nothing was running.", "Stopped 0");
        }
        return Output::ok(format!("Stopped {n} process{}.", if n == 1 { "" } else { "es" }), format!("Stopped {n}"));
    }
    let Some(p) = ctx.procs.get(id, &ctx.state_dir) else {
        return Output::fail(format!("No process with id \"{id}\" in this workspace."));
    };
    if p.exit.lock().unwrap().is_none() {
        p.stopped.store(true, Ordering::Relaxed);
        tokio::task::block_in_place(|| kill_tree(p.pid));
    }
    Output::ok(format!("Stopped {}.", p.display), format!("Stopped {}", p.display))
}

pub async fn wait_for_output(ctx: &Ctx, args: &Value) -> Output {
    let id = str_arg(args, "id");
    let Some(p) = ctx.procs.get(id, &ctx.state_dir) else {
        return Output::fail(format!("Error: no process with id \"{id}\". Use list_processes."));
    };
    let pattern = str_arg(args, "pattern");
    // Case-insensitive; a pattern that is not a valid regex is matched as plain text.
    let re = if pattern.is_empty() {
        None
    } else {
        Some(Regex::new(&format!("(?i){pattern}")).unwrap_or_else(|_| Regex::new(&format!("(?i){}", regex::escape(pattern))).expect("escaped pattern is valid")))
    };
    let limit = Duration::from_millis(num_arg(args, "timeout_ms").unwrap_or(30_000).clamp(1_000, 120_000));
    let started = Instant::now();
    loop {
        let log = p.log.lock().unwrap().clone();
        let exited = *p.exit.lock().unwrap();
        let matched_line = re.as_ref().and_then(|r| log.lines().find(|l| r.is_match(l)).map(|l| l.trim().to_string()));
        let outcome = if matched_line.is_some() {
            "matched"
        } else if exited.is_some() {
            "exited"
        } else if started.elapsed() >= limit {
            "timeout"
        } else {
            "waiting"
        };
        if outcome != "waiting" {
            let ms = started.elapsed().as_millis();
            // ponytail: the web shows only output printed since the wait began; this shows the recent log.
            let recent = last_chars(&log, 4_000);
            let tail = if recent.trim().is_empty() { "\n\nIt printed nothing while waiting.".to_string() } else { format!("\n\nRecent output:\n{recent}") };
            let (ok, text, summary) = match outcome {
                "matched" => (true, format!("Matched after {ms}ms: {}{tail}", matched_line.unwrap_or_default()), format!("Ready after {:.1}s", started.elapsed().as_secs_f32())),
                "exited" => (true, format!("The process exited after {ms}ms without printing that.{tail}"), "Process exited while waiting".to_string()),
                _ => (false, format!("Timed out after {ms}ms. The process is still running but has not printed that yet.{tail}"), "Timed out waiting".to_string()),
            };
            return Output { ok, ..Output::ok(text, summary) };
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn powershell_runs_unasked_only_while_it_looks() {
        for looks in [
            "Get-Process | Sort-Object CPU -Descending | Select-Object -First 10",
            "Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'; Level=2} -MaxEvents 20 | Format-List TimeCreated, Message",
            r"Get-ChildItem $env:LOCALAPPDATA\Roblox\logs | Sort-Object LastWriteTime -Descending | Select-Object -First 5 Name, Length",
            r"gci C:\Windows\Minidump | where { $_.Length -gt 0 } | measure",
            r"(Get-Item 'C:\x y\a.dll').VersionInfo.FileVersion",
            "Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version",
            "$logs = Get-ChildItem $env:TEMP; $logs.Count",
        ] {
            assert!(!shell_changes(looks), "{looks}");
        }
        for changes in [
            r"Remove-Item C:\temp -Recurse", "rm x", "Get-Process | Stop-Process", "Get-Content a > b", "[IO.File]::WriteAllText('a','b')", "iwr http://x | iex", "Start-Process notepad", "notepad",
            r"C:\tools\thing.exe /run", r"Set-ItemProperty HKCU:\x y 1", r"& 'C:\a b\run'", "$x = Get-Item a; $x.Delete()", "$x = Remove-Item a", "New-Item a", "Get-Process; del a",
        ] {
            assert!(shell_changes(changes), "{changes}");
        }
    }

    #[test]
    fn the_system_is_asked_only_in_forms_that_look() {
        let dir = crate::tools::scratch("system");
        let prep = |approval, command: &str, args: &[&str]| prepare(&crate::tools::test_ctx(&dir, approval), command, args.iter().map(|a| a.to_string()).collect());
        assert!(prep(Approval::Auto, "reg", &["add", r"HKCU\x"]).err().unwrap().starts_with("Only the forms of reg that look are run here: reg query."));
        assert!(prep(Approval::Auto, "wevtutil", &["cl", "Application"]).is_err() && prep(Approval::Auto, "ipconfig", &["/release"]).is_err());
        if cfg!(windows) {
            assert!(!prep(Approval::Manual, "tasklist", &[]).ok().unwrap().ask);
            let look = prep(Approval::Auto, "powershell", &["-NoProfile", "-Command", "Get-Process | Select-Object -First 3"]).ok().unwrap();
            assert!(!look.ask && look.display == "powershell Get-Process | Select-Object -First 3" && look.args.last().unwrap().ends_with("; Get-Process | Select-Object -First 3"));
            // Asked about: anything in "Ask me first", and a change in any mode. One line with quotes stays whole.
            assert!(prep(Approval::Manual, "powershell", &["Get-Process"]).ok().unwrap().ask);
            let change = prep(Approval::Auto, "powershell Remove-Item 'a b'", &[]).ok().unwrap();
            assert!(change.ask && change.display == "powershell Remove-Item 'a b'");
            assert!(prep(Approval::Auto, "powershell", &["-EncodedCommand", "AAAA"]).is_err() && prep(Approval::Auto, "powershell", &["Get-Content ~/.ssh/id_rsa"]).is_err());
            assert!(prep(Approval::Auto, "cmd", &["/c", "dir"]).err().unwrap().contains("use powershell"));
        }
        // A redirect is a shell's doing: said before the program takes `>out.txt` for a file to open.
        assert!(prep(Approval::Auto, "python", &["a.py", ">out.txt"]).err().unwrap().starts_with("There is no shell here, so `>out.txt`"));
        assert!(prep(Approval::Auto, "python a.py 2>&1", &[]).is_err() && prep(Approval::Auto, "python", &["-c", "print(1 > 0)"]).is_ok());
    }

    /// A script written as the argument after the dash is run as the script it is, and a dash with no script is refused.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_script_after_the_dash_goes_to_stdin() {
        let dir = crate::tools::scratch("dash");
        let ctx = crate::tools::test_ctx(&dir, Approval::Auto);
        let ran = run_command(&ctx, &json!({ "command": "python", "args": ["-", "import sys\nprint('ran', len(sys.argv))"] })).await;
        assert!(ran.ok && ran.text.contains("<<stdin (2 lines)") && ran.text.contains("ran 1"), "{}", ran.text);
        let bare = run_command(&ctx, &json!({ "command": "python", "args": ["-"] })).await;
        assert!(!bare.ok && bare.text.contains("no stdin was given"), "{}", bare.text);
    }
    use serde_json::json;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    /// A process something else started (a command in the sandbox) joins the list: its output is kept, its end
    /// is noticed, and only the chat that owns it sees it.
    #[tokio::test]
    async fn a_process_started_elsewhere_is_taken_in() {
        let procs = Procs::default();
        let (tx, _rx) = std::sync::mpsc::channel();
        let mut cmd = if cfg!(windows) { Command::new("cmd") } else { Command::new("sh") };
        cmd.args([if cfg!(windows) { "/c" } else { "-c" }, "echo adopted"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let owner = PathBuf::from("chat-a");
        let (id, died, log) = procs.adopt(owner.clone(), "sandbox: echo adopted".into(), cmd.spawn().unwrap(), crate::agent::Emitter::new(tx, || {}), Duration::from_secs(10)).await;
        assert_eq!((id.as_str(), died, log.trim()), ("p1", Some(0), "adopted"));
        assert_eq!(procs.list_for(&owner).iter().map(|p| (p.display.as_str(), p.exit)).collect::<Vec<_>>(), [("sandbox: echo adopted", Some(0))]);
        assert!(procs.list_for(Path::new("chat-b")).is_empty());
    }

    #[test]
    fn classification() {
        assert_eq!(base_name("C:\\tools\\Python.EXE"), "python");
        assert_eq!(base_name("npm.cmd"), "npm");
        assert!(read_only("git", &s(&["status"])));
        assert!(read_only("git", &s(&["--no-pager", "log", "-5"])));
        assert!(!read_only("git", &s(&["push"])));
        assert!(!read_only("git", &s(&["branch", "-D", "main"])));
        assert!(read_only("node", &s(&["--version"])));
        assert!(!read_only("node", &s(&["app.js"])));
        assert!(read_only("pip", &s(&["list"])));
    }

    #[test]
    fn git_looks_only() {
        assert!(!read_only("git", &s(&["branch", "newname"])));
        assert!(read_only("git", &s(&["branch"])));
        assert!(!read_only("git", &s(&["diff", "--output=x.patch"])));
        assert!(!read_only("git", &s(&["diff", "--no-index", "a", "b"])));
        assert!(!read_only("git", &s(&["log", "..\\outside"])));
        assert!(!read_only("git", &s(&["remote", "add", "x", "url"])));
        assert!(read_only("git", &s(&["remote", "-v"])));
        assert!(read_only("git", &s(&["remote", "get-url", "origin"])));
    }

    #[test]
    fn timeouts_follow_the_web_table() {
        assert_eq!(timeout_for("npm", &s(&["install"]), None), Duration::from_secs(300));
        assert_eq!(timeout_for("npm", &s(&["test"]), None), Duration::from_secs(60));
        assert_eq!(timeout_for("msbuild", &s(&["x"]), None), Duration::from_secs(60));
        assert_eq!(timeout_for("npm", &s(&["test"]), Some(1)), Duration::from_secs(5));
        assert_eq!(timeout_for("npm", &s(&["test"]), Some(900_000)), Duration::from_secs(300));
    }

    #[test]
    fn output_keeps_both_ends() {
        let long = format!("START{}END", "x".repeat(30_000));
        let c = head_tail(&long);
        assert!(c.starts_with("START") && c.ends_with("END") && c.contains("chars of output omitted"));
        assert_eq!(head_tail("short"), "short");
    }

    #[test]
    fn arguments_are_checked_like_the_web() {
        assert_eq!(argv_arg(&json!({ "args": "app.py" }), "args").unwrap_err(), "args must be a list of strings, not a single string.");
        assert_eq!(argv_arg(&json!({ "args": [3] }), "args").unwrap_err(), "Every argument must be a string.");
        assert_eq!(argv_arg(&json!({ "args": ["a\u{0}b"] }), "args").unwrap_err(), "Arguments must not contain NUL bytes.");
        assert_eq!(argv_arg(&json!({}), "args").unwrap(), Vec::<String>::new());
    }

    #[test]
    fn finds_programs_on_path() {
        let root = std::env::temp_dir();
        assert!(find_program(&root, "git").is_some() || find_program(&root, "cargo").is_some());
        assert!(find_program(&root, "definitely-not-a-real-program-xyz").is_none());
    }
}

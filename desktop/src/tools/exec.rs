//! Running programs: one-shot commands, tests, and background processes.
//! There is no shell by default; every launch goes through the approval rules. Ported from src/lib/runner.ts
//! (validation, timeouts, result text) and src/lib/processes.ts (background processes). Gaps are marked `ponytail:`.

use super::build::group;
use super::{Ctx, Output, num_arg, str_arg, testing};
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
    "which", "where", "unzip", "tar", "grep", "rg", "find", "diff", "cat", "wc", "head", "tail", "ls", "echo", "py",
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
/// The flags a read-only git look may take: how its output is shaped and what it selects. `--` ends the flags.
const GIT_LOOK_FLAGS: &[&str] = &[
    "--", "--no-pager", "--short", "-s", "--branch", "-b", "-sb", "--porcelain", "--long", "--ignored", "--untracked-files", "-uno", "-uall", "-unormal", "--oneline", "--graph", "--decorate", "--no-decorate", "--all",
    "--stat", "--numstat", "--shortstat", "--name-only", "--name-status", "--no-merges", "--merges", "--first-parent", "--reverse", "--abbrev-commit", "--no-abbrev-commit", "--follow", "--date-order", "--topo-order", "-p", "--patch",
    "--no-patch", "--format", "--pretty", "--date", "--author", "--committer", "--grep", "--since", "--until", "--after", "--before", "--max-count", "--skip", "-n", "--invert-grep", "-i", "--regexp-ignore-case", "-E", "--extended-regexp", "-z",
    "--staged", "--cached", "--no-color", "--color", "--no-ext-diff", "--no-textconv", "--word-diff", "--unified", "--diff-filter", "--find-renames", "--no-renames", "-v", "--verbose", "-vv", "--list", "-a", "-r", "--remotes", "--show-current",
    "--merged", "--no-merged", "--contains", "--no-contains", "--tags", "--always", "--abbrev", "--dirty", "--exact-match", "--match", "--abbrev-ref", "--show-toplevel", "--show-prefix", "--is-inside-work-tree", "--is-bare-repository",
    "--verify", "--quiet", "-q", "--symbolic-full-name", "--show-cdup", "--stage", "--others", "--modified", "--deleted", "--exclude-standard", "--error-unmatch", "--directory", "--ignore-submodules",
];
/// The environment a child keeps. Everything else apiM has is withheld, API keys included. Profile paths stay so rustup and npm can find their homes.
const CHILD_ENV: &[&str] = &[
    "COMPUTERNAME", "ALLUSERSPROFILE", "PUBLIC", "HOMEDRIVE", "HOMEPATH", "ProgramW6432", "CommonProgramFiles", "PSModulePath",
    "PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "windir", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "TEMP", "TMP", "USERPROFILE", "USERNAME", "HOME", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "CARGO_HOME", "RUSTUP_HOME", "LANG", "LC_ALL",
];

/// A command with no timeout asked for runs for this long (the web used 60s; raised here because the agent runs real
/// local work — a quick test or script often needs more than a minute). A caller can still ask up to MAX_ASKED.
const RUN_LIMIT: Duration = Duration::from_secs(120);
/// Installs and other slow subcommands of the package managers.
const INSTALL_LIMIT: Duration = Duration::from_secs(300);
/// The longest a model may ask for with timeout_ms, here and for a wait on a background process. At 2 minutes a
/// 10-minute build took five waits, each a round.
const MAX_ASKED: u64 = 600_000;
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
/// How long the last of a finished program's output may take to come out of its pipes, all of them together.
const AFTER_EXIT: Duration = Duration::from_millis(500);
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
/// A package put into the machine's own toolchain rather than the workspace: pip into the system Python, npm or yarn
/// globally, cargo or go install. It outlives the chat and no restore point takes it back, so it asks even when commands
/// run automatically. A live benchmark reply, told to write tests, put pytest into the user's Python unasked.
fn installs_on_machine(name: &str, args: &[String]) -> bool {
    let words: Vec<String> = args.iter().map(|a| a.to_ascii_lowercase()).collect();
    let has = |flag: &str| words.iter().any(|a| a == flag);
    let first = words.iter().find(|a| !a.starts_with('-')).map_or("", String::as_str);
    let pip = |rest: &[String]| rest.iter().find(|a| !a.starts_with('-')).is_some_and(|verb| matches!(verb.as_str(), "install" | "uninstall")) && !rest.iter().any(|a| a == "--target" || a == "-t");
    match name {
        "pip" | "pip3" => pip(&words),
        "python" | "python3" | "py" => words.iter().position(|a| a == "-m").is_some_and(|at| words.get(at + 1).is_some_and(|m| m == "pip") && pip(&words[at + 2..])),
        "npm" | "pnpm" | "bun" => has("-g") || has("--global"),
        "yarn" => first == "global",
        "cargo" | "go" => first == "install",
        "uv" => first == "tool" || (first == "pip" && has("--system")),
        _ => false,
    }
}

fn read_only(name: &str, args: &[String]) -> bool {
    let first = args.iter().map(String::as_str).find(|a| !a.starts_with('-')).unwrap_or("");
    if matches!(name, "which" | "where") || (args.len() == 1 && INFO_FLAGS.contains(&args[0].as_str())) {
        return true;
    }
    match name {
        // The forms that change things were refused before this is asked (`LOOKING_FORMS`).
        "tasklist" | "systeminfo" | "driverquery" | "getmac" | "wevtutil" | "nvidia-smi" => look_switches(name, args),
        "whoami" | "hostname" | "ipconfig" | "sc" | "ps" | "uname" | "df" | "uptime" | "id" | "free" | "lscpu" | "lsb_release" | "sw_vers" => true,
        "git" => git_read_only(first, args),
        "npm" => matches!(first, "ls" | "list" | "view" | "outdated" | "why" | "root" | "prefix"),
        "pnpm" => matches!(first, "ls" | "list" | "why" | "outdated"),
        "pip" | "pip3" => matches!(first, "list" | "show" | "freeze"),
        "go" => matches!(first, "version" | "env" | "list"),
        "cargo" => first == "tree",
        _ => false,
    }
}

/// git looks without a prompt only in listing form, and only with the flags on `GIT_LOOK_FLAGS`: a flag that writes a
/// file, names a helper or reads a path (`blame --contents`, `diff --output`, `--no-index`) asks first.
fn git_read_only(first: &str, args: &[String]) -> bool {
    if !GIT_LOOKS.contains(&first) {
        return false;
    }
    let risky = args.iter().any(|a| {
        let a = a.as_str();
        if !a.starts_with('-') {
            return leaves_repo(a);
        }
        // A flag's value is a path too when it names one: `--format=%H` passes, `--since=/etc` does not.
        let (flag, value) = a.split_once('=').unwrap_or((a, ""));
        let count = flag.len() > 1 && flag[1..].bytes().all(|b| b.is_ascii_digit());
        !(GIT_LOOK_FLAGS.contains(&flag) || count) || leaves_repo(value)
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

/// A word that leaves the repository: an absolute path, a rooted one (`/etc` is rooted, not absolute, on Windows), a
/// drive-relative one (`C:x`), a home-relative one, or one that climbs with `..`.
fn leaves_repo(word: &str) -> bool {
    let bytes = word.as_bytes();
    let drive = bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic();
    Path::new(word).is_absolute() || drive || word.starts_with(['~', '/', '\\']) || word.split(['/', '\\']).any(|p| p == "..")
}

/// The switches a system tool may take when it is only asked to look. Any other switch makes the call ask first: `/S`
/// names another host, `/r:` reads a remote log, `-f` writes a file, `-r` resets a GPU. Values are not switches.
fn look_switches(name: &str, args: &[String]) -> bool {
    let listed: &[&str] = match name {
        "tasklist" => &["/v", "/svc", "/m", "/fi", "/fo", "/nh"],
        "systeminfo" => &["/fo", "/nh"],
        "driverquery" => &["/v", "/fo", "/nh", "/si"],
        "getmac" => &["/fo", "/nh", "/v"],
        "wevtutil" => &["/c", "/rd", "/q", "/l", "/f"],
        "nvidia-smi" => &["-q", "-d", "--display", "-x", "-L", "--list-gpus", "--query-gpu", "--format", "-i", "--id", "-h", "--help"],
        _ => &[],
    };
    args.iter().all(|a| {
        let a = a.as_str();
        let switch = a.split(['=', ':']).next().unwrap_or(a).to_ascii_lowercase();
        !a.starts_with(['/', '-']) || listed.contains(&switch.as_str())
    })
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

/// A bare name that PATH answers while the workspace holds a program of that name. PATH wins, as in PowerShell, and
/// like PowerShell the answer says so: a reply told "`python.exe` here runs it" ran the machine's Python for four
/// rounds before it wrote `.\python.exe`.
fn shadowed(root: &Path, command: &str) -> Option<String> {
    if command.contains(['/', '\\']) {
        return None;
    }
    let (found, local) = (find_program(root, command)?, find_program(root, &format!("./{command}"))?);
    (std::fs::canonicalize(&found).ok() != std::fs::canonicalize(&local).ok()).then(|| format!("\n[This ran {}, found on PATH. The workspace has a program of that name too: `.{}{}` runs that one.]", found.display(), std::path::MAIN_SEPARATOR, local.file_name().unwrap_or_default().to_string_lossy()))
}

/// The call a shell wrapper was carrying, as `run_command` takes it: `["/c", "npm", "test"]` becomes
/// `{"command": "npm", "args": ["test"]}`. None where the wrapper held a whole script (pipes, `&&`, redirects),
/// which belongs in a PowerShell call instead.
fn unwrapped(argv: &[String]) -> Option<String> {
    let mut words = argv.iter().map(String::as_str).skip_while(|w| matches!(w.to_ascii_lowercase().as_str(), "/c" | "/k" | "-c" | "-lc" | "-ic" | "--"));
    let command = words.next()?;
    // One string holding a script was passed to `-c`: the words are not a command line.
    let rest: Vec<&str> = if command.split_whitespace().count() > 1 { command.split_whitespace().skip(1).chain(words).collect() } else { words.collect() };
    let command = command.split_whitespace().next()?;
    if [command].iter().chain(rest.iter()).any(|w| w.contains(['|', '>', '<', ';', '&', '$', '`'])) {
        return None;
    }
    let args: Vec<String> = rest.iter().map(|w| format!("{:?}", w)).collect();
    Some(format!("{{\"command\": {command:?}, \"args\": [{}]}}", args.join(", ")))
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

/// `git push --force` (or `-f`, `--force-with-lease`, `--mirror`), in either shell.
static FORCE_PUSH: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| Regex::new(r"(?i)\bgit\s+push\b[^;|&\n]*\s(--force\S*|-f|--mirror)\b").unwrap());

/// What `shell` treats as taking the computer apart: a disk format, a boot/registry/account/protection change
/// (bcdedit, diskpart, reg delete, …), or a delete naming a place outside the chat's folder, where a restore point
/// (which brings back the chat's folder and nothing else) could not undo it, or a force push, which rewrites a
/// remote for everyone. A match runs unasked in Auto, which the user picked to run everything, and is shown for approval
/// first in Manual and Critical.
// ponytail: a reading of the text, there to catch a wreck made in passing. It is not a parser, and a script the
// model writes to a file and runs was never held by it. Use PowerShell's own parser
// (System.Management.Automation.Language) if this has to hold against a command written to get past it.
fn shell_wrecks(script: &str, root: &Path) -> Option<&'static str> {
    use std::sync::LazyLock;
    static SYSTEM: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\b(format-volume|clear-disk|remove-partition|initialize-disk|stop-computer|restart-computer|shutdown|bcdedit|diskpart|vssadmin|wbadmin|set-mppreference|remove-localuser|disable-computerrestore|reg(\.exe)?\s+delete|remove-item(property)?\s+\S*\b(hklm|hkcu|registry):)|\bformat\s+[a-z]:|\bcipher\s+/w").unwrap()
    });
    static DELETES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(^|[\s;|{(&])(remove-item|rm|rmdir|rd|del|erase|ri)\b|(\.|::)delete\(").unwrap());
    // An environment variable is a place when a path goes on from it or it names one of the user's folders; `$env:TZ = 'UTC'` is not.
    static OUTSIDE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\b[a-z]:[\\/]|\\\\|\.\.[\\/]|~|\$env:\w+\s*[\\/]|\$env:(temp|tmp|userprofile|appdata|localappdata|programdata|programfiles\w*|windir|systemroot|systemdrive|public|onedrive\w*|homepath|homedrive)\b|\$home\b").unwrap()
    });
    // Deleting from the process's own drives (an environment variable, a variable, a function) touches no file: a reply that
    // set TZ in a loop and cleared it after was refused as deleting outside the folder.
    static PROCESS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)(remove-item|rm|ri|del|erase)\s+(-(literal)?path\s+)?['"]?(env|variable|function|alias):[^\s;|}'"]*['"]?"#).unwrap());
    if SYSTEM.is_match(script) {
        return Some("Not run: this changes the computer itself (its disks, its start-up, its accounts, its protection, or it deletes from the registry) and cannot be undone. Leave it to the user: say what should be run and why.");
    }
    if FORCE_PUSH.is_match(script) {
        return Some("Not run: a force push rewrites the remote's history for everyone who has it, and nothing here can restore it. Push without --force, or leave it to the user: say what should be pushed and why.");
    }
    let script = &PROCESS.replace_all(script, "").into_owned();
    // The chat's own folder written out in full is inside. A reply cleaning a project wrote `Remove-Item 'C:\…\chat\build'`,
    // was told the place was outside, and concluded that a shell cannot delete in the folder at all.
    let own = regex::escape(&root.to_string_lossy().to_lowercase().replace('/', "\\"));
    let inside = Regex::new(&format!(r#"{own}(\\|['",;)\s]|$)"#)).map(|own| own.replace_all(&script.to_lowercase().replace('/', "\\"), ".$1").into_owned());
    if DELETES.is_match(script) && OUTSIDE.is_match(inside.as_deref().unwrap_or(script)) {
        return Some("Not run: this deletes, and it names a place outside the chat's folder, where nothing can be restored. Delete inside the folder by a relative path (delete_file does it too), and keep a command that deletes apart from one that reads elsewhere. What is outside is the user's to remove.");
    }
    None
}

/// PowerShell on Windows: the one shell let through, for what only it can ask the system (event logs, services,
/// installed programs, hardware). With "Ask me first" the user is shown its text whole. With commands running
/// automatically it runs unasked, like any program, a `shell_wrecks` match too; the other modes ask about one first. The web has no such thing, because it runs on a server and not on the user's own computer.
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
    let mut ask = ctx.settings.approval.asks_routine();
    // A command that takes the computer apart (bcdedit, diskpart, a disk format, a delete outside the folder, a force
    // push): Auto runs it unasked, as the user chose it to; Manual and Critical show it for approval first.
    if shell_wrecks(&script, &ctx.root).is_some() && ctx.settings.approval != crate::store::Approval::Auto {
        ask = true;
    }
    let key = serde_json::to_string(&["powershell", script.as_str()]).unwrap_or_default();
    // Its output is asked for in UTF-8: the console's own code page turns every non-English letter into noise.
    let args = ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command"].iter().map(|flag| flag.to_string()).chain([format!("[Console]::OutputEncoding = [Text.Encoding]::UTF8; {script}")]).collect();
    Ok(Launch { program, args, display: format!("powershell {script}"), key, ask })
}

/// Catastrophic bash (the counterpart of `shell_wrecks`): what takes the computer apart, and a delete naming a place
/// outside the chat's folder, where nothing can be restored. The caller runs a match in Auto, prompts for it in Critical.
// ponytail: a reading of the text, not a parser — a script written to a file and run was never held by it. Harden with
// `bash -n` / an AST if this must stand against a command written to get past it.
fn bash_wrecks(script: &str, root: &Path) -> Option<&'static str> {
    use std::sync::LazyLock;
    static SYSTEM: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\b(mkfs\S*|shutdown|reboot|poweroff|halt|init\s+[06]|wipefs|fdisk|parted)\b|\bdd\b[^\n]*\bof=/dev/|>\s*/dev/sd|:\s*\(\s*\)\s*\{\s*:\s*\|\s*:|\brm\s+-[a-z]*[rf][a-z]*\s+(-[a-z]*\s+)*(/|~|\$\{?home)").unwrap()
    });
    static DELETES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(^|[\s;|&(])(rm|unlink|shred|srm)\b").unwrap());
    static OUTSIDE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b[a-z]:[\\/]|\\\\|(^|\s)/[a-z]|\.\.[\\/]|~|\$\{?home\b").unwrap());
    if SYSTEM.is_match(script) {
        return Some("Not run: this changes the computer itself (its disks, its start-up) or deletes from the root, your home or everything, and cannot be undone. Leave it to the user: say what should be run and why.");
    }
    if FORCE_PUSH.is_match(script) {
        return Some("Not run: a force push rewrites the remote's history for everyone who has it, and nothing here can restore it. Push without --force, or leave it to the user: say what should be pushed and why.");
    }
    // The chat's own folder written out in full is inside; everything else a delete names is outside.
    let own = regex::escape(&root.to_string_lossy().to_lowercase().replace('\\', "/"));
    let inside = Regex::new(&format!(r#"{own}(/|['",;)\s]|$)"#)).map(|re| re.replace_all(&script.to_lowercase().replace('\\', "/"), ".$1").into_owned());
    if DELETES.is_match(script) && OUTSIDE.is_match(inside.as_deref().unwrap_or(script)) {
        return Some("Not run: this deletes, and it names a place outside the chat's folder, where nothing can be restored. Delete inside the folder by a relative path (delete_file does it too). What is outside is the user's to remove.");
    }
    None
}

/// bash/sh as a real shell, the counterpart of `shell`: the script is run with `bash -c`, so its pipes, redirects, `&&`
/// and loops work. On Windows this needs git-bash's bash.exe on PATH. Asked for in "Ask me first"; while commands run
/// automatically it runs unasked like any program, a `bash_wrecks` match too; the other modes ask about one first.
fn bash_shell(ctx: &Ctx, command: &str, argv: Vec<String>) -> Result<Launch, String> {
    let mut words = argv.into_iter().peekable();
    // Drop the usual invocation flags; whatever remains is the script.
    while let Some(flag) = words.peek().map(|word| word.to_ascii_lowercase()) {
        match flag.as_str() {
            "-c" | "-lc" | "-ic" | "-xc" | "-l" | "-i" | "-x" | "-e" | "--norc" | "--noprofile" | "--login" => drop(words.next()),
            _ => break,
        }
    }
    let script = words.collect::<Vec<_>>().join(" ");
    if script.trim().is_empty() {
        return Err("No bash command was given. Pass it as one string, e.g. {\"command\":\"bash\",\"args\":[\"-c\",\"ls | wc -l\"]}.".into());
    }
    if super::files::closed_text(&script) {
        return Err(format!("The command names a place that is not read: {}", super::files::CLOSED_WHY));
    }
    let Some(program) = find_program(&ctx.root, command) else {
        return Err(format!("`{command}` was not found on this machine.{}", if cfg!(windows) { " Install Git for Windows and make sure bash.exe is on PATH, or use powershell instead." } else { "" }));
    };
    let mut ask = ctx.settings.approval.asks_routine();
    if bash_wrecks(&script, &ctx.root).is_some() && ctx.settings.approval != crate::store::Approval::Auto {
        ask = true;
    }
    let key = serde_json::to_string(&["bash", script.as_str()]).unwrap_or_default();
    Ok(Launch { program, args: vec!["-c".to_string(), script.clone()], display: format!("bash {script}"), key, ask })
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
    // One word is one argument however it is sent: `"args": "app/server.py"` was refused twice in one run (Sonnet 5.5).
    // Words with spaces between them are not split: where one argument ends would be a guess.
    if let Some(word) = v.as_str().filter(|s| !s.trim().is_empty() && !s.trim().contains(char::is_whitespace) && !s.contains('\0')) {
        return Ok(vec![word.trim().to_string()]);
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

/// The time a command may run, as the web's timeoutFor works it out: a caller's timeout_ms is honoured within 5 seconds and `MAX_ASKED`.
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
    // PowerShell or bash written as one line keeps its text whole: its quotes are its own.
    let shell_line = command.split_once(char::is_whitespace).filter(|(first, _)| argv.is_empty() && matches!(base_name(first).as_str(), "powershell" | "pwsh" | "bash" | "sh"));
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
    if matches!(name.as_str(), "bash" | "sh") {
        return bash_shell(ctx, command, argv);
    }
    if SHELLS.contains(&name.as_str()) {
        // The wrapped command, written out as this tool takes it: `cmd /c npm test` was refused with advice about
        // interpreters, which fits no launcher, and the round went on guessing the shape.
        let inner = unwrapped(&argv);
        return Err(format!(
            "`{name}` is not available.{}{}",
            inner.map(|c| format!(" Call it directly: {c}.")).unwrap_or_else(|| " Run the program itself, e.g. `python app.py` rather than `sh -c \"python app.py\"`.".into()),
            if cfg!(windows) { " PowerShell is the shell here: pass the whole script as one string in args, and its pipes, `;` and loops run several steps in one call." } else { "" }
        ));
    }
    // `>out.txt`, `|` and `&&` are a shell's to read, not the program's ("Error opening ./>_NBUF_OUT.txt"): the line goes to
    // the system's shell whole. Refused instead, small models sent the same line again, round after round (2026-10-27).
    // cmd's own commands (`del`, `dir`, `type`) are no programs, and were refused as not allowed: PowerShell knows each by that name.
    let cmd_word = cfg!(windows) && CMD_WORDS.contains(&name.as_str()) && find_program(&ctx.root, command).is_none();
    if argv.iter().any(|a| shell_word(a)) || cmd_word {
        let line = std::iter::once(command.to_string()).chain(argv.iter().map(|a| quoted_word(a))).collect::<Vec<_>>().join(" ");
        if cfg!(windows) {
            return shell(ctx, "powershell", vec![powershell_line(&line)]);
        }
        if on_path("bash") {
            return bash_shell(ctx, "bash", vec![line]);
        }
    }
    if let Some(word) = argv.iter().map(|a| a.trim()).find(|a| shell_word(a)) {
        return Err(format!("There is no shell here, so `{word}` would reach the program as a plain argument and redirect nothing. The output comes back to you as the result. To keep it in a file, have the program write the file itself.{}", if cfg!(windows) { " Or give the whole line to powershell as one string: it reads pipes and redirects." } else { "" }));
    }
    if let Some((_, forms)) = LOOKING_FORMS.iter().find(|(tool, _)| *tool == name) {
        let first = argv.first().map(|word| word.to_ascii_lowercase()).unwrap_or_default();
        if !forms.contains(&first.as_str()) {
            let looking: Vec<String> = forms.iter().map(|form| format!("{name} {form}").trim().to_string()).collect();
            return Err(format!("Only the forms of {name} that look are run here: {}.{}", looking.join(", "), if cfg!(windows) { " To change something on this computer use powershell." } else { "" }));
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
    // "Open it in Explorer" shows the user a folder and changes nothing. A file is refused: Explorer starts it with its app.
    let explorer = cfg!(windows) && name == "explorer";
    if explorer {
        let target = argv.first().map(|a| a.strip_prefix("/select,").unwrap_or(a).trim_matches('"').to_string()).unwrap_or_default();
        let at = if Path::new(&target).is_absolute() { PathBuf::from(&target) } else { ctx.root.join(&target) };
        if argv.len() != 1 || !(at.is_dir() || argv[0].starts_with("/select,") && at.exists()) {
            return Err("explorer is run here only to show a folder: give the folder as its one argument (or /select,<file> to point at a file). A file given alone would be started by its app.".into());
        }
    }
    if !own && !explorer && !ALLOWED.contains(&name.as_str()) && !SYSTEM.contains(&name.as_str()) {
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
    // "Ask me first" asks for a workspace program or any command that is not a mere look. "Critical only" asks for
    // an install into the machine but nothing else. "Run automatically" asks for nothing, installs included.
    let ask = (ctx.settings.approval.asks_routine() && (own || !read_only(&name, &argv)))
        || (ctx.settings.approval.asks_critical() && !own && installs_on_machine(&name, &argv));
    let git = name == "git";
    let display = std::iter::once(command.to_string()).chain(argv.iter().map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() })).collect::<Vec<_>>().join(" ");
    let key = serde_json::to_string(&std::iter::once(name).chain(argv.iter().cloned()).collect::<Vec<_>>()).unwrap_or_default();
    // git runs hardened from here too: a cloned repository's own config cannot name a program that git then runs.
    let argv = if git { crate::github::harden(&argv.iter().map(String::as_str).collect::<Vec<_>>()) } else { argv };
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
    // A git asking for a password on the terminal waited on a closed stdin until the command's time ran out.
    cmd.env("NO_COLOR", "1").env("FORCE_COLOR", "0").env("GIT_PAGER", "cat").env("PAGER", "cat").env("PYTHONUNBUFFERED", "1").env("PYTHONIOENCODING", "utf-8").env("GIT_TERMINAL_PROMPT", "0");
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

/// A command's output as the program wrote it, every byte up to KEEP_LIMIT, in a file of the chat's folder.
/// The answer shows the start and the end of a long output. The middle used to be gone: a reply that needed it
/// ran a five-minute program a second time through PowerShell's `>`, which writes UTF-16, and spent four more
/// rounds finding that out. Three times in one afternoon.
pub struct Kept {
    path: PathBuf,
    file: Option<std::fs::File>,
    bytes: u64,
}

/// More than this is a program that will not stop printing: the file holds the first of it.
const KEEP_LIMIT: u64 = 64 * 1024 * 1024;

impl Kept {
    fn take(&mut self, chunk: &[u8]) {
        use std::io::Write;
        if self.bytes < KEEP_LIMIT {
            if self.file.is_none() {
                let _ = std::fs::create_dir_all(self.path.parent().unwrap_or(Path::new("")));
                self.file = std::fs::File::create(&self.path).ok();
            }
            if let Some(file) = &mut self.file {
                let _ = file.write_all(chunk);
            }
        }
        self.bytes += chunk.len() as u64;
    }
}

/// Reads a pipe to the end into a shared buffer, keeping only the newest part of a huge log.
fn pump(mut pipe: impl tokio::io::AsyncRead + Unpin + Send + 'static, into: Arc<Mutex<String>>, keep: Option<Arc<Mutex<Kept>>>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        // The end of a letter cut by the read's edge waits for the rest: decoded alone, each half became U+FFFD, and
        // non-English output came back with holes in it.
        let mut held = Vec::new();
        while let Ok(n) = pipe.read(&mut buf).await {
            if n == 0 {
                break;
            }
            if let Some(keep) = &keep {
                keep.lock().unwrap().take(&buf[..n]);
            }
            held.extend_from_slice(&buf[..n]);
            let whole = match std::str::from_utf8(&held) {
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                _ => held.len(),
            };
            let mut log = into.lock().unwrap();
            log.push_str(&String::from_utf8_lossy(&held[..whole]));
            held.drain(..whole);
            if log.len() > MAX_PROCESS_LOG {
                let cut = (log.len() - MAX_PROCESS_LOG / 2..log.len()).find(|&i| log.is_char_boundary(i)).unwrap_or(0);
                log.drain(..cut);
            }
        }
        // A letter the program never finished is shown as what it is.
        if !held.is_empty() {
            into.lock().unwrap().push_str(&String::from_utf8_lossy(&held));
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

/// How a run came to an end.
enum Ended {
    /// (exit code, combined output, timed out).
    Ran(Option<i32>, String, bool),
    /// The user said something while it ran: the program, still going, and what it has printed (its pipes go on filling it).
    Spoken(Child, Arc<Mutex<String>>),
}

/// Runs to completion or to the limit (None waits as long as it takes).
/// With `keep`, every byte of the output also goes to that file, and how many there were comes back in it.
/// With `listen`, the user's words while it runs end the wait and leave the program running.
async fn run_to_end(mut child: Child, limit: Option<Duration>, keep: Option<Arc<Mutex<Kept>>>, listen: Option<&Ctx>) -> Ended {
    let log = Arc::new(Mutex::new(String::new()));
    let readers = [child.stdout.take().map(|p| pump(p, log.clone(), keep.clone())), child.stderr.take().map(|p| pump(p, log.clone(), keep.clone()))];
    let pid = child.id();
    let mut guard = TreeGuard(pid);
    let deadline = limit.map(|limit| Instant::now() + limit);
    let waited = loop {
        tokio::select! {
            status = child.wait() => break Some(status),
            _ = tokio::time::sleep(Duration::from_millis(150)) => {}
        }
        if deadline.is_some_and(|at| Instant::now() >= at) {
            break None;
        }
        if listen.is_some_and(Ctx::spoken_to) {
            guard.0 = None;
            return Ended::Spoken(child, log);
        }
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
    // What it printed last is in the pipes already and comes out at once. A pipe still open after that is held by a
    // program it started and left running (a game, its crash handler), which may never close it: waited out for 2 s
    // a pipe, one after the other, that put 4 s on every command that started one.
    let _ = tokio::time::timeout(AFTER_EXIT, futures_util::future::join_all(readers.into_iter().flatten())).await;
    let out = log.lock().unwrap().clone();
    Ended::Ran(code, out, timed_out)
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
    /// Where the whole output is, from the chat's folder, and its size: set when the answer shows less than all of it.
    pub kept: Option<(String, u64)>,
}

/// Approves and runs one program to the end, shared by run_command, run_tests and build_project. `limit` None waits as long as it takes.
/// Err is the answer as it goes back to the model: a refusal, or (run_command) the program left running because the user spoke.
/// `stdin` is text for the program's standard input: `python -` runs it as a script, in one call and with no file
/// left behind. A reply wrote some fifty one-off scripts as files and ran each in a second round.
pub async fn execute(ctx: &Ctx, program: &str, argv: Vec<String>, reason: &str, limit: Option<Duration>, stdin: Option<&str>) -> Result<Ran, Output> {
    execute_keeping(ctx, program, argv, reason, limit, stdin, false).await
}

/// `execute`, and with `keep` the whole output is left in `.outputs/` when the answer may not hold it for long:
/// when it is longer than the answer shows, or long enough to be folded out of the reply's context later.
/// With `keep` too, the user's words while it runs move it to the background and the answer comes at once: a question
/// asked during a four-minute boot was read only after the user gave up and pressed Stop.
// ponytail: run_tests and build_project still hold a question until they end; their verdicts need the whole run.
async fn execute_keeping(ctx: &Ctx, program: &str, argv: Vec<String>, reason: &str, limit: Option<Duration>, stdin: Option<&str>, keep: bool) -> Result<Ran, Output> {
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
        Err(e) => return Ok(Ran { display: launch.display, code: None, out: String::new(), timed_out: false, took: Duration::ZERO, error: Some(start_error(&e, &ctx.root)), kept: None }),
    };
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        // Written from the side: a program that prints before it has read everything must not hold the write up.
        let text = text.to_string();
        tokio::spawn(async move {
            let _ = pipe.write_all(text.as_bytes()).await;
        });
    }
    let started = Instant::now();
    // Named for the moment and the program: `.outputs/124857-luau.txt`. The folder is left out of the file list, as `.history` is.
    let stem: String = base_name(&launch.program.to_string_lossy()).chars().filter(|c| c.is_ascii_alphanumeric()).take(24).collect();
    let stamp = chrono::Local::now().format("%H%M%S").to_string();
    // Two runs in one second, or the same second of another day: the next free name.
    let name = (1..).map(|n| if n == 1 { format!(".outputs/{stamp}-{stem}.txt") } else { format!(".outputs/{stamp}-{stem}-{n}.txt") }).find(|name| !ctx.root.join(name).exists()).unwrap_or_default();
    let keeper = keep.then(|| Arc::new(Mutex::new(Kept { path: ctx.root.join(&name), file: None, bytes: 0 })));
    let (code, out, timed_out) = match run_to_end(child, limit, keeper.clone(), keep.then_some(ctx)).await {
        Ended::Ran(code, out, timed_out) => (code, out, timed_out),
        Ended::Spoken(child, log) => {
            // ponytail: in the background its timeout_ms no longer applies; stop_process ends it.
            let id = ctx.procs.track(ctx.state_dir.clone(), launch.display.clone(), child, log.clone(), ctx.emit.clone());
            let so_far = last_chars(&log.lock().unwrap(), 4_000);
            let state = format!("{} goes on running in the background as process {id}: wait_for_output with that id waits for it to end, read_process shows its output, stop_process stops it", launch.display);
            let tail = if so_far.trim().is_empty() { String::new() } else { format!("\n\nOutput so far:\n{so_far}") };
            return Err(Output::ok(format!("{}{tail}", spoken_while_waiting(started, &state)), "The user said something"));
        }
    };
    let kept = keeper.and_then(|keeper| {
        let mut kept = keeper.lock().unwrap();
        // Closed before it is named or removed.
        kept.file = None;
        // An answer of this size is folded to one line once it is old (`prune::MIN_COLLAPSE_CHARS`). Without its file it
        // could not be read again: a reply that needed an earlier run's output undid six files to print it once more.
        if out.trim().chars().count() >= crate::context::prune::MIN_COLLAPSE_CHARS {
            forget_old_outputs(kept.path.parent());
            Some((name, kept.bytes))
        } else {
            // All of it is in the answer, and stays there: no file is left behind, nor the folder if this was its only one.
            let _ = std::fs::remove_file(&kept.path);
            let _ = kept.path.parent().map(std::fs::remove_dir);
            None
        }
    });
    Ok(Ran { display: launch.display, code, out, timed_out, took: started.elapsed(), error: None, kept })
}

/// At most this many kept outputs: the oldest go when one more is kept.
const KEPT_OUTPUTS: usize = 300;

fn forget_old_outputs(folder: Option<&Path>) {
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = folder.and_then(|f| std::fs::read_dir(f).ok()).into_iter().flatten().flatten().filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path()))).collect();
    files.sort();
    for (_, path) in files.iter().take(files.len().saturating_sub(KEPT_OUTPUTS)) {
        let _ = std::fs::remove_file(path);
    }
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
    // First, so the one line an old answer is folded to still names the file.
    let mut parts: Vec<String> = ran.kept.iter().map(|(path, _)| format!("Output kept in {path}: read it there, do not run this again for it.")).collect();
    parts.push(format!("$ {}", ran.display));
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
        parts.push(match &ran.kept {
            Some((path, bytes)) if *bytes > KEEP_LIMIT => format!("\n(output was long: the start and the end are shown. The program printed {}, and the first {} of it is in {path}, as the program wrote it. Search it with search_files or open it from a script; do not run the program again for it.)", crate::context::format_size(*bytes), crate::context::format_size(KEEP_LIMIT)),
            Some((path, bytes)) => format!("\n(output was long: the start and the end are shown. ALL of it, {}, is in {path}, as the program wrote it. Search it with search_files, read part of it with read_file, or open it from a script; do not run the program again for it.)", crate::context::format_size(*bytes)),
            None => "\n(output was long; the start and the end are shown, the middle is omitted)".to_string(),
        });
    }
    Output { ok, text: parts.join("\n"), summary, ..Default::default() }
}

/// A command line cut into words as a shell cuts it: quotes group, and `\"` inside double quotes is a quote.
fn split_words(line: &str) -> Vec<String> {
    let (mut words, mut word, mut quote, mut open) = (Vec::new(), String::new(), None::<char>, false);
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some('"'), '\\') if chars.peek() == Some(&'"') => {
                word.push('"');
                chars.next();
            }
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => word.push(c),
            (None, '"' | '\'') => (quote, open) = (Some(c), true),
            (None, c) if c.is_whitespace() => {
                if open || !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                    open = false;
                }
            }
            (None, c) => word.push(c),
        }
    }
    if open || !word.is_empty() {
        words.push(word);
    }
    words
}

/// cmd's built-in commands that PowerShell also takes by name.
/// PowerShell's own names for the Unix ones (rm, cp, mv, pwd, sleep) go the same way: refused as programs, they cost a
/// round each (2026-10-28).
const CMD_WORDS: &[&str] = &["del", "erase", "dir", "type", "copy", "move", "ren", "md", "mkdir", "rd", "rmdir", "echo", "cls", "cd", "rm", "cp", "mv", "pwd", "sleep"];

/// A word only a shell reads: `&&`, `||`, a pipe, `;`, a redirect.
fn shell_word(word: &str) -> bool {
    let word = word.trim();
    matches!(word, "|" | "||" | "&&" | "&" | ";" | "<") || ["<", ">", "1>", "2>", "&>"].iter().any(|p| word.starts_with(p))
}

/// A word as a shell line writes it back: bare when it can be, else in quotes PowerShell and bash both read.
fn quoted_word(word: &str) -> String {
    if !word.is_empty() && !word.contains(|c: char| c.is_whitespace() || "\"'`$;&|(){}".contains(c)) || shell_word(word) {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', "''"))
    }
}

/// A cmd/bash line in the words Windows PowerShell 5.1 reads: `a && b` stops after a failing `a`, `a || b` runs `b`
/// only after a failing `a`, and `nul` is `$null`. Quoted text is left as written.
// ponytail: `a || b` ends the line once `a` succeeds, so a step after `b` is skipped then. Fine for the `x || y` lines models write.
fn powershell_line(line: &str) -> String {
    let (mut out, mut quote) = (String::new(), None::<char>);
    let mut rest = line;
    while let Some(c) = rest.chars().next() {
        let after = &rest[c.len_utf8()..];
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (None, '"' | '\'') => quote = Some(c),
            (None, '&') if after.starts_with('&') => {
                out.push_str("; if (-not $?) { exit 1 };");
                rest = &after[1..];
                continue;
            }
            (None, '|') if after.starts_with('|') => {
                out.push_str("; if ($?) { exit 0 };");
                rest = &after[1..];
                continue;
            }
            (None, '>') => {
                let target = after.trim_start();
                if target.get(..3).is_some_and(|w| w.eq_ignore_ascii_case("nul")) && !target[3..].starts_with(|c: char| c.is_alphanumeric() || c == '.') {
                    out.push_str(">$null");
                    rest = &target[3..];
                    continue;
                }
            }
            _ => {}
        }
        out.push(c);
        rest = after;
    }
    out
}

pub async fn run_command(ctx: &Ctx, args: &Value) -> Output {
    let mut argv = match argv_arg(args, "args") {
        Ok(argv) => argv,
        Err(e) => return Output::fail(e),
    };
    // The whole command line in `command` and no args (`python -c "print(1)"`): cut as a shell would cut it. A reply on
    // a smaller model wrote its commands so and was told "is not an allowed command" for each.
    let line = str_arg(args, "command").trim();
    let whole_line = argv.is_empty() && line.contains(char::is_whitespace) && find_program(&ctx.root, line).is_none();
    let mut words = if whole_line { split_words(line) } else { Vec::new() };
    // A shell line written whole goes to the shell as it was written, not cut into words and put back together.
    if cfg!(windows) && words.iter().any(|w| shell_word(w)) {
        words = vec!["powershell".into(), powershell_line(line)];
    }
    let command = if words.is_empty() { line.to_string() } else { words.remove(0) };
    let command = command.as_str();
    argv.extend(words);
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
    let note = shadowed(&ctx.root, command).unwrap_or_default();
    match execute_keeping(ctx, command, argv, str_arg(args, "reason"), Some(limit), Some(stdin.as_str()).filter(|text| !text.is_empty()), true).await {
        Ok(ran) => {
            let mut out = report(&ran);
            out.text.push_str(&note);
            out
        }
        Err(early) => early,
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
    let mut ran = match execute(ctx, &command, argv, "Run the project's tests", Some(limit), None).await {
        Ok(ran) => ran,
        Err(refused) => return refused,
    };
    let mut name = runner.name.clone();
    // No pytest here: Python's own runner finds the same test files. The answer used to be "install it (pip install
    // pytest)", and a reply did, into the user's own Python, for a project whose README said `python -m unittest`.
    if ran.out.contains("No module named pytest") {
        let mut argv: Vec<String> = vec!["-m".into(), "unittest".into()];
        match runner.args.last().filter(|dir| ["tests", "test"].contains(&dir.as_str())) {
            _ if filter.ends_with(".py") => argv.push(filter.trim_end_matches(".py").replace(['/', '\\'], ".")),
            // A tests folder that is a package is found from the project's root, a plain one from inside itself.
            Some(dir) if ctx.root.join(dir).join("__init__.py").is_file() => argv.extend(["discover".into(), "-s".into(), dir.clone(), "-t".into(), ".".into()]),
            Some(dir) => argv.extend(["discover".into(), "-s".into(), dir.clone()]),
            None => {}
        }
        if !filter.is_empty() && !filter.ends_with(".py") {
            argv.extend(["-k".into(), filter.to_string()]);
        }
        name = "unittest".into();
        ran = match execute(ctx, "python", argv, "Run the project's tests", Some(limit), None).await {
            Ok(ran) => ran,
            Err(refused) => return refused,
        };
    }
    let summary = testing::parse_output(&name, &ran.out, "", ran.code.unwrap_or(1));
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
            pump(p, log.clone(), None);
        }
        if let Some(p) = child.stderr.take() {
            pump(p, log.clone(), None);
        }
        let id = self.track(owner, display, child, log.clone(), wake);
        let proc = self.map.lock().unwrap()[&id].clone();
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

    /// Takes a running process whose output already flows into `log` into the list, and returns its id.
    fn track(&self, owner: PathBuf, display: String, mut child: Child, log: Arc<Mutex<String>>, wake: crate::agent::Emitter) -> String {
        let exit = Arc::new(Mutex::new(None));
        let ended = Arc::new(Mutex::new(None));
        let proc = Arc::new(Proc { display, pid: child.id().unwrap_or(0), owner, started: Instant::now(), log, exit: exit.clone(), ended: ended.clone(), stopped: AtomicBool::new(false), stdin: tokio::sync::Mutex::new(child.stdin.take()) });
        let id = format!("p{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        {
            let mut map = self.map.lock().unwrap();
            // A process that ended half an hour ago is let go with its log (up to 1 MB): a day of servers started and
            // stopped kept every one of them.
            map.retain(|_, p| p.ended.lock().unwrap().is_none_or(|at| at.elapsed() < Duration::from_secs(1800)));
            map.insert(id.clone(), proc);
        }
        tokio::spawn(async move {
            let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
            *exit.lock().unwrap() = Some(code);
            *ended.lock().unwrap() = Some(Instant::now());
            wake.wake();
        });
        id
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
    // Unless it says all went well: a launcher starts the real program and leaves (Roblox's, a game's, `start`), and
    // called a failure, the reply started the program again, and again.
    if died == Some(0) {
        return Output::ok(
            format!("{} finished at once, with exit code 0: it was a launcher, or a command that starts something and returns. What it started runs on its own and is not tracked here. To wait until that program closes, use wait_for_output with its process name.\n\n{}", launch.display, or_text(shown, "(no output)")),
            format!("Launched and returned: {}", launch.display),
        );
    }
    if let Some(code) = died {
        return Output { ok: false, text: format!("{} exited immediately (code {code}).\n\n{}\n\nFix the cause before trying again.", launch.display, or_text(shown, "(no output)")), summary: format!("Exited at once (code {code}): {}", launch.display), ..Default::default() };
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

/// A program on the computer the agent did not start, watched until it closes: no process of that name (or pid) is
/// left, or the windows it had are all gone (Roblox takes some seconds more to end after its window closes).
struct Watch {
    name: String,
    pids: Vec<u32>,
    /// It has shown a window while watched.
    windowed: bool,
    since: Instant,
}

/// How long a watched program that is not running yet may take to start: it was just launched, say.
const WATCH_START: Duration = Duration::from_secs(10);

impl Watch {
    fn new(asked: &str) -> Watch {
        let name = asked.trim().trim_end_matches(".exe").trim_end_matches(".EXE").to_string();
        Watch { name, pids: Vec::new(), windowed: false, since: Instant::now() }
    }

    fn matching(&self) -> Vec<u32> {
        let pid = self.name.parse::<u32>().ok();
        crate::computer::processes().into_iter().filter(|(p, n)| Some(*p) == pid || n.eq_ignore_ascii_case(&self.name)).map(|(p, _)| p).collect()
    }

    /// Some(why) once it has closed, or never started.
    fn closed(&mut self) -> Option<String> {
        let now = self.matching();
        if now.is_empty() {
            return if self.pids.is_empty() {
                (self.since.elapsed() >= WATCH_START).then(|| format!("{} is not running, and did not start within {}s", self.name, WATCH_START.as_secs()))
            } else {
                Some(format!("{} closed", self.name))
            };
        }
        self.pids = now;
        let windows = crate::computer::windows().into_iter().any(|w| self.pids.contains(&w.pid));
        if self.windowed && !windows {
            return Some(format!("{}'s window closed (the process is still finishing)", self.name));
        }
        self.windowed |= windows;
        None
    }
}

/// Why a wait gives up early. The user typed while the reply worked, and their words are read at the top of the next
/// round: waiting out a ten-minute `timeout_ms` first would leave a question hanging for ten minutes.
fn spoken_while_waiting(started: Instant, state: &str) -> String {
    format!(
        "Stopped waiting after {:.1}s: the user said something while you waited, and it is in this conversation just below. Nothing was lost — {state}.\n\nRead what they said and answer it. Then call wait_for_output again to go on waiting, unless what they said means you should do something else first.",
        started.elapsed().as_secs_f64()
    )
}

pub async fn wait_for_output(ctx: &Ctx, args: &Value) -> Output {
    let id = str_arg(args, "id");
    let watched = str_arg(args, "process").trim();
    if (watched.is_empty() || !id.trim().is_empty()) && ctx.procs.get(id, &ctx.state_dir).is_none() {
        return Output::fail(format!("Error: no process with id \"{id}\". Use list_processes, or pass `process` (a program's name) to wait for a program you did not start here."));
    }
    let mut watch = (!watched.is_empty()).then(|| Watch::new(watched));
    let limit = Duration::from_millis(num_arg(args, "timeout_ms").unwrap_or(30_000).clamp(1_000, MAX_ASKED));
    let Some(p) = ctx.procs.get(id, &ctx.state_dir) else {
        // Only a program to watch.
        let watch = watch.as_mut().expect("checked above");
        let started = Instant::now();
        loop {
            if let Some(why) = tokio::task::block_in_place(|| watch.closed()) {
                let ok = !watch.pids.is_empty();
                let took = started.elapsed().as_secs_f64();
                return Output { ok, ..Output::ok(format!("{why} after {took:.1}s."), if ok { format!("{} closed after {took:.1}s", watch.name) } else { format!("{} is not running", watch.name) }) };
            }
            if started.elapsed() >= limit {
                let state = if watch.pids.is_empty() { "has not started" } else { "is still open" };
                return Output::fail(format!("Timed out after {:.0}s: {} {state}.", limit.as_secs_f64(), watch.name));
            }
            if ctx.spoken_to() {
                return Output::ok(spoken_while_waiting(started, &format!("{} is still open", watch.name)), "The user said something");
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    };
    let pattern = str_arg(args, "pattern");
    // Case-insensitive; a pattern that is not a valid regex is matched as plain text.
    let re = if pattern.is_empty() {
        None
    } else {
        Some(Regex::new(&format!("(?i){pattern}")).unwrap_or_else(|_| Regex::new(&format!("(?i){}", regex::escape(pattern))).expect("escaped pattern is valid")))
    };
    let limit = Duration::from_millis(num_arg(args, "timeout_ms").unwrap_or(30_000).clamp(1_000, MAX_ASKED));
    let started = Instant::now();
    loop {
        let log = p.log.lock().unwrap().clone();
        let exited = *p.exit.lock().unwrap();
        let matched_line = re.as_ref().and_then(|r| log.lines().find(|l| r.is_match(l)).map(|l| l.trim().to_string()));
        let closed = watch.as_mut().and_then(|w| tokio::task::block_in_place(|| w.closed()));
        let outcome = if matched_line.is_some() {
            "matched"
        } else if exited.is_some() {
            "exited"
        } else if closed.is_some() {
            "closed"
        } else if started.elapsed() >= limit {
            "timeout"
        } else if ctx.spoken_to() {
            "spoken to"
        } else {
            "waiting"
        };
        if outcome == "spoken to" {
            return Output::ok(spoken_while_waiting(started, &format!("the process {id} is still running")), "The user said something");
        }
        if outcome != "waiting" {
            let ms = started.elapsed().as_millis();
            // ponytail: the web shows only output printed since the wait began; this shows the recent log.
            let recent = last_chars(&log, 4_000);
            let tail = if recent.trim().is_empty() { "\n\nIt printed nothing while waiting.".to_string() } else { format!("\n\nRecent output:\n{recent}") };
            let (ok, text, summary) = match outcome {
                "matched" => (true, format!("Matched after {ms}ms: {}{tail}", matched_line.unwrap_or_default()), format!("Ready after {:.1}s", started.elapsed().as_secs_f32())),
                "exited" => (true, format!("The process exited after {ms}ms without printing that.{tail}"), "Process exited while waiting".to_string()),
                "closed" => (true, format!("Stopped waiting after {ms}ms: {}. The process {id} is still running.{tail}", closed.clone().unwrap_or_default()), "Watched program closed".to_string()),
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
    use crate::store::Approval;

    #[cfg(windows)]
    #[test]
    fn a_workspace_program_hidden_by_one_on_path_is_pointed_out() {
        let root = crate::tools::scratch("shadowed");
        std::fs::write(root.join("cmd.exe"), b"MZ").unwrap();
        let note = shadowed(&root, "cmd.exe").unwrap();
        assert!(note.contains("found on PATH") && note.ends_with("`.\\cmd.exe` runs that one.]"), "{note}");
        assert!(shadowed(&root, "cmd").is_some() && shadowed(&root, ".\\cmd.exe").is_none() && shadowed(&root, "whoami").is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    /// A command of minutes must not sit on a question either: it goes on in the background, and the answer comes now.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_long_command_steps_aside_when_the_user_says_something() {
        let dir = crate::tools::scratch("runnote");
        let ctx = crate::tools::test_ctx(&dir, Approval::Auto);
        let notes = ctx.notes.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            notes.lock().unwrap().push("btw it shows a black screen".into());
        });
        let slow = if cfg!(windows) { json!({ "command": "powershell", "args": ["echo booting; Start-Sleep -Seconds 30"], "timeout_ms": 240_000 }) } else { json!({ "command": "sh", "args": ["-c", "echo booting; sleep 30"], "timeout_ms": 240_000 }) };
        let ran = tokio::time::timeout(Duration::from_secs(20), run_command(&ctx, &slow)).await.expect("the command held the question");
        assert!(ran.ok && ran.text.starts_with("Stopped waiting after") && ran.text.contains("background as process p") && ran.text.contains("booting"), "{}", ran.text);
        assert_eq!(ran.summary, "The user said something");
        // Left running, and tracked like one started in the background.
        let id = ran.text.split_once("as process ").and_then(|(_, rest)| rest.split(':').next()).unwrap_or_default().to_string();
        assert!(ctx.procs.get(&id, &ctx.state_dir).is_some_and(|p| p.exit.lock().unwrap().is_none()), "{id}");
        let _ = stop_process(&ctx, &json!({ "id": id }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A wait of minutes must not sit on a question. The user types while the reply works, and the next round reads
    /// what they said — so the wait gives it up at once, leaving the program it watched running.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_wait_gives_up_as_soon_as_the_user_says_something() {
        let dir = crate::tools::scratch("waitnote");
        let ctx = crate::tools::test_ctx(&dir, Approval::Auto);
        let sleep = if cfg!(windows) { json!({ "command": "powershell", "args": ["Start-Sleep -Seconds 30"] }) } else { json!({ "command": "sleep", "args": ["30"] }) };
        let started = start_process(&ctx, &sleep).await;
        let id = started.text.split_once("id ").map(|(_, rest)| rest.split(|c: char| !c.is_alphanumeric() && c != '-' && c != '_').next().unwrap_or("").to_string()).unwrap_or_default();
        assert!(started.ok && !id.is_empty(), "{}", started.text);
        let notes = ctx.notes.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            notes.lock().unwrap().push("btw how long does this take?".into());
        });
        let waited = tokio::time::timeout(Duration::from_secs(20), wait_for_output(&ctx, &json!({ "id": id, "timeout_ms": 600_000 }))).await.expect("the wait never came back");
        assert!(waited.ok && waited.text.starts_with("Stopped waiting after") && waited.text.contains("is still running"), "{}", waited.text);
        assert_eq!(waited.summary, "The user said something");
        // The program it watched was left alone.
        assert!(ctx.procs.get(&id, &ctx.state_dir).is_some_and(|p| p.exit.lock().unwrap().is_none()));
        let _ = stop_process(&ctx, &json!({ "id": id }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_command_line_is_cut_into_words() {
        assert_eq!(split_words(r#"python -c "from shop.utils import shout; print(shout('hello'))""#), ["python", "-c", "from shop.utils import shout; print(shout('hello'))"]);
        assert_eq!(split_words(r#"python  -m unittest 'tests/test a.py' "say \"hi\"" """#), ["python", "-m", "unittest", "tests/test a.py", "say \"hi\"", ""]);
    }

    #[test]
    fn a_shell_wrapper_is_answered_with_the_call_it_held() {
        let argv = |words: &[&str]| words.iter().map(|w| w.to_string()).collect::<Vec<_>>();
        assert_eq!(unwrapped(&argv(&["/c", "npm", "test"])).unwrap(), r#"{"command": "npm", "args": ["test"]}"#);
        assert_eq!(unwrapped(&argv(&["-c", "python app.py"])).unwrap(), r#"{"command": "python", "args": ["app.py"]}"#);
        assert_eq!(unwrapped(&argv(&["/c", "npm run build"])).unwrap(), r#"{"command": "npm", "args": ["run", "build"]}"#);
        // A whole script belongs in a PowerShell call, so no single command is offered for it.
        assert_eq!(unwrapped(&argv(&["-c", "npm test | tee out.txt"])), None);
        assert_eq!(unwrapped(&argv(&["/c", "a && b"])), None);
        assert_eq!(unwrapped(&argv(&[])), None);
    }

    #[test]
    fn powershell_is_refused_only_what_cannot_be_put_back() {
        for runs in [
            "Get-Process | Sort-Object CPU -Descending | Select-Object -First 10",
            "Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'; Level=2} -MaxEvents 20 | Format-List TimeCreated, Message",
            r"Get-ChildItem $env:LOCALAPPDATA\Roblox\logs | Sort-Object LastWriteTime -Descending | Select-Object -First 5 Name, Length",
            r"gci C:\Windows\Minidump | where { $_.Length -gt 0 } | measure",
            r"(Get-Item 'C:\x y\a.dll').VersionInfo.FileVersion",
            "Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version",
            "$logs = Get-ChildItem $env:TEMP; $logs.Count",
            // What used to ask: a program run with its output sent to a file, a file's length, a delete inside the folder.
            r"tools\luau-win\luau.exe analysis\run.luau > analysis\out.txt 2> analysis\err.txt; (Get-Item analysis\out.txt).Length",
            "Remove-Item analysis/tmp -Recurse", "rm x", "Get-Process; del a", "New-Item a", "[IO.File]::WriteAllText('a','b')", "$x = Get-Item a; $x.Delete()",
            "Get-ChildItem -Recurse | Format-Table Name", r"Copy-Item C:\tools\a.dll lib\a.dll",
            // A variable set and cleared is not a place, and clearing it deletes no file.
            "$zones = 'UTC','Asia/Tokyo'; foreach ($z in $zones) { $env:TZ = $z; npm test 2>&1 | Select-String -Pattern '^# (pass|fail)' }; Remove-Item Env:TZ",
            "Remove-Item build -Recurse; $env:NODE_ENV = 'test'; npm test", "Remove-Item -Path 'env:NODE_ENV'; rm variable:x",
        ] {
            assert_eq!(shell_wrecks(runs, Path::new(r"C:\chats\one")), None, "{runs}");
        }
        for wrecks in [
            r"Remove-Item C:\temp -Recurse", r"rm ..\..\other -Recurse", "del $env:USERPROFILE\\notes.txt", "Get-ChildItem ~ | Remove-Item", r"[IO.File]::Delete('C:\x\a')",
            "Remove-Item -Recurse (Join-Path $env:TEMP 'x')", r"Remove-Item -Recurse $env:MYDIR\x", r"Remove-Item Env:TZ; Remove-Item C:\x",
            "Format-Volume -DriveLetter D", "shutdown /s /t 0", "Restart-Computer -Force", r"reg delete HKCU\Software\x /f", r"Remove-Item HKCU:\Software\x", "Set-MpPreference -DisableRealtimeMonitoring $true", "bcdedit /set x",
        ] {
            assert!(shell_wrecks(wrecks, Path::new(r"C:\chats\one")).is_some(), "{wrecks}");
        }
        // The chat's own folder by its full name is inside; a folder that only starts like it, or a way out of it, is not.
        let own = Path::new(r"C:\chats\one");
        assert_eq!(shell_wrecks(r"Remove-Item -Recurse -Force 'C:\chats\one\build','c:/chats/one/dist'", own), None);
        assert!(shell_wrecks(r"Remove-Item -Recurse 'C:\chats\one-more\build'", own).is_some());
        assert!(shell_wrecks(r"Remove-Item -Recurse C:\chats\one\..\two", own).is_some());
    }

    #[test]
    fn bash_wrecks_catches_the_catastrophic_and_outside_deletes() {
        let own = Path::new(r"C:\chats\one");
        for runs in ["ls | wc -l", "grep -r foo src/ > out.txt", "rm -rf build", "rm -f ./tmp/x", r"rm -rf C:\chats\one\build", "find . -name '*.tmp' -delete", "git log --oneline | head"] {
            assert_eq!(bash_wrecks(runs, own), None, "{runs}");
        }
        for wrecks in [
            "rm -rf /", "rm -rf /*", "sudo rm -rf /usr", "rm -rf ~", "rm -rf ~/Documents", "rm -rf $HOME/x",
            "sudo mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=/dev/sda bs=1M", ":(){ :|:& };:", "shutdown -h now", "reboot", "wipefs -a /dev/sda",
            r"rm -rf C:\Windows", "rm -rf ../../other", "unlink /etc/hosts",
        ] {
            assert!(bash_wrecks(wrecks, own).is_some(), "{wrecks}");
        }
    }

    /// With git-bash on PATH, bash runs as a real shell: pipes and redirects work, and the flags are stripped.
    #[tokio::test(flavor = "multi_thread")]
    async fn bash_runs_a_real_shell_when_present() {
        let dir = crate::tools::scratch("bashrun");
        if find_program(&dir, "bash").is_none() {
            return; // no bash on this machine; the refusal path is covered by prepare's "was not found" branch
        }
        let ctx = crate::tools::test_ctx(&dir, Approval::Auto);
        let out = run_command(&ctx, &json!({ "command": "bash", "args": ["-c", "echo hi | tr a-z A-Z"] })).await;
        assert!(out.ok && out.text.contains("HI"), "{}", out.text);
        // A redirect writes a real file the shell handles.
        let wrote = run_command(&ctx, &json!({ "command": "bash", "args": ["-c", "printf one > bash_out.txt; wc -l < bash_out.txt"] })).await;
        assert!(wrote.ok && dir.join("bash_out.txt").exists(), "{}", wrote.text);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_system_is_asked_only_in_forms_that_look() {
        let dir = crate::tools::scratch("system");
        let prep = |approval, command: &str, args: &[&str]| prepare(&crate::tools::test_ctx(&dir, approval), command, args.iter().map(|a| a.to_string()).collect());
        assert!(prep(Approval::Auto, "reg", &["add", r"HKCU\x"]).err().unwrap().starts_with("Only the forms of reg that look are run here: reg query."));
        assert!(prep(Approval::Auto, "wevtutil", &["cl", "Application"]).is_err() && prep(Approval::Auto, "ipconfig", &["/release"]).is_err());
        // "Critical only" asks for an install into the machine; "Run automatically" asks for nothing, installs included.
        // One into the workspace, or a look, asks in neither. A program this machine lacks is the one excuse.
        let asks = |approval, command: &str, args: &[&str], want: bool| match prep(approval, command, args) {
            Ok(launch) => assert_eq!(launch.ask, want, "{approval:?} {command} {args:?}"),
            Err(e) => assert!(e.contains("was not found"), "{command} {args:?}: {e}"),
        };
        for (command, args) in [("pip", &["install", "pytest"][..]), ("python", &["-m", "pip", "install", "-U", "pytest"]), ("npm", &["i", "-g", "serve"]), ("cargo", &["install", "ripgrep"])] {
            asks(Approval::Critical, command, args, true);
            asks(Approval::Auto, command, args, false);
        }
        for (command, args) in [("pip", &["list"][..]), ("pip", &["install", "--target", "deps", "x"]), ("python", &["-m", "unittest"]), ("npm", &["install", "lodash"]), ("cargo", &["build"])] {
            asks(Approval::Critical, command, args, false);
            asks(Approval::Auto, command, args, false);
        }
        let words = |args: &[&str]| args.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert!(installs_on_machine("python", &words(&["-m", "pip", "install", "pytest"])) && !installs_on_machine("python", &words(&["-m", "pip", "list"])));
        assert!(installs_on_machine("yarn", &words(&["global", "add", "x"])) && !installs_on_machine("yarn", &words(&["add", "x"])));
        if cfg!(windows) {
            assert!(!prep(Approval::Manual, "tasklist", &[]).ok().unwrap().ask);
            let look = prep(Approval::Auto, "powershell", &["-NoProfile", "-Command", "Get-Process | Select-Object -First 3"]).ok().unwrap();
            assert!(!look.ask && look.display == "powershell Get-Process | Select-Object -First 3" && look.args.last().unwrap().ends_with("; Get-Process | Select-Object -First 3"));
            // Asked about: everything in "Ask me first", nothing when commands run automatically. One line with quotes stays whole.
            assert!(prep(Approval::Manual, "powershell", &["Get-Process"]).ok().unwrap().ask && prep(Approval::Manual, "powershell", &[r"Remove-Item C:\x"]).ok().unwrap().ask);
            let change = prep(Approval::Auto, "powershell Remove-Item 'a b'", &[]).ok().unwrap();
            assert!(!change.ask && change.display == "powershell Remove-Item 'a b'");
            // Auto runs even what cannot be undone, unasked: picking Auto was the user's yes. Critical shows it for approval.
            assert!(!prep(Approval::Auto, "powershell", &[r"Remove-Item C:\Users\x -Recurse"]).ok().unwrap().ask);
            assert!(!prep(Approval::Auto, "powershell", &["bcdedit /set {current} nx AlwaysOff"]).ok().unwrap().ask);
            assert!(!prep(Approval::Auto, "powershell", &["git push --force origin main"]).ok().unwrap().ask);
            assert!(prep(Approval::Critical, "powershell", &["git push origin main -f"]).ok().unwrap().ask);
            assert!(!prep(Approval::Auto, "powershell", &["git push origin main; git status"]).ok().unwrap().ask);
            assert!(prep(Approval::Critical, "powershell", &["bcdedit /set {current} nx AlwaysOff"]).ok().unwrap().ask);
            assert!(prep(Approval::Critical, "powershell", &[r"Remove-Item C:\Users\x -Recurse"]).ok().unwrap().ask);
            assert!(prep(Approval::Auto, "powershell", &["-EncodedCommand", "AAAA"]).is_err() && prep(Approval::Auto, "powershell", &["Get-Content ~/.ssh/id_rsa"]).is_err());
            assert!(prep(Approval::Auto, "cmd", &["/c", "dir"]).err().unwrap().contains("PowerShell is the shell here"));
        }
        // A redirect is a shell's doing: said before the program takes `>out.txt` for a file to open.
        // A shell's own words send the line to the shell whole: PowerShell here, with `&&`, `||` and `nul` put in its words.
        if cfg!(windows) {
            assert_eq!(prep(Approval::Auto, "python", &["a.py", ">out.txt"]).ok().unwrap().display, "powershell python a.py >out.txt");
            assert_eq!(prep(Approval::Auto, "python a.py 2>&1", &[]).ok().unwrap().display, "powershell python a.py 2>&1");
            assert_eq!(prep(Approval::Auto, "del", &["sample.txt"]).ok().unwrap().display, "powershell del sample.txt");
        }
        assert!(prep(Approval::Auto, "python", &["-c", "print(1 > 0)"]).is_ok());
        assert_eq!(powershell_line("python --version && pytest -q 2>nul || echo 'a && b'"), "python --version ; if (-not $?) { exit 1 }; pytest -q 2>$null ; if ($?) { exit 0 }; echo 'a && b'");
        assert_eq!((quoted_word("print('hi'); x"), quoted_word("a.py"), quoted_word("2>nul")), ("'print(''hi''); x'".into(), "a.py".into(), "2>nul".into()));
    }

    /// A long output is all in a file the answer names; a short one leaves no file behind.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_long_output_is_kept_whole_in_a_file() {
        let dir = crate::tools::scratch("kept");
        let ctx = crate::tools::test_ctx(&dir, Approval::Auto);
        let long = run_command(&ctx, &json!({ "command": "python", "args": ["-c", "for i in range(9000): print('line', i)"] })).await;
        let named = long.text.split("is in ").nth(1).and_then(|rest| rest.split(',').next()).unwrap_or_default().to_string();
        assert!(long.ok && named.starts_with(".outputs/") && long.text.starts_with(&format!("Output kept in {named}:")) && named.ends_with(".txt") && named.contains("-python") && long.text.contains("do not run the program again"), "{}", &long.text[long.text.len().saturating_sub(400)..]);
        let whole = std::fs::read_to_string(dir.join(&named)).unwrap();
        assert!(whole.lines().count() == 9000 && whole.contains("line 4500") && !long.text.contains("line 4500"));
        let short = run_command(&ctx, &json!({ "command": "python", "args": ["-c", "print('one line')"] })).await;
        assert!(short.ok && !short.text.contains("outputs/") && std::fs::read_dir(dir.join(".outputs")).unwrap().count() == 1);
        // One that is shown whole but will be folded once it is old keeps its file too, and is not in the file list.
        let medium = run_command(&ctx, &json!({ "command": "python", "args": ["-c", "for i in range(200): print('row', i)"] })).await;
        assert!(medium.text.starts_with("Output kept in .outputs/") && medium.text.contains("row 100") && std::fs::read_dir(dir.join(".outputs")).unwrap().count() == 2, "{}", medium.text);
        assert!(crate::tools::files::walk(&dir, &dir).is_empty());
        let _ = std::fs::remove_dir_all(dir);
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
        assert!(!read_only("git", &s(&["blame", "--contents=secret.txt", "a.rs"])));
        assert!(!read_only("git", &s(&["log", "--since=/etc"])));
        assert!(read_only("git", &s(&["log", "--format=%h %s", "-n", "5"])));
        assert!(read_only("git", &s(&["diff", "--", "src/a.rs"])));
    }

    #[test]
    fn system_tools_look_only_with_plain_switches() {
        assert!(!read_only("tasklist", &s(&["/S", "server1"])));
        assert!(read_only("tasklist", &s(&["/fi", "IMAGENAME eq x.exe", "/fo", "csv", "/nh"])));
        assert!(!read_only("nvidia-smi", &s(&["-f", "out.txt"])));
        assert!(!read_only("wevtutil", &s(&["qe", "System", "/r:server1"])));
        assert!(read_only("wevtutil", &s(&["qe", "System", "/c:5"])));
    }

    #[test]
    fn timeouts_follow_the_web_table() {
        assert_eq!(timeout_for("npm", &s(&["install"]), None), Duration::from_secs(300));
        assert_eq!(timeout_for("npm", &s(&["test"]), None), Duration::from_secs(120));
        assert_eq!(timeout_for("msbuild", &s(&["x"]), None), Duration::from_secs(120));
        assert_eq!(timeout_for("npm", &s(&["test"]), Some(1)), Duration::from_secs(5));
        assert_eq!(timeout_for("npm", &s(&["test"]), Some(900_000)), Duration::from_secs(600));
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
        assert_eq!(argv_arg(&json!({ "args": "app.py" }), "args").unwrap(), ["app.py"]);
        assert_eq!(argv_arg(&json!({ "args": "-m pytest" }), "args").unwrap_err(), "args must be a list of strings, not a single string.");
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

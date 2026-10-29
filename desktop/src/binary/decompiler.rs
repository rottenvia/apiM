//! binary-decompiler.ts: the optional deep tools. Managed .NET goes to ILSpy (`ilspycmd`), everything else to headless
//! Ghidra (`analyzeHeadless`), and PE files can also get a FLARE `capa` report. None of them is bundled or downloaded:
//! a missing tool returns the web's own "not installed" wording and setup hint. The target is passed to the tool as
//! data and never launched. Results are cached next to the web's artifacts (`analysis/<name>-<sha12>/{ilspy,ghidra,capa}`).
//!
//! Environment (same names as the web app): APIM_ILSPYCMD_PATH, APIM_GHIDRA_HOME / GHIDRA_HOME, APIM_CAPA_PATH,
//! APIM_CAPA_RULES_PATH, APIM_CAPA_SIGNATURES_PATH, APIM_GHIDRA_MAX_MEMORY (Ghidra's GHIDRA_HEADLESS_MAXMEM), APIM_BINARY_MAX_CPU,
//! APIM_GHIDRA_ANALYSIS_TIMEOUT_MS, APIM_BINARY_DECOMPILE_TIMEOUT_MS. The Ghidra scripts (ApimAnalysisOptions.java,
//! ApimDecompile.java) are the web repo's `scripts/ghidra` folder: set APIM_GHIDRA_SCRIPTS, or run from a folder that holds it.

use super::artifacts::number_env;
use super::pe::PeInspection;
use super::types::*;
use crate::tools::files::resolve;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;

#[derive(Clone, Debug)]
pub struct DeepDecompilationResult {
    pub attempted: bool,
    /// complete | partial | unavailable | failed | disabled
    pub status: &'static str,
    /// ilspy | ghidra | none
    pub engine: &'static str,
    pub outputs: Vec<String>,
    pub cached: bool,
    pub summary: String,
    pub focus_terms: Option<Vec<String>>,
    pub focused_only: Option<bool>,
    pub setup: Option<String>,
    pub log_tail: Option<String>,
}

#[derive(Clone, Debug)]
pub struct CapaAnalysisResult {
    pub attempted: bool,
    /// complete | unavailable | failed | disabled
    pub status: &'static str,
    pub output: Option<String>,
    pub cached: bool,
    pub summary: String,
    pub setup: Option<String>,
    pub log_tail: Option<String>,
}

impl DeepDecompilationResult {
    fn new(attempted: bool, status: &'static str, engine: &'static str, summary: String) -> Self {
        DeepDecompilationResult { attempted, status, engine, outputs: vec![], cached: false, summary, focus_terms: None, focused_only: None, setup: None, log_tail: None }
    }
    /// What `inspect_binary` reports when the caller switched decompilation off.
    pub fn disabled() -> Self {
        Self::new(false, "disabled", "none", "Deep decompilation was disabled.".into())
    }
}

/// Caller-chosen Ghidra analyzer overrides: exact analyzer names to turn off/on, and the preset ("fast" or "full").
#[derive(Clone, Debug, Default)]
pub struct AnalyzerOverrides {
    pub disable: Vec<String>,
    pub enable: Vec<String>,
    pub preset: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct DeepOptions {
    pub force: bool,
    /// Where a headerless image was mapped, and what it was built for: a dump of a running process has no header to
    /// read either from, so Ghidra is told to load the bytes raw at this address instead of looking for one.
    pub raw: RawImage,
    pub focus_terms: Vec<String>,
    pub focused_only: Option<bool>,
    pub analyzers: AnalyzerOverrides,
    pub allow_full_fallback: bool,
    /// Function starts to make functions at and decompile whatever the focus finds (`seed_addresses`): code nothing
    /// flows into, like the functions above the first call in an image cut out mid-function.
    pub seeds: Vec<String>,
}

/// How to load an image that carries no header of its own. Empty means the file has one and is loaded normally.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RawImage {
    /// The virtual address the bytes were mapped at, as written (`0x7ff782798000`).
    pub image_base: String,
    /// A processor as the caller named it ("x86-64", "x86", "arm64", "arm"), or a Ghidra language id passed straight through.
    pub arch: String,
}

impl RawImage {
    /// The Ghidra language id for `arch`, defaulting to 64-bit x86. A name holding colons is already one.
    pub fn language(&self) -> String {
        let arch = self.arch.trim();
        if arch.contains(':') {
            return arch.to_string();
        }
        match arch.to_ascii_lowercase().replace(['_', ' '], "-").as_str() {
            "x86" | "x86-32" | "i386" | "ia32" | "32" => "x86:LE:32:default",
            "arm64" | "aarch64" => "AARCH64:LE:64:v8A",
            "arm" | "arm32" => "ARM:LE:32:v8",
            _ => "x86:LE:64:default",
        }
        .to_string()
    }

    /// `0x…`, or a plain number read as hexadecimal, since that is how a mapped address is always written.
    pub fn base(&self) -> Option<u64> {
        let text = self.image_base.trim().trim_start_matches("0x").trim_start_matches("0X");
        (!text.is_empty()).then(|| u64::from_str_radix(text, 16).ok()).flatten()
    }

    /// The arguments that make headless Ghidra load the file as bytes at that address instead of parsing a header.
    /// Empty unless a base was given: without one the loader would place the image at 0, where nothing resolves.
    pub fn loader_args(&self) -> Vec<String> {
        let Some(base) = self.base() else { return Vec::new() };
        ["-loader".into(), "BinaryLoader".into(), "-loader-baseAddr".into(), format!("0x{base:x}"), "-processor".into(), self.language()].into()
    }
}

/// The launcher commands, resolved from the environment like the web app does.
#[derive(Clone, Debug)]
pub struct Tools {
    pub ilspy: String,
    pub ghidra: String,
    pub capa: String,
}

fn env_trim(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

impl Tools {
    pub fn from_env() -> Tools {
        let launcher = if cfg!(windows) { "analyzeHeadless.bat" } else { "analyzeHeadless" };
        let ghidra = match env_trim("APIM_GHIDRA_HOME").or_else(|| env_trim("GHIDRA_HOME")) {
            Some(home) => Path::new(&home).join("support").join(launcher).to_string_lossy().to_string(),
            None => launcher.to_string(),
        };
        Tools { ilspy: env_trim("APIM_ILSPYCMD_PATH").unwrap_or_else(|| "ilspycmd".into()), ghidra, capa: env_trim("APIM_CAPA_PATH").unwrap_or_else(|| "capa".into()) }
    }
}

/// Explicit paths can be rejected without starting anything; bare commands are left to the PATH lookup.
fn command_could_exist(command: &str) -> bool {
    !command.contains(['/', '\\']) || Path::new(command).exists()
}

struct RunResult {
    started: bool,
    code: Option<i32>,
    timed_out: bool,
    output: String,
    error: Option<String>,
}

const MAX_LOG_CHARS: usize = 32_000_000;
const DEFAULT_TIMEOUT_MS: f64 = 30.0 * 60.0 * 1000.0;

/// Only what Java, .NET and Windows process creation need; API keys and app secrets stay out of a third-party tool.
fn minimal_env() -> Vec<(String, String)> {
    let get = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let cwd = std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let temp = std::env::temp_dir().to_string_lossy().to_string();
    let mut env: Vec<(String, String)> = vec![
        ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
        ("HOME".into(), get("HOME").unwrap_or(cwd)),
        ("TEMP".into(), get("TEMP").unwrap_or_else(|| temp.clone())),
        ("TMP".into(), get("TMP").unwrap_or(temp)),
        ("NO_COLOR".into(), "1".into()),
    ];
    // The JVM heap, under the launcher's own names: Ghidra 12's analyzeHeadless reads GHIDRA_HEADLESS_MAXMEM (2G
    // unset), older ones MAXMEM. This exported MAX_MEMORY, which no Ghidra reads, so every run had 2G whatever
    // APIM_GHIDRA_MAX_MEMORY said, and a 15 MB raw image ran out of heap in auto-analysis before decompiling anything.
    let heap = env_trim("APIM_GHIDRA_MAX_MEMORY").or_else(|| env_trim("MAX_MEMORY")).unwrap_or_else(|| "4G".into());
    env.extend([("GHIDRA_HEADLESS_MAXMEM".to_string(), heap.clone()), ("MAXMEM".to_string(), heap)]);
    // Node hands a Windows child these as well (Python's getpass.getuser, used by vivisect inside capa, fails without USERNAME).
    for key in ["USERNAME", "USERDOMAIN", "LOGONSERVER", "HOMEDRIVE", "HOMEPATH", "SYSTEMDRIVE"] {
        if let Some(v) = get(key) {
            env.push((key.into(), v));
        }
    }
    for key in ["SystemRoot", "SYSTEMROOT", "windir", "COMSPEC", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "JAVA_HOME", "DOTNET_ROOT", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "APIM_BINARY_MAX_OUTPUT_MB", "APIM_GHIDRA_MAX_MEMORY", "APIM_DECOMPILE_TIMEOUT", "APIM_GHIDRA_ANALYSIS_TIMEOUT_MS"] {
        if let Some(v) = get(key) {
            env.push((key.into(), v));
        }
    }
    env
}

/// Finds the program the way a terminal would (PATH, plus PATHEXT on Windows).
fn find_program(cwd: &Path, command: &str) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) { std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into()).split(';').map(str::to_string).chain([String::new()]).collect() } else { vec![String::new()] };
    let try_at = |base: PathBuf| exts.iter().map(|e| PathBuf::from(format!("{}{e}", base.display()))).find(|p| p.is_file());
    if command.contains(['/', '\\']) {
        let p = Path::new(command);
        return try_at(if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) });
    }
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| try_at(dir.join(command)))
}

/// Stops a process and everything it started: a plain kill leaves Ghidra's JVM running behind its launcher script.
fn kill_tree(pid: u32) {
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]);
        c
    } else {
        let mut c = std::process::Command::new("kill");
        c.args(["-9", &format!("-{pid}")]);
        c
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let _ = cmd.stdout(Stdio::null()).stderr(Stdio::null()).status();
}

/// Kills the process tree when dropped, so a Stop that drops the tool call does not strand the decompiler.
struct TreeKill(Option<u32>);

impl Drop for TreeKill {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            kill_tree(pid);
        }
    }
}

fn pump(mut pipe: impl tokio::io::AsyncRead + Unpin + Send + 'static, into: Arc<Mutex<String>>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut buf).await {
            if n == 0 {
                break;
            }
            let mut out = into.lock().unwrap();
            if out.len() < MAX_LOG_CHARS {
                out.push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        }
    })
}

/// Runs a tool with no window, no stdin, the minimal environment, and stdout+stderr captured together.
/// ponytail: dropping the future (Stop) kills the tree but yields no "partial results kept" summary as the web has.
async fn run_captured(command: &str, args: &[String], cwd: &Path) -> RunResult {
    let timeout_ms = number_env("APIM_BINARY_DECOMPILE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 0.0, 9.0e15);
    let program = find_program(cwd, command).unwrap_or_else(|| PathBuf::from(command));
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args).current_dir(cwd).env_clear().envs(minimal_env()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    // CREATE_NO_WINDOW, and below normal priority. Ghidra runs one `decompile.exe` per analysis thread — five of them on
    // a six-core machine — and at ordinary priority they take the whole computer: the user's own windows stuttered while
    // a binary was being read. Below normal, Windows hands a core back the moment anything else wants one, and the
    // analysis still has them all to itself while the machine is idle, so nothing is given up but the lag. The JVM's
    // own children inherit the class, so the decompilers come along.
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000 | 0x0000_4000);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let error = if e.kind() == std::io::ErrorKind::NotFound { format!("spawn {command} ENOENT") } else { e.to_string() };
            return RunResult { started: false, code: None, timed_out: false, output: String::new(), error: Some(error) };
        }
    };
    let mut guard = TreeKill(child.id());
    let log = Arc::new(Mutex::new(String::new()));
    let readers: Vec<_> = [child.stdout.take().map(|p| pump(p, log.clone())), child.stderr.take().map(|p| pump(p, log.clone()))].into_iter().flatten().collect();
    let waited = if timeout_ms > 0.0 { tokio::time::timeout(Duration::from_millis(timeout_ms as u64), child.wait()).await.ok() } else { Some(child.wait().await) };
    let (code, timed_out) = match waited {
        Some(Ok(status)) => (status.code(), false),
        Some(Err(_)) => (None, false),
        None => {
            if let Some(pid) = child.id() {
                kill_tree(pid);
            }
            let _ = child.kill().await;
            (None, true)
        }
    };
    guard.0 = None;
    for r in readers {
        let _ = tokio::time::timeout(Duration::from_secs(10), r).await;
    }
    let output = log.lock().unwrap().clone();
    RunResult { started: true, code, timed_out, output, error: None }
}

fn rel(root: &Path, full: &Path) -> String {
    full.strip_prefix(root).unwrap_or(full).to_string_lossy().replace('\\', "/")
}

/// Every generated file under `dir`, workspace-relative and sorted (the marker file excluded).
fn list_outputs(dir: &Path, workspace_root: &Path) -> Vec<String> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            if out.len() >= 20_000 {
                return;
            }
            let path = e.path();
            let Ok(kind) = e.file_type() else { continue };
            if kind.is_dir() {
                walk(&path, root, out);
            } else if kind.is_file() && e.file_name() != ".apim-analysis.json" {
                out.push(rel(root, &path));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, workspace_root, &mut out);
    out.sort_by(|a, b| locale_cmp(a, b));
    out
}

/// The status the cached artifacts were left in ("complete", or "partial" for a run the time limit cut short), or
/// `None` when nothing on disk describes this hash, engine and profile. A marker without a status is from before
/// partial runs were kept, and every one of those was a complete run.
fn read_marker(file: &Path, hash: &str, engine: &str, profile: &str) -> Option<String> {
    let text = std::fs::read_to_string(file).ok()?;
    let m = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    if !(m["hash"] == hash && m["engine"] == engine && m["profile"] == profile && m["complete"] == true) {
        return None;
    }
    Some(m["status"].as_str().unwrap_or("complete").to_string())
}

fn write_marker(file: &Path, hash: &str, engine: &str, profile: &str) {
    write_marker_status(file, hash, engine, profile, "complete");
}

fn write_marker_status(file: &Path, hash: &str, engine: &str, profile: &str, status: &str) {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Marker<'a> {
        hash: &'a str,
        engine: &'a str,
        profile: &'a str,
        complete: bool,
        status: &'a str,
        created_at: String,
    }
    let body = Marker { hash, engine, profile, complete: true, status, created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) };
    let _ = std::fs::write(file, serde_json::to_string_pretty(&body).unwrap_or_default() + "\n");
}

/// The end of a log, the part with the error.
fn tail(text: &str) -> String {
    tail_of(text, 6000)
}

fn tail_of(text: &str, chars: usize) -> String {
    let n = text.chars().count();
    if n <= chars { text.trim().to_string() } else { format!("…{}", text.chars().skip(n - chars).collect::<String>().trim()) }
}

/// What a failed Ghidra run shows of its log: the lines naming the cause, then the end. The end alone is startup chatter
/// and two dozen script-path lines, and an analyzer's OutOfMemoryError or a script's compile error sits above its stack
/// trace and the shutdown, so the one line saying why could fall outside the tail while the tail still looked whole.
fn ghidra_failure_log(text: &str) -> String {
    let strong = regex::Regex::new(r"(?i)OutOfMemoryError|SCRIPT ERROR|: error:|No load spec|Import failed|Abort due to|Exception in thread|Could not create the Java Virtual Machine|Invalid maximum heap|supported JDK|timed out").unwrap();
    let weak = regex::Regex::new(r"^ERROR\b|^Caused by:").unwrap();
    let mut seen = std::collections::HashSet::new();
    let lines: Vec<String> = text.lines().map(|line| line.trim().chars().take(400).collect::<String>()).filter(|line| seen.insert(line.clone())).collect();
    let causes: Vec<&str> = lines.iter().filter(|line| strong.is_match(line)).take(16).chain(lines.iter().filter(|line| !strong.is_match(line) && weak.is_match(line)).take(8)).map(String::as_str).collect();
    if causes.is_empty() {
        return tail(text);
    }
    format!("Lines naming the cause:\n{}\n\nLast lines:\n{}", causes.join("\n"), tail_of(text, 3000))
}

fn normalise_focus_terms(terms: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in terms.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty() && utf16_len(t) <= 120) {
        if !out.contains(&t) {
            out.push(t);
        }
    }
    out.truncate(32);
    out
}

/// Versioned so old results never outlive the script that produced them.
fn focus_profile(terms: &[String], focused_only: bool) -> String {
    let mut lower: Vec<String> = terms.iter().map(|t| t.to_lowercase()).collect();
    lower.sort();
    format!("analysis-v9:{}:{}", if focused_only { "focused" } else { "full" }, lower.join("|"))
}

static RE_METHOD_HEAD: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"\b(public|private|protected|internal|static|virtual|override|async|unsafe|extern)\b[^;=]*\([^;]*\)\s*(?:\{|=>)?\s*$").unwrap());
static RE_SEMI_END: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r";\s*$").unwrap());

/// Keeps only method-sized blocks around the requested terms from ILSpy's project output.
fn focus_ilspy_output(project_dir: &Path, output_dir: &Path, terms: &[String]) -> Result<usize, String> {
    let mut chunks: Vec<String> = vec!["// apiM focused ILSpy references\n".into(), format!("// Terms: {}\n\n", if terms.is_empty() { "(none)".to_string() } else { terms.join(", ") })];
    let mut matches = 0usize;
    let mut seen = std::collections::HashSet::new();
    let lower_terms: Vec<String> = terms.iter().map(|t| t.to_lowercase()).collect();

    fn walk(dir: &Path, project_dir: &Path, terms: &[String], lower: &[String], chunks: &mut Vec<String>, matches: &mut usize, seen: &mut std::collections::HashSet<String>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let full = e.path();
            let Ok(kind) = e.file_type() else { continue };
            if kind.is_dir() {
                walk(&full, project_dir, terms, lower, chunks, matches, seen);
                continue;
            }
            if !kind.is_file() || !e.file_name().to_string_lossy().to_lowercase().ends_with(".cs") {
                continue;
            }
            let source = std::fs::read(&full).map(|b| String::from_utf8_lossy(&b).to_string()).unwrap_or_default();
            let source_lower = source.to_lowercase();
            if source.is_empty() || !lower.iter().any(|t| source_lower.contains(t.as_str())) {
                continue;
            }
            let lines: Vec<&str> = source.split('\n').collect();
            for line_index in 0..lines.len() {
                let line_lower = lines[line_index].to_lowercase();
                let hits: Vec<&str> = terms.iter().zip(lower).filter(|(_, l)| line_lower.contains(l.as_str())).map(|(t, _)| t.as_str()).collect();
                if hits.is_empty() {
                    continue;
                }
                let mut start = line_index;
                for i in (line_index.saturating_sub(120)..=line_index).rev() {
                    if RE_METHOD_HEAD.is_match(lines[i]) {
                        start = i;
                        break;
                    }
                }
                let mut end = (lines.len() - 1).min(line_index + 80);
                let (mut braces, mut opened) = (0i64, false);
                for i in start..lines.len().min(start + 500) {
                    for c in lines[i].chars() {
                        if c == '{' {
                            braces += 1;
                            opened = true;
                        } else if c == '}' {
                            braces -= 1;
                        }
                    }
                    if opened && braces <= 0 && i >= line_index {
                        end = i;
                        break;
                    }
                    if !opened && RE_SEMI_END.is_match(lines[i]) && i >= line_index {
                        end = i;
                        break;
                    }
                }
                if !seen.insert(format!("{}:{start}:{end}", full.display())) {
                    continue;
                }
                *matches += 1;
                chunks.push(format!("// {}:{}-{}\n// Matched: {}\n{}\n\n", rel(project_dir, &full), start + 1, end + 1, hits.join(", "), lines[start..=end].join("\n")));
            }
        }
    }
    walk(project_dir, project_dir, terms, &lower_terms, &mut chunks, &mut matches, &mut seen);
    if matches == 0 {
        chunks.push("// No decompiled method referenced the requested terms.\n".into());
    }
    std::fs::write(output_dir.join("focused-functions.cs"), chunks.concat()).map_err(|e| e.to_string())?;
    Ok(matches)
}

async fn run_ilspy(tools: &Tools, root: &Path, target: &str, inspection: &PeInspection, force: bool, focus_terms: Vec<String>, focused_only: bool) -> DeepDecompilationResult {
    let with = |mut r: DeepDecompilationResult, outputs: Vec<String>, log: Option<String>| {
        r.outputs = outputs;
        r.focus_terms = Some(focus_terms.clone());
        r.focused_only = Some(focused_only);
        r.log_tail = log;
        r
    };
    let sha = &inspection.hashes.sha256;
    let rel_root = binary_analysis_root(target, sha);
    let (target_path, root_dir) = match (resolve(root, target), resolve(root, &rel_root)) {
        (Ok(t), Ok(r)) => (t, r),
        (Err(e), _) | (_, Err(e)) => return DeepDecompilationResult::new(false, "failed", "ilspy", e),
    };
    let output = root_dir.join("ilspy");
    let project_output = output.join("project");
    let profile = focus_profile(&focus_terms, focused_only);
    let marker = output.join(".apim-analysis.json");
    if !force && read_marker(&marker, sha, "ilspy", &profile).is_some() {
        let outputs = list_outputs(&output, root);
        let mut r = DeepDecompilationResult::new(false, "complete", "ilspy", format!("Reused {} managed decompilation artifact(s) from {rel_root}/ilspy.", outputs.len()));
        r.cached = true;
        return with(r, outputs, None);
    }
    if !command_could_exist(&tools.ilspy) {
        let mut r = DeepDecompilationResult::new(false, "unavailable", "ilspy", "The binary is managed .NET, but ILSpy is not installed at the configured path.".into());
        r.setup = Some(format!("Install the .NET SDK, run `dotnet tool install --global ilspycmd`, restart apiM, and optionally set APIM_ILSPYCMD_PATH if it is not on PATH. {}", crate::env_local_source()));
        return r;
    }
    // A cache miss means the hash/profile does not describe what is on disk: rebuild from empty.
    let _ = std::fs::remove_dir_all(&output);
    if let Err(e) = std::fs::create_dir_all(&project_output) {
        return DeepDecompilationResult::new(false, "failed", "ilspy", e.to_string());
    }
    let args = vec!["--project".to_string(), "--outputdir".into(), project_output.to_string_lossy().to_string(), target_path.to_string_lossy().to_string()];
    let result = run_captured(&tools.ilspy, &args, root).await;
    if !result.started {
        let mut r = DeepDecompilationResult::new(false, "unavailable", "ilspy", format!("ILSpy could not start{}", result.error.as_ref().map_or(".".to_string(), |e| format!(": {e}"))));
        r.setup = Some("Run `dotnet tool install --global ilspycmd`, make sure the .NET tools directory is on PATH, then restart apiM. APIM_ILSPYCMD_PATH may point directly to ilspycmd.exe.".into());
        return r;
    }
    let mut focus_matches = 0;
    if !focus_terms.is_empty() {
        focus_matches = focus_ilspy_output(&project_output, &output, &focus_terms).unwrap_or(0);
    }
    if focused_only {
        let _ = std::fs::remove_dir_all(&project_output);
    }
    let outputs = list_outputs(&output, root);
    if result.code == Some(0) && !outputs.is_empty() {
        write_marker(&marker, sha, "ilspy", &profile);
        let terms = if focus_terms.is_empty() { "the requested terms".to_string() } else { focus_terms.join(", ") };
        let summary = format!("Decompiled the managed assembly and found {focus_matches} focused method block(s) referencing {terms}. {} artifact(s) are under {rel_root}/ilspy.", outputs.len());
        return with(DeepDecompilationResult::new(true, "complete", "ilspy", summary), outputs, Some(tail(&result.output)));
    }
    let status = if outputs.is_empty() { "failed" } else { "partial" };
    let summary = if result.timed_out {
        format!("ILSpy exceeded the configured time limit; {} partial file(s) were kept.", outputs.len())
    } else {
        format!("ILSpy exited with code {}; {} partial file(s) were kept. The assembly may be obfuscated, mixed-mode, damaged, or not ordinary managed IL.", result.code.map_or("unknown".to_string(), |c| c.to_string()), outputs.len())
    };
    with(DeepDecompilationResult::new(true, status, "ilspy", summary), outputs, Some(tail(&result.output)))
}

/// Analyzers that add substantial time and whose output we do not surface.
const FAST_DISABLED_ANALYZERS: [&str; 3] = ["Decompiler Parameter ID", "Decompiler Switch Analysis", "Stack"];

/// Ghidra's only analyzer that finds code with nothing pointing at it: a linear sweep of what flow never reached.
const AGGRESSIVE_FINDER: &str = "Aggressive Instruction Finder";

/// Up to this size a raw image gets the finder unasked. Above it the sweep is what breaks the run: a 15.3 MB carved
/// .text ran out of a 2G heap in X86Analyzer, and with 6G it filled the heap and reached the 15-minute limit at 53%
/// coverage, where without the finder it finished in 85 s at 27%. A 2.7 MB .text with it finished in 279 s.
// ponytail: a size measured on two images, not a model of what the sweep costs; seed_addresses reach chosen functions.
const RAW_FINDER_BYTES: i64 = 4 * 1024 * 1024;

/// Preset first, then the caller's enable/disable, so Parameter ID can be turned on without also paying for the rest.
fn resolve_analyzer_config(o: &AnalyzerOverrides) -> (Vec<String>, Vec<String>) {
    let mut disable: Vec<String> = if o.preset.as_deref() == Some("full") { vec![] } else { FAST_DISABLED_ANALYZERS.iter().map(|s| s.to_string()).collect() };
    let mut enable: Vec<String> = Vec::new();
    for name in o.disable.iter().map(|n| n.trim()).filter(|n| !n.is_empty()) {
        if !disable.iter().any(|d| d == name) {
            disable.push(name.into());
        }
        enable.retain(|e| e != name);
    }
    for name in o.enable.iter().map(|n| n.trim()).filter(|n| !n.is_empty()) {
        if !enable.iter().any(|e| e == name) {
            enable.push(name.into());
        }
        disable.retain(|d| d != name);
    }
    (disable, enable)
}

/// One line the model can read back: the preset and the analyzers that ended up off or on.
/// The cache key for one Ghidra run: everything that changes what Ghidra is asked to do.
///
/// It held only the focus terms, so a rerun that asked for a different analyzer set, a different preset or a different
/// load address was answered in a tenth of a second out of the old artifacts — including the one rerun the tool's own
/// description asks the caller to make, `enable_analyzers: ["Decompiler Parameter ID"]` to get real parameter names
/// instead of `param_1`, which could therefore never work.
///
/// Both time limits are in it because a run they cut short is cached too: the same limits would stop in the same place,
/// and a raised one is a different question. They are different knobs — `APIM_GHIDRA_ANALYSIS_TIMEOUT_MS` gives up on
/// Ghidra's own analysis and still runs the post-script, `APIM_BINARY_DECOMPILE_TIMEOUT_MS` kills the whole process —
/// and only the second one produces `timed_out`.
fn ghidra_profile(focus_terms: &[String], focused_only: bool, o: &DeepOptions, analysis_ms: u64, kill_ms: u64) -> String {
    let (disable, enable) = resolve_analyzer_config(&o.analyzers);
    format!(
        "{}:fallback{}:analyzers[{}|{}]:raw[{}|{}]:seeds[{}]:limit{analysis_ms}/{kill_ms}",
        focus_profile(focus_terms, focused_only),
        o.allow_full_fallback,
        disable.join(","),
        enable.join(","),
        o.raw.image_base.trim(),
        o.raw.arch.trim(),
        o.seeds.join(","),
    )
}

/// The analysis limit Ghidra is given: at most half the whole-process one. The two were equal (30 minutes each above
/// 10 MB), and the process limit counts from launch, so whenever analysis ran into its own the kill came first and the
/// post-script never decompiled a function.
// ponytail: half is a guess at what decompiling needs; it is not known until the functions are counted.
fn analysis_limit(asked_ms: f64, kill_ms: f64) -> f64 {
    if kill_ms > 0.0 { asked_ms.min((kill_ms / 2.0).max(30_000.0)) } else { asked_ms }
}

/// `seed_addresses` as `0x…`, deduplicated, or the first one that is not a hex address.
fn seed_list(seeds: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for seed in seeds.iter().map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()) {
        let digits = seed.trim_start_matches("0x");
        if digits.is_empty() || digits.len() > 16 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(seed);
        }
        let seed = format!("0x{digits}");
        if !out.contains(&seed) {
            out.push(seed);
        }
    }
    // ponytail: the first 256; more than that is a full run's job.
    out.truncate(256);
    Ok(out)
}

fn describe_analyzer_config(o: &AnalyzerOverrides) -> String {
    let (disable, enable) = resolve_analyzer_config(o);
    let mut parts = vec![format!("preset {}", o.preset.as_deref().unwrap_or("fast"))];
    if !disable.is_empty() {
        parts.push(format!("off: {}", disable.join(", ")));
    }
    if !enable.is_empty() {
        parts.push(format!("on: {}", enable.join(", ")));
    }
    parts.join(" · ")
}

/// Where the Ghidra scripts live: APIM_GHIDRA_SCRIPTS, else `scripts/ghidra` beside the working folder or the program.
fn ghidra_script_dir() -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = env_trim("APIM_GHIDRA_SCRIPTS") {
        candidates.push(PathBuf::from(dir));
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    candidates.push(cwd.join("scripts").join("ghidra"));
    if let Ok(exe) = std::env::current_exe() {
        for up in exe.ancestors().skip(1).take(5) {
            candidates.push(up.join("scripts").join("ghidra"));
        }
    }
    candidates.iter().find(|c| c.join("ApimDecompile.java").is_file()).cloned().unwrap_or_else(|| cwd.join("scripts").join("ghidra"))
}

async fn run_ghidra(tools: &Tools, root: &Path, target: &str, inspection: &PeInspection, o: &DeepOptions, focus_terms: Vec<String>, focused_only: bool) -> DeepDecompilationResult {
    let with = |mut r: DeepDecompilationResult, outputs: Vec<String>, log: Option<String>| {
        r.outputs = outputs;
        r.focus_terms = Some(focus_terms.clone());
        r.focused_only = Some(focused_only);
        r.log_tail = log;
        r
    };
    let sha = &inspection.hashes.sha256;
    let rel_root = binary_analysis_root(target, sha);
    let (target_path, root_dir) = match (resolve(root, target), resolve(root, &rel_root)) {
        (Ok(t), Ok(r)) => (t, r),
        (Err(e), _) | (_, Err(e)) => return DeepDecompilationResult::new(false, "failed", "ghidra", e),
    };
    let output = root_dir.join("ghidra");
    let cpus = std::thread::available_parallelism().map_or(1, |n| n.get()) as f64;
    let default_analysis_ms = if inspection.packing.status == "likely" { 15.0 * 60_000.0 } else if inspection.bytes <= 10 * 1024 * 1024 { 10.0 * 60_000.0 } else { 30.0 * 60_000.0 };
    let kill_timeout_ms = number_env("APIM_BINARY_DECOMPILE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 0.0, 9.0e15);
    let analysis_timeout_ms = analysis_limit(number_env("APIM_GHIDRA_ANALYSIS_TIMEOUT_MS", default_analysis_ms, 30_000.0, 9.0e15), kill_timeout_ms);
    let profile = ghidra_profile(&focus_terms, focused_only, o, analysis_timeout_ms as u64, kill_timeout_ms as u64);
    let marker = output.join(".apim-analysis.json");
    if !o.force {
        if let Some(status) = read_marker(&marker, sha, "ghidra", &profile) {
            let outputs = list_outputs(&output, root);
            let partial = status == "partial";
            let more = if partial { " That run was stopped by the time limit, so these artifacts cover only the part of the binary it reached: read summary.txt for the coverage, and raise APIM_BINARY_DECOMPILE_TIMEOUT_MS or pass force to go further." } else { "" };
            let mut r = DeepDecompilationResult::new(false, if partial { "partial" } else { "complete" }, "ghidra", format!("Reused {} native decompilation artifact(s) from {rel_root}/ghidra.{more}", outputs.len()));
            r.cached = true;
            return with(r, outputs, None);
        }
    }
    let command = tools.ghidra.clone();
    if !command_could_exist(&command) {
        let mut r = DeepDecompilationResult::new(false, "unavailable", "ghidra", "Native static inspection completed, but Ghidra is not installed at the configured path.".into());
        r.setup = Some(format!("Install Ghidra and Java 21, set APIM_GHIDRA_HOME to the extracted Ghidra directory (the one containing support\\analyzeHeadless.bat), then restart apiM. {}", crate::env_local_source()));
        return r;
    }
    let _ = std::fs::remove_dir_all(&output);
    if let Err(e) = std::fs::create_dir_all(&output) {
        return DeepDecompilationResult::new(false, "failed", "ghidra", e.to_string());
    }
    // Ghidra rejects project paths with a dot-prefixed element, so the disposable project lives in the OS temp folder.
    // One folder per analysis, not per file: two chats looking at the same binary deleted each other's project.
    let project_dir = std::env::temp_dir().join("apim-ghidra-projects").join(format!("{}-{}", &sha[..16.min(sha.len())], crate::store::new_id()));
    let _ = std::fs::remove_dir_all(&project_dir);
    if let Err(e) = std::fs::create_dir_all(&project_dir) {
        return DeepDecompilationResult::new(false, "failed", "ghidra", e.to_string());
    }
    let script_dir = ghidra_script_dir();
    let max_cpu = number_env("APIM_BINARY_MAX_CPU", (cpus - 1.0).clamp(1.0, 16.0), 1.0, 64.0);
    let (disable, mut enable) = resolve_analyzer_config(&o.analyzers);
    // Loaded raw there is no entry point but the block starts the pre-script marks, so a small raw load also gets the
    // finder unless the caller said otherwise. A big one does not (`RAW_FINDER_BYTES`), and the result says so.
    let asked_finder = disable.iter().chain(&enable).any(|name| name == AGGRESSIVE_FINDER);
    let finder_left_off = o.raw.base().is_some() && !asked_finder && inspection.bytes > RAW_FINDER_BYTES;
    if o.raw.base().is_some() && !asked_finder && !finder_left_off {
        enable.push(AGGRESSIVE_FINDER.into());
    }
    let finder_note = if finder_left_off {
        format!(" Aggressive Instruction Finder was left off for a raw image over {} MB: on a 15 MB one it filled a 6G heap and ran into the time limit. Pass enable_analyzers: [\"Aggressive Instruction Finder\"] to run it anyway, or the starts of the functions you need as seed_addresses.", RAW_FINDER_BYTES >> 20)
    } else {
        String::new()
    };
    // Both scripts read seeds.txt from the output folder, which also keeps what was asked beside what came back.
    if !o.seeds.is_empty() {
        let _ = std::fs::write(output.join("seeds.txt"), o.seeds.join("\n") + "\n");
    }
    let analyzer_cfg = project_dir.join("analyzers.json");
    let _ = std::fs::write(&analyzer_cfg, serde_json::to_string_pretty(&serde_json::json!({ "disable": disable, "enable": enable })).unwrap_or_default());
    let out = output.to_string_lossy().to_string();
    // A dump of mapped memory has no header for Ghidra to read either, so it is told to take the bytes raw at the
    // address they were mapped at. Without this the loader places the image at 0 and nothing in it resolves.
    let raw = o.raw.loader_args();
    let mut args: Vec<String> = vec![
        project_dir.to_string_lossy().to_string(),
        format!("apim-{}", &sha[..12.min(sha.len())]),
        "-import".into(),
        target_path.to_string_lossy().to_string(),
        "-overwrite".into(),
        "-analysisTimeoutPerFile".into(),
        (analysis_timeout_ms / 1000.0).ceil().to_string(),
        "-max-cpu".into(),
        (max_cpu as u64).to_string(),
        "-deleteProject".into(),
        // The pre-script applies the chosen analyzer overrides and dumps the available analyzer list into the output folder.
        "-preScript".into(),
        "ApimAnalysisOptions.java".into(),
        analyzer_cfg.to_string_lossy().to_string(),
        out.clone(),
        // Loaded raw, nothing points at any code: the pre-script marks each executable block's start as an entry
        // point so the disassembler has somewhere to begin.
        if raw.is_empty() { "file".into() } else { "raw".into() },
        "-scriptPath".into(),
        script_dir.to_string_lossy().to_string(),
        "-postScript".into(),
        "ApimDecompile.java".into(),
        out,
        (if focused_only { if o.allow_full_fallback { "focused-fallback" } else { "focused" } } else { "full" }).into(),
    ];
    args.extend(focus_terms.iter().cloned());
    args.splice(2..2, raw);
    let result = run_captured(&command, &args, root).await;
    let launcher_fact = format!("The apiM server resolved and started the Ghidra launcher at {command}. Agent run_command processes use a separate scrubbed environment, so echoing APIM_GHIDRA_HOME or running where from them cannot diagnose this server-side launch.");
    let _ = std::fs::remove_dir_all(&project_dir);
    if !result.started {
        let mut r = DeepDecompilationResult::new(false, "unavailable", "ghidra", format!("Ghidra headless could not start{}", result.error.as_ref().map_or(".".to_string(), |e| format!(": {e}"))));
        r.setup = Some(format!("Install Ghidra and Java 21, set APIM_GHIDRA_HOME, then restart apiM. The configured folder must contain support\\analyzeHeadless.bat. {}", crate::env_local_source()));
        return r;
    }
    // The whole log, beside the output. It lived only in this process, and Ghidra's own application.log is one file
    // under %APPDATA% that every run on the machine writes into.
    let log_file = format!("{rel_root}/ghidra/ghidra.log");
    let _ = std::fs::write(output.join("ghidra.log"), &result.output);
    let outputs = list_outputs(&output, root);
    let summary_text = std::fs::read_to_string(output.join("summary.txt")).unwrap_or_default();
    let decompiled = regex::Regex::new(r"(?i)Functions decompiled:\s*(\d+)").unwrap().captures(&summary_text).and_then(|c| c[1].parse::<u64>().ok());
    let flag = |label: &str| regex::Regex::new(&format!(r"(?i){label}:\s*true")).unwrap().is_match(&summary_text);
    let behavior_fallback = flag("Behavior fallback used");
    // "Focus fallback used" is the pre-v3 spelling of one generated summary.
    let full_fallback = flag("Full fallback used") || flag("Focus fallback used");
    if result.code == Some(0) && decompiled.is_some_and(|n| n > 0) && outputs.iter().any(|x| x.ends_with("functions.tsv")) {
        write_marker(&marker, sha, "ghidra", &profile);
        let terms_slash = focus_terms.join("/");
        let how = if behavior_fallback {
            format!("No surviving {terms_slash} references were found, so only callers of high-interest loader/process-memory APIs were decompiled.")
        } else if full_fallback {
            format!("No surviving {terms_slash} or behavioral API references were found, so bounded full decompilation ran automatically.")
        } else {
            format!("Focus terms: {}.", if focus_terms.is_empty() { "(none)".to_string() } else { focus_terms.join(", ") })
        };
        // The model must see what this run paid for, so it can choose a cheaper or richer rerun on purpose.
        let hint = if enable.iter().any(|e| e == "Decompiler Parameter ID") || o.analyzers.preset.as_deref() == Some("full") {
            ""
        } else {
            "Placeholder names (param_1, var_1...) are expected: rerun with enable_analyzers: [\"Decompiler Parameter ID\"] to recover them. "
        };
        let seeds = if o.seeds.is_empty() { String::new() } else { format!(" Seed addresses: {}; the \"Seed addresses\" line of summary.txt says which became functions.", o.seeds.join(", ")) };
        let summary = format!("Ghidra decompiled {} function(s) and produced {} artifact(s) under {rel_root}/ghidra. {how}{seeds}{finder_note} Analyzer config: {}. {hint}", decompiled.unwrap_or(0), outputs.len(), describe_analyzer_config(&o.analyzers));
        return with(DeepDecompilationResult::new(true, "complete", "ghidra", summary), outputs, Some(tail(&result.output)));
    }
    let empty_success = result.code == Some(0) && decompiled == Some(0);
    // Partial means some code came back. The analyzer lists and the log come from every run, so counting files called a
    // run that died in auto-analysis "partial" with nothing decompiled.
    let status = if decompiled.is_some_and(|n| n > 0) { "partial" } else { "failed" };
    // A run the limit stopped is kept, not thrown away. The next inspection used to delete this output and start the
    // same analysis again, reach the same limit and delete it again — half an hour of every core, each time, for
    // artifacts that were already on disk. The limit is in the profile above, so raising it still reruns.
    if status == "partial" && result.timed_out && decompiled.is_some_and(|n| n > 0) {
        write_marker_status(&marker, sha, "ghidra", &profile, "partial");
    }
    let detail = if empty_success {
        "Ghidra exited successfully but decompiled zero functions. This is not accepted as a completed analysis; inspect the log tail below for loader, language or packing failures.".to_string()
    } else if result.timed_out {
        format!(
            "Ghidra exceeded the configured time limit after decompiling {} function(s); {} output file(s) were kept and are cached as a partial result, so re-inspecting this hash reuses them instead of starting over. summary.txt holds the coverage, including how much of the executable bytes any function covers. Raise APIM_BINARY_DECOMPILE_TIMEOUT_MS (the whole-process limit that stopped it), or pass force, to go further.",
            decompiled.map_or("an unrecorded number of".to_string(), |n| n.to_string()),
            outputs.len()
        )
    } else {
        let how_far = match decompiled {
            None => "before its post-script wrote a summary, so nothing was decompiled".to_string(),
            Some(n) => format!("after decompiling {n} function(s)"),
        };
        format!("Ghidra exited with code {} {how_far}. The lines naming the cause are below.", result.code.map_or("unknown".to_string(), |c| c.to_string()))
    };
    // Ghidra exits 0 when the import itself fails, so the code alone says nothing.
    let no_loader = if o.raw.base().is_none() && result.output.contains("No load spec found") { " The file has no header Ghidra recognises: if it is a memory dump or a carved section, pass image_base (and arch) to load it raw." } else { "" };
    with(DeepDecompilationResult::new(true, status, "ghidra", format!("{launcher_fact} {detail}{no_loader}{finder_note} The whole log is {log_file}.")), outputs, Some(ghidra_failure_log(&result.output)))
}

struct CapaResource {
    path: Option<PathBuf>,
    /// An explicit setting that points nowhere is a configuration error.
    missing: Option<String>,
}

fn capa_resource_path(env_name: &str, defaults: &[&str]) -> CapaResource {
    let cwd = std::env::current_dir().unwrap_or_default();
    if let Some(configured) = env_trim(env_name) {
        let p = Path::new(&configured);
        let resolved = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
        return if resolved.exists() { CapaResource { path: Some(resolved), missing: None } } else { CapaResource { path: None, missing: Some(resolved.to_string_lossy().to_string()) } };
    }
    for d in defaults {
        let resolved = d.split('/').fold(cwd.clone(), |p, part| p.join(part)); // no mixed separators in what capa is handed
        if resolved.exists() {
            return CapaResource { path: Some(resolved), missing: None };
        }
    }
    CapaResource { path: None, missing: None }
}

/// Runs Mandiant/FLARE capa when installed (PE only); the static parser stays independent of it.
pub async fn run_capa_analysis_with(tools: &Tools, root: &Path, target: &str, inspection: &PeInspection, force: bool, enabled: bool) -> CapaAnalysisResult {
    let result = |attempted: bool, status: &'static str, summary: String| CapaAnalysisResult { attempted, status, output: None, cached: false, summary, setup: None, log_tail: None };
    if !enabled {
        return result(false, "disabled", "capa analysis was disabled for this call.".into());
    }
    if !inspection.format.starts_with("PE") {
        return result(false, "unavailable", format!("{} is not supported by this capa pipeline.", inspection.format));
    }
    let rules = capa_resource_path("APIM_CAPA_RULES_PATH", &["tools/capa-rules"]);
    let signatures = capa_resource_path("APIM_CAPA_SIGNATURES_PATH", &["tools/capa/sigs"]);
    let missing = if let Some(m) = &rules.missing {
        Some(format!("Configured capa rules path does not exist: {m}"))
    } else {
        signatures.missing.as_ref().map(|m| format!("Configured capa signatures path does not exist: {m}"))
    };
    if let Some(summary) = missing {
        let mut r = result(false, "unavailable", summary);
        r.setup = Some(format!("Fix APIM_CAPA_RULES_PATH/APIM_CAPA_SIGNATURES_PATH. Relative paths are resolved from the apiM folder. {}", crate::env_local_source()));
        return r;
    }
    let sha = &inspection.hashes.sha256;
    let rel_root = binary_analysis_root(target, sha);
    let (output_dir, target_path) = match (resolve(root, &format!("{rel_root}/capa")), resolve(root, target)) {
        (Ok(o), Ok(t)) => (o, t),
        (Err(e), _) | (_, Err(e)) => return result(false, "failed", e),
    };
    let output = output_dir.join("capa-report.txt");
    let marker = output_dir.join(".apim-analysis.json");
    let show = |p: &Option<PathBuf>| p.as_ref().map_or("embedded".to_string(), |p| p.to_string_lossy().to_string());
    let profile = format!("text-v2:rules={}:sigs={}", show(&rules.path), show(&signatures.path));
    if !force && read_marker(&marker, sha, "capa", &profile).is_some() {
        let out = rel(root, &output);
        let mut r = result(false, "complete", format!("Reused cached capa report at {out}."));
        r.output = Some(out);
        r.cached = true;
        return r;
    }
    if !command_could_exist(&tools.capa) {
        let mut r = result(false, "unavailable", "capa is not installed at the configured path.".into());
        r.setup = Some("Prefer the official standalone capa release (it embeds rules/signatures), or install flare-capa plus matching rules/signatures. Put capa on PATH or set APIM_CAPA_PATH, then restart apiM.".into());
        return r;
    }
    let _ = std::fs::remove_dir_all(&output_dir);
    if let Err(e) = std::fs::create_dir_all(&output_dir) {
        return result(false, "failed", e.to_string());
    }
    let mut args: Vec<String> = Vec::new();
    if let Some(p) = &rules.path {
        args.extend(["-r".to_string(), p.to_string_lossy().to_string()]);
    }
    if let Some(p) = &signatures.path {
        args.extend(["-s".to_string(), p.to_string_lossy().to_string()]);
    }
    args.push(target_path.to_string_lossy().to_string());
    let run = run_captured(&tools.capa, &args, root).await;
    if !run.started {
        let mut r = result(false, "unavailable", format!("capa could not start{}", run.error.as_ref().map_or(".".to_string(), |e| format!(": {e}"))));
        r.setup = Some(format!("Install FLARE capa and put capa.exe on PATH, or set APIM_CAPA_PATH to the executable. {}", crate::env_local_source()));
        return r;
    }
    let _ = std::fs::write(&output, if run.output.is_empty() { "(capa produced no text output)\n" } else { &run.output });
    let out = Some(rel(root, &output));
    if run.code == Some(0) {
        write_marker(&marker, sha, "capa", &profile);
        let mut r = result(true, "complete", format!("capa completed; full report saved to {}.", rel(root, &output)));
        r.output = out;
        r.log_tail = Some(tail(&run.output));
        return r;
    }
    let lower = run.output.to_lowercase();
    let missing_rules = lower.contains("default embedded rules not found") || lower.contains("provide your own rule set via the `-r`");
    let missing_sigs = lower.contains("default signature path") || lower.contains("install the signatures first") || (lower.contains("signatures path") && lower.contains("does not exist"));
    if missing_rules || missing_sigs {
        let what = if missing_rules && missing_sigs { "rules and signatures" } else if missing_rules { "rules" } else { "signatures" };
        let mut r = result(true, "unavailable", format!("The capa engine is installed, but its pip package is missing {what}."));
        r.output = out;
        r.setup = Some("Install matching capa-rules and capa/sigs directories, then set APIM_CAPA_RULES_PATH and APIM_CAPA_SIGNATURES_PATH. apiM also auto-detects tools/capa-rules and tools/capa/sigs. The official standalone capa executable is an alternative because it embeds both resources.".into());
        r.log_tail = Some(tail(&run.output));
        return r;
    }
    let summary = if run.timed_out { "capa exceeded the configured analysis timeout; partial output was saved.".to_string() } else { format!("capa exited with code {}; its diagnostic output was saved.", run.code.map_or("unknown".to_string(), |c| c.to_string())) };
    let mut r = result(true, "failed", summary);
    r.output = out;
    r.log_tail = Some(tail(&run.output));
    r
}

pub async fn run_capa_analysis(root: &Path, target: &str, inspection: &PeInspection, force: bool, enabled: bool) -> CapaAnalysisResult {
    run_capa_analysis_with(&Tools::from_env(), root, target, inspection, force, enabled).await
}

/// Picks ILSpy for managed code and Ghidra for everything else, refusing to start either without named focus terms.
pub async fn run_deep_decompilation_with(tools: &Tools, root: &Path, target: &str, inspection: &PeInspection, o: &DeepOptions) -> DeepDecompilationResult {
    // Headless Ghidra detects ELF and Mach-O itself; only the legacy DOS images are out of reach.
    let ghidra_formats = ["ELF", "Mach-O", "Mach-O universal", "unknown binary"];
    // An address given for it says to ignore whatever header it has and take the bytes raw, so a dump wearing an MZ
    // header that leads nowhere is not turned away as a 16-bit program — which is what it looks like from the outside.
    let raw_asked = o.raw.base().is_some();
    if !raw_asked && !inspection.format.starts_with("PE") && !ghidra_formats.contains(&inspection.format.as_str()) {
        return DeepDecompilationResult::new(false, "unavailable", "none", format!("{} is a legacy executable format; the configured modern decompilers cannot reconstruct it. Static strings and hashes are still shown.", inspection.format));
    }
    let engine = if inspection.managed.is_some() { "ilspy" } else { "ghidra" };
    let focus_terms = normalise_focus_terms(&o.focus_terms);
    let focused_only = o.focused_only != Some(false);
    // Refused up front: a word in an address list would otherwise reach Ghidra and come back as one line of summary.txt
    // after minutes of analysis.
    let seeds = match seed_list(&o.seeds) {
        Ok(seeds) => seeds,
        Err(bad) => return DeepDecompilationResult::new(false, "failed", engine, format!("\"{bad}\" is not a hex address (seed_addresses takes values like 0x140001000). Nothing was started.")),
    };
    // Do not launch Ghidra/ILSpy until the caller named what they want: an unfocused run on a big DLL can go on for hours.
    if focused_only && focus_terms.is_empty() && (seeds.is_empty() || engine != "ghidra") && !o.allow_full_fallback {
        let mut r = DeepDecompilationResult::new(
            false,
            "disabled",
            engine,
            format!("Deep decompilation was not started. Name the functions or strings you need in focus_terms (from a summary/strings pass), give their start addresses in seed_addresses, or set focused_only=false / allow_full_fallback=true only if you really want the whole {}.", if engine == "ghidra" { "binary" } else { "assembly" }),
        );
        r.focus_terms = Some(focus_terms);
        r.focused_only = Some(focused_only);
        return r;
    }
    // An image with no header of its own (a dump of mapped memory, a carved section) needs to be told where it
    // belongs before anything in it can be followed: an address is a fact only the caller has.
    let headerless = inspection.sections.is_empty() && (inspection.format == "unknown binary" || inspection.format.starts_with("DOS/"));
    if headerless && o.raw.base().is_none() {
        let mut r = DeepDecompilationResult::new(
            false,
            "disabled",
            "ghidra",
            format!("{} carries no header, so there is nothing to say where its bytes belong in memory. Pass image_base (the address it was mapped at, as hex) to load it raw there, and arch when it is not x86-64 (\"x86\", \"arm64\", \"arm\", or a Ghidra language id). Everything in it resolves against that address, so a wrong one is worse than none.", inspection.format),
        );
        r.focus_terms = Some(focus_terms);
        r.focused_only = Some(focused_only);
        return r;
    }
    // ponytail: the web de-duplicates identical in-flight runs; one tool call at a time makes that unnecessary here.
    if inspection.managed.is_some() {
        run_ilspy(tools, root, target, inspection, o.force, focus_terms, focused_only).await
    } else {
        run_ghidra(tools, root, target, inspection, &DeepOptions { seeds, ..o.clone() }, focus_terms, focused_only).await
    }
}

pub async fn run_deep_decompilation(root: &Path, target: &str, inspection: &PeInspection, o: &DeepOptions) -> DeepDecompilationResult {
    run_deep_decompilation_with(&Tools::from_env(), root, target, inspection, o).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binary::pe::{inspect_portable_executable, samples, StringOptions};

    #[test]
    fn a_rerun_that_asks_for_something_else_does_not_hit_the_cache() {
        let terms = ["CreateMove".to_string()];
        let key = |o: &DeepOptions| ghidra_profile(&terms, true, o, 600_000, 1_800_000);
        let base = DeepOptions::default();
        assert_eq!(key(&base), key(&DeepOptions::default()), "the same question must reuse its answer");

        // Each of these changes what Ghidra is handed, so each has to miss. The analyzer set is the one that mattered
        // in practice: the tool tells the caller to rerun with Decompiler Parameter ID for real parameter names.
        let mut named = base.clone();
        named.analyzers.enable = vec!["Decompiler Parameter ID".into()];
        let mut preset = base.clone();
        preset.analyzers.preset = Some("full".into());
        let mut off = base.clone();
        off.analyzers.disable = vec!["Aggressive Instruction Finder".into()];
        let mut raw = base.clone();
        raw.raw.image_base = "0x7ff782798000".into();
        let mut arch = raw.clone();
        arch.raw.arch = "x86".into();
        let mut fallback = base.clone();
        fallback.allow_full_fallback = true;
        let mut seeded = base.clone();
        seeded.seeds = vec!["0x14002d6d0".into()];

        let mut keys = vec![key(&base), key(&named), key(&preset), key(&off), key(&raw), key(&arch), key(&fallback), key(&seeded)];
        keys.push(ghidra_profile(&terms, true, &base, 60_000, 1_800_000)); // a shorter analysis limit
        keys.push(ghidra_profile(&terms, true, &base, 600_000, 60_000)); // a shorter kill limit
        keys.push(ghidra_profile(&terms, false, &base, 600_000, 1_800_000)); // full rather than focused
        keys.push(ghidra_profile(&[], true, &base, 600_000, 1_800_000)); // different focus terms
        let total = keys.len();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), total, "two different questions share one cache key");
    }

    #[test]
    fn analysis_stops_in_time_for_the_decompiling() {
        // Asked for the same hour as the kill, analysis gets half of it; with no kill, all it asked for.
        assert_eq!(analysis_limit(3_600_000.0, 3_600_000.0), 1_800_000.0);
        assert_eq!(analysis_limit(600_000.0, 1_800_000.0), 600_000.0);
        assert_eq!(analysis_limit(3_600_000.0, 0.0), 3_600_000.0);
        assert_eq!(analysis_limit(600_000.0, 20_000.0), 30_000.0, "never under the analysis limit's own floor");
    }

    #[test]
    fn seed_addresses_are_read_as_hex_or_refused() {
        let list = |seeds: &[&str]| seed_list(&seeds.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(list(&["0x14002D6D0", "14002d6d0", " ", "0x1"]), Ok(vec!["0x14002d6d0".to_string(), "0x1".to_string()]));
        assert_eq!(list(&["0x1", "CreateMove"]), Err("createmove".to_string()));
        assert_eq!(list(&["0x"]), Err("0x".to_string()));
        assert_eq!(list(&["0x11112222333344445"]), Err("0x11112222333344445".to_string()), "longer than 64 bits");
    }

    #[test]
    fn a_failed_run_shows_the_line_that_says_why() {
        let mut log = String::from("INFO  Using log file\n");
        log += "ERROR (X86Analyzer) java.lang.OutOfMemoryError: Java heap space\n";
        for i in 0..400 {
            log += &format!("INFO  shutdown chatter line {i} that goes on long enough to push the cause out of the tail\n");
        }
        let shown = ghidra_failure_log(&log);
        assert!(shown.starts_with("Lines naming the cause:\nERROR (X86Analyzer) java.lang.OutOfMemoryError: Java heap space\n"), "{shown}");
        assert!(!tail(&log).contains("OutOfMemoryError"), "the cause was outside the old tail");
        assert_eq!(ghidra_failure_log("all fine"), "all fine");
    }

    fn sample() -> PeInspection {
        inspect_portable_executable(&samples::pe64(), &StringOptions::default()).unwrap()
    }

    /// Everything the decompilers start must run under the user's own windows, so reading a binary never takes the
    /// computer. Asked from inside the process itself, since the class is what its children inherit.
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread")]
    async fn what_a_decompiler_starts_runs_below_normal_priority() {
        let cwd = std::env::temp_dir();
        let args = ["-NoProfile".to_string(), "-Command".to_string(), "(Get-Process -Id $PID).PriorityClass".to_string()];
        let run = run_captured("powershell", &args, &cwd).await;
        assert!(run.started && run.code == Some(0), "started {} code {:?} error {:?}", run.started, run.code, run.error);
        assert_eq!(run.output.trim(), "BelowNormal", "{}", run.output);
    }

    /// A dump of mapped memory has no header, so Ghidra is told where the bytes belong and what reads them.
    #[test]
    fn a_headerless_image_is_loaded_raw_at_the_address_it_was_mapped_at() {
        let at = |base: &str, arch: &str| RawImage { image_base: base.into(), arch: arch.into() }.loader_args().join(" ");
        assert_eq!(at("0x7ff782798000", ""), "-loader BinaryLoader -loader-baseAddr 0x7ff782798000 -processor x86:LE:64:default");
        // Written without the 0x, as a mapped address often is, and with the processors a caller names.
        assert_eq!(at("400000", "x86"), "-loader BinaryLoader -loader-baseAddr 0x400000 -processor x86:LE:32:default");
        assert_eq!(at("0x1000", "ARM64"), "-loader BinaryLoader -loader-baseAddr 0x1000 -processor AARCH64:LE:64:v8A");
        // A Ghidra language id is passed straight through, so an unusual processor needs no list here.
        assert_eq!(at("0x1000", "MIPS:BE:32:default"), "-loader BinaryLoader -loader-baseAddr 0x1000 -processor MIPS:BE:32:default");
        // No address, nothing to say: the file is loaded the ordinary way.
        assert!(at("", "x86").is_empty() && at("not a number", "").is_empty() && RawImage::default().base().is_none());
    }

    /// Without that address nothing in the image resolves, so it says what to pass rather than running a useless load.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_headerless_image_without_an_address_says_what_to_pass() {
        let root = crate::tools::scratch("rawbase");
        let raw = crate::binary::formats::inspect_generic_binary(&[0x66u8; 4096], &StringOptions::default(), "MQg.bin");
        assert_eq!(raw.format, "unknown binary");
        let asked = DeepOptions { focus_terms: vec!["CreateMove".into()], ..Default::default() };
        let r = run_deep_decompilation_with(&missing(), &root, "MQg.bin", &raw, &asked).await;
        assert_eq!((r.status, r.attempted), ("disabled", false), "{}", r.summary);
        assert!(r.summary.contains("carries no header") && r.summary.contains("image_base") && r.summary.contains("arch"), "{}", r.summary);
        // Given one, it goes on to the launcher (which is not installed here, so it reports that instead).
        let with_base = DeepOptions { raw: RawImage { image_base: "0x7ff782798000".into(), arch: String::new() }, ..asked.clone() };
        let r = run_deep_decompilation_with(&missing(), &root, "MQg.bin", &raw, &with_base).await;
        assert_eq!(r.status, "unavailable", "{}", r.summary);
        // A dump wearing a hand-built MZ header reads as a 16-bit program and was turned away before any of this.
        // With an address it is taken raw like any other headerless file, header and all.
        let mut mz = raw.clone();
        mz.format = "DOS/MZ".into();
        let without = run_deep_decompilation_with(&missing(), &root, "MQg.bin", &mz, &asked).await;
        assert!(without.summary.contains("legacy executable format"), "{}", without.summary);
        let r = run_deep_decompilation_with(&missing(), &root, "MQg.bin", &mz, &with_base).await;
        assert_eq!(r.status, "unavailable", "{}", r.summary);
        assert!(r.summary.contains("Ghidra") && !r.summary.contains("legacy executable format"), "{}", r.summary);
        let _ = std::fs::remove_dir_all(&root);
    }

    fn missing() -> Tools {
        Tools { ilspy: "C:/definitely/not/here/ilspycmd.exe".into(), ghidra: "C:/definitely/not/here/analyzeHeadless.bat".into(), capa: "C:/definitely/not/here/capa.exe".into() }
    }

    #[test]
    fn analyzer_presets_follow_the_web() {
        let fast = AnalyzerOverrides::default();
        assert_eq!(describe_analyzer_config(&fast), "preset fast · off: Decompiler Parameter ID, Decompiler Switch Analysis, Stack");
        let custom = AnalyzerOverrides { enable: vec!["Decompiler Parameter ID".into()], disable: vec![" Foo ".into()], preset: Some("fast".into()) };
        assert_eq!(describe_analyzer_config(&custom), "preset fast · off: Decompiler Switch Analysis, Stack, Foo · on: Decompiler Parameter ID");
        let full = AnalyzerOverrides { preset: Some("full".into()), ..Default::default() };
        assert_eq!(describe_analyzer_config(&full), "preset full");
        assert_eq!(focus_profile(&["B".into(), "a".into()], true), "analysis-v9:focused:a|b");
        assert_eq!(normalise_focus_terms(&[" x ".into(), "x".into(), "".into(), "y".repeat(121)]), ["x"]);
    }

    #[tokio::test]
    async fn refuses_to_start_without_focus_terms() {
        let root = test_dir("decompiler-gate");
        let r = run_deep_decompilation_with(&missing(), &root, "a.exe", &sample(), &DeepOptions::default()).await;
        assert_eq!((r.status, r.engine, r.attempted), ("disabled", "ghidra", false));
        assert!(r.summary.starts_with("Deep decompilation was not started. Name the functions or strings you need in focus_terms") && r.summary.ends_with("whole binary."));
        let mut elf = sample();
        elf.format = "DOS/NE".into();
        let r = run_deep_decompilation_with(&missing(), &root, "a.exe", &elf, &DeepOptions::default()).await;
        assert_eq!((r.status, r.engine), ("unavailable", "none"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn missing_tools_return_the_web_wording() {
        let root = test_dir("decompiler-missing");
        let opts = DeepOptions { focus_terms: vec!["CreateMove".into()], ..Default::default() };
        let g = run_deep_decompilation_with(&missing(), &root, "a.exe", &sample(), &opts).await;
        assert_eq!((g.status, g.summary.as_str()), ("unavailable", "Native static inspection completed, but Ghidra is not installed at the configured path."));
        assert!(g.setup.unwrap().starts_with("Install Ghidra and Java 21, set APIM_GHIDRA_HOME to the extracted Ghidra directory"));
        let mut managed = sample();
        managed.managed = Some(crate::binary::pe::ManagedAssembly { name: None, version: None, runtime_version: None, flags: 1, references: vec![] });
        let i = run_deep_decompilation_with(&missing(), &root, "a.exe", &managed, &opts).await;
        assert_eq!((i.engine, i.summary.as_str()), ("ilspy", "The binary is managed .NET, but ILSpy is not installed at the configured path."));
        let c = run_capa_analysis_with(&missing(), &root, "a.exe", &sample(), false, true).await;
        assert_eq!((c.status, c.summary.as_str()), ("unavailable", "capa is not installed at the configured path."));
        let off = run_capa_analysis_with(&missing(), &root, "a.exe", &sample(), false, false).await;
        assert_eq!((off.status, off.summary.as_str()), ("disabled", "capa analysis was disabled for this call."));
        std::fs::remove_dir_all(&root).ok();
    }

    /// A stand-in launcher: finds the output folder after -postScript, writes what Ghidra's post-script would, exits 0.
    #[cfg(windows)]
    #[tokio::test]
    async fn runs_a_launcher_and_reads_its_summary() {
        let root = test_dir("decompiler-fake");
        let fake = root.join("fake-analyzeHeadless.bat");
        std::fs::write(&fake, "@echo off\r\n:a\r\nif \"%~1\"==\"-postScript\" goto b\r\nshift\r\ngoto a\r\n:b\r\nset OUT=%~3\r\n> \"%OUT%\\summary.txt\" echo Functions decompiled: 3\r\n> \"%OUT%\\functions.tsv\" echo name\r\necho fake ghidra ran\r\nexit /b 0\r\n").unwrap();
        let tools = Tools { ghidra: fake.to_string_lossy().to_string(), ..missing() };
        let p = sample();
        let opts = DeepOptions { focus_terms: vec!["CreateMove".into()], ..Default::default() };
        let r = run_deep_decompilation_with(&tools, &root, "uploads/a.exe", &p, &opts).await;
        let rel_root = binary_analysis_root("uploads/a.exe", &p.hashes.sha256);
        assert_eq!((r.status, r.attempted, r.cached), ("complete", true, false), "{r:?}");
        assert_eq!(r.outputs, [format!("{rel_root}/ghidra/functions.tsv"), format!("{rel_root}/ghidra/ghidra.log"), format!("{rel_root}/ghidra/summary.txt")]);
        assert!(r.summary.starts_with(&format!("Ghidra decompiled 3 function(s) and produced 3 artifact(s) under {rel_root}/ghidra. Focus terms: CreateMove. Analyzer config: preset fast · off: Decompiler Parameter ID")), "{}", r.summary);
        assert!(r.summary.ends_with("to recover them. "));
        assert!(r.log_tail.unwrap().contains("fake ghidra ran"));
        let again = run_deep_decompilation_with(&tools, &root, "uploads/a.exe", &p, &opts).await;
        assert_eq!((again.status, again.attempted, again.cached), ("complete", false, true));
        assert!(again.summary.starts_with("Reused 3 native decompilation artifact(s) from "));
        std::fs::remove_dir_all(&root).ok();
    }
}

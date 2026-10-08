//! binary-decompiler.ts: the optional deep tools. Managed .NET goes to ILSpy (`ilspycmd`), everything else to headless
//! Ghidra (`analyzeHeadless`), and PE files can also get a FLARE `capa` report. None of them is bundled or downloaded:
//! a missing tool returns the web's own "not installed" wording and setup hint. The target is passed to the tool as
//! data and never launched. Results are cached next to the web's artifacts (`analysis/<name>-<sha12>/{ilspy,ghidra,capa}`).
//!
//! Environment (same names as the web app): APIM_ILSPYCMD_PATH, APIM_GHIDRA_HOME / GHIDRA_HOME, APIM_CAPA_PATH,
//! APIM_CAPA_RULES_PATH, APIM_CAPA_SIGNATURES_PATH, APIM_GHIDRA_MAX_MEMORY, APIM_BINARY_MAX_CPU,
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
    pub focus_terms: Vec<String>,
    pub focused_only: Option<bool>,
    pub analyzers: AnalyzerOverrides,
    pub allow_full_fallback: bool,
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
        // Ghidra's launcher reads MAX_MEMORY for the JVM heap; a big decompile can exhaust the default.
        ("MAX_MEMORY".into(), env_trim("APIM_GHIDRA_MAX_MEMORY").or_else(|| env_trim("MAX_MEMORY")).unwrap_or_else(|| "4G".into())),
    ];
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
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
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

fn read_marker(file: &Path, hash: &str, engine: &str, profile: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(file) else { return false };
    let Ok(m) = serde_json::from_str::<serde_json::Value>(&text) else { return false };
    m["hash"] == hash && m["engine"] == engine && m["profile"] == profile && m["complete"] == true
}

fn write_marker(file: &Path, hash: &str, engine: &str, profile: &str) {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Marker<'a> {
        hash: &'a str,
        engine: &'a str,
        profile: &'a str,
        complete: bool,
        created_at: String,
    }
    let body = Marker { hash, engine, profile, complete: true, created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) };
    let _ = std::fs::write(file, serde_json::to_string_pretty(&body).unwrap_or_default() + "\n");
}

/// The end of a log, the part with the error.
fn tail(text: &str) -> String {
    let n = text.chars().count();
    if n <= 6000 { text.trim().to_string() } else { format!("…{}", text.chars().skip(n - 6000).collect::<String>().trim()) }
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
    if !force && read_marker(&marker, sha, "ilspy", &profile) {
        let outputs = list_outputs(&output, root);
        let mut r = DeepDecompilationResult::new(false, "complete", "ilspy", format!("Reused {} managed decompilation artifact(s) from {rel_root}/ilspy.", outputs.len()));
        r.cached = true;
        return with(r, outputs, None);
    }
    if !command_could_exist(&tools.ilspy) {
        let mut r = DeepDecompilationResult::new(false, "unavailable", "ilspy", "The binary is managed .NET, but ILSpy is not installed at the configured path.".into());
        r.setup = Some("Install the .NET SDK, run `dotnet tool install --global ilspycmd`, restart apiM, and optionally set APIM_ILSPYCMD_PATH in .env.local if it is not on PATH.".into());
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
    let profile = focus_profile(&focus_terms, focused_only);
    let marker = output.join(".apim-analysis.json");
    if !o.force && read_marker(&marker, sha, "ghidra", &profile) {
        let outputs = list_outputs(&output, root);
        let mut r = DeepDecompilationResult::new(false, "complete", "ghidra", format!("Reused {} native decompilation artifact(s) from {rel_root}/ghidra.", outputs.len()));
        r.cached = true;
        return with(r, outputs, None);
    }
    let command = tools.ghidra.clone();
    if !command_could_exist(&command) {
        let mut r = DeepDecompilationResult::new(false, "unavailable", "ghidra", "Native static inspection completed, but Ghidra is not installed at the configured path.".into());
        r.setup = Some("Install Ghidra and Java 21, set APIM_GHIDRA_HOME in .env.local to the extracted Ghidra directory (the one containing support\\analyzeHeadless.bat), then restart apiM.".into());
        return r;
    }
    let _ = std::fs::remove_dir_all(&output);
    if let Err(e) = std::fs::create_dir_all(&output) {
        return DeepDecompilationResult::new(false, "failed", "ghidra", e.to_string());
    }
    // Ghidra rejects project paths with a dot-prefixed element, so the disposable project lives in the OS temp folder.
    let project_dir = std::env::temp_dir().join("apim-ghidra-projects").join(&sha[..16.min(sha.len())]);
    let _ = std::fs::remove_dir_all(&project_dir);
    if let Err(e) = std::fs::create_dir_all(&project_dir) {
        return DeepDecompilationResult::new(false, "failed", "ghidra", e.to_string());
    }
    let script_dir = ghidra_script_dir();
    let cpus = std::thread::available_parallelism().map_or(1, |n| n.get()) as f64;
    let max_cpu = number_env("APIM_BINARY_MAX_CPU", (cpus - 1.0).clamp(1.0, 16.0), 1.0, 64.0);
    let default_analysis_ms = if inspection.packing.status == "likely" { 15.0 * 60_000.0 } else if inspection.bytes <= 10 * 1024 * 1024 { 10.0 * 60_000.0 } else { 30.0 * 60_000.0 };
    let analysis_timeout_ms = number_env("APIM_GHIDRA_ANALYSIS_TIMEOUT_MS", default_analysis_ms, 30_000.0, 9.0e15);
    let (disable, enable) = resolve_analyzer_config(&o.analyzers);
    let analyzer_cfg = project_dir.join("analyzers.json");
    let _ = std::fs::write(&analyzer_cfg, serde_json::to_string_pretty(&serde_json::json!({ "disable": disable, "enable": enable })).unwrap_or_default());
    let out = output.to_string_lossy().to_string();
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
        "-scriptPath".into(),
        script_dir.to_string_lossy().to_string(),
        "-postScript".into(),
        "ApimDecompile.java".into(),
        out,
        (if focused_only { if o.allow_full_fallback { "focused-fallback" } else { "focused" } } else { "full" }).into(),
    ];
    args.extend(focus_terms.iter().cloned());
    let result = run_captured(&command, &args, root).await;
    let launcher_fact = format!("The apiM server resolved and started the Ghidra launcher at {command}. Agent run_command processes use a separate scrubbed environment, so echoing APIM_GHIDRA_HOME or running where from them cannot diagnose this server-side launch.");
    let _ = std::fs::remove_dir_all(&project_dir);
    if !result.started {
        let mut r = DeepDecompilationResult::new(false, "unavailable", "ghidra", format!("Ghidra headless could not start{}", result.error.as_ref().map_or(".".to_string(), |e| format!(": {e}"))));
        r.setup = Some("Install Ghidra and Java 21, set APIM_GHIDRA_HOME in .env.local, then restart apiM. The configured folder must contain support\\analyzeHeadless.bat.".into());
        return r;
    }
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
        let summary = format!("Ghidra decompiled {} function(s) and produced {} artifact(s) under {rel_root}/ghidra. {how} Analyzer config: {}. {hint}", decompiled.unwrap_or(0), outputs.len(), describe_analyzer_config(&o.analyzers));
        return with(DeepDecompilationResult::new(true, "complete", "ghidra", summary), outputs, Some(tail(&result.output)));
    }
    let empty_success = result.code == Some(0) && decompiled == Some(0);
    let status = if empty_success || outputs.is_empty() { "failed" } else { "partial" };
    let detail = if empty_success {
        "Ghidra exited successfully but decompiled zero functions. This is not accepted as a completed analysis; inspect the log tail below for loader, language or packing failures.".to_string()
    } else if result.timed_out {
        format!("Ghidra exceeded the configured time limit; {} partial output file(s) were kept. Increase APIM_BINARY_DECOMPILE_TIMEOUT_MS only for binaries that justify it.", outputs.len())
    } else {
        format!("Ghidra exited with code {}; {} partial output file(s) were kept. The log tail below contains the actual Java, loader or post-script error.", result.code.map_or("unknown".to_string(), |c| c.to_string()), outputs.len())
    };
    with(DeepDecompilationResult::new(true, status, "ghidra", format!("{launcher_fact} {detail}")), outputs, Some(tail(&result.output)))
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
        r.setup = Some("Fix APIM_CAPA_RULES_PATH/APIM_CAPA_SIGNATURES_PATH in .env.local. Relative paths are resolved from the apiM folder.".into());
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
    if !force && read_marker(&marker, sha, "capa", &profile) {
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
        r.setup = Some("Install FLARE capa and put capa.exe on PATH, or set APIM_CAPA_PATH to the executable in .env.local.".into());
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
    if !inspection.format.starts_with("PE") && !ghidra_formats.contains(&inspection.format.as_str()) {
        return DeepDecompilationResult::new(false, "unavailable", "none", format!("{} is a legacy executable format; the configured modern decompilers cannot reconstruct it. Static strings and hashes are still shown.", inspection.format));
    }
    let engine = if inspection.managed.is_some() { "ilspy" } else { "ghidra" };
    let focus_terms = normalise_focus_terms(&o.focus_terms);
    let focused_only = o.focused_only != Some(false);
    // Do not launch Ghidra/ILSpy until the caller named what they want: an unfocused run on a big DLL can go on for hours.
    if focused_only && focus_terms.is_empty() && !o.allow_full_fallback {
        let mut r = DeepDecompilationResult::new(
            false,
            "disabled",
            engine,
            format!("Deep decompilation was not started. Name the functions or strings you need in focus_terms (from a summary/strings pass), enable a specific analyzer such as \"Decompiler Parameter ID\" via enable_analyzers, or set focused_only=false / allow_full_fallback=true only if you really want the whole {}.", if engine == "ghidra" { "binary" } else { "assembly" }),
        );
        r.focus_terms = Some(focus_terms);
        r.focused_only = Some(focused_only);
        return r;
    }
    // ponytail: the web de-duplicates identical in-flight runs; one tool call at a time makes that unnecessary here.
    if inspection.managed.is_some() {
        run_ilspy(tools, root, target, inspection, o.force, focus_terms, focused_only).await
    } else {
        run_ghidra(tools, root, target, inspection, o, focus_terms, focused_only).await
    }
}

pub async fn run_deep_decompilation(root: &Path, target: &str, inspection: &PeInspection, o: &DeepOptions) -> DeepDecompilationResult {
    run_deep_decompilation_with(&Tools::from_env(), root, target, inspection, o).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binary::pe::{inspect_portable_executable, samples, StringOptions};

    fn sample() -> PeInspection {
        inspect_portable_executable(&samples::pe64(), &StringOptions::default()).unwrap()
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
        assert!(g.setup.unwrap().starts_with("Install Ghidra and Java 21, set APIM_GHIDRA_HOME in .env.local to the extracted Ghidra directory"));
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
        assert_eq!(r.outputs, [format!("{rel_root}/ghidra/functions.tsv"), format!("{rel_root}/ghidra/summary.txt")]);
        assert!(r.summary.starts_with(&format!("Ghidra decompiled 3 function(s) and produced 2 artifact(s) under {rel_root}/ghidra. Focus terms: CreateMove. Analyzer config: preset fast · off: Decompiler Parameter ID")), "{}", r.summary);
        assert!(r.summary.ends_with("to recover them. "));
        assert!(r.log_tail.unwrap().contains("fake ghidra ran"));
        let again = run_deep_decompilation_with(&tools, &root, "uploads/a.exe", &p, &opts).await;
        assert_eq!((again.status, again.attempted, again.cached), ("complete", false, true));
        assert!(again.summary.starts_with("Reused 2 native decompilation artifact(s) from "));
        std::fs::remove_dir_all(&root).ok();
    }
}

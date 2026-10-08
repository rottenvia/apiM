//! The build_project tool, ported from src/lib/build.ts (finding the project and toolchain,
//! choosing the command) and src/lib/build-diagnostics.ts (reading a failed build). The build
//! itself runs through exec.rs, so it asks for approval the same way run_command does.

use super::exec;
use super::{Ctx, Output, str_arg};
use regex::Regex;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::{Command as Process, Stdio};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// Source files that compile on their own when there is no project file.
const SOURCE_EXTS: &[&str] = &[".c", ".cc", ".cpp", ".cxx", ".c++"];
/// Directories that never hold the project you meant.
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", ".packages", "obj", "bin", "build", "out", "dist", "x64", "x86", "win32", "debug", "release", ".vs", ".vscode", "packages", "target", "venv", "__pycache__",
];
/// How deep discovery looks for a project file.
const MAX_DEPTH: usize = 4;
/// A restore can take a while on the first run.
const RESTORE_LIMIT: Duration = Duration::from_secs(10 * 60);
/// Diagnostic probes (handle.exe, fuser) that take longer than this are treated as unavailable.
const PROBE_LIMIT: Duration = Duration::from_secs(8);
/// The log part of the result is capped here, as the web caps it.
const LOG_CHARS: usize = 60_000;

const CPP_MISSING: &str = "No C/C++ compiler found. On Windows this means vswhere reported no VC++ toolset and cl/clang/g++ are not on PATH — install the \"Desktop development with C++\" workload, or set APIM_CPP_COMPILER to a compiler executable. If Visual Studio IS installed, build a .sln/.vcxproj instead: MSBuild sets up the compiler environment itself, which a bare cl.exe cannot.";
const NOTHING_TO_BUILD: &str = "I could not find anything to build here. Add a Visual Studio solution (.sln), CMakeLists.txt, .csproj, package.json, Cargo.toml, go.mod, Makefile, or a single .cpp/.cs file, then ask again.";
const AV_ADVICE: &str = "This is a scanner, not your code and not a stale handle. Rename the output out of the way and build again — the rename gambit works because a quarantined path is denied while a NEW path is not. If it repeats every build, the real fix is an antivirus exclusion for the output directory, which only the user can add. Do not 'fix' source that compiled cleanly.";
const LOCK_ADVICE: &str = "Something holds a handle on the output file. In order: stop any process this workspace started that is running that binary (list_processes, then stop_process); if nothing owns it, rename the locked file out of the way and build again — on Windows a running image cannot be deleted but CAN be renamed, which is why the rename gambit works when delete is denied.";
const FLAKY_ADVICE: &str = "This is a known-flaky class, not a code error. The same build is run once more automatically; if it fails the same way twice it is real and the second log is the one to read.";

/// Failures known to pass on an immediate second attempt, each with the rule that names it.
static FLAKY: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r"(?i)MSB4166|child node .* exited prematurely", "MSB4166 — an MSBuild worker node died before reporting; this is a node-startup race"),
        (r"(?i)fatal error C1041|cannot open program database|PDB .* is locked", "C1041 — two compiler processes reached the same .pdb at once (parallel build PDB race)"),
        (r"(?i)LNK1318|Unexpected PDB error", "LNK1318 — linker PDB contention, the linker's own flavour of the same race"),
        (r"(?i)MSB3021|MSB3027|Could not copy .* exceeded retry count", "MSB3021/MSB3027 — copy step lost a race with a handle that has since closed"),
        (r"(?i)error MSB6006:.*exited with code 1(\s|$)", "MSB6006 — a tool exited without producing a diagnostic, which is usually a startup race"),
        (r"(?i)The process cannot access the file .*obj\\|Access is denied.*\.tlog", "transient handle on an intermediate (obj/tlog) file"),
    ]
    .into_iter()
    .map(|(p, rule)| (re(p), rule))
    .collect()
});

/// File-lock messages; the first capture group, when there is one, names the locked file.
static LOCK: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)LNK1104: cannot open file '([^']+)'",
        r"(?i)cannot open output file ([^\s:]+): Permission denied",
        r"(?i)The process cannot access the file '([^']+)' because it is being used by another process",
        r#"(?i)Could not copy "[^"]+" to "([^"]+)"\."#,
        r"(?i)EBUSY: resource busy or locked, [a-z]+ '([^']+)'",
        r"(?i)EPERM: operation not permitted, [a-z]+ '([^']+)'",
        r#"(?i)error MSB3027: Could not copy "[^"]+" to "([^"]+)""#,
        r#"(?i)Unable to copy file "[^"]+" to "([^"]+)"\.\s*The process cannot access the file"#,
        r"(?i)()The process cannot access the file because it is being used by another process",
    ]
    .into_iter()
    .map(re)
    .collect()
});

static AV: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)contains a virus or potentially unwanted software|operation did not complete successfully because the file contains|quarantin|Defender|threat was (?:detected|found)"));
static AV_FILE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)([\w.\-\\/]+\.(?:exe|dll|sys|scr))"));
static MISSING: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)is not recognized as an internal or external command|MSB1009|command not found|No such file or directory: '?(cl|link|msbuild|cmake|gcc|g\+\+|dotnet)"));
static OUT_OF_SPACE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)no space left on device|ENOSPC|not enough space"));
static REAL: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\b(error [A-Z]{1,4}\d{3,5}|error:|fatal error)\b"));
static MSG: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^([^\s(][^(]*)\((\d+)(?:,\d+)?\)\s*:\s*(fatal error|error|warning)\s+([A-Z]{1,4}\d{3,5})\s*:\s*(.*)$"));
static MSG_NO_FILE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^(?:.*?:)?\s*(fatal error|error|warning)\s+([A-Z]{1,4}\d{3,5})\s*:\s*(.*)$"));
static GCC: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^([^\s:][^:]*):(\d+):(?:\d+:)?\s*(error|warning):\s*(.*)$"));
static LINKED: LazyLock<Regex> = LazyLock::new(|| re(r"->\s+([A-Za-z]:\\[^\s]+|/[^\s]+)$"));
static PID: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\b(?:pid:?\s*)?(\d{2,7})\b"));
static BINARY: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\.(exe|dll|sys|scr)$"));
/// Project files by rank: a solution beats a project at the same depth.
static PROJECT_RANK: LazyLock<Vec<(Regex, &'static str, usize)>> = LazyLock::new(|| {
    [(r"(?i)\.slnx?$", "msbuild", 0), (r"(?i)\.vcxproj$", "msbuild", 1), (r"(?i)\.csproj$", "csproj", 2), (r"(?i)\.fsproj$", "dotnet", 2), (r"(?i)^CMakeLists\.txt$", "cmake", 3)]
        .into_iter()
        .map(|(p, kind, rank)| (re(p), kind, rank))
        .collect()
});

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("build pattern is valid")
}

fn sv(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn or<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.is_empty() { fallback } else { value }
}

fn code_text(code: Option<i32>) -> String {
    code.map_or("?".to_string(), |c| c.to_string())
}

fn timed(timed_out: bool) -> &'static str {
    if timed_out { ", timed out" } else { "" }
}

/// The command line as a log shows it: program then arguments, unquoted.
fn join(command: &str, args: &[String]) -> String {
    std::iter::once(command).chain(args.iter().map(String::as_str)).collect::<Vec<_>>().join(" ")
}

// ---------------------------------------------------------------- discovery

/// The names in a directory, sorted so that "first match" means the same on every run.
fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir).into_iter().flatten().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

/// The first entry matching a name (case-insensitive) or a `*.ext` suffix, in the order given.
fn find_ci(names: &[&str], entries: &[String]) -> Option<String> {
    names.iter().find_map(|n| match n.strip_prefix('*') {
        Some(suffix) => entries.iter().find(|e| e.to_ascii_lowercase().ends_with(&suffix.to_ascii_lowercase())).cloned(),
        None => entries.iter().find(|e| e.eq_ignore_ascii_case(n)).cloned(),
    })
}

fn is_source(name: &str) -> bool {
    Path::new(name).extension().is_some_and(|x| SOURCE_EXTS.contains(&format!(".{}", x.to_string_lossy().to_lowercase()).as_str()))
}

/// Breadth-first search for a project file, shallowest first. Returns (kind, path, directories visited).
fn find_project_file(root: &Path) -> Option<(&'static str, String, usize)> {
    let mut best: Option<(usize, &'static str, String)> = None;
    let mut visited = 0;
    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
    while let Some((dir, depth)) = queue.pop_front() {
        visited += 1;
        let names = entries(&dir);
        for name in &names {
            for (re, kind, rank) in PROJECT_RANK.iter() {
                // Depth dominates rank: a solution three levels down loses to a vcxproj beside it.
                let score = depth * 10 + *rank;
                if re.is_match(name) && best.as_ref().is_none_or(|b| score < b.0) {
                    let rel = dir.join(name).strip_prefix(root).map_or_else(|_| name.clone(), |p| p.display().to_string());
                    best = Some((score, *kind, rel));
                }
            }
        }
        if depth >= MAX_DEPTH {
            continue;
        }
        for name in names.iter().filter(|n| !SKIP_DIRS.contains(&n.to_ascii_lowercase().as_str())) {
            let child = dir.join(name);
            if child.is_dir() {
                queue.push_back((child, depth + 1));
            }
        }
    }
    best.map(|(_, kind, rel)| (kind, rel, visited))
}

#[derive(Debug, Clone, PartialEq)]
struct Target {
    /// msbuild, csproj, dotnet, cmake, npm, cargo, go, make, python, single-cpp, single-cs or none.
    kind: &'static str,
    path: String,
    /// Where discovery looked, so a miss can be argued with.
    searched: Option<String>,
}

fn detect_target(root: &Path) -> Target {
    let names = entries(root);
    let ends = |ext: &str| names.iter().find(|e| e.to_ascii_lowercase().ends_with(ext)).cloned();
    let found = |kind: &'static str, path: &str| Target { kind, path: path.to_string(), searched: None };
    // Most specific first: solution or project files drive everything.
    if let Some(sln) = find_ci(&["*.sln"], &names) {
        return found("msbuild", &sln);
    }
    if let Some(vcx) = ends(".vcxproj") {
        return found("msbuild", &vcx);
    }
    if let Some(cs) = ends(".csproj") {
        return found("csproj", &cs);
    }
    if let Some(fs) = ends(".fsproj") {
        return found("dotnet", &fs);
    }
    if find_ci(&["CMakeLists.txt"], &names).is_some() {
        return found("cmake", "CMakeLists.txt");
    }
    if find_ci(&["package.json"], &names).is_some() {
        return found("npm", "package.json");
    }
    if find_ci(&["Cargo.toml"], &names).is_some() {
        return found("cargo", "Cargo.toml");
    }
    if find_ci(&["go.mod"], &names).is_some() {
        return found("go", "go.mod");
    }
    if find_ci(&["Makefile", "makefile", "GNUmakefile"], &names).is_some() {
        return found("make", "Makefile");
    }
    if find_ci(&["pyproject.toml", "setup.py"], &names).is_some() {
        return found("python", "pyproject.toml");
    }
    // Nothing at the root: look deeper before falling back to loose sources.
    if let Some((kind, path, visited)) = find_project_file(root) {
        return Target { kind, path, searched: Some(format!("{visited} directories")) };
    }
    if let Some(cpp) = names.iter().find(|e| is_source(e)) {
        return found("single-cpp", cpp);
    }
    if let Some(cs) = names.iter().find(|e| e.to_ascii_lowercase().ends_with(".cs")) {
        return found("single-cs", cs);
    }
    found("none", "")
}

/// The kind of a project named explicitly, by its extension.
fn kind_of_name(named: &str) -> &'static str {
    let n = named.to_ascii_lowercase();
    if n.ends_with(".sln") || n.ends_with(".slnx") || n.ends_with(".vcxproj") {
        "msbuild"
    } else if n.ends_with(".csproj") {
        "csproj"
    } else if n.ends_with(".fsproj") {
        "dotnet"
    } else if n.ends_with("cmakelists.txt") {
        "cmake"
    } else if [".c", ".cc", ".cpp", ".cxx"].iter().any(|e| n.ends_with(e)) {
        "single-cpp"
    } else if n.ends_with(".cs") {
        "single-cs"
    } else {
        "none"
    }
}

// ---------------------------------------------------------------- toolchain

/// A toolchain program a plan may need. Discovery answers each one at most once per build.
#[derive(Debug, Clone, Copy)]
enum Tool {
    MSBuild,
    Cpp,
    CSharp,
}

fn env_path(key: &str) -> Option<String> {
    std::env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Visual Studio's locator, if it is installed.
fn vswhere() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let root = env_path("ProgramFiles(x86)").or_else(|| env_path("ProgramFiles")).unwrap_or_else(|| r"C:\Program Files (x86)".to_string());
    let p = Path::new(&root).join(r"Microsoft Visual Studio\Installer\vswhere.exe");
    p.exists().then_some(p)
}

/// Runs a discovery command and returns its stdout, or None when it cannot start. No approval: this is the tool's own lookup.
fn probe(cmd: &str, args: &[&str]) -> Option<String> {
    let mut c = Process::new(cmd);
    c.args(args).stdin(Stdio::null());
    exec::hide_window_std(&mut c);
    c.output().ok().map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
}

/// Like probe, but gives up after PROBE_LIMIT (the process is killed) and reports stdout and stderr together.
fn probe_limited(cmd: &str, args: &[&str]) -> Option<String> {
    let mut c = Process::new(cmd);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    exec::hide_window_std(&mut c);
    let child = c.spawn().ok()?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(PROBE_LIMIT) {
        Ok(Ok(out)) if out.status.code().is_some() => Some(format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))),
        Ok(_) => None,
        Err(_) => {
            exec::kill_tree(pid);
            None
        }
    }
}

/// Is this program on PATH right now?
fn on_path(command: &str) -> bool {
    let mut c = Process::new(if cfg!(windows) { "where" } else { "which" });
    c.arg(command).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    exec::hide_window_std(&mut c);
    c.status().is_ok_and(|s| s.success())
}

/// MSBuild.exe from an installed Visual Studio, else the bare name for PATH to resolve.
fn find_msbuild() -> String {
    if let Some(p) = env_path("APIM_MSBUILD_PATH").filter(|p| Path::new(p).exists()) {
        return p;
    }
    if cfg!(windows) {
        if let Some(vswhere) = vswhere() {
            let vswhere = vswhere.to_string_lossy().into_owned();
            for extra in [&["-latest", "-prerelease"][..], &["-latest"][..], &["-prerelease"][..]] {
                let mut args: Vec<&str> = extra.to_vec();
                args.extend(["-find", r"MSBuild\**\Bin\MSBuild.exe"]);
                let Some(out) = probe(&vswhere, &args) else { continue };
                let mut found: Vec<&str> = out.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
                // Prefer the 64-bit host when the install ships both.
                found.sort_by_key(|l| !l.contains("amd64"));
                if let Some(hit) = found.into_iter().find(|l| Path::new(l).exists()) {
                    return hit.to_string();
                }
            }
        }
        // vswhere can be missing; the standard install roots still hold MSBuild.
        for root in ["ProgramFiles", "ProgramFiles(x86)"].into_iter().filter_map(env_path) {
            let vs = Path::new(&root).join("Microsoft Visual Studio");
            for year in entries(&vs).iter().rev() {
                for edition in entries(&vs.join(year)) {
                    for bin in [r"MSBuild\Current\Bin\amd64\MSBuild.exe", r"MSBuild\Current\Bin\MSBuild.exe"] {
                        let p = vs.join(year).join(&edition).join(bin);
                        if p.exists() {
                            return p.display().to_string();
                        }
                    }
                }
            }
        }
    }
    "msbuild".to_string()
}

/// cl.exe from Visual Studio, by its full path: bare `cl` only works in a Developer Command Prompt.
fn find_cl() -> Option<String> {
    let vswhere = vswhere()?;
    let out = probe(&vswhere.to_string_lossy(), &["-latest", "-prerelease", "-find", r"VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe"])?;
    let mut found: Vec<&str> = out.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    found.sort();
    found.reverse();
    found.into_iter().find(|l| Path::new(l).exists()).map(str::to_string)
}

fn find_cpp() -> Option<String> {
    if let Some(explicit) = env_path("APIM_CPP_COMPILER") {
        return Some(explicit);
    }
    if cfg!(windows) {
        if let Some(cl) = find_cl() {
            return Some(cl);
        }
        return ["cl", "clang-cl", "clang++", "g++"].into_iter().find(|c| on_path(c)).map(str::to_string);
    }
    Some(["clang++", "clang", "g++", "cc", "c++"].into_iter().find(|c| on_path(c)).unwrap_or("c++").to_string())
}

/// csc.exe from the .NET Framework when it is there, else the bare name.
fn find_csharp() -> String {
    if let Some(p) = env_path("APIM_CSC_PATH").filter(|p| Path::new(p).exists()) {
        return p;
    }
    if cfg!(windows) {
        let windir = env_path("WINDIR").unwrap_or_else(|| r"C:\Windows".to_string());
        let fw = Path::new(&windir).join(r"Microsoft.NET\Framework64\v4.0.30319\csc.exe");
        if fw.exists() {
            return fw.display().to_string();
        }
    }
    "csc".to_string()
}

/// Absolute toolchain paths discovery has returned, lowercased. A build may run these by full path; nothing else outside the workspace may run.
static FOUND: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn discover(tool: Tool) -> Option<String> {
    let found = match tool {
        Tool::MSBuild => Some(find_msbuild()),
        Tool::Cpp => find_cpp(),
        Tool::CSharp => Some(find_csharp()),
    };
    if let Some(p) = found.as_ref().filter(|p| Path::new(p).is_absolute()) {
        let mut known = FOUND.lock().unwrap();
        if !known.contains(&p.to_ascii_lowercase()) {
            known.push(p.to_ascii_lowercase());
        }
    }
    found
}

/// Is this a toolchain path discovery found, so a command may run it by its full path?
pub(super) fn is_toolchain(program: &Path) -> bool {
    FOUND.lock().unwrap().contains(&program.display().to_string().to_ascii_lowercase())
}

// ---------------------------------------------------------------- plan

/// The settings a build call resolves to, before discovery.
#[derive(Debug, Clone)]
struct Options {
    /// "Debug" selects Debug; anything else is Release.
    config: String,
    /// Empty means x64.
    platform: String,
    restore: bool,
    extra: Vec<String>,
    /// Solution or project to build, workspace-relative. Empty means discover.
    project: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct Runner {
    name: String,
    command: String,
    args: Vec<String>,
    reason: String,
}

#[derive(Debug, Clone, PartialEq)]
struct Plan {
    target: Target,
    runner: Runner,
    /// Runs first when present (NuGet restore for MSBuild).
    restore: Option<Runner>,
}

/// The build the workspace needs, or the setup message when nothing can build it. `find` answers toolchain lookups.
fn plan(root: &Path, opts: &Options, find: impl Fn(Tool) -> Option<String>) -> Result<Plan, String> {
    let config: &str = if opts.config == "Debug" { "Debug" } else { "Release" };
    let platform: &str = match opts.platform.trim() {
        "" => "x64",
        p => p,
    };
    // An explicit project beats any amount of discovery: the model may already know the answer.
    let named = opts.project.as_deref().map(str::trim).unwrap_or("");
    let target = if named.is_empty() {
        detect_target(root)
    } else {
        Target { kind: kind_of_name(named), path: named.to_string(), searched: Some("named explicitly".to_string()) }
    };
    if !named.is_empty() && target.kind == "none" {
        return Err(format!("\"{named}\" is not something this can build. Pass a .sln, .vcxproj, .csproj, CMakeLists.txt, or a single .cpp/.cs file — or omit project and let discovery find it."));
    }
    let extra = &opts.extra;
    let with = |mut args: Vec<String>| -> Vec<String> {
        args.extend(extra.iter().cloned());
        args
    };
    let path = target.path.as_str();
    let mut restore = None;
    let runner = match target.kind {
        "msbuild" => {
            let Some(ms) = find(Tool::MSBuild) else {
                return Err("Visual Studio MSBuild was not found. Install Visual Studio (with the C++/.NET desktop workload) or set APIM_MSBUILD_PATH to MSBuild.exe.".to_string());
            };
            if opts.restore {
                restore = Some(Runner { name: "NuGet restore".into(), command: ms.clone(), args: sv(&[path, "/t:Restore", "/nologo", "/v:minimal"]), reason: "Restoring NuGet packages before the build.".into() });
            }
            let mut args = sv(&[path, "/m", "/nologo", "/v:minimal"]);
            args.push(format!("/p:Configuration={config}"));
            args.push(format!("/p:Platform={platform}"));
            args.push("/nr:false".into());
            Runner { name: format!("MSBuild {config} {platform}"), command: ms, args: with(args), reason: format!("Found {path} in the workspace; MSBuild drives the VS solution/project.") }
        }
        "csproj" | "dotnet" => {
            let mut args = sv(&["build", path, "-c", config]);
            args.push(format!("-p:Platform={platform}"));
            Runner { name: format!("dotnet build {config}"), command: "dotnet".into(), args: with(args), reason: format!("Found {path}; the .NET SDK builds and restores it.") }
        }
        "cmake" => Runner {
            name: format!("CMake + native build ({config})"),
            command: "cmake".into(),
            args: with(sv(&["--build", "build", "--config", config, "--parallel"])),
            reason: "Found CMakeLists.txt. Configures into build/ if needed, then builds with the native generator (MSBuild on VS, make/ninja elsewhere).".into(),
        },
        "npm" => Runner { name: "npm run build".into(), command: if cfg!(windows) { "npm.cmd" } else { "npm" }.into(), args: with(sv(&["run", "build"])), reason: "Found package.json with a build script.".into() },
        "cargo" => {
            let release = config == "Release";
            let mut args = sv(&["build"]);
            if release {
                args.push("--release".into());
            }
            Runner { name: if release { "cargo build --release" } else { "cargo build" }.into(), command: "cargo".into(), args: with(args), reason: "Found Cargo.toml.".into() }
        }
        "go" => Runner { name: "go build".into(), command: "go".into(), args: with(sv(&["build", "./..."])), reason: "Found go.mod.".into() },
        "make" => Runner { name: "make".into(), command: "make".into(), args: with(Vec::new()), reason: "Found a Makefile.".into() },
        "python" => Runner {
            name: "python build".into(),
            command: if cfg!(windows) { "python" } else { "python3" }.into(),
            args: with(sv(&["-m", "pip", "install", "--no-build-isolation", "-e", "."])),
            reason: "Found a Python project; builds/installs it in the workspace venv.".into(),
        },
        "single-cpp" => {
            let Some(cc) = find(Tool::Cpp) else { return Err(CPP_MISSING.to_string()) };
            let args = if cfg!(windows) { with(sv(&["/EHsc", "/O2", "/std:c++17", path, "/Fe:out.exe"])) } else { with(sv(&["-O2", "-std=c++17", path, "-o", "out"])) };
            Runner { name: format!("compile {path} ({cc})"), command: cc, args, reason: "No project file found; compiling the single C/C++ source directly. Use a .sln/.vcxproj/CMakeLists.txt for anything multi-file.".into() }
        }
        "single-cs" => {
            let Some(csc) = find(Tool::CSharp) else { return Err("No C# compiler (csc.exe) found. Install the .NET Framework/SDK or set APIM_CSC_PATH.".to_string()) };
            Runner { name: format!("compile {path} (csc)"), command: csc, args: with(sv(&["/nologo", "/optimize", "/out:out.exe", "*.cs"])), reason: "No .csproj found; compiling all .cs files in the workspace root with csc.".into() }
        }
        _ => return Err(NOTHING_TO_BUILD.to_string()),
    };
    Ok(Plan { target, runner, restore })
}

// ---------------------------------------------------------------- failure reading

/// How a failed build is classified: the rule that fired, whether a retry can help, and what to do.
#[derive(Debug, Clone, PartialEq)]
struct Diagnosis {
    kind: &'static str,
    retryable: bool,
    locked_file: Option<String>,
    rule: String,
    advice: &'static str,
}

/// Real compiler diagnostics, ignoring the lines a lock or a race rule already explains.
/// Without this, a flaky build would read as a compile error, since LNK1104 and C1041 both say "fatal error".
fn has_real_diagnostic(text: &str) -> bool {
    let remaining: Vec<&str> = text.lines().filter(|l| !LOCK.iter().any(|p| p.is_match(l)) && !FLAKY.iter().any(|(p, _)| p.is_match(l))).collect();
    REAL.is_match(&remaining.join("\n"))
}

/// Classifies one build's output. Environment first, then real source errors, then locks, then the known-flaky classes.
fn diagnose(output: &str) -> Diagnosis {
    let plain = |kind: &'static str, rule: &str, advice: &'static str| Diagnosis { kind, retryable: false, locked_file: None, rule: rule.to_string(), advice };
    if OUT_OF_SPACE.is_match(output) {
        return plain("out_of_space", "the disk is full", "Free space before building again — a retry cannot help.");
    }
    if MISSING.is_match(output) {
        return plain("missing_toolchain", "the toolchain itself was not found", "The compiler or project file could not be located. Check the path and the install rather than rebuilding.");
    }
    // A genuine source error outranks every "this is just flaky" rule: a retry would only repeat it.
    if has_real_diagnostic(output) {
        return plain("compile_error", "real compiler diagnostics", "Fix the errors in the source. A retry would produce the identical failure and cost a round.");
    }
    if AV.is_match(output) {
        let file = AV_FILE.captures(output).map(|c| c[1].to_string());
        return Diagnosis { kind: "av_quarantine", retryable: false, locked_file: file, rule: "the toolchain reported an antivirus/EDR interception by name".to_string(), advice: AV_ADVICE };
    }
    for re in LOCK.iter() {
        if let Some(c) = re.captures(output) {
            let file = c.get(1).map(|m| m.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
            let shown: String = c[0].chars().take(120).collect();
            // Not retryable: a held handle refuses the second attempt too.
            return Diagnosis { kind: "locked_file", retryable: false, locked_file: file, rule: format!("file lock — {shown}"), advice: LOCK_ADVICE };
        }
    }
    for (re, rule) in FLAKY.iter() {
        if re.is_match(output) {
            return Diagnosis { kind: "flaky_race", retryable: true, locked_file: None, rule: rule.to_string(), advice: FLAKY_ADVICE };
        }
    }
    plain("unknown", "no recognised failure signature", "Read the log below; nothing here matches a known pattern.")
}

/// Who holds the file: processes this workspace started first (stoppable), then whatever the OS tools name.
struct Holder {
    source: &'static str,
    pid: Option<u32>,
    detail: String,
    process_id: Option<String>,
}

/// Returns (holders, probes that ran, probes that could not run).
fn file_holders(ctx: &Ctx, file: &str) -> (Vec<Holder>, Vec<String>, Vec<String>) {
    let base = Path::new(file).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut holders = Vec::new();
    let mut probed = vec!["workspace processes".to_string()];
    let mut unavailable = Vec::new();
    for p in ctx.procs.list_for(&ctx.state_dir).into_iter().filter(|p| p.exit.is_none()) {
        if p.display.to_lowercase().contains(&base) {
            holders.push(Holder { source: "workspace process", pid: Some(p.pid), detail: format!("{} (started by this workspace)", p.display), process_id: Some(p.id) });
        }
    }
    let handle = env_path("APIM_HANDLE_PATH").unwrap_or_else(|| "handle.exe".to_string());
    let attempts: Vec<(&'static str, String, Vec<&str>)> = if cfg!(windows) {
        vec![("handle.exe", handle, vec!["-nobanner", "-accepteula", file]), ("openfiles", "openfiles".to_string(), vec!["/query", "/fo", "csv"])]
    } else {
        vec![("fuser", "fuser".to_string(), vec!["-v", file]), ("lsof", "lsof".to_string(), vec!["--", file])]
    };
    for (name, cmd, args) in attempts {
        let Some(text) = probe_limited(&cmd, &args) else {
            unavailable.push(name.to_string());
            continue;
        };
        probed.push(name.to_string());
        for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
            if !line.to_lowercase().contains(&base) && name != "fuser" {
                continue;
            }
            let pid = PID.captures(line).and_then(|c| c[1].parse().ok());
            holders.push(Holder { source: name, pid, detail: line.chars().take(200).collect(), process_id: None });
        }
        // One successful OS probe is enough.
        if holders.iter().any(|h| h.source == name) {
            break;
        }
    }
    (holders, probed, unavailable)
}

/// The lock section of a build report: who holds the file, and what to do about it.
fn lock_report(ctx: &Ctx, file: &str) -> String {
    let (holders, probed, unavailable) = file_holders(ctx, file);
    let mut lines = vec![format!("Locked file: {file}")];
    if holders.is_empty() {
        // No holder for a freshly built binary is the antivirus signature, not a shrug.
        let unavailable = if unavailable.is_empty() { String::new() } else { format!("; unavailable: {}", unavailable.join(", ")) };
        lines.push(format!("No holder identified (probed: {}{unavailable}).", probed.join(", ")));
        if BINARY.is_match(file) {
            lines.push("Access denied on a freshly built binary that NO process holds is the antivirus/EDR signature — the scanner grabs the artefact between the linker closing it and the next build opening it, so it never appears in a handle list.".to_string());
            lines.push(AV_ADVICE.to_string());
        } else {
            lines.push("\"No owning process\" does not mean the lock is imaginary — a handle can outlive its process briefly, and antivirus and indexers hold files without appearing here. Rename the file out of the way and rebuild: a running image refuses delete but allows rename.".to_string());
        }
        return lines.join("\n");
    }
    lines.push("Holders:".to_string());
    for h in holders.iter().take(10) {
        let pid = h.pid.filter(|p| *p != 0).map(|p| format!(" [pid {p}]")).unwrap_or_default();
        let stop = h.process_id.as_ref().map(|id| format!(" — stop it with stop_process id=\"{id}\"")).unwrap_or_default();
        lines.push(format!("  - {}{pid}{stop}", h.detail));
    }
    if holders.iter().any(|h| h.process_id.is_some()) {
        lines.push("Stop the workspace process above and build again; that releases the handle without touching the file.".to_string());
    } else {
        lines.push("None of these were started by this workspace, so rename the locked file out of the way and rebuild.".to_string());
    }
    lines.join("\n")
}

/// One distinct diagnostic line, deduplicated on code and text.
#[derive(Debug, Clone, PartialEq)]
struct Message {
    /// "C2065", "MSB3021", "CS0103"; empty for compilers that print none.
    code: String,
    /// Basename of the first place it appeared.
    file: String,
    line: Option<u64>,
    text: String,
    count: usize,
}

#[derive(Debug, Default, PartialEq)]
struct Digest {
    errors: Vec<Message>,
    warnings: Vec<Message>,
    /// Linked outputs with their size, or None when the file is not where the log said.
    artifacts: Vec<(String, Option<u64>)>,
    log_lines: usize,
}

/// One diagnostic line, whichever compiler wrote it: (kind, code, file, line, text).
fn parse_diagnostic(line: &str) -> Option<(String, String, String, Option<u64>, String)> {
    if let Some(c) = MSG.captures(line) {
        return Some((c[3].to_lowercase(), c[4].to_string(), c[1].trim().to_string(), c[2].parse().ok(), c[5].trim().to_string()));
    }
    if let Some(c) = GCC.captures(line) {
        return Some((c[3].to_lowercase(), String::new(), c[1].trim().to_string(), c[2].parse().ok(), c[4].trim().to_string()));
    }
    let c = MSG_NO_FILE.captures(line)?;
    Some((c[1].to_lowercase(), c[2].to_string(), String::new(), None, c[3].trim().to_string()))
}

/// Counts and deduplicates a log: unique errors and warnings with their first location, plus linked outputs.
fn digest(output: &str) -> Digest {
    let lines: Vec<&str> = output.split('\n').collect();
    let mut d = Digest { log_lines: lines.len(), ..Default::default() };
    let (mut error_index, mut warning_index): (HashMap<String, usize>, HashMap<String, usize>) = (HashMap::new(), HashMap::new());
    for raw in &lines {
        let line = raw.trim_end();
        if let Some(c) = LINKED.captures(line) {
            let path = c[1].to_string();
            if !d.artifacts.iter().any(|(p, _)| *p == path) {
                let bytes = std::fs::metadata(&path).ok().map(|m| m.len());
                d.artifacts.push((path, bytes));
            }
        }
        let Some((kind, code, file, line_no, text)) = parse_diagnostic(line) else { continue };
        let key = format!("{code}|{text}");
        let (bucket, index) = if kind.contains("error") { (&mut d.errors, &mut error_index) } else { (&mut d.warnings, &mut warning_index) };
        match index.get(&key) {
            Some(&i) => bucket[i].count += 1,
            None => {
                index.insert(key, bucket.len());
                let file = if file.is_empty() { String::new() } else { file.replace('\\', "/").rsplit('/').next().unwrap_or_default().to_string() };
                bucket.push(Message { code, file, line: line_no, text, count: 1 });
            }
        }
    }
    d
}

/// 12345 becomes "12,345", as toLocaleString does in en-US.
pub(super) fn group(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn location(m: &Message) -> String {
    match (m.file.is_empty(), m.line) {
        (true, _) => String::new(),
        (false, Some(n)) if n != 0 => format!(" {}:{n}", m.file),
        _ => format!(" {}", m.file),
    }
}

fn message_line(m: &Message, fallback: &str) -> String {
    let code = if m.code.is_empty() { fallback } else { m.code.as_str() };
    let count = if m.count > 1 { format!("  (x{})", m.count) } else { String::new() };
    format!("  {code}{}: {}{count}", location(m), m.text)
}

/// The digest shown above the log: counts, unique errors and warnings, linked outputs. The log itself is never replaced.
fn format_digest(d: &Digest, exit: Option<i32>, took_ms: u64) -> String {
    let took = if took_ms > 0 { format!(", {:.1}s", took_ms as f64 / 1000.0) } else { String::new() };
    let mut out = vec![format!("DIGEST — exit {}{took}, {} distinct error(s), {} distinct warning(s), {} log line(s).", code_text(exit), d.errors.len(), d.warnings.len(), d.log_lines)];
    if !d.errors.is_empty() {
        out.push(String::new());
        out.push("Errors:".to_string());
        out.extend(d.errors.iter().take(20).map(|m| message_line(m, "error")));
        if d.errors.len() > 20 {
            out.push(format!("  … {} more, in the log below.", d.errors.len() - 20));
        }
    }
    if !d.warnings.is_empty() {
        out.push(String::new());
        out.push("Warnings (unique, first sighting):".to_string());
        out.extend(d.warnings.iter().take(15).map(|m| message_line(m, "warning")));
        if d.warnings.len() > 15 {
            out.push(format!("  … {} more, in the log below.", d.warnings.len() - 15));
        }
    }
    if !d.artifacts.is_empty() {
        out.push(String::new());
        out.push("Linked:".to_string());
        for (path, bytes) in d.artifacts.iter().take(10) {
            out.push(match bytes {
                None => format!("  {path} (size unknown — the file is not where the log said)"),
                Some(b) => format!("  {path} — {} bytes", group(*b)),
            });
        }
    }
    out.join("\n")
}

// ---------------------------------------------------------------- the tool

/// The build_project tool: plan, optional restore, the build, then a verdict with the digest and the log.
pub async fn build_project(ctx: &Ctx, args: &Value) -> Output {
    let opts = Options {
        config: str_arg(args, "config").to_string(),
        platform: str_arg(args, "platform").to_string(),
        restore: args["restore"].as_bool() != Some(false),
        extra: args["extra_args"].as_array().map(|a| a.iter().map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string)).collect()).unwrap_or_default(),
        project: Some(str_arg(args, "project").to_string()),
    };
    let dry_run = args["dry_run"].as_bool() == Some(true);
    let no_retry = args["no_retry"].as_bool() == Some(true);
    let planned = match tokio::task::block_in_place(|| plan(&ctx.root, &opts, discover)) {
        Ok(p) => p,
        Err(e) => return Output { ok: false, text: e, summary: "No buildable project found".into(), ..Default::default() },
    };
    let runner = &planned.runner;
    let target = &planned.target;
    let argv = join(&runner.command, &runner.args);
    if dry_run {
        let searched = target.searched.as_ref().map(|s| format!(" (found by searching {s})")).unwrap_or_default();
        let restore_line = planned.restore.as_ref().map(|r| format!("\n\nRestore first: {}", join(&r.command, &r.args))).unwrap_or_default();
        let text = format!("Would build {} using {}{searched}.\n\nCommand: {argv}\n\nReason: {}{restore_line}", or(&target.path, "the workspace"), runner.name, runner.reason);
        return Output { ok: true, text, summary: format!("Build plan: {}", runner.name), ..Default::default() };
    }

    let mut logs: Vec<String> = Vec::new();
    if let Some(r) = &planned.restore {
        let ran = match exec::execute(ctx, &r.command, r.args.clone(), "Restore packages before the build", Some(RESTORE_LIMIT)).await {
            Ok(ran) => ran,
            Err(refused) => return refused,
        };
        logs.push(format!("$ {}\n[exit {}{}]\n{}", join(&r.command, &r.args), code_text(ran.code), timed(ran.timed_out), ran.out));
        if ran.code != Some(0) {
            return Output { ok: false, text: format!("Dependency restore failed (exit {}) before the build:\n\n{}\n\nFix the error above and rebuild.", code_text(ran.code), logs[0]), summary: "Restore failed".into(), ..Default::default() };
        }
    }

    let mut run = match exec::execute(ctx, &runner.command, runner.args.clone(), "Build the project", None).await {
        Ok(ran) => ran,
        Err(refused) => return refused,
    };
    let mut diagnosis = (run.code != Some(0)).then(|| diagnose(&run.out));
    let mut retry_note = String::new();
    // Only a known-flaky class is rebuilt once; a real compile error is never retried.
    if !no_retry && diagnosis.as_ref().is_some_and(|d| d.retryable) {
        let first = run;
        let first_rule = diagnosis.as_ref().map(|d| d.rule.clone()).unwrap_or_default();
        run = match exec::execute(ctx, &runner.command, runner.args.clone(), "Build the project", None).await {
            Ok(ran) => ran,
            Err(refused) => return refused,
        };
        diagnosis = (run.code != Some(0)).then(|| diagnose(&run.out));
        retry_note = format!(
            "\n\nAUTOMATIC RETRY — the first attempt failed on a known-flaky class: {} / {first_rule}. {}",
            code_text(first.code),
            if run.code == Some(0) { "The second attempt succeeded, so the first failure was the race and not your code. Nothing to fix." } else { "The second attempt failed too, so this is REAL — read the log below and fix it rather than building again." }
        );
    }

    let mut combined = String::new();
    for log in &logs {
        combined.push_str(log);
        combined.push_str("\n\n");
    }
    combined.push_str(&format!("$ {argv}\n[exit {}{}]\n{}", code_text(run.code), timed(run.timed_out), run.out));

    let lock = match diagnosis.as_ref().filter(|d| d.kind == "locked_file").and_then(|d| d.locked_file.clone()) {
        Some(file) => format!("\n\n{}", tokio::task::block_in_place(|| lock_report(ctx, &file))),
        None => String::new(),
    };
    let verdict = match &diagnosis {
        Some(d) => format!("Build FAILED (exit {}) — {}.\n{}", code_text(run.code), d.rule, d.advice),
        None => format!("Build succeeded: {}.", runner.name),
    };
    let digest_text = format_digest(&digest(&combined), run.code, run.took.as_millis() as u64);
    // The 60,000-character cap covers only the last part, as the web's slice does.
    let tail: String = format!("Command: {argv}\n\n{combined}").chars().take(LOG_CHARS).collect();
    let searched = target.searched.as_ref().map(|s| format!(" [found by searching {s}]")).unwrap_or_default();
    let text = format!("{verdict}{retry_note}{lock}\n\n{digest_text}\n\nTarget: {}{searched}\nToolchain: {}\n{tail}", or(&target.path, "(workspace)"), runner.command);
    let subject = or(&target.path, "workspace");
    let summary = if run.code == Some(0) {
        if retry_note.is_empty() { format!("Built {subject} ({})", runner.name) } else { format!("Built {subject} ({}, after 1 retry)", runner.name) }
    } else {
        format!("Build failed: {} ({})", diagnosis.as_ref().map_or("unknown", |d| d.kind).replacen('_', " ", 1), runner.name)
    };
    // A failed compile is a successful tool call: the true result came back, and a retry would repeat it.
    Output { ok: true, text, summary, ..Default::default() }
}

#[cfg(test)]
impl Plan {
    /// The plan in the shape the recorded web results use.
    fn json(&self) -> Value {
        let runner = |r: &Runner| serde_json::json!({ "name": r.name, "command": r.command, "args": r.args, "reason": r.reason });
        let mut target = serde_json::json!({ "kind": self.target.kind, "path": self.target.path });
        if let Some(s) = &self.target.searched {
            target["searched"] = Value::String(s.clone());
        }
        let mut v = serde_json::json!({ "target": target, "runner": runner(&self.runner) });
        if let Some(r) = &self.restore {
            v["restore"] = runner(r);
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures() -> Value {
        serde_json::from_str(include_str!("build_fixtures.json")).expect("fixtures parse")
    }

    #[test]
    fn diagnosis_matches_the_web() {
        for case in fixtures()["diagnose"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let d = diagnose(case["input"].as_str().unwrap());
            let want = &case["expect"];
            assert_eq!(d.kind, want["kind"].as_str().unwrap(), "{name}");
            assert_eq!(d.retryable, want["retryable"].as_bool().unwrap(), "{name}");
            assert_eq!(d.locked_file.as_deref(), want["lockedFile"].as_str(), "{name}");
            assert_eq!(d.rule, want["rule"].as_str().unwrap(), "{name}");
            assert_eq!(d.advice, want["advice"].as_str().unwrap(), "{name}");
        }
    }

    #[test]
    fn digest_matches_the_web() {
        for case in fixtures()["diagnose"].as_array().unwrap() {
            let text = format_digest(&digest(case["input"].as_str().unwrap()), Some(1), 2500);
            assert_eq!(text, case["digest"].as_str().unwrap(), "{}", case["name"]);
        }
        for v in fixtures()["variants"].as_array().unwrap() {
            let text = format_digest(&digest(v["input"].as_str().unwrap()), v["exit"].as_i64().map(|c| c as i32), v["durationMs"].as_u64().unwrap());
            assert_eq!(text, v["digest"].as_str().unwrap(), "{}", v["name"]);
        }
    }

    #[test]
    fn plans_match_the_web() {
        for case in fixtures()["plan"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let dir = std::env::temp_dir().join(format!("apim-build-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            for f in case["files"].as_array().unwrap() {
                let p = dir.join(f.as_str().unwrap());
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::fs::write(&p, "").unwrap();
            }
            let opt = &case["options"];
            let opts = Options {
                config: opt["config"].as_str().unwrap_or("Release").to_string(),
                platform: opt["platform"].as_str().unwrap_or("").to_string(),
                restore: opt["restore"].as_bool() != Some(false),
                extra: opt["extraArgs"].as_array().map(|a| a.iter().map(|v| v.as_str().unwrap().to_string()).collect()).unwrap_or_default(),
                project: opt["project"].as_str().map(str::to_string),
            };
            let tc = &case["toolchain"];
            let got = plan(&dir, &opts, |t| {
                let key = match t {
                    Tool::MSBuild => "msbuild",
                    Tool::Cpp => "cpp",
                    Tool::CSharp => "csc",
                };
                tc[key].as_str().map(str::to_string)
            });
            let want = &case["expect"];
            match got {
                Ok(p) => assert_eq!(p.json(), *want, "{name}"),
                Err(e) => assert_eq!(want["error"].as_str(), Some(e.as_str()), "{name}"),
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn numbers_read_like_locale_output() {
        assert_eq!(group(0), "0");
        assert_eq!(group(12345), "12,345");
        assert_eq!(group(1234567), "1,234,567");
    }

    #[test]
    fn named_project_kinds() {
        assert_eq!(kind_of_name("app/nightfall.sln"), "msbuild");
        assert_eq!(kind_of_name("x/tool.CSPROJ"), "csproj");
        assert_eq!(kind_of_name("src/CMakeLists.txt"), "cmake");
        assert_eq!(kind_of_name("main.cpp"), "single-cpp");
        assert_eq!(kind_of_name("notes.txt"), "none");
    }
}

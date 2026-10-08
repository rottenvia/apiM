//! Port of src/lib/sandbox-setup.ts: the setup, removal, upgrade, self-check and enable-WSL-1 jobs, and the
//! status snapshot the Sandbox panel polls. Each job runs on its own thread; the UI polls job().
//! Real setup downloads Ubuntu and imports a distro, so tests only ever reach it with the fake wsl.

use super::run;
use super::wsl::{self, Wsl1Probe, Wsl1State, SANDBOX_DISTRO, ROOTFS_BASE, ROOTFS_FILE, SELF_CHECK_MARKER};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_LOG: usize = 40_000;
/// Output kept from one wsl.exe run, as runLogged does.
const RUN_KEEP: usize = 200_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum JobKind {
    Setup,
    Remove,
    EnableWsl,
    Upgrade,
    Check,
}

/// One job as the panel shows it (the web's SandboxJob, same JSON keys).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub kind: JobKind,
    pub phase: String,
    /// 0..1 while downloading, None otherwise.
    pub progress: Option<f64>,
    pub log: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// A button to offer next when the fix is one click.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxStatus {
    pub installed: bool,
    pub distros: Vec<wsl::WslDistro>,
    pub default_distro: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub set_up: bool,
    pub dir: String,
}

/// The GET /api/sandbox body: platform, status and the current job.
#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub platform: String,
    pub status: SandboxStatus,
    pub job: Option<Job>,
}

/// Where things are: the wsl program, the sandbox folder (disk and download), and the app's data folder.
#[derive(Clone, Debug)]
pub struct Paths {
    pub wsl: PathBuf,
    pub dir: PathBuf,
    pub data: PathBuf,
}

impl Paths {
    /// The real locations: wsl.exe from PATH, the folder from the environment, the app's data folder.
    pub fn real() -> Paths {
        let data = crate::store::data_dir();
        let lad = std::env::var("LOCALAPPDATA").ok();
        let dir = wsl::sandbox_base_dir(std::env::var("APIM_SANDBOX_DIR").ok().as_deref(), lad.as_deref(), cfg!(windows), &data);
        Paths { wsl: PathBuf::from("wsl.exe"), dir, data }
    }
}

static JOB: Mutex<Option<Job>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// The current or last job, or None.
pub fn job() -> Option<Job> {
    JOB.lock().unwrap().clone()
}

fn with_job(f: impl FnOnce(&mut Job)) {
    if let Some(j) = JOB.lock().unwrap().as_mut() {
        f(j);
    }
}

fn log(line: &str) {
    with_job(|j| {
        j.log.push_str(line);
        if !line.ends_with('\n') {
            j.log.push('\n');
        }
        if j.log.len() > MAX_LOG {
            let cut = (j.log.len() - MAX_LOG..).find(|&i| j.log.is_char_boundary(i)).unwrap_or(j.log.len());
            j.log.drain(..cut);
        }
    });
}

fn phase(name: &str) {
    with_job(|j| {
        j.phase = name.to_string();
        j.progress = None;
    });
    log(&format!("== {name}"));
}

fn finish(ok: bool, error: Option<String>) {
    let shown = error.clone();
    with_job(|j| {
        j.ok = Some(ok);
        j.error = error;
        j.finished_at = Some(now_ms());
        j.phase = if ok { "Done" } else { "Failed" }.to_string();
    });
    if let Some(e) = shown {
        log(&format!("!! {e}"));
    }
}

fn begin(kind: JobKind) -> Result<(), String> {
    let mut slot = JOB.lock().unwrap();
    if slot.as_ref().is_some_and(|j| j.finished_at.is_none()) {
        return Err("A sandbox job is already running.".into());
    }
    *slot = Some(Job { kind, phase: "Starting".into(), progress: None, log: String::new(), started_at: now_ms(), finished_at: None, ok: None, error: None, hint: None });
    Ok(())
}

/// Starts a job thread. A panic inside it still finishes the job, so the panel never waits forever.
fn spawn_job(kind: JobKind, body: impl FnOnce() -> Result<(), String> + Send + 'static) -> Result<(), String> {
    begin(kind)?;
    std::thread::spawn(move || match std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
        Ok(Ok(())) => finish(true, None),
        Ok(Err(e)) => finish(false, Some(e)),
        Err(_) => finish(false, Some("the sandbox job crashed; see the log above".into())),
    });
    Ok(())
}

pub fn status(p: &Paths) -> SandboxStatus {
    let st = wsl::probe(&p.wsl);
    SandboxStatus {
        set_up: st.distros.iter().any(|d| d.name == SANDBOX_DISTRO),
        installed: st.installed,
        default_distro: st.default_distro,
        reason: st.reason,
        distros: st.distros,
        dir: p.dir.display().to_string(),
    }
}

/// What GET /api/sandbox returns.
pub fn snapshot(p: &Paths) -> Snapshot {
    let platform = match std::env::consts::OS {
        "windows" => "win32".to_string(),
        "macos" => "darwin".to_string(),
        other => other.to_string(),
    };
    Snapshot { platform, status: status(p), job: job() }
}

/// What POST /api/sandbox does: start the named job and return the job now. Err is the message the route sends with a 409.
pub fn act(p: &Paths, action: &str) -> Result<Option<Job>, String> {
    let p = p.clone();
    let needs_windows = || if cfg!(windows) { Ok(()) } else { Err("The WSL sandbox needs the app to run on Windows.".to_string()) };
    match action {
        "setup" => {
            needs_windows()?;
            spawn_job(JobKind::Setup, move || run_setup(p))?;
        }
        "remove" => {
            needs_windows()?;
            spawn_job(JobKind::Remove, move || run_remove(p))?;
        }
        "check" => {
            needs_windows()?;
            spawn_job(JobKind::Check, move || {
                self_check(&p);
                Ok(())
            })?;
        }
        "upgrade" => {
            needs_windows()?;
            spawn_job(JobKind::Upgrade, move || run_upgrade(p))?;
        }
        "enable-wsl" => {
            if !cfg!(windows) {
                return Err("WSL only exists on Windows.".into());
            }
            spawn_job(JobKind::EnableWsl, run_enable_wsl)?;
        }
        _ => return Err("action must be setup, remove, upgrade, check or enable-wsl".into()),
    }
    Ok(job())
}

struct Logged {
    code: Option<i32>,
    output: String,
}

/// Decodes one chunk of child output: UTF-16LE when it has NULs (wsl.exe's own messages), else UTF-8.
fn decode_chunk(b: &[u8]) -> String {
    let text = if b.contains(&0) {
        let units: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(b).into_owned()
    };
    text.replace('\0', "")
}

fn pipe_reader(mut pipe: impl Read + Send + 'static, out: Arc<Mutex<String>>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut buf) {
            if n == 0 {
                break;
            }
            let text = decode_chunk(&buf[..n]);
            {
                let mut o = out.lock().unwrap();
                if o.len() < RUN_KEEP {
                    o.push_str(&text);
                }
            }
            log(&text);
        }
    })
}

/// Runs a program to the end or until `limit`, streaming its output into the job log. The output is returned too.
fn run_logged(program: &Path, args: &[String], input: Option<&str>, limit: Duration) -> Logged {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("could not start {}: {e}", program.display());
            log(&msg);
            return Logged { code: None, output: msg };
        }
    };
    let out = Arc::new(Mutex::new(String::new()));
    let readers: Vec<_> = [child.stdout.take().map(|p| pipe_reader(p, out.clone())), child.stderr.take().map(|p| pipe_reader(p, out.clone()))].into_iter().flatten().collect();
    if let (Some(text), Some(mut pipe)) = (input, child.stdin.take()) {
        let _ = pipe.write_all(text.as_bytes());
    }
    let started = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                log(&format!("(stopped after {}s)", limit.as_secs_f64().round() as u64));
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Err(_) => break None,
        }
    };
    for r in readers {
        let _ = r.join();
    }
    let output = out.lock().unwrap().clone();
    Logged { code, output }
}

/// A silent run for its exit code and output only; nothing goes to the log.
fn run_quiet(program: &Path, args: &[String], limit: Duration) -> Option<wsl::Ran> {
    wsl::run_timed(program, args, limit, None)
}

fn args(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

/// "<step> failed: <known explanation>", or the exit code when the error is not one we know.
fn failure(step: &str, run: &Logged) -> String {
    match wsl::explain_wsl_error(&run.output) {
        Some(known) => format!("{step} failed: {known}"),
        None => format!("{step} failed (exit {}); see the log above.", wsl::format_exit_code(wsl::exit_code_of(run.code))),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// SHA-256 of a file on disk, or None when it cannot be read.
fn hash_file(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Some(hex(&h.finalize()))
}

fn block_on<T>(f: impl std::future::Future<Output = T>) -> Result<T, String> {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    Ok(rt.block_on(f))
}

/// Streams a URL to disk while hashing it, reporting progress into the job. Returns the SHA-256.
fn download(url: &str, dest: &Path) -> Result<String, String> {
    block_on(async {
        let mut res = reqwest::get(url).await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("download failed: HTTP {}", res.status().as_u16()));
        }
        let total = res.content_length().unwrap_or(0);
        let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let (mut received, mut last_logged) = (0u64, 0u64);
        while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
            hasher.update(&chunk);
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            received += chunk.len() as u64;
            if total > 0 {
                with_job(|j| j.progress = Some(received as f64 / total as f64));
            }
            if received - last_logged > 50 * 1024 * 1024 {
                last_logged = received;
                let of = if total > 0 { format!(" of {} MB", (total as f64 / 1048576.0).round()) } else { String::new() };
                log(&format!("  {} MB{of}", (received as f64 / 1048576.0).round()));
            }
        }
        file.flush().map_err(|e| e.to_string())?;
        Ok(hex(&hasher.finalize()))
    })?
}

fn fetch_text(url: &str) -> Result<String, String> {
    block_on(async {
        let res = reqwest::get(url).await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("could not fetch SHA256SUMS: HTTP {}", res.status().as_u16()));
        }
        res.text().await.map_err(|e| e.to_string())
    })?
}

/// Removes a file or folder tree; a missing path is fine.
fn rm(path: &Path) -> Result<(), String> {
    let r = if path.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
    match r {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn system_root() -> PathBuf {
    PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()))
}

/// `sc.exe <args>` as text (latin1), or None when it could not run.
fn sc(args: &[&str]) -> Option<String> {
    let run = run_quiet(Path::new("sc.exe"), &args_owned(args), Duration::from_secs(10))?;
    Some(run.stdout.iter().chain(run.stderr.iter()).map(|&b| b as char).collect())
}

fn args_owned(items: &[&str]) -> Vec<String> {
    args(items)
}

/// What the virtual-disk drivers look like, formatted as the log shows it.
fn vhd_report() -> String {
    let drivers = system_root().join("System32").join("drivers");
    let files: Vec<(&str, bool)> = wsl::VHD_DRIVER_FILES.iter().map(|f| (*f, drivers.join(f).exists())).collect();
    let texts: Vec<(&str, String)> = wsl::VHD_SERVICES.iter().map(|s| (*s, sc(&["qc", s]).unwrap_or_default())).collect();
    let services: Vec<(&str, &str)> = texts.iter().map(|(n, t)| (*n, t.as_str())).collect();
    wsl::format_vhd_findings(&wsl::diagnose_vhd_stack(&files, &services))
}

fn reboot_pending() -> bool {
    [
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending",
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired",
    ]
    .iter()
    .any(|key| run_quiet(Path::new("reg.exe"), &args(&["query", key]), Duration::from_secs(10)).is_some_and(|r| r.code == Some(0)))
}

/// WSL 1's driver files, their registration and a pending restart.
fn wsl1_probe() -> Wsl1Probe {
    let drivers = system_root().join("System32").join("drivers");
    Wsl1Probe {
        reboot_pending: reboot_pending(),
        files: wsl::WSL1_DRIVER_FILES.iter().map(|f| (f.to_string(), drivers.join(f).exists())).collect(),
        services: wsl::WSL1_SERVICES.iter().filter_map(|s| sc(&["qc", s]).map(|t| (s.to_string(), t))).collect(),
    }
}

#[derive(serde::Deserialize)]
struct ProbeJson {
    fs: String,
    #[serde(rename = "driveType")]
    drive_type: String,
    #[serde(rename = "freeGB")]
    free_gb: f64,
    compressed: bool,
    encrypted: bool,
}

/// Checks the install folder (creates it), clears compression or encryption on our own folder, and returns any
/// problem the user must fix. A probe that cannot run is logged and skipped, as the web does.
fn preflight(p: &Paths, install_dir: &Path) -> Result<(), String> {
    let script = std::env::temp_dir().join("apim-sandbox-probe.ps1");
    std::fs::write(&script, wsl::install_dir_probe_script()).map_err(|e| e.to_string())?;
    let dir = install_dir.to_string_lossy().into_owned();
    let base = p.dir.to_string_lossy().into_owned();
    let script_s = script.to_string_lossy().into_owned();
    let probe = || -> Option<wsl::InstallDirInfo> {
        let run = run_quiet(Path::new("powershell.exe"), &args(&["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", &script_s, "-Dir", &dir]), Duration::from_secs(30))?;
        let text = String::from_utf8_lossy(&run.stdout).into_owned();
        let (a, b) = (text.find('{')?, text.rfind('}')?);
        let v: ProbeJson = serde_json::from_str(text.get(a..=b)?).ok()?;
        Some(wsl::InstallDirInfo { fs: v.fs, drive_type: v.drive_type, free_gb: v.free_gb, compressed: v.compressed, encrypted: v.encrypted })
    };
    let Some(mut info) = probe() else {
        log("  (could not inspect the folder; continuing)");
        return Ok(());
    };
    log(&format!("  {dir}: {}, {} GB free", info.fs, info.free_gb));
    let onedrive: Vec<String> = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"].iter().filter_map(|k| std::env::var(k).ok()).filter(|v| !v.is_empty()).collect();
    let mut verdict = wsl::assess_install_dir(&dir, &info, &onedrive);
    let quiet = Duration::from_secs(60);
    if verdict.fix_compression {
        log("  The folder is NTFS-compressed; turning compression off for apiM's folder.");
        for d in [&base, &dir] {
            run_quiet(Path::new("compact.exe"), &args(&["/u", "/i", "/q", d]), quiet);
        }
        run_quiet(Path::new("compact.exe"), &args(&["/u", "/i", "/q", &format!("/s:{base}")]), quiet);
    }
    if verdict.fix_encryption {
        log("  The folder is encrypted (EFS); turning encryption off for apiM's folder.");
        for d in [&base, &dir] {
            run_quiet(Path::new("cipher.exe"), &args(&["/d", d]), quiet);
        }
        run_quiet(Path::new("cipher.exe"), &args(&["/d", &format!("/s:{base}")]), quiet);
    }
    if verdict.fix_compression || verdict.fix_encryption {
        info = probe().unwrap_or(info);
        verdict = wsl::assess_install_dir(&dir, &info, &onedrive);
        if verdict.fix_compression || verdict.fix_encryption {
            let what = if verdict.fix_compression { "compressed" } else { "encrypted" };
            verdict.problems.push(format!("{dir} is still {what}. Right-click it -> Properties -> Advanced and untick that option, or set APIM_SANDBOX_DIR to another folder."));
        }
    }
    if verdict.problems.is_empty() { Ok(()) } else { Err(verdict.problems.join(" ")) }
}

/// Removes the first release's leftover folder when it is empty.
fn tidy_legacy(p: &Paths) {
    let legacy = p.data.join("sandbox");
    if legacy == p.dir {
        return;
    }
    let _ = std::fs::remove_dir(legacy.join("distro"));
    let _ = std::fs::remove_dir(&legacy);
}

fn run_setup(p: Paths) -> Result<(), String> {
    phase("Checking WSL");
    if reboot_pending() {
        log("  Windows is waiting for a restart to finish installing something. If you just turned WSL on, restart first (Start -> Power -> Restart).");
    }
    let status = wsl::probe(&p.wsl);
    if !status.installed {
        return Err(status.reason.unwrap_or_else(|| "WSL is not turned on.".into()));
    }
    let install_dir = p.dir.join("distro");
    let tarball = p.dir.join(ROOTFS_FILE);
    if status.distros.iter().any(|d| d.name == SANDBOX_DISTRO) {
        log(&format!("  \"{SANDBOX_DISTRO}\" already exists; reusing it."));
    } else {
        phase("Checking where the sandbox disk will go");
        std::fs::create_dir_all(&install_dir).map_err(|e| e.to_string())?;
        preflight(&p, &install_dir)?;
        tidy_legacy(&p);

        let sums = fetch_text(&format!("{ROOTFS_BASE}/SHA256SUMS"))?;
        let expected = wsl::expected_sha256(&sums, ROOTFS_FILE).ok_or_else(|| format!("{ROOTFS_FILE} is not listed in SHA256SUMS"))?;
        // A verified download from a failed attempt is reused, not fetched again.
        if hash_file(&tarball).as_deref() == Some(expected.as_str()) {
            phase("Reusing the Ubuntu image downloaded last time");
            log("  SHA256 matches Ubuntu's published checksum.");
        } else {
            phase("Downloading Ubuntu 24.04 (about 350 MB)");
            let actual = download(&format!("{ROOTFS_BASE}/{ROOTFS_FILE}"), &tarball)?;
            phase("Verifying download");
            if actual != expected {
                let _ = std::fs::remove_file(&tarball);
                return Err(format!("checksum mismatch (expected {}…, got {}…). The file was deleted; nothing was installed.", &expected[..12], &actual[..12]));
            }
            log("  SHA256 matches Ubuntu's published checksum.");
        }

        phase(&format!("Importing as \"{SANDBOX_DISTRO}\" (WSL 2)"));
        log(&format!("  disk: {}", install_dir.display()));
        let (dir_s, tar_s) = (install_dir.to_string_lossy().into_owned(), tarball.to_string_lossy().into_owned());
        let run = run_logged(&p.wsl, &wsl::import_args(&dir_s, &tar_s, 2), None, Duration::from_secs(600));
        if run.code != Some(0) {
            // Any WSL 2 failure falls back to WSL 1, which needs no virtual machine and no virtual disk.
            match wsl::wsl2_cannot_run_here(&run.output) {
                Some("virtual-disk") => {
                    phase("Windows cannot create virtual disks; checking its drivers");
                    log(&vhd_report());
                    log("  This is also what breaks Docker Desktop and Hyper-V on this PC.");
                }
                _ => {
                    phase("WSL 2 cannot run on this PC; using WSL 1");
                    log(&format!("  {}", wsl::explain_wsl_error(&run.output).unwrap_or("WSL 2's virtual machine failed to start.")));
                }
            }
            phase(&format!("Importing as \"{SANDBOX_DISTRO}\" (WSL 1, no virtual machine needed)"));
            rm(&install_dir)?;
            std::fs::create_dir_all(&install_dir).map_err(|e| e.to_string())?;
            let v1 = run_logged(&p.wsl, &wsl::import_args(&dir_s, &tar_s, 1), None, Duration::from_secs(1200));
            if v1.code != Some(0) {
                let lower = v1.output.to_lowercase();
                if !(lower.contains("wsl1_not_supported") || lower.contains("optional component")) {
                    return Err(failure("wsl --import (WSL 1 fallback)", &v1));
                }
                // One message, three causes: find out which before suggesting a fix.
                phase("Checking why WSL 1 is unavailable");
                let (state, message) = wsl::diagnose_wsl1(&wsl1_probe());
                if state == Wsl1State::FeatureOff {
                    with_job(|j| j.hint = Some("enable-wsl1"));
                }
                return Err(format!("WSL 1 is not available: {message}"));
            }
            log("  Running on WSL 1. Everything the sandbox uses works on it. Once the drivers above are fixed, click Upgrade to WSL 2 in this panel.");
        }
        rm(&tarball)?;
    }

    phase("Locking down the sandbox (wsl.conf)");
    let conf_text = wsl::sandbox_wsl_conf();
    let conf = run_logged(
        &p.wsl,
        &args(&["-d", SANDBOX_DISTRO, "-u", "root", "--cd", "/", "--exec", "sh", "-c", "cat > /etc/wsl.conf"]),
        Some(conf_text.as_str()),
        Duration::from_secs(60),
    );
    if conf.code != Some(0) {
        if conf.output.to_lowercase().contains("0xd0000034") {
            phase("Linux could not start; checking WSL 1's driver");
            log(&format!("  {}", wsl::diagnose_wsl1(&wsl1_probe()).1));
        }
        return Err(failure("Starting the sandbox", &conf));
    }
    run::close(&p.wsl);
    run_quiet(&p.wsl, &args(&["--terminate", SANDBOX_DISTRO]), Duration::from_secs(30));

    phase("Installing tools (apt-get, a few minutes)");
    let mut apt_args = args(&["-d", SANDBOX_DISTRO, "-u", "root", "--cd", "/", "--exec", "bash", "-c"]);
    apt_args.push(wsl::wsl_setup_script());
    let apt = run_logged(&p.wsl, &apt_args, None, Duration::from_secs(1800));
    if apt.code != Some(0) || !apt.output.contains("apim-wsl-setup-ok") {
        return Err(failure("Installing the tools", &apt));
    }
    self_check(&p);
    Ok(())
}

/// Runs one real command the way the agent will and logs what works. Never fails: a sandbox that cannot see the
/// folder still runs things, and the log says so.
fn self_check(p: &Paths) {
    phase("Checking the sandbox works");
    let dir = p.dir.join("selfcheck");
    let _ = std::fs::remove_dir_all(&dir);
    let result: Result<(), String> = (|| {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("apim-selfcheck.txt"), SELF_CHECK_MARKER).map_err(|e| e.to_string())?;
        let (inv, _) = wsl::wrap_for_sandbox(SANDBOX_DISTRO, &wsl::pick_display(&[]), "selfcheck", &dir.to_string_lossy(), &wsl::self_check_script(), &[]);
        let run = run_logged(&p.wsl, &inv.args, None, Duration::from_secs(120));
        let wrote_back = dir.join("from-sandbox.txt").exists();
        let (_, lines) = wsl::interpret_self_check(&run.output, wrote_back);
        log(&lines.iter().map(|l| format!("  {l}")).collect::<Vec<_>>().join("\n"));
        Ok(())
    })();
    if let Err(e) = result {
        log(&format!("  !!  the check could not run: {e}"));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

fn run_remove(p: Paths) -> Result<(), String> {
    phase(&format!("Removing \"{SANDBOX_DISTRO}\""));
    run::close(&p.wsl);
    let run = run_logged(&p.wsl, &args(&["--unregister", SANDBOX_DISTRO]), None, Duration::from_secs(300));
    rm(&p.dir.join("distro"))?;
    rm(&p.dir.join(ROOTFS_FILE))?;
    if run.code == Some(0) {
        Ok(())
    } else {
        Err(format!("wsl --unregister exited {}", wsl::format_exit_code(wsl::exit_code_of(run.code))))
    }
}

fn run_upgrade(p: Paths) -> Result<(), String> {
    phase(&format!("Converting \"{SANDBOX_DISTRO}\" to WSL 2"));
    run::close(&p.wsl);
    let run = run_logged(&p.wsl, &args(&["--set-version", SANDBOX_DISTRO, "2"]), None, Duration::from_secs(1800));
    if run.code == Some(0) {
        return Ok(());
    }
    if wsl::wsl2_cannot_run_here(&run.output) == Some("virtual-disk") {
        log(&vhd_report());
    }
    Err(format!("{} The sandbox stays on WSL 1 and keeps working.", failure("Converting to WSL 2", &run)))
}

/// Asks Windows for administrator rights to turn WSL 1 on. The elevated half writes DISM's exit code to a log.
fn run_enable_wsl() -> Result<(), String> {
    phase("Asking Windows for administrator rights");
    let dir = std::env::temp_dir().join("apim-enable-wsl");
    let inner = dir.join("enable.ps1");
    let launcher = dir.join("launch.ps1");
    let log_file = dir.join("result.log");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(&inner, wsl::enable_wsl_elevated_script()).map_err(|e| e.to_string())?;
    std::fs::write(&launcher, wsl::enable_wsl_launcher_script()).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&log_file);
    let run = run_logged(
        Path::new("powershell.exe"),
        &args(&["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", &launcher.to_string_lossy(), "-Inner", &inner.to_string_lossy(), "-Log", &log_file.to_string_lossy()]),
        None,
        Duration::from_secs(1800),
    );
    let result = std::fs::read(&log_file).map(|b| String::from_utf8_lossy(&b).trim_start_matches('\u{feff}').replace('\0', "")).unwrap_or_default();
    if !result.is_empty() {
        log(result.trim());
    }
    let declined = run.output.contains("apim-uac-declined") || result.is_empty();
    let dism = wsl::explain_dism_exit(if declined { None } else { wsl::parse_dism_exit(&result) });
    if !dism.ok {
        return Err(dism.message);
    }
    let restart = dism.restart || reboot_pending();
    log(if restart { "Restart Windows now (Start -> Power -> Restart), then click Set up." } else { "Done. Click Set up." });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::fake_wsl;

    fn paths(name: &str) -> Paths {
        let base = std::env::temp_dir().join(format!("asb-setup-{name}"));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        Paths { wsl: fake_wsl(), dir: base.clone(), data: base.join("data") }
    }

    fn wait_for_job() -> Job {
        for _ in 0..600 {
            if let Some(j) = job().filter(|j| j.finished_at.is_some()) {
                return j;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("job did not finish: {:?}", job());
    }

    #[test]
    fn status_and_snapshot_have_the_web_shape() {
        let _turn = crate::sandbox::test_lock();
        let p = paths("status");
        let s = status(&p);
        assert!(s.installed && s.set_up);
        assert_eq!(s.default_distro.as_deref(), Some("wsltest"));
        let v = serde_json::to_value(snapshot(&p)).unwrap();
        assert_eq!(v["status"]["setUp"], true);
        assert_eq!(v["status"]["defaultDistro"], "wsltest");
        assert!(v["status"].get("reason").is_none());
        assert!(v["job"].is_null() || v["job"]["kind"].is_string());
    }

    #[test]
    fn setup_with_the_distro_present_runs_the_rest_and_checks_the_sandbox() {
        let _turn = crate::sandbox::test_lock();
        let p = paths("setup");
        act(&p, "setup").unwrap();
        let j = wait_for_job();
        assert_eq!(j.kind, JobKind::Setup);
        assert_eq!(j.ok, Some(true), "{:?}", j.error);
        assert!(j.log.contains("\"apim-sandbox\" already exists; reusing it."));
        assert!(j.log.contains("OK  the sandbox sees the chat folder and its files reach Windows"));
        assert!(j.log.contains("OK  Python 3.12.3"));
        assert!(j.log.contains("OK  node v22.1.0"));
        assert!(j.log.contains("OK  the off-screen display is up"));
        assert!(!p.dir.join("selfcheck").exists());
    }

    #[test]
    fn check_remove_upgrade_and_refusals() {
        let _turn = crate::sandbox::test_lock();
        let p = paths("ops");
        act(&p, "check").unwrap();
        let j = wait_for_job();
        assert_eq!((j.kind, j.ok), (JobKind::Check, Some(true)));

        std::fs::create_dir_all(p.dir.join("distro")).unwrap();
        std::fs::write(p.dir.join(ROOTFS_FILE), b"x").unwrap();
        act(&p, "remove").unwrap();
        let j = wait_for_job();
        assert_eq!((j.kind, j.ok), (JobKind::Remove, Some(true)));
        assert!(!p.dir.join("distro").exists() && !p.dir.join(ROOTFS_FILE).exists());

        act(&p, "upgrade").unwrap();
        let j = wait_for_job();
        assert_eq!((j.kind, j.ok), (JobKind::Upgrade, Some(true)));

        assert_eq!(act(&p, "reboot"), Err("action must be setup, remove, upgrade, check or enable-wsl".to_string()));
    }

    #[test]
    fn one_job_at_a_time() {
        begin(JobKind::Check).unwrap();
        assert_eq!(begin(JobKind::Setup), Err("A sandbox job is already running.".to_string()));
        finish(true, None);
        assert!(begin(JobKind::Setup).is_ok());
        finish(false, Some("cleanup".into()));
        assert_eq!(job().unwrap().ok, Some(false));
    }

    #[test]
    fn failures_name_the_known_cause_or_the_exit_code() {
        let known = Logged { code: Some(-1), output: "Error code: 0xc03a0014".into() };
        assert!(failure("Importing", &known).starts_with("Importing failed: Windows could not create a virtual disk."));
        let unknown = Logged { code: Some(-1), output: "x".into() };
        assert_eq!(failure("Step", &unknown), "Step failed (exit -1); see the log above.");
        let none = Logged { code: None, output: String::new() };
        assert_eq!(failure("Installing the tools", &none), "Installing the tools failed (exit no exit code); see the log above.");
    }

    #[test]
    fn run_logged_reads_utf16_and_stops_on_time() {
        let _turn = crate::sandbox::test_lock();
        let fake = fake_wsl();
        let listed = run_logged(&fake, &args(&["--list"]), None, Duration::from_secs(10));
        assert_eq!(listed.code, Some(0));
        assert!(listed.output.contains("apim-sandbox"));
        let script = wsl::base64_encode(b"SLEEP");
        let slow = run_logged(&fake, &args(&["bash", "-c", "x", "apim-sandbox", &script, "/ws/t", "C:\\w"]), None, Duration::from_secs(1));
        // The "(stopped after 1s)" line goes to the job log, not to the returned output, as in the web.
        assert_eq!(slow.code, None);
        assert!(slow.output.is_empty());
        let missing = run_logged(Path::new("C:/no/such/program.exe"), &[], None, Duration::from_secs(5));
        assert!(missing.output.starts_with("could not start C:/no/such/program.exe"));
    }

    #[test]
    fn hashes_match_the_standard_vector() {
        let _turn = crate::sandbox::test_lock();
        let p = paths("hash");
        let f = p.dir.join("abc.txt");
        std::fs::write(&f, b"abc").unwrap();
        assert_eq!(hash_file(&f).as_deref(), Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
        assert_eq!(hash_file(&p.dir.join("missing")), None);
        assert_eq!(hex(&[0x0a, 0xff]), "0aff");
    }
}

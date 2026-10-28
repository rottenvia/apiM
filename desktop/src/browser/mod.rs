//! Drives a Chromium-family browser that is already installed. Nothing is bundled or downloaded.
//!
//! The web app drives Playwright's own Chromium. Here the browser is found on the machine (Edge is always
//! there on Windows 11), started headless with a fresh temporary profile, and driven over the DevTools
//! Protocol. Its own profile is never touched.

pub mod cdp;
pub mod live;
pub mod page;
pub mod policy;
pub mod window;

use serde_json::Value;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

/// The web's wording when its browser is missing, verbatim, so the model reads the same thing.
/// ponytail: it names an npm command this desktop does not have. Reword once the desktop has a setup step.
pub const NOT_INSTALLED: &str = "No browser was found on this computer. Install Microsoft Edge, Chrome, Chromium, Brave or Thorium, or point APIM_BROWSER_PATH at one, and this works.";

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Does not open a console window when the browser is started from a GUI process.
fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// The first executable on PATH with this name, or None.
fn on_path(name: &str) -> Option<PathBuf> {
    let probe = if cfg!(windows) { "where" } else { "which" };
    let out = quiet(Command::new(probe).arg(name).stdout(Stdio::piped()).stderr(Stdio::null())).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let first = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
    (!first.is_empty()).then(|| PathBuf::from(first))
}

/// APIM_BROWSER_PATH wins, then the usual install folders, then PATH. None if no browser is found.
pub fn find_browser() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("APIM_BROWSER_PATH").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
    let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into());
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let usual = [
        format!(r"{pf86}\Microsoft\Edge\Application\msedge.exe"),
        format!(r"{pf}\Google\Chrome\Application\chrome.exe"),
        format!(r"{pf86}\Google\Chrome\Application\chrome.exe"),
        format!(r"{local}\Google\Chrome\Application\chrome.exe"),
        format!(r"{pf}\Chromium\Application\chrome.exe"),
        format!(r"{pf}\BraveSoftware\Brave-Browser\Application\brave.exe"),
        format!(r"{local}\Thorium\Application\thorium.exe"),
        format!(r"{pf}\Thorium\Application\thorium.exe"),
    ];
    usual.iter().map(PathBuf::from).find(|p| p.is_file()).or_else(|| ["msedge", "chrome", "chromium", "thorium", "brave"].iter().find_map(|n| on_path(n)))
}

/// Is a browser available? The tool list is filtered on this, as the web withholds `browse` when it is missing.
pub fn available() -> bool {
    // Looked up once: the search starts `where`, and the header asks every frame.
    static FOUND: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| find_browser().is_some());
    *FOUND
}

/// The child process and its profile. Dropping it kills the whole process tree and removes the profile.
struct Process {
    child: Child,
    profile: PathBuf,
}

impl Drop for Process {
    fn drop(&mut self) {
        crate::tools::exec::kill_tree(self.child.id());
        let _ = self.child.wait();
        // ponytail: Edge can still hold files for a moment after the kill, so a leftover temp profile is possible.
        let _ = std::fs::remove_dir_all(&self.profile);
    }
}

/// A running headless browser. Dropping it ends the session.
pub struct Browser {
    _proc: Process,
    pub cdp: cdp::Cdp,
}

/// Start a fresh headless browser on a temporary profile and connect to it.
/// Returns the browser and the stream of its events (console, exceptions, network).
pub async fn launch() -> Result<(Browser, mpsc::UnboundedReceiver<Value>), String> {
    let exe = find_browser().ok_or_else(|| NOT_INSTALLED.to_string())?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let profile = std::env::temp_dir().join(format!("apim-browser-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&profile).map_err(|e| format!("Could not start the browser: {e}"))?;

    let mut cmd = Command::new(&exe);
    cmd.args(["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1280,800", "--autoplay-policy=no-user-gesture-required"])
        .arg(format!("--user-agent={USER_AGENT}"))
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = quiet(&mut cmd).spawn().map_err(|e| format!("Could not start the browser: {e}"))?;
    #[cfg(windows)]
    tie_to_this_process(child.id());
    // From here on, any early return drops `proc`, which kills the browser and removes the profile.
    let proc = Process { child, profile: profile.clone() };

    let file = profile.join("DevToolsActivePort");
    let started = Instant::now();
    let (port, path) = loop {
        if let Ok(text) = std::fs::read_to_string(&file) {
            let mut lines = text.lines();
            if let (Some(port), Some(path)) = (lines.next(), lines.next()) {
                if let Ok(port) = port.trim().parse::<u16>() {
                    break (port, path.trim().to_string());
                }
            }
        }
        if started.elapsed() > Duration::from_secs(15) {
            return Err("Could not start the browser: it did not open its debug port within 15 seconds.".to_string());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };

    let (cdp, events) = cdp::Cdp::connect(port, &path).await.map_err(|e| format!("Could not start the browser: {e}"))?;
    Ok((Browser { _proc: proc, cdp }, events))
}

/// Puts the browser in a job that Windows closes with this process, so a crash or a killed apiM cannot leave headless
/// Edge running: the shared page lives in a static, whose `Drop` never runs at exit.
#[cfg(windows)]
fn tie_to_this_process(pid: u32) {
    #[repr(C)]
    #[derive(Default)]
    struct Basic { user_time: i64, job_time: i64, flags: u32, min_ws: usize, max_ws: usize, processes: u32, affinity: usize, priority: u32, scheduling: u32 }
    #[repr(C)]
    #[derive(Default)]
    struct Extended { basic: Basic, io: [u64; 6], process_memory: usize, job_memory: usize, peak_process: usize, peak_job: usize }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attrs: *const core::ffi::c_void, name: *const u16) -> isize;
        fn SetInformationJobObject(job: isize, class: i32, info: *const core::ffi::c_void, len: u32) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn AssignProcessToJobObject(job: isize, process: isize) -> i32;
        fn CloseHandle(h: isize) -> i32;
    }
    static JOB: std::sync::OnceLock<isize> = std::sync::OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        let info = Extended { basic: Basic { flags: 0x2000, ..Default::default() }, ..Default::default() }; // KILL_ON_JOB_CLOSE
        SetInformationJobObject(job, 9, &info as *const Extended as *const _, std::mem::size_of::<Extended>() as u32);
        job // never closed: it goes with the process
    });
    unsafe {
        let process = OpenProcess(0x0101, 0, pid); // PROCESS_TERMINATE | PROCESS_SET_QUOTA
        if process != 0 {
            AssignProcessToJobObject(job, process);
            CloseHandle(process);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_program_is_not_on_path() {
        assert_eq!(on_path("definitely-not-a-program-apim-test"), None);
    }

    #[test]
    fn not_installed_text_says_how_to_fix_it() {
        assert!(NOT_INSTALLED.contains("APIM_BROWSER_PATH"));
    }
}

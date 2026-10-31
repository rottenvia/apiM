//! Drives a Chromium-family browser that is already installed. Nothing is bundled or downloaded.
//!
//! The web app drives Playwright's own Chromium. Here the browser is found on the machine (Edge is always
//! there on Windows 11), started headless on apiM's own profile, and driven over the DevTools Protocol. The
//! user's own browser profile is never touched.

pub mod cdp;
pub mod live;
pub mod page;
pub mod policy;
pub mod window;

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

/// The web's wording when its browser is missing, verbatim, so the model reads the same thing.
/// ponytail: it names an npm command this desktop does not have. Reword once the desktop has a setup step.
pub const NOT_INSTALLED: &str = "No browser was found on this computer. Install Microsoft Edge, Chrome, Chromium, Brave or Thorium, or point APIM_BROWSER_PATH at one, and this works.";

/// What the headless browser calls itself: what the same browser says in a window of its own. A site's check for a
/// person (Cloudflare's) is passed in such a window (`live::in_window`), and the pass holds only for the browser that
/// earned it, by this name. It was a fixed "Chrome/131" on a Thorium 138: a check passed in the window never held in the
/// pane, and the version it named was not the one the browser's other headers gave.
fn user_agent(exe: &Path) -> String {
    // Each version of a Chromium-family browser is installed in a folder named for it, beside the program.
    let version = |name: &str| name.split('.').map(|n| n.parse::<u32>().ok()).collect::<Option<Vec<u32>>>().filter(|v| v.len() == 4);
    let newest = exe.parent().and_then(|dir| std::fs::read_dir(dir).ok()).into_iter().flatten().flatten().filter_map(|entry| version(&entry.file_name().to_string_lossy())).max();
    // ponytail: a browser found without its version folders (on PATH elsewhere) is called Chrome 138.
    let major = newest.map_or(138, |v| v[0]);
    let edge = exe.file_stem().is_some_and(|stem| stem.eq_ignore_ascii_case("msedge"));
    format!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36{}", if edge { format!(" Edg/{major}.0.0.0") } else { String::new() })
}

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

/// The child process, and the profile to remove after it when it was a throwaway one. Dropping it kills the whole
/// process tree.
struct Process {
    child: Child,
    throwaway: Option<PathBuf>,
}

impl Drop for Process {
    fn drop(&mut self) {
        // A browser that already quit is not killed: its number may belong to another program by now.
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            crate::tools::exec::kill_tree(self.child.id());
        }
        let _ = self.child.wait();
        // ponytail: Edge can still hold files for a moment after the kill, so a leftover temp profile is possible.
        if let Some(profile) = &self.throwaway {
            let _ = std::fs::remove_dir_all(profile);
        }
    }
}

/// A running headless browser. Dropping it ends the session.
pub struct Browser {
    _proc: Process,
    pub cdp: cdp::Cdp,
}

impl Browser {
    /// Asks the browser to close and gives it two seconds to be gone before it is killed: it writes the profile's
    /// cookies on its way out, and killed at once a sign-in of the last half minute could be lost.
    pub async fn quit(mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(2), self.cdp.call("Browser.close", serde_json::json!({}), None)).await;
        for _ in 0..40 {
            if matches!(self._proc.child.try_wait(), Ok(Some(_))) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

/// Start a headless browser and connect to it. Returns the browser and the stream of its events (console, exceptions,
/// network), for every page it will have.
///
/// Its profile is kept in the data folder, so an account signed into in the Browser pane is still signed in the next
/// time; on a throwaway profile every start began signed out (asked for, 2026-10-28). The profile is apiM's, never the
/// user's own browser's. Another apiM on the same data folder holds it, and a browser on a held profile hands its
/// window over and quits: then this one runs on a throwaway profile.
pub async fn launch() -> Result<(Browser, mpsc::UnboundedReceiver<Value>), String> {
    let exe = find_browser().ok_or_else(|| NOT_INSTALLED.to_string())?;
    match start(&exe, &crate::store::data_dir().join("browser"), false).await {
        Ok(started) => Ok(started),
        Err(_) => {
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            start(&exe, &std::env::temp_dir().join(format!("apim-browser-{}-{stamp}", std::process::id())), true).await
        }
    }
}

async fn start(exe: &Path, profile: &Path, throwaway: bool) -> Result<(Browser, mpsc::UnboundedReceiver<Value>), String> {
    std::fs::create_dir_all(profile).map_err(|e| format!("Could not start the browser: {e}"))?;
    // Left by the last run, it names a port long closed, and would be read before the new browser writes its own.
    let file = profile.join("DevToolsActivePort");
    let _ = std::fs::remove_file(&file);

    let mut cmd = Command::new(exe);
    cmd.args(["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1280,800", "--autoplay-policy=no-user-gesture-required"])
        .arg(format!("--user-agent={}", user_agent(exe)))
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = quiet(&mut cmd).spawn().map_err(|e| format!("Could not start the browser: {e}"))?;
    #[cfg(windows)]
    tie_to_this_process(child.id());
    // From here on, any early return drops `proc`, which kills the browser (and removes a throwaway profile).
    let mut proc = Process { child, throwaway: throwaway.then(|| profile.to_path_buf()) };

    let started = Instant::now();
    let (port, path) = loop {
        if let Ok(Some(_)) = proc.child.try_wait() {
            return Err("Could not start the browser: it quit at once (its profile is in use by another apiM).".to_string());
        }
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

/// The browser as anyone uses it, on the Browser pane's profile: a window of its own with nothing driving it, and not
/// tied to this process, so it is the user's to close. For signing in, or passing a check for a person, where a driven
/// browser is turned away (`live::in_window`).
pub fn open_window(url: &str) -> Result<Child, String> {
    let exe = find_browser().ok_or_else(|| NOT_INSTALLED.to_string())?;
    let mut cmd = Command::new(exe);
    cmd.args(["--no-first-run", "--no-default-browser-check"])
        .arg(format!("--user-data-dir={}", crate::store::data_dir().join("browser").display()))
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    quiet(&mut cmd).spawn().map_err(|e| format!("Could not open the browser: {e}"))
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

    /// The headless browser names the version installed, as it would in a window, and Edge says it is Edge.
    #[test]
    fn the_headless_browser_names_the_version_installed() {
        let dir = crate::tools::scratch("ua");
        for folder in ["137.0.1.2", "138.0.7204.303", "SetupMetrics", "9.9"] {
            std::fs::create_dir_all(dir.join(folder)).unwrap();
        }
        let agent = user_agent(&dir.join("thorium.exe"));
        assert_eq!(agent, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36");
        assert!(user_agent(&dir.join("msedge.exe")).ends_with("Safari/537.36 Edg/138.0.0.0"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_program_is_not_on_path() {
        assert_eq!(on_path("definitely-not-a-program-apim-test"), None);
    }

    #[test]
    fn not_installed_text_says_how_to_fix_it() {
        assert!(NOT_INSTALLED.contains("APIM_BROWSER_PATH"));
    }
}

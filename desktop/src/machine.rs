//! What the app knows about the computer it runs on. It is read once, when first asked for, and told to the model
//! with every request: no chat then starts by finding out which system this is, where the user's folders are or
//! which programs there are to run. A model that had to guess took Windows for Linux and spent rounds on it.

use std::path::Path;
use std::sync::LazyLock;

/// Programs worth naming: what a task most often reaches for.
const PROGRAMS: &[&str] = &["python", "pip", "node", "npm", "git", "cargo", "go", "java", "dotnet", "gcc", "cmake", "docker"];

/// "Windows 11, build 26200" from `ver`'s "Microsoft Windows [Version 10.0.26200.6584]"; Windows 11 began at build 22000.
fn windows_name(ver: &str) -> Option<String> {
    let build: u32 = ver.split("Version ").nth(1)?.split('.').nth(2)?.trim_end_matches(|c: char| !c.is_ascii_digit()).parse().ok()?;
    Some(format!("Windows {}, build {build}", if build >= 22_000 { 11 } else { 10 }))
}

fn said_by(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args).stdin(std::process::Stdio::null());
    crate::tools::exec::hide_window_std(&mut cmd);
    let out = cmd.output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|text| !text.is_empty())
}

/// The lines that stay the same for as long as the app runs.
static FACTS: LazyLock<String> = LazyLock::new(|| {
    let system = if cfg!(windows) { said_by("cmd", &["/c", "ver"]).as_deref().and_then(windows_name).unwrap_or_else(|| "Windows".into()) } else { said_by("uname", &["-sr"]).unwrap_or_else(|| std::env::consts::OS.into()) };
    let var = |name: &str| std::env::var(name).unwrap_or_default();
    let mut out = format!("- {system}, {}.", std::env::consts::ARCH);
    if cfg!(windows) {
        out += " Its shell is PowerShell. dir, type, copy and echo are built into cmd and are not programs; python3 is only a Microsoft Store stub here: the interpreter is python.";
        out += &format!("\n- The user's home: {}. Programs keep their data, logs and crash dumps per user under %LOCALAPPDATA% ({}) and %APPDATA% ({}); temporary files under {}.", var("USERPROFILE"), var("LOCALAPPDATA"), var("APPDATA"), var("TEMP"));
    } else {
        out += &format!("\n- The user's home: {}.", var("HOME"));
    }
    let (found, missing): (Vec<&str>, Vec<&str>) = PROGRAMS.iter().partition(|name| crate::tools::exec::on_path(name));
    out += &format!("\n- Programs found: {}.", if found.is_empty() { "none of the usual ones".to_string() } else { found.join(", ") });
    if !missing.is_empty() {
        out += &format!(" Not found: {}.", missing.join(", "));
    }
    out
});

/// The section of the system prompt. `auto`: commands run without asking. The workspace is not in it: see `today`.
pub fn block(approval: crate::store::Approval) -> String {
    use crate::store::Approval;
    let asks = match approval {
        Approval::Manual => "The user approves each command before it runs, except a program that only looks (git status or log, tasklist, systeminfo, which, a --version), and each folder you look into outside the workspace. Every PowerShell call is shown to them whole: put the steps that go together in one.",
        Approval::Critical => "Commands and looks outside the workspace run without asking; the critical actions still ask the user — installing a package into the machine (pip into the system Python, npm -g, cargo install), adding a skill, pushing to a remote or opening a pull request, calling an outside tool, and changing a process the app did not start. Prefer what is already there: the standard library's unittest needs nothing installed.",
        Approval::Auto => "Commands and looks outside the workspace run without asking, installing a package into the machine (pip into the system Python, npm -g, cargo install) included; nothing asks. A system command that takes the computer itself apart is refused outright, not asked. Prefer what is already there: the standard library's unittest needs nothing installed.",
    };
    format!(
        "\n\nThis computer, as the app found it when it started (take it as given, do not spend a round checking it):\n{}\n- {asks}",
        *FACTS
    )
}

/// The date and the workspace, for the note before each question. In the system prompt the date changed the start of
/// every request at midnight, and a chat open across it was sent again whole at full price. The workspace made each
/// folder's chats a prompt of their own: Claude, which reads its cache only up to a mark, wrote all 13,800 tokens of
/// rules and tools again for every new chat in another folder.
pub fn today(workspace: &Path) -> String {
    format!("Today is {}. Your workspace: {}", chrono::Local::now().format("%Y-%m-%d, %A"), workspace.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_computer_is_described() {
        assert_eq!(windows_name("Microsoft Windows [Version 10.0.26200.6584]").as_deref(), Some("Windows 11, build 26200"));
        assert_eq!(windows_name("Microsoft Windows [Version 10.0.19045.3803]").as_deref(), Some("Windows 10, build 19045"));
        assert_eq!(windows_name("nonsense"), None);
        use crate::store::Approval;
        let told = block(Approval::Manual);
        assert!(told.contains(".\n- The user approves") && told.contains("Programs found: ") && told.ends_with("put the steps that go together in one.") && !told.contains("workspace:"), "{told}");
        let today = today(Path::new("/w/chat"));
        assert!(today.starts_with("Today is 20") && today.ends_with(". Your workspace: /w/chat") && !told.contains("Today is"));
        assert!(block(Approval::Critical).contains("cargo install), adding a skill"));
        assert!(block(Approval::Auto).contains("cargo install) included; nothing asks"));
    }
}

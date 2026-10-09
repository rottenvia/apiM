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

/// The section of the system prompt. `auto`: commands run without asking.
pub fn block(workspace: &Path, auto: bool) -> String {
    let asks = if auto { "Commands and looks outside the workspace run without asking; a system command that changes or deletes something still asks the user." } else { "The user approves each command, and each folder you look into outside the workspace." };
    format!(
        "\n\nThis computer, as the app found it when it started (take it as given, do not spend a round checking it):\n{}\n- Your workspace: {}\n- Today is {}.\n- {asks}",
        *FACTS,
        workspace.display(),
        chrono::Local::now().format("%Y-%m-%d, %A")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_computer_is_described() {
        assert_eq!(windows_name("Microsoft Windows [Version 10.0.26200.6584]").as_deref(), Some("Windows 11, build 26200"));
        assert_eq!(windows_name("Microsoft Windows [Version 10.0.19045.3803]").as_deref(), Some("Windows 10, build 19045"));
        assert_eq!(windows_name("nonsense"), None);
        let told = block(Path::new("/w/chat"), false);
        assert!(told.contains("- Your workspace: /w/chat\n- Today is 20") && told.contains("Programs found: ") && told.ends_with("outside the workspace."), "{told}");
        assert!(block(Path::new("/w"), true).ends_with("still asks the user."));
    }
}

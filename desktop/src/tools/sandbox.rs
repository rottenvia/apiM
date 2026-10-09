//! The sandbox_run and sandbox_screenshot tools. Texts, limits and approval follow the web's chat route
//! (src/app/api/chat/route.ts: the sandbox_screenshot and sandbox_run branches).

use crate::sandbox::run;
use crate::store::Approval;
use crate::tools::{Ctx, Output, str_arg};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How long an approval card waits, as in exec.rs.
const APPROVAL_LIMIT: Duration = Duration::from_secs(5 * 60);

fn wsl_program() -> PathBuf {
    PathBuf::from("wsl.exe")
}

/// The chat's sandbox id: its folder name, as search_conversation reads the chat id.
fn workspace_id(ctx: &Ctx) -> String {
    ctx.state_dir.file_name().unwrap_or_default().to_string_lossy().into_owned()
}

fn outcome(ok: bool, text: String, summary: String) -> Output {
    Output { ok, text, summary, ..Default::default() }
}

/// The line the approval card and the step row show: "sandbox[ (background)]: <first 80 characters>".
pub fn display_line(script: &str, background: bool) -> String {
    format!("sandbox{}: {}", if background { " (background)" } else { "" }, script.chars().take(80).collect::<String>())
}

/// The file name a screenshot request asks for: the last part of `path` after leading slashes, or None when no path was given.
pub fn requested_shot_name(args: &Value) -> Option<String> {
    let path = str_arg(args, "path").trim();
    if path.is_empty() {
        return None;
    }
    Some(path.trim_start_matches('/').rsplit('/').next().unwrap_or("").to_string())
}

pub async fn sandbox_run(ctx: &Ctx, args: &Value) -> Output {
    sandbox_run_with(&wsl_program(), ctx, args).await
}

/// sandbox_run with the wsl program given, so tests can use a fake.
pub async fn sandbox_run_with(wsl: &Path, ctx: &Ctx, args: &Value) -> Output {
    let script = str_arg(args, "command").trim().to_string();
    if script.is_empty() {
        return outcome(false, "No command was given. Pass command as a shell line, e.g. {\"command\":\"python3 solve.py\"}.".into(), "Missing command".into());
    }
    let background = args["background"].as_bool() == Some(true);
    let display = display_line(&script, background);
    // Same gate as run_command: Auto mode runs it, otherwise the card asks. "Always allow" is remembered by the key.
    if ctx.settings.approval != Approval::Auto {
        let reason = str_arg(args, "reason").trim();
        let key = serde_json::to_string(&["sandbox", script.as_str()]).unwrap_or_default();
        // Stricter than the web: the card shows the whole command. The web cuts it at 80 characters, which lets a long tail be approved unseen.
        let card = format!("sandbox: {script}");
        let decline = match tokio::time::timeout(APPROVAL_LIMIT, ctx.emit.approve_keyed(&card, reason, &key)).await {
            Ok(true) => None,
            Ok(false) => Some("The user declined this command."),
            Err(_) => Some("The user did not respond to the approval prompt within 5 minutes."),
        };
        if let Some(why) = decline {
            return outcome(false, format!("The sandbox command was not run. {why} Do not retry it — explain what you were trying to do."), format!("Skipped: {display}"));
        }
    }
    if background {
        // A server, a watcher or a window: started, left running, and kept in the process list like any other.
        let child = match run::start_background(wsl, &workspace_id(ctx), &ctx.root, &script).await {
            Ok(child) => child,
            Err((error, needs_setup)) => return outcome(false, if needs_setup { format!("{error} Ask the user to run /sandbox and set it up once.") } else { error }, "Sandbox start failed".into()),
        };
        let listed = format!("sandbox: {}", script.chars().take(60).collect::<String>());
        let (id, died, log) = ctx.procs.adopt(ctx.state_dir.clone(), listed, child, ctx.emit.clone(), Duration::from_secs(3)).await;
        ctx.memory.invalidate_all();
        let first = |most: usize, none: &str| if log.trim().is_empty() { none.to_string() } else { log.chars().take(most).collect() };
        return match died {
            Some(_) => outcome(false, format!("The sandbox process exited immediately.\n{}", first(2000, "(no output)")), "Sandbox process exited at once".into()),
            None => outcome(true, format!("Started in the sandbox as {id}. First output:\n{}\nScreenshot it with sandbox_screenshot; read it with read_process {id}.", first(1500, "(none yet)")), format!("Sandbox process {id}")),
        };
    }
    let timeout_ms = args["timeout_ms"].as_f64().map(|v| v.max(0.0) as u64);
    let r = run::run_command(wsl, &workspace_id(ctx), &ctx.root, &script, timeout_ms).await;
    ctx.memory.invalidate_all();
    outcome(r.ok, r.content, r.summary)
}

pub async fn sandbox_screenshot(ctx: &Ctx, args: &Value) -> Output {
    sandbox_screenshot_with(&wsl_program(), ctx, args).await
}

/// sandbox_screenshot with the wsl program given, so tests can use a fake.
pub async fn sandbox_screenshot_with(wsl: &Path, ctx: &Ctx, args: &Value) -> Output {
    // Read-only: it looks at the off-screen display and changes nothing, so no approval (as screenshot_window).
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let full = args["full_screen"].as_bool() == Some(true);
    let wait = args["wait_seconds"].as_f64();
    let name = requested_shot_name(args);
    match run::screenshot(wsl, &workspace_id(ctx), &ctx.root, name.as_deref(), now, full, wait).await {
        Ok(shot) => {
            let mut text = format!("Saved a screenshot of the sandbox display ({}) to {}. Open it with view_image to see it.", shot.display, shot.file_name);
            if !shot.note.is_empty() {
                text.push('\n');
                text.push_str(&shot.note);
            }
            Output { ok: true, text, summary: "Sandbox screenshot saved".into(), image: Some(ctx.root.join(&shot.file_name)), changed: Some(shot.file_name), ..Default::default() }
        }
        Err((error, needs_setup)) => {
            let text = if needs_setup { format!("{error} Ask the user to run /sandbox and set it up once.") } else { error };
            outcome(false, text, "Sandbox screenshot failed".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn display_is_capped_at_eighty_characters() {
        let long = "x".repeat(100);
        assert_eq!(display_line(&long, false), format!("sandbox: {}", "x".repeat(80)));
        assert_eq!(display_line("ls", true), "sandbox (background): ls");
    }

    #[test]
    fn screenshot_path_keeps_only_the_last_part() {
        assert_eq!(requested_shot_name(&json!({"path": "/shots/a.png"})), Some("a.png".into()));
        assert_eq!(requested_shot_name(&json!({"path": "  "})), None);
        assert_eq!(requested_shot_name(&json!({"path": 5})), None);
        assert_eq!(requested_shot_name(&json!({})), None);
    }
}

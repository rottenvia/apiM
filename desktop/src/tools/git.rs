//! Git tools, offered when the workspace is a git repository.
//! They drive the `git` on PATH; nothing is ever pushed from here.

use super::{Ctx, Output, bool_arg, clip, list_arg, num_arg, str_arg};
use crate::store::Approval;
use serde_json::Value;
use std::process::Stdio;

const MAX_DIFF: usize = 60_000;

/// Runs git in the workspace. Returns (succeeded, combined output).
async fn git(ctx: &Ctx, args: &[&str]) -> (bool, String) {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(["--no-pager", "-c", "core.quotepath=off"]).args(args).current_dir(&ctx.root).stdin(Stdio::null()).env("GIT_TERMINAL_PROMPT", "0").kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    match tokio::time::timeout(std::time::Duration::from_secs(60), cmd.output()).await {
        Ok(Ok(o)) => (o.status.success(), format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)).trim().to_string()),
        Ok(Err(e)) => (false, format!("Could not run git: {e}. Is Git installed and on PATH?")),
        Err(_) => (false, "git did not finish within 60 seconds.".into()),
    }
}

/// The branch new work must not be committed to directly.
async fn base_branch(ctx: &Ctx) -> String {
    // A repository connected through GitHub has the base the user picked.
    if let Some(c) = crate::github::read_connection(&super::github::ws(ctx)) {
        return c.base_branch;
    }
    let (ok, head) = git(ctx, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).await;
    if ok {
        return head.trim().trim_start_matches("origin/").to_string();
    }
    let (has_main, _) = git(ctx, &["rev-parse", "--verify", "--quiet", "main"]).await;
    if has_main { "main".into() } else { "master".into() }
}

async fn current_branch(ctx: &Ctx) -> String {
    git(ctx, &["rev-parse", "--abbrev-ref", "HEAD"]).await.1
}

/// Changing the repository asks first in Manual mode.
async fn allowed(ctx: &Ctx, what: &str) -> bool {
    ctx.settings.approval == Approval::Auto || ctx.emit.approve(what, "Changes the git repository in this folder").await
}

pub async fn run(ctx: &Ctx, name: &str, args: &Value) -> Output {
    match name {
        "git_status" => {
            let (ok, out) = git(ctx, &["status", "--short", "--branch"]).await;
            let branch = out.lines().next().unwrap_or("").trim_start_matches("## ").to_string();
            Output { ok, ..Output::ok(if out.is_empty() { "Clean working tree.".into() } else { out }, format!("Status: {branch}")) }
        }
        "git_diff" => {
            let base = base_branch(ctx).await;
            let range = format!("origin/{base}...HEAD");
            let mut argv = vec!["diff"];
            if bool_arg(args, "base") {
                argv.push(&range);
            } else if bool_arg(args, "staged") {
                argv.push("--staged");
            }
            let path = str_arg(args, "path");
            if !path.is_empty() {
                argv.extend(["--", path]);
            }
            let (ok, out) = git(ctx, &argv).await;
            let lines = out.lines().count();
            Output { ok, ..Output::ok(if out.is_empty() { "No changes.".into() } else { clip(&out, MAX_DIFF) }, format!("Diff: {lines} lines")) }
        }
        "git_log" => {
            let count = num_arg(args, "count").unwrap_or(10).clamp(1, 50).to_string();
            let (ok, out) = git(ctx, &["log", "-n", &count, "--date=short", "--pretty=format:%h %ad %an: %s"]).await;
            Output { ok, ..Output::ok(out, format!("Last {count} commits")) }
        }
        "git_commit" => {
            let message = str_arg(args, "message").trim();
            if message.is_empty() {
                return Output::fail("message is required.");
            }
            let (branch, base) = (current_branch(ctx).await, base_branch(ctx).await);
            if branch == base {
                return Output::fail(format!("You are on the base branch `{base}`. Create a working branch with git_branch first, then commit there."));
            }
            if !allowed(ctx, &format!("git commit -m \"{}\"", message.lines().next().unwrap_or(""))).await {
                return Output::fail("The user declined the commit.");
            }
            let paths = list_arg(args, "paths");
            let mut add = vec!["add"];
            if paths.is_empty() {
                add.push("-A");
            } else {
                add.push("--");
                add.extend(paths.iter().map(String::as_str));
            }
            let (ok, out) = git(ctx, &add).await;
            if !ok {
                return Output::fail(format!("git add failed: {out}"));
            }
            let (ok, out) = git(ctx, &["commit", "-m", message]).await;
            Output { ok, ..Output::ok(out, format!("Committed: {}", message.lines().next().unwrap_or(""))) }
        }
        "git_branch" => {
            let branch = str_arg(args, "name").trim();
            match str_arg(args, "action") {
                "list" => {
                    let (ok, out) = git(ctx, &["branch", "--list", "-vv"]).await;
                    Output { ok, ..Output::ok(out, "Listed branches") }
                }
                action @ ("create" | "switch") => {
                    if branch.is_empty() {
                        return Output::fail("name is required.");
                    }
                    if action == "switch" && branch == base_branch(ctx).await {
                        return Output::fail("Switching to the base branch is refused: work stays on a working branch.");
                    }
                    // New branches live under apim/ so they are easy to tell from the user's own.
                    let full = if action == "create" && !branch.starts_with("apim/") { format!("apim/{branch}") } else { branch.to_string() };
                    if !allowed(ctx, &format!("git switch {}{full}", if action == "create" { "-c " } else { "" })).await {
                        return Output::fail("The user declined the branch change.");
                    }
                    let (ok, out) = if action == "create" { git(ctx, &["switch", "-c", &full]).await } else { git(ctx, &["switch", &full]).await };
                    if ok {
                        // github_push and github_create_pr target the branch now checked out.
                        crate::git_agent::follow_branch(&super::github::ws(ctx), &full);
                    }
                    Output { ok, ..Output::ok(out, format!("Now on {full}")) }
                }
                other => Output::fail(format!("Unknown action `{other}`. Use list, create or switch.")),
            }
        }
        other => Output::fail(format!("{other} is not available in the desktop app yet.")),
    }
}

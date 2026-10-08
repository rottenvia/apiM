//! The GitHub tools: merge the latest base, push the working branch, open a pull request, read its status.
//! Result text, limits and approval rules are the web app's (its chat route and git-agent.ts), word for word.

use super::{Ctx, Output};
use crate::git_agent;
use crate::github::{self, Api, Ws};
use crate::store::Approval;
use serde_json::Value;

const NOT_CONNECTED: &str = "GitHub is not connected to this workspace. Open the GitHub connector and choose a repository first.";

fn out(ok: bool, text: impl Into<String>, summary: impl Into<String>) -> Output {
    Output { ok, text: text.into(), summary: summary.into(), ..Default::default() }
}

fn failed(name: &str, error: &str) -> Output {
    out(false, format!("{name} failed: {error}"), format!("{name} failed"))
}

/// The workspace of the chat this run works in. Its id is the folder name both apps use.
pub fn ws(ctx: &Ctx) -> Ws {
    Ws { id: ctx.state_dir.file_name().unwrap_or_default().to_string_lossy().into_owned(), root: ctx.root.clone(), data: crate::store::data_dir() }
}

pub async fn run(ctx: &Ctx, name: &str, args: &Value) -> Output {
    let token = github::resolve_token(&ctx.settings.github_token).ok().flatten();
    run_at(ctx, &ws(ctx), github::API, token.as_deref(), name, args).await
}

/// Pushing and opening a pull request ask first, unless commands run automatically. A remembered answer is the
/// approval card's own business.
async fn allowed(ctx: &Ctx, display: &str, reason: &str) -> bool {
    ctx.settings.approval == Approval::Auto || ctx.emit.approve(display, reason).await
}

async fn run_at(ctx: &Ctx, ws: &Ws, api_base: &str, token: Option<&str>, name: &str, args: &Value) -> Output {
    let local = matches!(name, "git_pull_base" | "github_pr_status");
    // Re-read each call: git_branch may have moved the working branch this run.
    let Some(live) = github::read_connection(ws) else {
        return out(false, if local { "GitHub is not connected to this workspace." } else { NOT_CONNECTED }, "GitHub not connected");
    };
    let api = |token: &str| Api { client: ctx.client.clone(), base: api_base.to_string(), token: token.to_string() };
    match (name, token) {
        ("git_pull_base", _) => match git_agent::pull_base(ws, token).await {
            Ok(pulled) if pulled.conflicts.is_empty() => out(true, pulled.text, if pulled.merged { "Merged base" } else { "Up to date" }),
            Ok(pulled) => out(false, pulled.text, format!("Merge conflicts ({})", pulled.conflicts.len())),
            Err(error) => failed(name, &error),
        },
        ("github_pr_status", None) => failed(name, "GitHub token missing — reconnect GitHub in the connector"),
        ("github_pr_status", Some(token)) => match git_agent::pr_status(ws, &api(token)).await {
            Ok(Some(status)) => out(true, git_agent::format_pr_status(&status), format!("PR #{} {}", status.pr.number, status.pr.state)),
            Ok(None) => out(true, "No pull request exists for this branch yet.", "No PR"),
            Err(error) => failed(name, &error),
        },
        ("github_create_pr" | "github_push", None) => out(false, NOT_CONNECTED, "GitHub not connected"),
        ("github_create_pr", Some(token)) => {
            let title = args["title"].as_str().unwrap_or("").trim();
            let reason = if title.is_empty() { "Open a pull request for the working branch".to_string() } else { format!("Open pull request: {}", title.chars().take(120).collect::<String>()) };
            if !allowed(ctx, &format!("push {} and open PR → {}:{}", live.working_branch, live.repo, live.base_branch), &reason).await {
                return out(false, "The pull request was not opened. Do not retry until the user asks.", "Pull request skipped");
            }
            match git_agent::create_pr(ws, &api(token), title, args["body"].as_str().unwrap_or(""), args["draft"] == true).await {
                Ok((pr, pushed)) => {
                    let opened = if pr.existing { "A pull request already exists" } else { "Opened pull request" };
                    let text = format!("{opened} #{}: {}\n{} → {} ({}{}){}", pr.number, pr.url, pr.head, pr.base, pr.state, if pr.draft { ", draft" } else { "" }, if pushed { "\nPushed the branch first." } else { "" });
                    out(true, text, format!("PR #{}{}", pr.number, if pr.existing { " (existing)" } else { "" }))
                }
                Err(error) => out(false, format!("Could not open the pull request: {error}"), "Pull request failed"),
            }
        }
        ("github_push", Some(token)) => {
            let reason = args["reason"].as_str().map_or("Publish committed work to the dedicated GitHub branch", str::trim);
            if !allowed(ctx, &format!("git push origin {}", live.working_branch), reason).await {
                return out(false, "The GitHub push was not run. Do not retry until the user asks.", "GitHub push skipped");
            }
            match github::push(ws, token).await {
                Ok((c, said)) => out(true, format!("Pushed committed work to {} branch {}.\n\n{}", c.repo, c.working_branch, if said.is_empty() { "Push completed." } else { &said }), format!("Pushed {}", c.working_branch)),
                Err(error) => out(false, format!("GitHub push failed: {error}"), "GitHub push failed"),
            }
        }
        _ => out(false, format!("Unknown git tool {name}"), "Unknown tool"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::Emitter;
    use crate::github::tests::{FAKE, connected, fixture, leaks, sh, stub, upstream};
    use crate::store::Settings;
    use crate::tools::{ChatState, exec::Procs};
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    /// A tool context. Nobody listens for approval cards, so in Manual mode every one of them is declined.
    fn ctx(root: &std::path::Path, approval: Approval) -> Ctx {
        let (tx, _) = std::sync::mpsc::channel();
        Ctx {
            root: root.to_path_buf(),
            state_dir: root.to_path_buf(),
            settings: Settings { approval, ..Settings::default() },
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            read_chars: 20_000,
            emit: Emitter::new(tx, || {}),
            chat: Arc::new(Mutex::new(ChatState::default())),
            procs: Arc::new(Procs::default()),
            planner: None,
            limits: crate::context::tool_limits::tool_limits_for(false),
            memory: Default::default(),
        }
    }

    async fn commit(root: &std::path::Path, file: &str, content: &str) {
        std::fs::write(root.join(file), content).unwrap();
        sh(root, &["add", "-A"]).await;
        sh(root, &["commit", "-q", "-m", &format!("Change {file}")]).await;
    }

    #[tokio::test]
    async fn the_four_tools_use_the_webs_words_and_never_show_the_token() {
        let opened = Arc::new(AtomicBool::new(false));
        let was_opened = opened.clone();
        let (base, seen) = stub(move |req, body| {
            let pr = |extra: Value| {
                let mut row = json!({ "number": 7, "html_url": "https://github.com/octo/demo/pull/7", "state": "open", "draft": false, "title": "Fix login", "head": { "ref": "apim/work", "sha": "abc123" }, "base": { "ref": "main" } });
                row.as_object_mut().unwrap().extend(extra.as_object().cloned().unwrap_or_default());
                row
            };
            match req {
                r if r.starts_with("GET /repos/octo/demo/pulls?head=octo%3Aapim%2F") => (200, if was_opened.load(Ordering::SeqCst) { json!([pr(json!({}))]) } else { json!([]) }),
                "POST /repos/octo/demo/pulls" => {
                    was_opened.store(true, Ordering::SeqCst);
                    let sent: Value = serde_json::from_str(body).unwrap();
                    assert_eq!((sent["base"].as_str(), sent["draft"].as_bool(), sent["title"].as_str()), (Some("main"), Some(false), Some("Fix login")));
                    (201, pr(json!({})))
                }
                "GET /repos/octo/demo/pulls/7" => (200, pr(json!({ "mergeable": true, "mergeable_state": "clean", "review_comments": 2, "comments": 1 }))),
                "GET /repos/octo/demo/commits/abc123/check-runs?per_page=100" => (200, json!({ "check_runs": [{ "name": "build", "status": "completed", "conclusion": "success" }, { "name": "lint", "status": "completed", "conclusion": "failure" }, { "name": "e2e", "status": "in_progress" }] })),
                _ => (404, json!({ "message": "Not Found" })),
            }
        })
        .await;
        let mut all: Vec<Output> = Vec::new();
        let mut call = async |ctx: &Ctx, ws: &Ws, token: Option<&str>, name: &str, args: Value| {
            let o = run_at(ctx, ws, &base, token, name, &args).await;
            all.push(Output { ok: o.ok, text: o.text.clone(), summary: o.summary.clone(), ..Default::default() });
            (o.ok, o.text, o.summary)
        };
        let no = json!({});

        // Not connected: the two local tools and the two remote ones each say so in the web's words.
        let (lone, _) = fixture("tools-lone").await;
        let auto = ctx(&lone.root, Approval::Auto);
        assert_eq!(call(&auto, &lone, Some(FAKE), "git_pull_base", no.clone()).await, (false, "GitHub is not connected to this workspace.".into(), "GitHub not connected".into()));
        assert_eq!(call(&auto, &lone, Some(FAKE), "github_pr_status", no.clone()).await.1, "GitHub is not connected to this workspace.");
        assert_eq!(call(&auto, &lone, Some(FAKE), "github_push", no.clone()).await, (false, NOT_CONNECTED.into(), "GitHub not connected".into()));
        assert_eq!(call(&auto, &lone, Some(FAKE), "github_create_pr", no.clone()).await.1, NOT_CONNECTED);

        let (ws, remote, c) = connected("tools").await;
        let branch = c.working_branch.as_str();
        let (auto, manual) = (ctx(&ws.root, Approval::Auto), ctx(&ws.root, Approval::Manual));
        commit(&ws.root, "login.txt", "fixed\n").await;

        // Connected but no token.
        assert_eq!(call(&auto, &ws, None, "github_push", no.clone()).await.1, NOT_CONNECTED);
        assert_eq!(call(&auto, &ws, None, "github_create_pr", json!({ "title": "x" })).await.1, NOT_CONNECTED);
        assert_eq!(call(&auto, &ws, None, "github_pr_status", no.clone()).await, (false, "github_pr_status failed: GitHub token missing — reconnect GitHub in the connector".into(), "github_pr_status failed".into()));

        // Declined approvals: nothing is pushed, nothing is opened.
        assert_eq!(call(&manual, &ws, Some(FAKE), "github_push", json!({ "reason": "ready" })).await, (false, "The GitHub push was not run. Do not retry until the user asks.".into(), "GitHub push skipped".into()));
        assert_eq!(call(&manual, &ws, Some(FAKE), "github_create_pr", json!({ "title": "Fix login", "body": "b" })).await, (false, "The pull request was not opened. Do not retry until the user asks.".into(), "Pull request skipped".into()));
        assert!(seen.lock().unwrap().is_empty() && !sh(std::path::Path::new(&remote), &["--git-dir", ".", "branch"]).await.contains("apim/"));

        assert_eq!(call(&auto, &ws, Some(FAKE), "github_pr_status", no.clone()).await, (true, "No pull request exists for this branch yet.".into(), "No PR".into()));
        assert_eq!(call(&auto, &ws, Some(FAKE), "github_create_pr", json!({ "title": "  ", "body": "b" })).await, (false, "Could not open the pull request: A pull request title is required".into(), "Pull request failed".into()));

        // Opening the pull request pushes the branch first; a second call finds the open one and pushes nothing.
        assert_eq!(call(&auto, &ws, Some(FAKE), "github_create_pr", json!({ "title": " Fix login ", "body": "What changed" })).await, (true, "Opened pull request #7: https://github.com/octo/demo/pull/7\napim/work → main (open)\nPushed the branch first.".into(), "PR #7".into()));
        assert!(sh(std::path::Path::new(&remote), &["--git-dir", ".", "branch"]).await.contains(branch));
        assert_eq!(call(&auto, &ws, Some(FAKE), "github_create_pr", json!({ "title": "Fix login", "body": "" })).await, (true, "A pull request already exists #7: https://github.com/octo/demo/pull/7\napim/work → main (open)".into(), "PR #7 (existing)".into()));
        let stored = github::read_connection(&ws).unwrap();
        assert_eq!((stored.pr_number, stored.pr_url.as_deref(), stored.pr_branch.as_deref()), (Some(7), Some("https://github.com/octo/demo/pull/7"), Some(branch)));

        let (ok, text, summary) = call(&auto, &ws, Some(FAKE), "github_push", json!({ "reason": "ready" })).await;
        assert!(ok && text.starts_with(&format!("Pushed committed work to octo/demo branch {branch}.\n\n")) && summary == format!("Pushed {branch}"), "{text}");
        assert_eq!(call(&auto, &ws, Some(FAKE), "github_pr_status", no.clone()).await, (true, "PR #7 https://github.com/octo/demo/pull/7\nState: open · apim/work → main\nMergeable: yes (clean)\nChecks: 1 passed, 1 failed, 1 pending\nFailing: lint (failure)\nReview comments: 2 · conversation comments: 1".into(), "PR #7 open".into()));

        // The base: up to date, then one upstream commit merged, then a conflict that is aborted and reported.
        assert_eq!(call(&auto, &ws, Some(FAKE), "git_pull_base", no.clone()).await, (true, "Already up to date with origin/main.".into(), "Up to date".into()));
        upstream(&remote, "other.txt", "theirs\n").await;
        let (ok, text, summary) = call(&auto, &ws, Some(FAKE), "git_pull_base", no.clone()).await;
        assert!(ok && summary == "Merged base" && text.starts_with(&format!("Merged 1 commit from origin/main into {branch} (now ")) && ws.root.join("other.txt").exists(), "{text}");
        assert_eq!(sh(&ws.root, &["log", "-1", "--pretty=%an <%ae>"]).await.trim(), "apiM Agent <apim-agent@users.noreply.github.com>", "the merge commit is the agent's");
        upstream(&remote, "login.txt", "theirs\n").await;
        commit(&ws.root, "login.txt", "ours\n").await;
        assert_eq!(call(&auto, &ws, Some(FAKE), "git_pull_base", no.clone()).await, (false, format!("Merging origin/main into {branch} conflicts in: login.txt. The merge was aborted; the branch is unchanged. Resolve by editing those files to match the base, committing, then git_pull_base again — or tell the user."), "Merge conflicts (1)".into()));
        assert_eq!(sh(&ws.root, &["status", "--porcelain"]).await, "", "no half-merged tree is left behind");
        std::fs::write(ws.root.join("login.txt"), "edited\n").unwrap();
        assert_eq!(call(&auto, &ws, Some(FAKE), "git_pull_base", no.clone()).await, (false, "git_pull_base failed: Commit (git_commit) or discard your uncommitted changes before git_pull_base".into(), "git_pull_base failed".into()));

        // Refusals surface as failures, still without the token.
        sh(&ws.root, &["remote", "set-url", "origin", &format!("{remote}/elsewhere")]).await;
        assert_eq!(call(&auto, &ws, Some(FAKE), "github_push", no.clone()).await, (false, "GitHub push failed: Push refused: origin no longer matches the connected repository".into(), "GitHub push failed".into()));
        assert_eq!(call(&auto, &ws, Some(FAKE), "github_fork", no.clone()).await.1, "Unknown git tool github_fork");

        assert!(all.len() >= 20 && all.iter().all(|o| !leaks(&o.text) && !leaks(&o.summary)), "a tool result carried the token");
        let seen = seen.lock().unwrap();
        assert!(!seen.is_empty() && seen.iter().all(|(line, auth)| !leaks(line) && auth.contains(FAKE)), "the token goes to the API in the header only");
    }
}

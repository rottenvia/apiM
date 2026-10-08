//! Git work on a connected repository's working branch: merging the latest base, and its pull request.
//! A port of the web app's `src/lib/git-agent.ts`.
//!
//! Everything here reads the stored connection first and refuses to merge into, or push, the base branch. Nothing
//! force-pushes. The token only ever goes to `run_git` (as environment) or to `Api` (as the Authorization header).
// ponytail: git_status, git_diff, git_log, git_commit and git_branch keep the desktop's own wording (tools/git.rs)
// instead of git-agent.ts's; they only learn the connection's base branch and follow branch switches.

use crate::github::{self, Api, Connection, Ws, read_connection, run_git, write_connection};
use serde_json::{Value, json};
use std::path::Path;

async fn git(root: &Path, args: &[&str], token: Option<&str>) -> Result<String, String> {
    Ok(run_git(root, args, token, 180).await?.0)
}

fn context(ws: &Ws) -> Result<Connection, String> {
    read_connection(ws).ok_or_else(|| "No GitHub repository is connected to this workspace".to_string())
}

async fn current_branch(root: &Path) -> Result<String, String> {
    Ok(git(root, &["branch", "--show-current"], None).await?.trim().to_string())
}

fn refuse_base(branch: &str, c: &Connection, what: &str) -> Result<(), String> {
    if branch.is_empty() {
        return Err(format!("{what} refused: HEAD is detached — switch to a working branch first"));
    }
    if branch == c.base_branch {
        return Err(format!("{what} refused: {branch} is the base branch. Work on {} (or git_branch create) instead.", c.working_branch));
    }
    Ok(())
}

/// (ahead, behind): commits on HEAD that `left` lacks, and the reverse. Zeros when git cannot tell.
pub async fn ahead_behind(root: &Path, left: &str) -> (u32, u32) {
    let out = git(root, &["rev-list", "--left-right", "--count", &format!("{left}...HEAD")], None).await.unwrap_or_default();
    let mut counts = out.split_whitespace().map(|n| n.parse().unwrap_or(0));
    let behind = counts.next().unwrap_or(0);
    (counts.next().unwrap_or(0), behind)
}

/// The working branch moved (git_branch): push and pull request follow it, and a pull request remembered for
/// another branch is forgotten.
pub fn follow_branch(ws: &Ws, name: &str) {
    let Some(mut c) = read_connection(ws) else { return };
    c.working_branch = name.to_string();
    if c.pr_branch.as_deref().is_some_and(|b| b != name) {
        (c.pr_url, c.pr_number, c.pr_branch) = (None, None, None);
    }
    let _ = write_connection(ws, &c);
}

/// How merging the base went. `conflicts` is empty unless the merge was aborted for them.
pub struct Pulled {
    pub merged: bool,
    pub conflicts: Vec<String>,
    pub text: String,
}

/// Fetches origin and merges the latest base into the working branch. Needs a clean tree; a conflicting merge is
/// aborted, so a half-merged tree is never left behind.
pub async fn pull_base(ws: &Ws, token: Option<&str>) -> Result<Pulled, String> {
    let (c, root) = (context(ws)?, &ws.root);
    let branch = current_branch(root).await?;
    refuse_base(&branch, &c, "Merging the base")?;
    if !git(root, &["status", "--porcelain", "--untracked-files=no"], None).await?.trim().is_empty() {
        return Err("Commit (git_commit) or discard your uncommitted changes before git_pull_base".into());
    }
    git(root, &["fetch", "--no-tags", "origin", &c.base_branch], token).await?;
    let base_ref = format!("origin/{}", c.base_branch);
    let (_, behind) = ahead_behind(root, &base_ref).await;
    if behind == 0 {
        return Ok(Pulled { merged: false, conflicts: Vec::new(), text: format!("Already up to date with {base_ref}.") });
    }
    if let Err(error) = git(root, &["merge", "--no-edit", "--no-verify", &base_ref], None).await {
        let conflicts: Vec<String> = git(root, &["diff", "--name-only", "--diff-filter=U"], None).await.unwrap_or_default().lines().filter(|l| !l.is_empty()).map(str::to_string).collect();
        if git(root, &["merge", "--abort"], None).await.is_err() {
            let _ = git(root, &["reset", "--merge"], None).await;
        }
        if conflicts.is_empty() {
            return Err(error);
        }
        let text = format!("Merging {base_ref} into {branch} conflicts in: {}. The merge was aborted; the branch is unchanged. Resolve by editing those files to match the base, committing, then git_pull_base again — or tell the user.", conflicts.join(", "));
        return Ok(Pulled { merged: false, conflicts, text });
    }
    let head = git(root, &["rev-parse", "--short", "HEAD"], None).await?.trim().to_string();
    Ok(Pulled { merged: true, conflicts: Vec::new(), text: format!("Merged {behind} commit{} from {base_ref} into {branch} (now {head}).", if behind == 1 { "" } else { "s" }) })
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Pr {
    pub number: u64,
    pub url: String,
    pub state: String,
    pub draft: bool,
    pub title: String,
    pub head: String,
    pub base: String,
    /// This call found an existing pull request instead of opening one.
    pub existing: bool,
}

fn to_pr(row: &Value) -> Pr {
    let text = |v: &Value| v.as_str().unwrap_or("").to_string();
    let state = if row["merged_at"].as_str().is_some_and(|at| !at.is_empty()) { "merged".to_string() } else { row["state"].as_str().unwrap_or("open").to_string() };
    Pr { number: row["number"].as_u64().unwrap_or(0), url: text(&row["html_url"]), state, draft: row["draft"] == true, title: text(&row["title"]), head: text(&row["head"]["ref"]), base: text(&row["base"]["ref"]), existing: false }
}

/// `encodeURIComponent`.
fn enc(text: &str) -> String {
    text.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

async fn find_pr(api: &Api, c: &Connection, state: &str) -> Result<Option<Value>, String> {
    let owner = c.repo.split('/').next().unwrap_or("");
    let rows = api.get(&format!("/repos/{}/pulls?head={}&state={state}&per_page=5", c.repo, enc(&format!("{owner}:{}", c.working_branch)))).await?;
    Ok(rows.get(0).filter(|row| row.is_object()).cloned())
}

/// Does origin lack this branch, or lack commits HEAD has?
pub async fn needs_push(ws: &Ws, token: Option<&str>) -> Result<bool, String> {
    let c = context(ws)?;
    let remote = git(&ws.root, &["ls-remote", "--heads", "origin", &format!("refs/heads/{}", c.working_branch)], token).await?;
    let Some(sha) = remote.split_whitespace().next() else { return Ok(true) };
    Ok(sha != git(&ws.root, &["rev-parse", "HEAD"], None).await?.trim())
}

fn remember_pr(ws: &Ws, c: &Connection, pr: &Pr) -> Result<(), String> {
    let fresh = read_connection(ws).unwrap_or_else(|| c.clone());
    write_connection(ws, &Connection { pr_url: Some(pr.url.clone()), pr_number: Some(pr.number), pr_branch: Some(c.working_branch.clone()), ..fresh })
}

/// Opens a pull request from the working branch into the base, pushing first when origin is behind (never forced).
/// Gives back the pull request, or the one already open, and whether a push happened.
pub async fn create_pr(ws: &Ws, api: &Api, title: &str, body: &str, draft: bool) -> Result<(Pr, bool), String> {
    let (c, root) = (context(ws)?, &ws.root);
    let title = title.trim();
    if title.is_empty() {
        return Err("A pull request title is required".into());
    }
    if c.working_branch == c.base_branch {
        return Err("Pull request refused: the working branch is the base branch".into());
    }
    let branch = current_branch(root).await?;
    if branch != c.working_branch {
        return Err(format!("Current branch is {}, expected {}", if branch.is_empty() { "detached" } else { &branch }, c.working_branch));
    }
    if ahead_behind(root, &format!("origin/{}", c.base_branch)).await.0 == 0 {
        return Err(format!("No commits on {branch} beyond {} — commit work with git_commit first", c.base_branch));
    }
    let mut pushed = false;
    if needs_push(ws, Some(&api.token)).await? {
        github::push(ws, &api.token).await?;
        pushed = true;
    }
    let existing = |row: &Value| Pr { existing: true, ..to_pr(row) };
    let take = |text: &str, max: usize| text.chars().take(max).collect::<String>();
    let pr = match find_pr(api, &c, "open").await? {
        Some(row) => existing(&row),
        None => match api.post(&format!("/repos/{}/pulls", c.repo), &json!({ "title": take(title, 256), "body": take(body, 60_000), "head": c.working_branch, "base": c.base_branch, "draft": draft })).await {
            Ok(row) => to_pr(&row),
            // 422 "A pull request already exists": a race, or one the search missed.
            Err(error) if error.starts_with("GitHub returned 422") => match find_pr(api, &c, "open").await? {
                Some(row) => existing(&row),
                None => return Err(error),
            },
            Err(error) => return Err(error),
        },
    };
    remember_pr(ws, &c, &pr)?;
    Ok((pr, pushed))
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Checks {
    pub total: u32,
    pub passed: u32,
    pub failed: u32,
    pub pending: u32,
    pub failing: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PrStatus {
    pub pr: Pr,
    /// None while GitHub is still computing it.
    pub mergeable: Option<bool>,
    pub mergeable_state: String,
    pub checks: Checks,
    pub review_comments: u64,
    pub comments: u64,
}

/// The working branch's pull request with its checks, or None when there is none yet.
pub async fn pr_status(ws: &Ws, api: &Api) -> Result<Option<PrStatus>, String> {
    let c = context(ws)?;
    let mut number = if c.pr_branch.as_deref() == Some(c.working_branch.as_str()) { c.pr_number.unwrap_or(0) } else { 0 };
    if number == 0 {
        let Some(found) = find_pr(api, &c, "all").await? else { return Ok(None) };
        number = found["number"].as_u64().unwrap_or(0);
    }
    let row = api.get(&format!("/repos/{}/pulls/{number}", c.repo)).await?;
    let pr = to_pr(&row);
    if c.pr_number != Some(pr.number) {
        remember_pr(ws, &c, &pr)?;
    }
    let mut checks = Checks::default();
    if let Some(sha) = row["head"]["sha"].as_str().filter(|sha| !sha.is_empty()) {
        let runs = api.get(&format!("/repos/{}/commits/{sha}/check-runs?per_page=100", c.repo)).await.unwrap_or_default();
        for run in runs["check_runs"].as_array().into_iter().flatten() {
            checks.total += 1;
            let conclusion = run["conclusion"].as_str().unwrap_or("");
            if run["status"] != "completed" {
                checks.pending += 1;
            } else if ["success", "neutral", "skipped"].contains(&conclusion) {
                checks.passed += 1;
            } else {
                checks.failed += 1;
                checks.failing.push(format!("{} ({conclusion})", run["name"].as_str().unwrap_or("check")));
            }
        }
    }
    Ok(Some(PrStatus { pr, mergeable: row["mergeable"].as_bool(), mergeable_state: row["mergeable_state"].as_str().unwrap_or("unknown").to_string(), checks, review_comments: row["review_comments"].as_u64().unwrap_or(0), comments: row["comments"].as_u64().unwrap_or(0) }))
}

pub fn format_pr_status(s: &PrStatus) -> String {
    let c = &s.checks;
    let mergeable = match s.mergeable {
        None => "unknown (GitHub is still computing)",
        Some(true) => "yes",
        Some(false) => "no",
    };
    let checks = if c.total == 0 { "none reported".to_string() } else { format!("{} passed, {} failed, {} pending", c.passed, c.failed, c.pending) };
    let failing = if c.failing.is_empty() { String::new() } else { format!("\nFailing: {}", c.failing.iter().take(10).map(String::as_str).collect::<Vec<_>>().join(", ")) };
    format!(
        "PR #{} {}\nState: {}{} · {} → {}\nMergeable: {mergeable} ({})\nChecks: {checks}{failing}\nReview comments: {} · conversation comments: {}",
        s.pr.number,
        s.pr.url,
        s.pr.state,
        if s.pr.draft { " (draft)" } else { "" },
        s.pr.head,
        s.pr.base,
        s.mergeable_state,
        s.review_comments,
        s.comments
    )
}

/// A title and body from the branch's commits since the base, for the connector's "Create pull request" form:
/// (title, body, number of commits). Local only.
pub async fn suggest_pr(ws: &Ws) -> Result<(String, String, usize), String> {
    let c = context(ws)?;
    let out = git(&ws.root, &["log", "--reverse", "--pretty=format:%s", &format!("origin/{}..HEAD", c.base_branch)], None).await.unwrap_or_default();
    let subjects: Vec<&str> = out.lines().map(str::trim).filter(|s| !s.is_empty()).collect();
    let title = match subjects.last() {
        Some(last) => last.to_string(),
        None => {
            // "apim/fix-the-login-a1b2c3" reads as "Fix the login".
            let name = c.working_branch.strip_prefix("apim/").unwrap_or(&c.working_branch);
            let id_at = name.len().saturating_sub(7);
            let has_id = name.is_char_boundary(id_at) && name[id_at..].starts_with('-') && name.len() >= 7 && name[id_at + 1..].bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
            let words = if has_id { &name[..id_at] } else { name }.split(['-', '_', '/']).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
            let mut letters = words.chars();
            letters.next().map(|first| first.to_uppercase().chain(letters).collect()).unwrap_or_default()
        }
    };
    let last_30 = &subjects[subjects.len().saturating_sub(30)..];
    let body = if subjects.is_empty() { String::new() } else { format!("## Changes\n\n{}\n", last_30.iter().map(|s| format!("- {s}")).collect::<Vec<_>>().join("\n")) };
    Ok((title.chars().take(256).collect(), body, subjects.len()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::tests::{connected, sh};

    #[test]
    fn pr_status_reads_like_the_web() {
        let pr = Pr { number: 7, url: "https://github.com/octo/demo/pull/7".into(), state: "open".into(), draft: true, head: "apim/x".into(), base: "main".into(), ..Default::default() };
        let quiet = PrStatus { pr: pr.clone(), mergeable_state: "unknown".into(), ..Default::default() };
        assert_eq!(format_pr_status(&quiet), "PR #7 https://github.com/octo/demo/pull/7\nState: open (draft) · apim/x → main\nMergeable: unknown (GitHub is still computing) (unknown)\nChecks: none reported\nReview comments: 0 · conversation comments: 0");
        let busy = PrStatus { mergeable: Some(false), mergeable_state: "dirty".into(), checks: Checks { total: 3, passed: 1, failed: 1, pending: 1, failing: vec!["lint (failure)".into()] }, review_comments: 2, comments: 1, pr: Pr { draft: false, ..pr } };
        assert!(format_pr_status(&busy).ends_with("State: open · apim/x → main\nMergeable: no (dirty)\nChecks: 1 passed, 1 failed, 1 pending\nFailing: lint (failure)\nReview comments: 2 · conversation comments: 1"));
        assert_eq!(enc("octo:apim/fix it"), "octo%3Aapim%2Ffix%20it");
        assert_eq!(to_pr(&json!({ "number": 3, "state": "closed", "merged_at": "2026-01-01T00:00:00Z", "head": { "ref": "a" } })).state, "merged");
    }

    #[tokio::test]
    async fn suggestions_come_from_commits_and_the_connection_follows_the_branch() {
        let (ws, _remote, c) = connected("agent").await;
        assert_eq!(suggest_pr(&ws).await.unwrap(), ("Fix the login".to_string(), String::new(), 0));
        for (file, subject) in [("a.txt", "Add a"), ("b.txt", "Add b")] {
            std::fs::write(ws.root.join(file), "x\n").unwrap();
            sh(&ws.root, &["add", "-A"]).await;
            sh(&ws.root, &["commit", "-q", "-m", subject]).await;
        }
        assert_eq!(suggest_pr(&ws).await.unwrap(), ("Add b".to_string(), "## Changes\n\n- Add a\n- Add b\n".to_string(), 2));
        assert_eq!(ahead_behind(&ws.root, "origin/main").await, (2, 0));
        assert!(needs_push(&ws, None).await.unwrap(), "the branch is not on origin yet");

        let pr = Pr { number: 4, url: "https://github.com/octo/demo/pull/4".into(), ..Default::default() };
        remember_pr(&ws, &c, &pr).unwrap();
        follow_branch(&ws, &c.working_branch);
        assert_eq!(read_connection(&ws).unwrap().pr_number, Some(4), "same branch keeps its pull request");
        follow_branch(&ws, "apim/next");
        let moved = read_connection(&ws).unwrap();
        assert_eq!((moved.working_branch.as_str(), moved.pr_url, moved.pr_number, moved.pr_branch), ("apim/next", None, None, None));
        assert_eq!(refuse_base("main", &c, "Merging the base").unwrap_err(), format!("Merging the base refused: main is the base branch. Work on {} (or git_branch create) instead.", c.working_branch));
    }
}

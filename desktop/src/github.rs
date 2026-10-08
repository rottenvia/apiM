//! GitHub for a chat's workspace: the token, the REST calls, the clone that becomes the workspace, and the push.
//! A port of the web app's `src/lib/github.ts`.
//!
//! Connecting is by Personal Access Token only. The token is kept in the desktop settings file (the web app keeps
//! its copy in the browser), or comes from `GITHUB_TOKEN` / `GITHUB_PAT`, which both apps honour. The repository
//! connection itself is the same file the web app writes, `<data>/github/workspaces/<id>.json`, so a repository
//! connected in one app is connected in the other.
// ponytail: no OAuth sign-in. It needs the web server's registered app, client secret and callback; the dialog offers the token path only.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

pub const API: &str = "https://api.github.com";

/// One chat's workspace: its id (the folder name both apps use), its folder, and the data root the connection file lives under.
#[derive(Clone, Debug, Default)]
pub struct Ws {
    pub id: String,
    pub root: PathBuf,
    pub data: PathBuf,
}

/// How to reach the GitHub REST API. `base` is a field so tests can point at a local stub.
#[derive(Clone)]
pub struct Api {
    pub client: reqwest::Client,
    pub base: String,
    pub token: String,
}

/// A token from the environment, used with nothing saved.
pub fn env_token() -> Option<String> {
    ["GITHUB_TOKEN", "GITHUB_PAT"].iter().filter_map(|k| std::env::var(k).ok()).map(|v| v.trim().to_string()).find(|v| !v.is_empty())
}

/// Does this look like a GitHub access token? The prefixed kinds (`ghp_…`, `github_pat_…`) and bare legacy tokens
/// are all 20 or more letters, digits and underscores; a pasted sentence is not, and must never be sent as a header.
pub fn looks_like_token(value: &str) -> bool {
    let t = value.trim();
    t.len() >= 20 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// The token to use: the saved one, else the environment's. A saved value that is not token-shaped is an error.
pub fn resolve_token(saved: &str) -> Result<Option<String>, String> {
    let saved = saved.trim();
    if saved.is_empty() {
        return Ok(env_token());
    }
    if looks_like_token(saved) { Ok(Some(saved.to_string())) } else { Err("That does not look like a GitHub access token.".into()) }
}

pub fn assert_repo(repo: &str) -> Result<String, String> {
    let clean = repo.trim();
    let parts: Vec<&str> = clean.split('/').collect();
    let owner_ok = |o: &str| (1..=39).contains(&o.len()) && o.as_bytes()[0].is_ascii_alphanumeric() && o.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    let name_ok = |n: &str| (1..=100).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b)) && n != "." && n != "..";
    if parts.len() == 2 && owner_ok(parts[0]) && name_ok(parts[1]) { Ok(clean.to_string()) } else { Err("Invalid GitHub repository name".into()) }
}

pub fn assert_branch(branch: &str) -> Result<String, String> {
    let clean = branch.trim();
    let bad = clean.is_empty() || clean.len() > 180 || clean.starts_with('-') || clean.contains("..") || clean.chars().any(|c| "~^:?*[\\".contains(c) || c.is_whitespace()) || clean.ends_with('/') || clean.ends_with(".lock");
    if bad { Err("Invalid Git branch name".into()) } else { Ok(clean.to_string()) }
}

impl Api {
    pub fn new(token: &str) -> Api {
        Api { client: crate::provider::client(), base: API.into(), token: token.to_string() }
    }
    pub async fn get(&self, path: &str) -> Result<Value, String> {
        self.send(reqwest::Method::GET, path, None).await
    }
    pub async fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        self.send(reqwest::Method::POST, path, Some(body)).await
    }
    /// The token travels in the Authorization header only, never in the URL.
    async fn send(&self, method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<Value, String> {
        let mut req = self.client.request(method, format!("{}{path}", self.base)).header("Accept", "application/vnd.github+json").bearer_auth(&self.token).header("X-GitHub-Api-Version", "2022-11-28").header("User-Agent", "apiM-github-connector").timeout(Duration::from_secs(30));
        if let Some(body) = body {
            req = req.json(body);
        }
        let res = req.send().await.map_err(|e| format!("fetch failed: {}", e.without_url()))?;
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            let body: String = text.chars().take(180).collect();
            return Err(if body.is_empty() { format!("GitHub returned {status}") } else { format!("GitHub returned {status}: {body}") });
        }
        serde_json::from_str(&text).map_err(|e| format!("GitHub sent a reply that is not JSON: {e}"))
    }
}

/// Who the token belongs to. An error means the token did not authenticate.
pub async fn login(api: &Api) -> Result<String, String> {
    Ok(api.get("/user").await?["login"].as_str().unwrap_or("GitHub user").to_string())
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Repo {
    pub full_name: String,
    pub private: bool,
    pub default_branch: String,
}

/// The 100 most recently updated repositories the token can reach.
pub async fn list_repos(api: &Api) -> Result<Vec<Repo>, String> {
    let rows = api.get("/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member").await?;
    let text = |v: &Value| v.as_str().unwrap_or("").to_string();
    Ok(rows
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| row["clone_url"].as_str().is_some_and(|u| u.starts_with("https://github.com/")))
        .map(|row| Repo { full_name: text(&row["full_name"]), private: row["private"] == true, default_branch: row["default_branch"].as_str().unwrap_or("main").to_string() })
        .filter(|repo| !repo.full_name.is_empty())
        .collect())
}

pub async fn list_branches(api: &Api, repo: &str) -> Result<Vec<String>, String> {
    let rows = api.get(&format!("/repos/{}/branches?per_page=100", assert_repo(repo)?)).await?;
    Ok(rows.as_array().into_iter().flatten().filter_map(|row| row["name"].as_str()).filter(|n| !n.is_empty()).map(str::to_string).collect())
}

/// What binds a workspace to a repository. Field names and order are the web app's.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Connection {
    pub workspace_id: String,
    pub repo: String,
    pub clone_url: String,
    pub base_branch: String,
    pub working_branch: String,
    pub connected_at: String,
    /// The pull request opened for `pr_branch` (the working branch at the time).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_number: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_branch: Option<String>,
}

fn metadata_path(ws: &Ws) -> Result<PathBuf, String> {
    let ok = (1..=128).contains(&ws.id.len()) && ws.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok { Ok(ws.data.join("github").join("workspaces").join(format!("{}.json", ws.id))) } else { Err("Invalid workspace id".into()) }
}

pub fn read_connection(ws: &Ws) -> Option<Connection> {
    let c: Connection = serde_json::from_slice(&std::fs::read(metadata_path(ws).ok()?).ok()?).ok()?;
    (!c.repo.is_empty() && !c.working_branch.is_empty()).then_some(c)
}

// ponytail: the file is not chmod 600 as on the web. It holds a repository and branch names, never the token.
pub fn write_connection(ws: &Ws, c: &Connection) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(c).map_err(|e| e.to_string())?;
    crate::store::write_atomic(&metadata_path(ws)?, &json).map_err(|e| format!("Could not save the GitHub connection: {e}"))
}

/// Forgets the connection ("Turn off"). The cloned files stay exactly where they are.
pub fn clear_connection(ws: &Ws) {
    if let Ok(path) = metadata_path(ws) {
        let _ = std::fs::remove_file(path);
    }
}

/// What git may see of our environment: a PATH, a home for its own config, temp, locale, proxy and CA settings.
/// API keys and everything else stay out of git and whatever git launches.
const GIT_ENV_KEYS: &[&str] = &[
    "PATH", "Path", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SystemRoot", "SYSTEMROOT", "windir", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
    "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE",
];

fn basic_auth(token: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"))
}

/// The whole environment git runs with. A token rides only here, as an `http.extraheader` for github.com handed
/// over in GIT_CONFIG_* variables: never an argument, never a remote URL, never written to a config file.
pub fn git_env(token: Option<&str>) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = GIT_ENV_KEYS.iter().filter_map(|k| Some((k.to_string(), std::env::var(k).ok()?))).collect();
    // No prompts, no LFS downloads, and merges and commits never open an editor.
    let fixed = [("GIT_TERMINAL_PROMPT", "0"), ("GIT_LFS_SKIP_SMUDGE", "1"), ("GIT_EDITOR", "true"), ("GIT_MERGE_AUTOEDIT", "no")];
    env.extend(fixed.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    if let Some(token) = token {
        let auth = [("GIT_CONFIG_COUNT", "2".to_string()), ("GIT_CONFIG_KEY_0", "credential.helper".to_string()), ("GIT_CONFIG_VALUE_0", String::new()), ("GIT_CONFIG_KEY_1", "http.https://github.com/.extraheader".to_string()), ("GIT_CONFIG_VALUE_1", format!("AUTHORIZATION: basic {}", basic_auth(token)))];
        env.extend(auth.into_iter().map(|(k, v)| (k.to_string(), v)));
    }
    env
}

/// The arguments git really gets: overrides that outrank the repository's own config, so a cloned repository can
/// never pick a program we run (no hooks, no fsmonitor, no external diff or textconv, no pager, no chosen ssh).
pub fn harden(args: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = ["core.fsmonitor=false", "core.hooksPath=/dev/null", "diff.external=", "core.pager=cat", "core.sshCommand=", "safe.bareRepository=explicit"].iter().flat_map(|c| ["-c".to_string(), c.to_string()]).collect();
    let sub = args.iter().position(|a| !a.starts_with('-'));
    for (i, arg) in args.iter().enumerate() {
        out.push(arg.to_string());
        if Some(i) == sub && matches!(*arg, "diff" | "log" | "show") {
            out.extend(["--no-ext-diff".to_string(), "--no-textconv".to_string()]);
        }
    }
    out
}

/// Blanks the token, and the base64 form git is given, out of anything git printed.
pub fn scrub(text: &str, token: Option<&str>) -> String {
    match token.filter(|t| !t.is_empty()) {
        Some(token) => text.replace(token, "***").replace(&basic_auth(token), "***"),
        None => text.to_string(),
    }
}

fn tail(text: &str, max: usize) -> String {
    let start = text.len().saturating_sub(max);
    text[(start..=text.len()).find(|&i| text.is_char_boundary(i)).unwrap_or(text.len())..].to_string()
}

/// Runs the `git` on PATH with no shell. Gives back (stdout, stderr), or what git said when it failed.
pub async fn run_git(cwd: &Path, args: &[&str], token: Option<&str>, timeout_secs: u64) -> Result<(String, String), String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(harden(args)).current_dir(cwd).stdin(Stdio::null()).env_clear().envs(git_env(token)).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let out = match tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(format!("Could not run git: {e}. Is Git installed and on PATH?")),
        Err(_) => return Err(format!("git {} timed out", args.first().unwrap_or(&""))),
    };
    let (stdout, stderr) = (scrub(&String::from_utf8_lossy(&out.stdout), token), scrub(&String::from_utf8_lossy(&out.stderr), token));
    if out.status.success() {
        return Ok((stdout, stderr));
    }
    let said = [stderr, stdout].into_iter().find(|s| !s.trim().is_empty()).unwrap_or_else(|| format!("git exited {}", out.status.code().unwrap_or(-1)));
    Err(tail(said.trim(), 2000))
}

async fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    Ok(run_git(root, args, None, 180).await?.0)
}

/// Lowercase, dash-separated, at most 40 characters: safe inside a branch name.
// ponytail: no NFKD step (that needs a Unicode table crate), so "é" becomes a dash where the web makes it "e".
pub fn branch_slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let cut: String = out.trim_matches('-').chars().take(40).collect();
    cut.trim_end_matches('-').to_string()
}

/// A fresh working branch, `apim/<slug of the task>-<short id>`; named after the workspace when there is no task.
pub fn working_branch_name(task: &str, workspace_id: &str) -> Result<String, String> {
    let from_id = branch_slug(&workspace_id.chars().take(8).collect::<String>());
    let slug = [branch_slug(task), from_id].into_iter().find(|s| !s.is_empty()).unwrap_or_else(|| "work".into());
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64);
    let mut n = now ^ u64::from(std::process::id()).rotate_left(40);
    let short: String = (0..6).map(|_| (b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize] as char, n /= 36).0).collect();
    assert_branch(&format!("apim/{slug}-{short}"))
}

/// What the connector asks for when it connects a repository.
#[derive(Clone, Debug, Default)]
pub struct Connect {
    pub repo: String,
    pub base_branch: String,
    /// Names the new working branch (the chat's title, or what the user typed).
    pub task: String,
    /// An existing remote branch to continue instead of creating a new one.
    pub continue_branch: String,
}

/// Looks the repository up on GitHub, then clones it into the workspace.
pub async fn connect(ws: &Ws, api: &Api, opt: &Connect) -> Result<Connection, String> {
    let repo = assert_repo(&opt.repo)?;
    let info = api.get(&format!("/repos/{repo}")).await?;
    let clone_url = info["clone_url"].as_str().unwrap_or("");
    if !clone_url.starts_with("https://github.com/") {
        return Err("GitHub did not return a valid clone URL".into());
    }
    clone_to_workspace(ws, Some(&api.token), clone_url, opt).await
}

/// Copies a tree without overwriting anything already there: the user's files win, the rest of the project is
/// filled in. Symlinks in the clone are skipped, never followed.
fn merge_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let (src, dst, kind) = (entry.path(), to.join(entry.file_name()), entry.file_type()?);
        let existing = std::fs::symlink_metadata(&dst).ok();
        if kind.is_dir() {
            if existing.is_none_or(|m| m.is_dir()) {
                merge_tree(&src, &dst)?;
            }
        } else if kind.is_file() && existing.is_none() {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Clones `clone_url` and lays it over the workspace on a dedicated working branch. Public on its own so tests can
/// use a local bare repository as the remote.
pub async fn clone_to_workspace(ws: &Ws, token: Option<&str>, clone_url: &str, opt: &Connect) -> Result<Connection, String> {
    let repo = assert_repo(&opt.repo)?;
    let base = assert_branch(&opt.base_branch)?;
    let cont = if opt.continue_branch.trim().is_empty() { String::new() } else { assert_branch(&opt.continue_branch)? };
    if !cont.is_empty() && cont == base {
        return Err("Pick a branch other than the base to continue — the base branch is never committed to".into());
    }
    let root = &ws.root;
    let has_files = std::fs::read_dir(root).is_ok_and(|dir| dir.flatten().any(|e| e.file_name() != ".git"));
    // A repository already in the workspace (a reconnect after "Turn off", an imported checkout) is never shadowed by the clone's.
    let (root_exists, root_has_git) = (root.exists(), root.join(".git").exists());
    let parent = root.parent().ok_or("The workspace folder has no parent folder")?;
    let temp = parent.join(format!("{}.github-{}", root.file_name().unwrap_or_default().to_string_lossy(), crate::store::new_id()));
    let working = if cont.is_empty() { working_branch_name(&opt.task, &ws.id)? } else { cont.clone() };
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let io = |e: std::io::Error| e.to_string();
    let identity = |dir: PathBuf| async move {
        let _ = git(&dir, &["config", "user.name", "apiM Agent"]).await;
        let _ = git(&dir, &["config", "user.email", "apim-agent@users.noreply.github.com"]).await;
    };
    let track = format!("origin/{working}");
    let attach = async {
        // A full clone into a temp folder next to the workspace. The token goes by environment only, so it never lands in git config.
        run_git(parent, &["clone", "--no-hardlinks", clone_url, &temp.to_string_lossy()], token, 600).await?;
        // The working branch is made in the clone, so checkout can never touch workspace files.
        let from_base = format!("origin/{base}");
        let checkout: Vec<&str> = if cont.is_empty() { vec!["checkout", "-b", &working, &from_base] } else { vec!["checkout", "-B", &working, "--track", &track] };
        run_git(&temp, &checkout, token, 180).await?;
        identity(temp.clone()).await;

        if root_has_git {
            // Keep the workspace's history and files as they are; only point origin at the connected repository.
            let remotes = git(root, &["remote"]).await.unwrap_or_default();
            let verb = if remotes.lines().any(|r| r == "origin") { "set-url" } else { "add" };
            git(root, &["remote", verb, "origin", clone_url]).await?;
            let _ = run_git(root, &["fetch", "origin"], token, 300).await;
            identity(root.clone()).await;
            // New branch: anchored at the current commit, so no file is touched. Continuing: git refuses if local edits would be lost.
            let onto: Vec<&str> = if cont.is_empty() { vec!["checkout", "-B", &working] } else { vec!["checkout", "-B", &working, "--track", &track] };
            git(root, &onto).await?;
        } else {
            if !root_exists {
                std::fs::create_dir_all(root).map_err(io)?;
            }
            // Only .git moves in: the project files filled in below are tracked, the user's own show up as changes.
            std::fs::rename(temp.join(".git"), root.join(".git")).map_err(io)?;
            identity(root.clone()).await;
            let _ = git(root, &["checkout", "-B", &working]).await;
            merge_tree(&temp, root).map_err(io)?;
            // Refresh the index so status is right. Nothing is committed here: the agent commits its own work.
            let _ = git(root, &["add", "-A", "--"]).await;
        }
        Ok::<(), String>(())
    };
    let done = attach.await;
    let _ = std::fs::remove_dir_all(&temp);
    if let Err(error) = done {
        // A half-attached repository in what was an empty, non-git workspace is removed so a retry starts clean.
        if !has_files && !root_has_git {
            let _ = std::fs::remove_dir_all(root.join(".git"));
        }
        return Err(error);
    }
    let connection = Connection { workspace_id: ws.id.clone(), repo, clone_url: clone_url.to_string(), base_branch: base, working_branch: working, connected_at: crate::store::iso(crate::store::now_ms()), ..Default::default() };
    write_connection(ws, &connection)?;
    Ok(connection)
}

/// Pushes the working branch, and only that. Never the base, never forced. Gives back the connection and what git said.
pub async fn push(ws: &Ws, token: &str) -> Result<(Connection, String), String> {
    let c = read_connection(ws).ok_or("No GitHub repository is connected to this workspace")?;
    if c.working_branch == c.base_branch {
        return Err("Push refused: the working branch is the base branch".into());
    }
    let branch = git(&ws.root, &["branch", "--show-current"]).await?.trim().to_string();
    if branch != c.working_branch {
        return Err(format!("Push refused: current branch is {}, expected {}", if branch.is_empty() { "detached" } else { &branch }, c.working_branch));
    }
    if git(&ws.root, &["remote", "get-url", "origin"]).await?.trim() != c.clone_url {
        return Err("Push refused: origin no longer matches the connected repository".into());
    }
    let (stdout, stderr) = run_git(&ws.root, &["push", "--set-upstream", "origin", &format!("HEAD:refs/heads/{}", c.working_branch)], Some(token), 300).await?;
    let said = if stderr.trim().is_empty() { stdout } else { stderr };
    Ok((c, said.trim().to_string()))
}

#[derive(Clone, Debug, PartialEq)]
pub struct FileChange {
    pub path: String,
    /// M modified, A added, D deleted, R renamed, C copied.
    pub status: char,
    pub additions: u32,
    pub deletions: u32,
}

/// What the workspace would change on GitHub relative to the base branch.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Changes {
    /// The stored connection as of this read: the agent may have switched branches.
    pub connection: Option<Connection>,
    /// Commits on the working branch that are not on the base yet.
    pub ahead: u32,
    pub files: Vec<FileChange>,
    pub total_additions: u32,
    pub total_deletions: u32,
    /// A unified diff, capped, for the review pane.
    pub diff: String,
    pub uncommitted: u32,
}

/// Compares the working branch (commits plus uncommitted edits) with the base. Local clone only: no token, no network.
pub async fn changes(ws: &Ws) -> Result<Changes, String> {
    let Some(connection) = read_connection(ws) else { return Ok(Changes::default()) };
    let root = &ws.root;
    let quiet = |args: Vec<String>| async move { git(root, &args.iter().map(String::as_str).collect::<Vec<_>>()).await.unwrap_or_default() };
    let status = git(root, &["status", "--porcelain"]).await?;
    let uncommitted = status.lines().filter(|l| !l.trim().is_empty()).count() as u32;
    let base_ref = format!("origin/{}", connection.base_branch);
    let ahead = quiet(vec!["rev-list".into(), "--count".into(), format!("{base_ref}..HEAD")]).await.trim().parse().unwrap_or(0);

    // Line counts for committed work, then for the working tree, so live edits show too.
    let mut files: BTreeMap<String, FileChange> = BTreeMap::new();
    for range in [format!("{base_ref}...HEAD"), base_ref.clone()] {
        for line in quiet(vec!["diff".into(), "--numstat".into(), range]).await.lines() {
            let parts: Vec<&str> = line.trim().split('\t').collect();
            if parts.len() < 3 {
                continue;
            }
            let (additions, deletions) = (parts[0].parse().unwrap_or(0), parts[1].parse().unwrap_or(0));
            let path = parts[2].rsplit(" -> ").next().unwrap_or(parts[2]).to_string();
            let entry = files.entry(path.clone()).or_insert(FileChange { path, status: if deletions == 0 { 'A' } else { 'M' }, additions: 0, deletions: 0 });
            (entry.additions, entry.deletions) = (entry.additions.max(additions), entry.deletions.max(deletions));
        }
    }
    for line in quiet(vec!["diff".into(), "--name-status".into(), base_ref.clone()]).await.lines() {
        let parts: Vec<&str> = line.trim().split('\t').collect();
        if let (true, Some(letter), Some(path)) = (parts.len() >= 2, parts[0].chars().next(), parts.last()) {
            files.entry(path.to_string()).or_insert(FileChange { path: path.to_string(), status: letter, additions: 0, deletions: 0 }).status = letter;
        }
    }
    // Brand-new files are not in `git diff`: list them as additions and render each as one in the diff.
    let untracked: Vec<&str> = status.lines().filter(|l| l.starts_with("??") && l.len() > 3).map(|l| l[3..].trim()).filter(|p| !p.is_empty()).collect();
    let mut diff = quiet(vec!["diff".into(), "--no-color".into(), "--unified=3".into(), base_ref]).await;
    for path in untracked {
        files.entry(path.to_string()).or_insert(FileChange { path: path.to_string(), status: 'A', additions: 0, deletions: 0 });
        // Binary or unreadable files are listed, not diffed.
        if let Ok(content) = std::fs::read_to_string(root.join(path)) {
            let body: Vec<String> = content.split('\n').map(|l| format!("+{l}")).collect();
            diff.push_str(&format!("\ndiff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n{}\n", body.join("\n")));
        }
    }
    let cut = (0..=diff.len().min(200_000)).rev().find(|&i| diff.is_char_boundary(i)).unwrap_or(0);
    diff.truncate(cut);
    let files: Vec<FileChange> = files.into_values().collect();
    Ok(Changes { connection: Some(connection), ahead, total_additions: files.iter().map(|f| f.additions).sum(), total_deletions: files.iter().map(|f| f.deletions).sum(), files, diff, uncommitted })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Invented for the tests. Never a real token.
    pub(crate) const FAKE: &str = "ghp_testFAKEtoken0123456789abcdefghijkl";

    /// Does this text carry the fake token, raw or in the form git is handed?
    pub(crate) fn leaks(text: &str) -> bool {
        text.contains(FAKE) || text.contains(&basic_auth(FAKE))
    }

    /// A GitHub stand-in on a free local port: `answer("GET /user", body)` gives (status, JSON). Every request line
    /// and its Authorization header are recorded.
    pub(crate) async fn stub(answer: impl Fn(&str, &str) -> (u16, Value) + Send + Sync + 'static) -> (String, Arc<Mutex<Vec<(String, String)>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (seen, answer) = (Arc::new(Mutex::new(Vec::new())), Arc::new(answer));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let (log, answer) = (log.clone(), answer.clone());
                tokio::spawn(async move {
                    let (mut got, mut chunk) = (Vec::new(), [0u8; 4096]);
                    let (head, body) = loop {
                        match socket.read(&mut chunk).await {
                            Ok(n) if n > 0 => got.extend_from_slice(&chunk[..n]),
                            _ => return,
                        }
                        let text = String::from_utf8_lossy(&got);
                        let Some((head, body)) = text.split_once("\r\n\r\n") else { continue };
                        let length = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:")?.trim().parse::<usize>().ok()).unwrap_or(0);
                        if body.len() >= length {
                            break (head.to_string(), body.to_string());
                        }
                    };
                    let line = head.lines().next().unwrap_or("").trim_end_matches(" HTTP/1.1").to_string();
                    let auth = head.lines().find(|l| l.to_ascii_lowercase().starts_with("authorization:")).unwrap_or("").to_string();
                    let (status, out) = answer(&line, &body);
                    log.lock().unwrap().push((line, auth));
                    let out = out.to_string();
                    let _ = socket.write_all(format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len()).as_bytes()).await;
                });
            }
        });
        (base, seen)
    }

    pub(crate) fn api(base: &str) -> Api {
        Api { client: reqwest::Client::builder().no_proxy().build().unwrap(), base: base.to_string(), token: FAKE.to_string() }
    }

    /// Git for test setup, with an identity of its own.
    pub(crate) async fn sh(dir: &Path, args: &[&str]) -> String {
        let all = [&["-c", "user.name=Tester", "-c", "user.email=tester@example.invalid", "-c", "commit.gpgsign=false"][..], args].concat();
        run_git(dir, &all, None, 120).await.unwrap_or_else(|e| panic!("git {args:?} failed: {e}")).0
    }

    /// Commits `file` on the remote's main branch, as someone else pushing to the base.
    pub(crate) async fn upstream(remote: &str, file: &str, content: &str) {
        let dir = PathBuf::from(format!("{remote}.other-{}", crate::store::new_id()));
        sh(dir.parent().unwrap(), &["clone", "-q", remote, &dir.to_string_lossy()]).await;
        std::fs::write(dir.join(file), content).unwrap();
        sh(&dir, &["add", "-A"]).await;
        sh(&dir, &["commit", "-q", "-m", &format!("Upstream change to {file}")]).await;
        sh(&dir, &["push", "-q", "origin", "HEAD:main"]).await;
    }

    /// A temp folder holding a bare "remote" with one commit on main, and an empty workspace to connect to it.
    pub(crate) async fn fixture(name: &str) -> (Ws, String) {
        let dir = std::env::temp_dir().join(format!("apim-gh-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("seed")).unwrap();
        let remote = dir.join("remote.git").to_string_lossy().replace('\\', "/");
        sh(&dir, &["init", "-q", "--bare", "-b", "main", "remote.git"]).await;
        sh(&dir, &["init", "-q", "-b", "main", "seed"]).await;
        std::fs::write(dir.join("seed/README.md"), "hello\n").unwrap();
        sh(&dir.join("seed"), &["add", "-A"]).await;
        sh(&dir.join("seed"), &["commit", "-q", "-m", "Initial commit"]).await;
        sh(&dir.join("seed"), &["push", "-q", &remote, "main"]).await;
        (Ws { id: "chat1".into(), root: dir.join("workspaces").join("chat1"), data: dir.join("data") }, remote)
    }

    /// Connects the fixture's workspace to its remote as `octo/demo`, and keeps commit signing out of the tests.
    pub(crate) async fn connected(name: &str) -> (Ws, String, Connection) {
        let (ws, remote) = fixture(name).await;
        let c = clone_to_workspace(&ws, Some(FAKE), &remote, &Connect { repo: "octo/demo".into(), base_branch: "main".into(), task: "Fix the Login!".into(), ..Default::default() }).await.unwrap();
        sh(&ws.root, &["config", "commit.gpgsign", "false"]).await;
        (ws, remote, c)
    }

    #[test]
    fn names_and_tokens_are_checked() {
        assert!(looks_like_token(FAKE) && looks_like_token(&format!("github_pat_{}", "a".repeat(40))));
        assert!(!looks_like_token("short") && !looks_like_token("this is a sentence, not a token at all"));
        assert_eq!(resolve_token(" not a token ").unwrap_err(), "That does not look like a GitHub access token.");
        assert_eq!(resolve_token(FAKE).unwrap().as_deref(), Some(FAKE));
        assert_eq!(assert_repo(" octo/demo.js ").unwrap(), "octo/demo.js");
        for bad in ["octo", "octo/demo/x", "-octo/demo", "octo/..", "octo/de mo", "/demo"] {
            assert_eq!(assert_repo(bad).unwrap_err(), "Invalid GitHub repository name", "{bad}");
        }
        assert_eq!(assert_branch("apim/fix-1").unwrap(), "apim/fix-1");
        for bad in ["", "-x", "a..b", "a b", "a~b", "x/", "x.lock", "a:b"] {
            assert_eq!(assert_branch(bad).unwrap_err(), "Invalid Git branch name", "{bad}");
        }
        assert_eq!(branch_slug("  Fix the Login!! (v2) "), "fix-the-login-v2");
        assert_eq!(branch_slug(&"word ".repeat(20)).len(), 39);
        let name = working_branch_name("", "My_Chat-1234").unwrap();
        assert!(name.starts_with("apim/my-chat-") && name.len() == "apim/my-chat-".len() + 6, "{name}");
        assert!(working_branch_name("", "___").unwrap().starts_with("apim/work-"));
    }

    #[test]
    fn git_gets_the_token_only_as_an_environment_header() {
        let env = git_env(Some(FAKE));
        assert!(env.iter().all(|(_, v)| !v.contains(FAKE)), "the raw token must not sit in git's environment");
        let value = |key: &str| env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
        assert_eq!(value("GIT_CONFIG_KEY_1"), Some("http.https://github.com/.extraheader"));
        assert_eq!(value("GIT_CONFIG_VALUE_1"), Some(format!("AUTHORIZATION: basic {}", basic_auth(FAKE)).as_str()));
        assert_eq!((value("GIT_CONFIG_KEY_0"), value("GIT_CONFIG_VALUE_0")), (Some("credential.helper"), Some("")));
        assert_eq!(value("GIT_TERMINAL_PROMPT"), Some("0"));
        // Nothing of ours beyond the allow-list reaches git, and with no token there is no credential config at all.
        assert!(env.iter().all(|(k, _)| GIT_ENV_KEYS.contains(&k.as_str()) || k.starts_with("GIT_")));
        assert!(git_env(None).iter().all(|(k, _)| !k.starts_with("GIT_CONFIG")));
        let args = harden(&["diff", "--cached"]);
        assert_eq!(&args[12..], ["diff", "--no-ext-diff", "--no-textconv", "--cached"]);
        assert!(args.contains(&"core.hooksPath=/dev/null".to_string()) && harden(&["push", "origin"]).ends_with(&["push".to_string(), "origin".to_string()]));
        assert_eq!(scrub(&format!("fatal: {FAKE} / {}", basic_auth(FAKE)), Some(FAKE)), "fatal: *** / ***");
    }

    #[tokio::test]
    async fn api_lists_repositories_and_reports_errors_in_the_webs_words() {
        let (base, seen) = stub(|req, _| match req {
            "GET /user" => (200, json!({ "login": "octocat" })),
            r if r.starts_with("GET /user/repos?per_page=100&sort=updated") => (200, json!([
                { "full_name": "octo/demo", "private": true, "default_branch": "trunk", "clone_url": "https://github.com/octo/demo.git" },
                { "full_name": "octo/elsewhere", "clone_url": "https://example.invalid/octo/elsewhere.git" },
                { "full_name": "octo/plain", "clone_url": "https://github.com/octo/plain.git" },
            ])),
            "GET /repos/octo/demo/branches?per_page=100" => (200, json!([{ "name": "trunk" }, { "name": "apim/old" }, {}])),
            "GET /repos/octo/odd" => (200, json!({ "clone_url": "https://example.invalid/octo/odd.git" })),
            _ => (401, json!({ "message": "Bad credentials" })),
        })
        .await;
        let api = api(&base);
        assert_eq!(login(&api).await.unwrap(), "octocat");
        let repos = list_repos(&api).await.unwrap();
        assert_eq!(repos, [Repo { full_name: "octo/demo".into(), private: true, default_branch: "trunk".into() }, Repo { full_name: "octo/plain".into(), private: false, default_branch: "main".into() }]);
        assert_eq!(list_branches(&api, "octo/demo").await.unwrap(), ["trunk", "apim/old"]);
        assert_eq!(list_branches(&api, "octo/none").await.unwrap_err(), r#"GitHub returned 401: {"message":"Bad credentials"}"#);
        assert_eq!(list_branches(&api, "not a repo").await.unwrap_err(), "Invalid GitHub repository name");
        // A clone URL that is not github.com is refused before git ever runs.
        let (ws, _) = fixture("api").await;
        let odd = connect(&ws, &api, &Connect { repo: "octo/odd".into(), base_branch: "main".into(), ..Default::default() }).await;
        assert_eq!(odd.unwrap_err(), "GitHub did not return a valid clone URL");
        let seen = seen.lock().unwrap();
        assert!(seen.iter().all(|(line, auth)| !leaks(line) && auth.eq_ignore_ascii_case(&format!("authorization: Bearer {FAKE}"))), "the token travels in the header only");
    }

    #[tokio::test]
    async fn clone_keeps_the_users_files_then_pushes_only_the_working_branch() {
        let (ws, remote) = fixture("clone").await;
        std::fs::create_dir_all(&ws.root).unwrap();
        std::fs::write(ws.root.join("notes.txt"), "mine\n").unwrap();
        std::fs::write(ws.root.join("README.md"), "my own readme\n").unwrap();
        let opt = Connect { repo: "octo/demo".into(), base_branch: "main".into(), task: "Fix the Login!".into(), ..Default::default() };
        assert_eq!(clone_to_workspace(&ws, Some(FAKE), &remote, &Connect { continue_branch: "main".into(), ..opt.clone() }).await.unwrap_err(), "Pick a branch other than the base to continue — the base branch is never committed to");
        let c = clone_to_workspace(&ws, Some(FAKE), &remote, &opt).await.unwrap();
        sh(&ws.root, &["config", "commit.gpgsign", "false"]).await;
        assert!(c.working_branch.starts_with("apim/fix-the-login-") && c.base_branch == "main" && c.repo == "octo/demo");
        assert_eq!(std::fs::read_to_string(ws.root.join("README.md")).unwrap(), "my own readme\n", "the user's copy wins");
        assert_eq!(sh(&ws.root, &["config", "--local", "user.name"]).await.trim(), "apiM Agent");
        assert_eq!(sh(&ws.root, &["config", "--local", "user.email"]).await.trim(), "apim-agent@users.noreply.github.com");

        // The connection file is the web app's shape, and neither it nor git's config holds the token.
        let stored = std::fs::read_to_string(ws.data.join("github/workspaces/chat1.json")).unwrap();
        let mut keys: Vec<String> = serde_json::from_str::<serde_json::Map<String, Value>>(&stored).unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["baseBranch", "cloneUrl", "connectedAt", "repo", "workingBranch", "workspaceId"]);
        assert_eq!(read_connection(&ws), Some(c.clone()));
        assert!(!leaks(&stored) && !leaks(&std::fs::read_to_string(ws.root.join(".git/config")).unwrap()));
        assert_eq!(sh(&ws.root, &["remote", "get-url", "origin"]).await.trim(), remote);
        let web_written = json!({ "workspaceId": "chat1", "repo": "octo/demo", "cloneUrl": remote, "baseBranch": "main", "workingBranch": "apim/x", "connectedAt": "2026-01-01T00:00:00.000Z", "prUrl": "https://github.com/octo/demo/pull/3", "prNumber": 3, "prBranch": "apim/x" });
        let parsed: Connection = serde_json::from_value(web_written).unwrap();
        assert_eq!((parsed.pr_number, parsed.pr_branch.as_deref()), (Some(3), Some("apim/x")));

        let before = changes(&ws).await.unwrap();
        assert_eq!((before.ahead, before.uncommitted), (0, 2));
        assert_eq!(before.files.iter().map(|f| (f.path.as_str(), f.status)).collect::<Vec<_>>(), [("README.md", 'M'), ("notes.txt", 'A')]);
        assert!(before.diff.contains("+my own readme") && (before.total_additions, before.total_deletions) == (2, 1));

        sh(&ws.root, &["commit", "-q", "-m", "Keep my files"]).await;
        std::fs::write(ws.root.join("new.txt"), "fresh\n").unwrap();
        let after = changes(&ws).await.unwrap();
        assert!(after.ahead == 1 && after.uncommitted == 1 && after.diff.contains("+++ b/new.txt\n+fresh"));
        let (pushed, said) = push(&ws, FAKE).await.unwrap();
        assert!(pushed == c && !leaks(&said));
        assert_eq!(sh(Path::new(&remote), &["--git-dir", ".", "branch", "--format=%(refname:short)"]).await.lines().collect::<Vec<_>>(), [c.working_branch.as_str(), "main"]);

        sh(&ws.root, &["checkout", "-q", "-b", "apim/elsewhere"]).await;
        assert_eq!(push(&ws, FAKE).await.unwrap_err(), format!("Push refused: current branch is apim/elsewhere, expected {}", c.working_branch));
        write_connection(&ws, &Connection { base_branch: c.working_branch.clone(), ..c.clone() }).unwrap();
        assert_eq!(push(&ws, FAKE).await.unwrap_err(), "Push refused: the working branch is the base branch");
        clear_connection(&ws);
        assert_eq!(push(&ws, FAKE).await.unwrap_err(), "No GitHub repository is connected to this workspace");
        assert!(ws.root.join("notes.txt").exists() && changes(&ws).await.unwrap() == Changes::default(), "turning off keeps the files");
    }
}

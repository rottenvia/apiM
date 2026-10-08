//! The agent's browser stays separate from the user's. Port of browser-policy.ts
//! (command rules and prompts) and the request rule in browser-playwright.ts.
//!
//! Three command rules: never kill a browser, never attach to a real profile,
//! never open a visible window. Each rewrites the command where a safe form
//! exists and refuses with an explanation where it does not.
//!
//! ponytail: checkBrowserPolicy is not yet called from exec.rs (run_command and
//! start_process). Wire it in there when exec.rs is free to edit.

use regex::Regex;
use std::path::Path;

/// Where an agent-launched browser keeps its profile, inside the workspace.
pub const AGENT_PROFILE_DIR: &str = ".agent-browser";

const BROWSER_NAMES: [&str; 10] = ["chrome", "chromium", "msedge", "edge", "firefox", "brave", "opera", "thorium", "safari", "iexplore"];
const KILLERS: [&str; 6] = ["taskkill", "kill", "killall", "pkill", "wmic", "stop-process"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Allow,
    Rewrite,
    Refuse,
}

/// "allow" leaves the command as it is, "rewrite" runs `args` instead, "refuse" does not run.
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub action: Action,
    pub args: Vec<String>,
    /// Shown to the model, and to the user on the approval prompt.
    pub reason: Option<String>,
}

fn looks_like_browser(text: &str) -> bool {
    let lower = text.to_lowercase();
    BROWSER_NAMES.iter().any(|b| {
        lower == *b
            || lower.ends_with(&format!("/{b}"))
            || lower.ends_with(&format!("\\{b}"))
            || lower.contains(&format!("{b}.exe"))
            || lower.contains(&format!("{b}-stable"))
            // A whole word anywhere, so "Google Chrome" and "Brave Browser" match but "chromeo" does not.
            || Regex::new(&format!(r"(^|[^a-z0-9]){b}([^a-z0-9]|$)")).is_ok_and(|re| re.is_match(&lower))
    })
}

/// Does this argument point at a real, human-owned browser profile?
/// Anything under the workspace's own profile dir is the agent's; the rest is the user's.
fn is_user_profile_path(value: &str) -> bool {
    let v = value.to_lowercase().replace('\\', "/");
    if v.contains(AGENT_PROFILE_DIR) {
        return false;
    }
    let profile_name = Regex::new(r"(^|/)profile( ?\d+)?$").is_ok_and(|re| re.is_match(&v));
    v.contains("appdata")
        || v.contains("local/google")
        || v.contains("library/application support")
        || v.contains(".config/google-chrome")
        || v.contains(".config/chromium")
        || v.contains(".mozilla")
        || v.contains("user data")
        || v.contains("/users/")
        || v.contains("c:/users")
        || v.contains("default profile")
        || profile_name
}

/// Check one command before it runs. `workspace_dir` is where the agent's own profile belongs.
pub fn check_browser_policy(command: &str, args: &[String], workspace_dir: &str) -> Verdict {
    let cmd = Regex::new(r"\.(exe|cmd|bat)$").map(|re| re.replace(&command.to_lowercase(), "").to_string()).unwrap_or_default();
    let joined = args.join(" ").to_lowercase();
    let agent_profile = Path::new(workspace_dir).join(AGENT_PROFILE_DIR).display().to_string();

    // Rule 1: never terminate a browser.
    if KILLERS.contains(&cmd.as_str()) && (args.iter().any(|a| looks_like_browser(a)) || looks_like_browser(&joined)) {
        return Verdict {
            action: Action::Refuse,
            args: args.to_vec(),
            reason: Some(format!(
                "Refused: this would close a browser that is running on the user's desktop, which may be in the middle of their own work. You do not need to close their browser — launch your own with `--headless` and `--user-data-dir={AGENT_PROFILE_DIR}`, which is a separate profile inside the workspace. If the page needs a logged-in session, say so and ask the user rather than taking over the browser they are using."
            )),
        };
    }

    // Rules 2 and 3 apply when a browser is being launched.
    let launching = looks_like_browser(&cmd) || (joined.contains("playwright") && joined.contains("open"));
    if !launching {
        return Verdict { action: Action::Allow, args: args.to_vec(), reason: None };
    }

    let mut next = args.to_vec();
    let mut notes: Vec<&str> = Vec::new();

    match next.iter().position(|a| a.starts_with("--user-data-dir") || a.starts_with("--profile-directory")) {
        Some(i) => {
            let value = if next[i].contains('=') {
                next[i].splitn(2, '=').nth(1).unwrap_or("").to_string()
            } else {
                next.get(i + 1).cloned().unwrap_or_default()
            };
            if is_user_profile_path(&value) {
                return Verdict {
                    action: Action::Refuse,
                    args: args.to_vec(),
                    reason: Some(format!(
                        "Refused: that is the user's own browser profile, with their logged-in sessions in it. Driving it would interfere with the browser they are using. Use `--user-data-dir={agent_profile}` instead — a separate profile that belongs to this workspace. If the task genuinely needs the user to be signed in, stop and ask them; do not take their session."
                    )),
                };
            }
        }
        // No profile given means the default one, which is the user's.
        None => {
            next.push(format!("--user-data-dir={agent_profile}"));
            notes.push("using the workspace's own browser profile");
        }
    }

    // Headless unless the user explicitly wanted to watch.
    let has_headless = next.iter().any(|a| a == "--headless" || a.starts_with("--headless="));
    let wants_visible = next.iter().any(|a| a == "--headed" || a == "--no-headless");
    if !has_headless && !wants_visible {
        next.push("--headless=new".to_string());
        notes.push("headless, so it cannot take focus from what the user is doing");
    }

    if notes.is_empty() {
        return Verdict { action: Action::Allow, args: args.to_vec(), reason: None };
    }
    Verdict {
        action: Action::Rewrite,
        args: next,
        reason: Some(format!("Adjusted so the agent's browser stays separate from the user's: {}.", notes.join("; "))),
    }
}

/// The request rule from browser-playwright.ts `allowed()`. data:, blob: and about: pass.
/// http and https pass only when the shared public-address guard does. Everything else is refused.
pub async fn url_allowed(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else { return false };
    match url.scheme() {
        "data" | "blob" | "about" => true,
        "http" | "https" => crate::search::assert_public_url_resolved(raw, false).await.is_ok(),
        _ => false,
    }
}

/// Playwright keeps one verdict per scheme and host, so a page's hundreds of requests cost one check per host.
pub fn host_key(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw).ok()?;
    let host = url.host_str().unwrap_or("");
    Some(match url.port() {
        Some(p) => format!("{}://{host}:{p}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

/// The rules stated up front for the model, so it does not learn them by being refused.
pub const BROWSER_POLICY_PROMPT: &str = "\nBrowser use:\n- You have your own browser profile at .agent-browser/ inside the workspace. Use it.\n- Never close, kill or restart the user's browser. They may be working in it.\n- Never launch a browser with the user's real profile (their Chrome/Edge/Firefox user data). It holds their live sessions.\n- Run headless unless the user asked to watch it happen.\n- If a page needs a logged-in account, stop and ask the user instead of trying to borrow their session.";

/// What to say when no Chromium-family browser is installed.
pub const NO_BROWSER_PROMPT: &str = "\n\nBrowser use:\n- There is no real browser available in this workspace, so you cannot run JavaScript on a page or click anything. fetch_url and inspect_page still work and read the HTML the server sends.\n- That is enough for most sites. It is NOT enough for a page whose content is built by JavaScript after load: you will see an empty shell.\n- If a task actually needs a rendered page, say so plainly and tell the user to run `npm run browser:install` once. Do not pretend fetch_url saw something it could not.";

#[cfg(test)]
mod tests {
    use super::*;

    fn action_name(a: Action) -> &'static str {
        match a {
            Action::Allow => "allow",
            Action::Rewrite => "rewrite",
            Action::Refuse => "refuse",
        }
    }

    fn strings(v: &serde_json::Value) -> Vec<String> {
        v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default()
    }

    /// Every case the TypeScript produced, replayed here. See dump-fixtures.ts.
    #[test]
    fn matches_typescript_fixtures() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!("fixtures.json")).unwrap();
        let cases = fixtures["policy"].as_array().unwrap();
        assert_eq!(cases.len(), 19);
        for case in cases {
            let input = &case[0];
            let want = &case[1];
            let args = strings(&input["args"]);
            let got = check_browser_policy(input["command"].as_str().unwrap(), &args, input["workspaceDir"].as_str().unwrap());
            assert_eq!(action_name(got.action), want["action"].as_str().unwrap(), "{input}");
            assert_eq!(got.args, strings(&want["args"]), "{input}");
            assert_eq!(got.reason.as_deref(), want["reason"].as_str(), "{input}");
        }
    }

    #[test]
    fn request_rule_and_host_cache_key() {
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        rt.block_on(async {
            assert!(url_allowed("data:text/html,hi").await);
            assert!(url_allowed("about:blank").await);
            assert!(!url_allowed("file:///home/u/.ssh/id_rsa").await);
            assert!(!url_allowed("not a url").await);
        });
        assert_eq!(host_key("https://x.test:8443/a?b").as_deref(), Some("https://x.test:8443"));
        assert_eq!(host_key("https://x.test/a").as_deref(), Some("https://x.test"));
        assert_eq!(host_key("nope"), None);
    }
}

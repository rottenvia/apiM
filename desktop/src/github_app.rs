//! apiM's own GitHub App. With it apiM pushes and opens pull requests as `<slug>[bot]`, on the repositories it is
//! installed on and nowhere else, with tokens that last an hour. A Personal Access Token acts as you, on everything
//! it reaches, until it is revoked.
//!
//! It is made once from a manifest (GitHub's "create a GitHub App from a manifest" flow): the browser shows GitHub's
//! form filled in, one click there makes the app on your account, and GitHub sends the browser back to a listener on
//! 127.0.0.1 with a code that is traded for the app's id and private key. Installing it on repositories is the second
//! click. The key is kept in `github-app.json` next to the settings, which no tool reads for a model.
// ponytail: a personal account only. An organisation's app is made at /organizations/<org>/settings/apps/new.

use crate::github::{Api, Repo};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// What GitHub hands back when the app is made, and what signs in as it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct App {
    pub id: u64,
    pub slug: String,
    /// The app's page on GitHub, where it is changed or deleted.
    pub html_url: String,
    /// The private key, PEM. It signs the nine-minute sign-in that installation tokens are asked for with.
    pub pem: String,
    /// The bot account's id: a commit by `<id>+<slug>[bot]@users.noreply.github.com` shows as the app.
    pub bot_id: u64,
}

impl App {
    pub fn bot(&self) -> String {
        format!("{}[bot]", self.slug)
    }
    /// The name and email its commits are made with.
    pub fn identity(&self) -> (String, String) {
        (self.bot(), format!("{}+{}@users.noreply.github.com", self.bot_id, self.bot()))
    }
    /// Where repositories are added to it.
    pub fn install_url(&self) -> String {
        format!("https://github.com/apps/{}/installations/new", self.slug)
    }
}

pub fn path() -> PathBuf {
    crate::store::config_dir().join("github-app.json")
}

/// The app, when it has been made on this computer.
pub fn load() -> Option<App> {
    load_from(&path())
}

fn load_from(file: &Path) -> Option<App> {
    serde_json::from_slice::<App>(&std::fs::read(file).ok()?).ok().filter(|app| app.id > 0 && !app.pem.is_empty())
}

/// Forgets the app on this computer. It stays on GitHub, at `html_url`, until it is deleted there.
pub fn forget() {
    let _ = std::fs::remove_file(path());
}

/// The name and email commits get: the app's bot when there is one, else the agent's own.
pub fn identity() -> (String, String) {
    load().map(|app| app.identity()).unwrap_or_else(|| ("apiM Agent".into(), "apim-agent@users.noreply.github.com".into()))
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// The app's own sign-in (a JWT signed with its key): good for nine minutes, and for nothing but asking for
/// installation tokens.
fn jwt(app: &App, now: u64) -> Result<String, String> {
    let body: String = app.pem.lines().filter(|line| !line.starts_with("-----")).collect();
    let der = base64::engine::general_purpose::STANDARD.decode(body.trim()).map_err(|_| "The app's private key is not PEM.".to_string())?;
    let key = ring::signature::RsaKeyPair::from_der(&der).or_else(|_| ring::signature::RsaKeyPair::from_pkcs8(&der)).map_err(|e| format!("The app's private key was not taken: {e}"))?;
    // A minute back, for a clock that runs ahead of GitHub's; ten minutes is the most GitHub takes.
    let claims = json!({ "iat": now.saturating_sub(60), "exp": now + 540, "iss": app.id });
    let signed = format!("{}.{}", b64(br#"{"alg":"RS256","typ":"JWT"}"#), b64(claims.to_string().as_bytes()));
    let mut signature = vec![0; key.public().modulus_len()];
    key.sign(&ring::signature::RSA_PKCS1_SHA256, &ring::rand::SystemRandom::new(), signed.as_bytes(), &mut signature).map_err(|_| "Signing with the app's key failed.".to_string())?;
    Ok(format!("{signed}.{}", b64(&signature)))
}

/// Installation tokens made so far: (app, installation, token, until). They last an hour; one is made again five minutes before.
static TOKENS: Mutex<Vec<(u64, u64, String, Instant)>> = Mutex::new(Vec::new());

/// The app signed in, on `via`'s client and address.
fn as_app(app: &App, via: &Api) -> Result<Api, String> {
    Ok(Api { token: jwt(app, now())?, ..via.clone() })
}

async fn installation_token(as_app: &Api, app_id: u64, installation: u64) -> Result<String, String> {
    if let Some((.., token, _)) = TOKENS.lock().unwrap().iter().find(|t| t.0 == app_id && t.1 == installation && t.3 > Instant::now()) {
        return Ok(token.clone());
    }
    let made = as_app.post(&format!("/app/installations/{installation}/access_tokens"), &json!({})).await?;
    let token = made["token"].as_str().filter(|t| crate::github::looks_like_token(t)).ok_or("GitHub gave no installation token.")?.to_string();
    let mut all = TOKENS.lock().unwrap();
    all.retain(|t| !(t.0 == app_id && t.1 == installation));
    all.push((app_id, installation, token.clone(), Instant::now() + Duration::from_secs(55 * 60)));
    Ok(token)
}

/// An Api that acts as the app on `repo` (owner/name), or on its first installation when none is named. `via` is
/// where GitHub's API is and the client that reaches it; its own token is not used.
pub async fn api(app: &App, via: &Api, repo: Option<&str>) -> Result<Api, String> {
    let signed = as_app(app, via)?;
    let missing = || format!("apiM's GitHub App is not installed on {}. Add it there: {}", repo.unwrap_or("any repository yet"), app.install_url());
    let installation = match repo {
        Some(repo) => match signed.get(&format!("/repos/{}/installation", crate::github::assert_repo(repo)?)).await {
            Ok(found) => found["id"].as_u64(),
            Err(e) if e.starts_with("GitHub returned 404") => None,
            Err(e) => return Err(e),
        },
        None => signed.get("/app/installations").await?.as_array().and_then(|all| all.first()).and_then(|one| one["id"].as_u64()),
    }
    .ok_or_else(missing)?;
    Ok(Api { token: installation_token(&signed, app.id, installation).await?, ..via.clone() })
}

/// Every repository the app is installed on, as the connector lists them.
pub async fn repos(app: &App, via: &Api) -> Result<Vec<Repo>, String> {
    let signed = as_app(app, via)?;
    let mut out = Vec::new();
    for installation in signed.get("/app/installations").await?.as_array().into_iter().flatten().filter_map(|one| one["id"].as_u64()) {
        let installed = Api { token: installation_token(&signed, app.id, installation).await?, ..via.clone() };
        out.extend(crate::github::repo_rows(&installed.get("/installation/repositories?per_page=100").await?["repositories"]));
    }
    Ok(out)
}

/// The app being made: the local listener GitHub sends the browser back to, and the page that starts it.
pub struct Setup {
    listener: std::net::TcpListener,
    state: String,
    name: String,
    /// Open this in the browser: its page posts the manifest to GitHub.
    pub url: String,
    via: Api,
    file: PathBuf,
}

/// Opens the listener and names the app. `owner` (the GitHub login, when known) makes the name unique on GitHub.
pub fn begin(owner: &str) -> Result<Setup, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Could not open a local port for GitHub's answer: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let mut bytes = [0u8; 16];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes).map_err(|_| "No random state for GitHub's answer.".to_string())?;
    let state: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    // GitHub takes 34 characters at most, and one name once across all of GitHub.
    let name = format!("apiM {}", if owner.is_empty() { &state[..6] } else { owner }).chars().take(34).collect();
    Ok(Setup { listener, state, name, url: format!("http://127.0.0.1:{port}/"), via: Api::new(""), file: path() })
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;")
}

fn page(title: &str, body: &str) -> String {
    format!("<!doctype html><meta charset=utf-8><title>{title}</title><body style=\"font:15px/1.5 system-ui,sans-serif;max-width:34em;margin:15vh auto;padding:0 16px\"><h2 style=\"font-weight:600\">{title}</h2>{body}")
}

async fn reply(socket: &mut tokio::net::TcpStream, status: u16, html: &str) {
    let head = format!("HTTP/1.1 {status} {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", if status == 200 { "OK" } else { "Not Found" }, html.len());
    let _ = socket.write_all(format!("{head}{html}").as_bytes()).await;
    let _ = socket.shutdown().await;
}

/// The path a browser asked for, from its request line.
async fn asked(socket: &mut tokio::net::TcpStream) -> String {
    let (mut got, mut chunk) = (Vec::new(), [0u8; 4096]);
    while !got.windows(4).any(|w| w == b"\r\n\r\n") && got.len() < 16_384 {
        match tokio::time::timeout(Duration::from_secs(10), socket.read(&mut chunk)).await {
            Ok(Ok(n)) if n > 0 => got.extend_from_slice(&chunk[..n]),
            _ => break,
        }
    }
    String::from_utf8_lossy(&got).lines().next().and_then(|line| line.strip_prefix("GET ")).and_then(|rest| rest.split(' ').next()).unwrap_or("").to_string()
}

/// Trades GitHub's one-time code for the app, and finds its bot account.
async fn convert(via: &Api, code: &str) -> Result<App, String> {
    let made = via.post(&format!("/app-manifests/{code}/conversions"), &json!({})).await?;
    let text = |key: &str| made[key].as_str().unwrap_or("").to_string();
    let app = App { id: made["id"].as_u64().unwrap_or(0), slug: text("slug"), html_url: text("html_url"), pem: text("pem"), bot_id: 0 };
    if app.id == 0 || app.slug.is_empty() || app.pem.is_empty() {
        return Err("GitHub's answer did not hold the app.".into());
    }
    jwt(&app, now())?;
    let bot: Value = via.get(&format!("/users/{}%5Bbot%5D", app.slug)).await.unwrap_or_default();
    Ok(App { bot_id: bot["id"].as_u64().unwrap_or(0), ..app })
}

/// Serves the page that sends the manifest to GitHub and waits up to 15 minutes for GitHub to send the browser back.
/// The app is saved the moment it exists, whatever became of the window that asked for it, and the browser goes on to
/// GitHub's page for picking its repositories.
pub async fn finish(setup: Setup) -> Result<App, String> {
    let listener = tokio::net::TcpListener::from_std(setup.listener).map_err(|e| e.to_string())?;
    let manifest = json!({
        "name": setup.name,
        "url": "https://github.com/rottenvia/apiM",
        "description": "apiM's coding agent: it pushes its own branches and opens pull requests.",
        "redirect_url": format!("{}created", setup.url),
        "public": false,
        "hook_attributes": { "url": "https://github.com/rottenvia/apiM", "active": false },
        "default_permissions": { "contents": "write", "pull_requests": "write", "issues": "write", "workflows": "write", "checks": "read", "statuses": "read", "actions": "read", "metadata": "read" },
    });
    let start = page(
        "apiM → GitHub",
        &format!(
            "<form action=\"https://github.com/settings/apps/new?state={}\" method=\"post\"><input type=\"hidden\" name=\"manifest\" value=\"{}\"><p>GitHub's form for apiM's app opens next. Check the name, then press <b>Create GitHub App</b>.</p><button>Continue to GitHub</button></form><script>document.forms[0].submit()</script>",
            setup.state,
            escape(&manifest.to_string())
        ),
    );
    let wait = async {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { continue };
            let path = asked(&mut socket).await;
            if path == "/" {
                reply(&mut socket, 200, &start).await;
                continue;
            }
            let query = path.strip_prefix("/created?").unwrap_or("");
            let param = |key: &str| query.split('&').find_map(|pair| pair.strip_prefix(key)?.strip_prefix('='));
            let Some(code) = param("code").filter(|_| param("state") == Some(setup.state.as_str())).filter(|code| !code.is_empty() && code.bytes().all(|b| b.is_ascii_alphanumeric())) else {
                reply(&mut socket, 404, "").await;
                continue;
            };
            let made = convert(&setup.via, code).await.and_then(|app| {
                crate::store::write_atomic(&setup.file, &serde_json::to_vec_pretty(&app).map_err(|e| e.to_string())?).map_err(|e| format!("The app was made on GitHub but could not be saved here: {e}"))?;
                Ok(app)
            });
            match &made {
                Ok(app) => {
                    let go = escape(&app.install_url());
                    reply(&mut socket, 200, &page("apiM's GitHub App is made", &format!("<meta http-equiv=\"refresh\" content=\"2;url={go}\"><p>It is <b>{}</b>. Now pick the repositories it may work on: <a href=\"{go}\">install it</a>.</p>", escape(&app.bot())))).await
                }
                Err(e) => reply(&mut socket, 200, &page("The app was not made", &format!("<p>{}</p><p>Close this tab and set it up again in apiM.</p>", escape(e)))).await,
            }
            return made;
        }
    };
    tokio::time::timeout(Duration::from_secs(15 * 60), wait).await.map_err(|_| "GitHub did not send the browser back within 15 minutes. Set the app up again.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::tests::{api as stub_api, stub};

    /// Made for these tests with `openssl genrsa -traditional 2048` and used for nothing else.
    const PEM: &str = include_str!("github_app_key.test.pem");

    fn app(id: u64) -> App {
        App { id, slug: "apim-mona".into(), html_url: "https://github.com/apps/apim-mona".into(), pem: PEM.into(), bot_id: 555 }
    }

    #[test]
    fn the_app_signs_in_with_a_jwt_github_can_check() {
        let token = jwt(&app(42), 1_800_000_000).unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        let decode = |part: &str| serde_json::from_slice::<Value>(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(part).unwrap()).unwrap();
        assert_eq!((decode(parts[0]), decode(parts[1])), (json!({ "alg": "RS256", "typ": "JWT" }), json!({ "iat": 1_799_999_940u64, "exp": 1_800_000_540u64, "iss": 42 })));
        let der = base64::engine::general_purpose::STANDARD.decode(PEM.lines().filter(|l| !l.starts_with("-----")).collect::<String>()).unwrap();
        let public = ring::signature::RsaKeyPair::from_der(&der).unwrap().public().as_ref().to_vec();
        let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        assert!(ring::signature::UnparsedPublicKey::new(&ring::signature::RSA_PKCS1_2048_8192_SHA256, public).verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature).is_ok());
        assert!(jwt(&App { pem: "nonsense".into(), ..app(42) }, 0).is_err());
        assert_eq!(app(42).identity(), ("apim-mona[bot]".to_string(), "555+apim-mona[bot]@users.noreply.github.com".to_string()));
    }

    #[tokio::test]
    async fn a_repository_gets_its_installations_token_and_keeps_it_for_the_hour() {
        let (base, seen) = stub(|line, _| match line {
            "GET /repos/octo/demo/installation" => (200, json!({ "id": 7 })),
            "POST /app/installations/7/access_tokens" => (201, json!({ "token": "ghs_installationTOKEN0123456789abcdefgh", "expires_at": "2030-01-01T00:00:00Z" })),
            "GET /app/installations" => (200, json!([{ "id": 7 }])),
            "GET /installation/repositories?per_page=100" => (200, json!({ "total_count": 1, "repositories": [{ "full_name": "octo/demo", "private": true, "default_branch": "trunk", "clone_url": "https://github.com/octo/demo.git" }] })),
            _ => (404, json!({ "message": "Not Found" })),
        })
        .await;
        let (app, via) = (app(9_001), stub_api(&base));
        for _ in 0..2 {
            assert_eq!(api(&app, &via, Some("octo/demo")).await.unwrap().token, "ghs_installationTOKEN0123456789abcdefgh");
        }
        assert_eq!(repos(&app, &via).await.unwrap(), [Repo { full_name: "octo/demo".into(), private: true, default_branch: "trunk".into() }]);
        let not_there = api(&app, &via, Some("octo/other")).await.err().unwrap();
        assert!(not_there.contains("not installed on octo/other") && not_there.contains("https://github.com/apps/apim-mona/installations/new"), "{not_there}");
        let seen = seen.lock().unwrap();
        // One token for the installation, asked for with the app's own sign-in; the repositories with the token.
        assert_eq!(seen.iter().filter(|(line, _)| line.starts_with("POST")).count(), 1);
        assert!(seen.iter().filter(|(line, _)| line.contains("installation") && !line.contains("repositories")).all(|(_, auth)| auth.starts_with("authorization: Bearer ey") || auth.starts_with("Authorization: Bearer ey")), "{seen:?}");
        assert!(seen.iter().any(|(line, auth)| line.contains("/installation/repositories") && auth.ends_with("ghs_installationTOKEN0123456789abcdefgh")));
    }

    #[tokio::test]
    async fn the_app_is_made_from_the_manifest_and_kept() {
        let (base, _) = stub(|line, _| match line {
            "POST /app-manifests/abc123/conversions" => (201, json!({ "id": 9, "slug": "apim-mona", "html_url": "https://github.com/apps/apim-mona", "pem": PEM })),
            "GET /users/apim-mona%5Bbot%5D" => (200, json!({ "login": "apim-mona[bot]", "id": 555 })),
            _ => (404, json!({ "message": "Not Found" })),
        })
        .await;
        let dir = std::env::temp_dir().join(format!("apim-github-app-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let setup = Setup { via: stub_api(&base), file: dir.join("github-app.json"), ..begin("mona").unwrap() };
        let (url, file) = (setup.url.clone(), setup.file.clone());
        let made = tokio::spawn(finish(setup));
        let browser = reqwest::Client::builder().no_proxy().build().unwrap();
        let get = async |path: &str| {
            let res = browser.get(format!("{url}{path}")).send().await.unwrap();
            (res.status().as_u16(), res.text().await.unwrap())
        };
        let (status, form) = get("").await;
        let state = form.split("apps/new?state=").nth(1).unwrap().split('"').next().unwrap().to_string();
        assert!(status == 200 && state.len() == 32 && form.contains(&escape(&format!("\"redirect_url\":\"{url}created\""))) && form.contains("&quot;name&quot;:&quot;apiM mona&quot;"), "{form}");
        // Only GitHub's answer to this very page is taken.
        assert_eq!(get("created?code=abc123&state=someone-else").await.0, 404);
        let (status, done) = get(&format!("created?code=abc123&state={state}")).await;
        assert!(status == 200 && done.contains("https://github.com/apps/apim-mona/installations/new") && done.contains("apim-mona[bot]"), "{done}");
        let app = made.await.unwrap().unwrap();
        assert_eq!((app.id, app.bot_id, app.identity().1.as_str()), (9, 555, "555+apim-mona[bot]@users.noreply.github.com"));
        assert_eq!(load_from(&file), Some(app));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

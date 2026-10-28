//! The browser the user can watch: one headless page shared by the agent's `browse` and the Browser pane, streamed
//! into the app as screencast frames (Claude's browser pane, with the agent and the user on the same page).
//!
//! Before, every `browse` call started a fresh browser and threw it away, so nobody saw what the agent saw and
//! nothing carried from one call to the next. Now the page stays open: the agent's steps play out in the pane, the
//! user can click, scroll and type into the same page, and the next call starts where the last one left off.
//!
//! ponytail: one page for the whole app, not one per chat. Two chats browsing at once share it.

use super::cdp::Cdp;
use super::page::Page;
use super::Browser;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

/// The page's size in CSS pixels until the pane gives it its own (`Input::Size`).
pub const VIEWPORT: (u32, u32) = (1280, 800);
/// The widest the page is laid out. A wider pane scales the frame up, so the agent's screenshots stay this size at most.
pub const WIDEST: f32 = 1280.0;
/// Closed and unused this long, the browser is shut to give its memory back.
const IDLE: Duration = Duration::from_secs(10 * 60);

/// What the pane draws, written by the page's event pump and read by the UI every frame.
#[derive(Default)]
pub struct View {
    /// The last frame, RGBA, and its size in pixels.
    pub rgba: Arc<Vec<u8>>,
    pub size: [usize; 2],
    /// Moves on with every frame, so the UI uploads a texture only when there is a new one.
    pub seq: u64,
    pub url: String,
    pub title: String,
    pub loading: bool,
    /// The page's layout size in CSS pixels, which the pane's clicks are mapped into.
    pub viewport: (u32, u32),
    /// Agent calls on the page right now.
    pub driving: u32,
    /// The pane should be on screen: the agent started browsing, or a file was opened for preview.
    pub wanted: bool,
    /// A browser runs.
    pub running: bool,
    pub error: Option<String>,
    /// The workspace whose files the page may open (file://).
    pub root: Option<PathBuf>,
    pub last_used: Option<Instant>,
}

static VIEW: LazyLock<StdMutex<View>> = LazyLock::new(Default::default);
static SESSION: LazyLock<tokio::sync::Mutex<Option<(Browser, Arc<Page>)>>> = LazyLock::new(Default::default);
static WAKE: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
static RUNTIME: OnceLock<tokio::runtime::Handle> = OnceLock::new();

pub fn view() -> std::sync::MutexGuard<'static, View> {
    VIEW.lock().unwrap_or_else(|e| e.into_inner())
}

/// The UI's repaint, so a new frame is drawn when it arrives rather than on the next mouse move, and the runtime the
/// page's work runs on.
pub fn set_wake(wake: impl Fn() + Send + Sync + 'static, runtime: tokio::runtime::Handle) {
    let _ = WAKE.set(Box::new(wake));
    let _ = RUNTIME.set(runtime);
}

/// Live reload: a workspace page on show is loaded again when a file it is made of is written (the page itself, its
/// styles, its scripts), so the user watches the page change as the agent edits it, with no Reload to press.
/// While the agent drives the page it is left alone: its own steps decide when the page loads.
pub fn written(path: &Path) {
    let (url, idle) = {
        let v = view();
        (v.url.clone(), v.running && v.driving == 0)
    };
    if idle && part_of(&url, path) {
        if let Some(rt) = RUNTIME.get() {
            rt.spawn(act(Input::Reload));
        }
    }
}

/// `path` is a file the page at `url` may be built from: a web file in the page's folder or below it.
fn part_of(url: &str, path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let web = matches!(ext.as_str(), "html" | "htm" | "css" | "js" | "mjs" | "svg" | "json" | "png" | "jpg" | "jpeg" | "gif" | "webp");
    let folder = reqwest::Url::parse(url).ok().filter(|u| u.scheme() == "file").and_then(|u| u.to_file_path().ok()).and_then(|p| p.parent().map(Path::to_path_buf));
    let canon = |p: &Path| std::fs::canonicalize(p).ok();
    web && folder.and_then(|dir| canon(&dir)).zip(canon(path)).is_some_and(|(dir, file)| file.starts_with(dir))
}

pub(super) fn wake() {
    if let Some(w) = WAKE.get() {
        w();
    }
}

/// The workspace a page may open files from. None: no file:// at all.
pub fn root() -> Option<PathBuf> {
    view().root.clone()
}

/// The shared page, started on first use. A page whose browser died is replaced.
pub async fn page() -> Result<Arc<Page>, String> {
    let mut session = SESSION.lock().await;
    if let Some((_, page)) = session.as_ref() {
        if page.alive() {
            view().last_used = Some(Instant::now());
            return Ok(page.clone());
        }
    }
    *session = None;
    let (browser, events) = super::launch().await?;
    let page = Arc::new(Page::open(browser.cdp.clone(), events).await?);
    page.screencast(true).await?;
    *session = Some((browser, page.clone()));
    let mut v = view();
    (v.running, v.error, v.last_used, v.viewport) = (true, None, Some(Instant::now()), VIEWPORT);
    drop(v);
    watch_idle();
    Ok(page)
}

/// Ends the browser. The next use starts a new one.
pub async fn shutdown() {
    let old = SESSION.lock().await.take();
    drop(old);
    let mut v = view();
    (v.running, v.rgba, v.size, v.url, v.title, v.loading) = (false, Arc::default(), [0, 0], String::new(), String::new(), false);
    v.seq += 1;
}

/// Ends the browser at once, from a thread that is not async (the window closing).
pub fn shutdown_now() {
    if let Ok(mut session) = SESSION.try_lock() {
        session.take();
    }
}

/// A step that never answered leaves the page unusable (a script stuck in a loop): the next call starts afresh.
pub async fn discard() {
    SESSION.lock().await.take();
    view().running = false;
}

fn watch_idle() {
    static WATCHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if WATCHING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let idle = {
                let v = view();
                v.running && !v.wanted && v.driving == 0 && v.last_used.is_some_and(|at| at.elapsed() > IDLE)
            };
            if idle {
                shutdown().await;
            }
        }
    });
}

/// The agent is driving while this lives: the pane says so and shows itself.
pub struct Driving;

impl Driving {
    pub fn start(root: &Path) -> Driving {
        let mut v = view();
        v.driving += 1;
        v.wanted = true;
        v.root = Some(root.to_path_buf());
        drop(v);
        wake();
        Driving
    }
}

impl Drop for Driving {
    fn drop(&mut self) {
        let mut v = view();
        v.driving = v.driving.saturating_sub(1);
        v.last_used = Some(Instant::now());
        drop(v);
        wake();
    }
}

/// What the user does in the pane.
pub enum Input {
    Go(String),
    Back,
    Forward,
    Reload,
    Stop,
    /// A click at a point of the page, in CSS pixels.
    Click(f32, f32),
    Move(f32, f32),
    Wheel(f32, f32, f32, f32),
    Text(String),
    Key(&'static str, &'static str, u32),
    /// The pane's size: the page is laid out at it, as in a browser window of that size.
    Size(u32, u32),
}

/// Runs a user's action on the page. Errors land in the view for the pane to show.
pub async fn act(input: Input) {
    let page = match page().await {
        Ok(p) => p,
        Err(e) => {
            view().error = Some(e);
            wake();
            return;
        }
    };
    let done = match input {
        Input::Go(url) => page.goto(&url).await.map(|_| ()),
        Input::Back => page.history(-1).await,
        Input::Forward => page.history(1).await,
        Input::Reload => page.raw("Page.reload", json!({})).await.map(|_| ()),
        Input::Stop => page.raw("Page.stopLoading", json!({})).await.map(|_| ()),
        Input::Click(x, y) => page.mouse(x, y, true).await,
        Input::Move(x, y) => page.mouse(x, y, false).await,
        Input::Wheel(x, y, dx, dy) => page.raw("Input.dispatchMouseEvent", json!({ "type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy })).await.map(|_| ()),
        Input::Text(text) => page.raw("Input.insertText", json!({ "text": text })).await.map(|_| ()),
        Input::Key(key, code, vk) => page.key(key, code, vk).await,
        Input::Size(width, height) => {
            let sized = page.raw("Emulation.setDeviceMetricsOverride", json!({ "width": width, "height": height, "deviceScaleFactor": 1, "mobile": false })).await;
            if sized.is_ok() {
                view().viewport = (width, height);
            }
            sized.map(|_| ())
        }
    };
    view().error = done.err();
    wake();
}

/// The frame the page sent, decoded off the UI thread.
pub(super) fn frame(cdp: &Cdp, sid: &str, params: &Value) {
    let ack = params["sessionId"].clone();
    let data = params["data"].as_str().unwrap_or("").to_string();
    let (cdp, sid) = (cdp.clone(), sid.to_string());
    tokio::spawn(async move {
        // Acked first: the browser sends the next frame only after this one is acknowledged.
        let _ = cdp.call("Page.screencastFrameAck", json!({ "sessionId": ack }), Some(&sid)).await;
        use base64::Engine;
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else { return };
        let Ok(img) = tokio::task::spawn_blocking(move || image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).map(|i| i.to_rgba8())).await else { return };
        let Ok(img) = img else { return };
        let size = [img.width() as usize, img.height() as usize];
        let mut v = view();
        (v.rgba, v.size) = (Arc::new(img.into_raw()), size);
        v.seq += 1;
        drop(v);
        wake();
    });
}

/// The main frame went somewhere, or started or finished loading.
pub(super) fn navigated(url: Option<&str>, loading: Option<bool>, title: Option<String>) {
    let mut v = view();
    if let Some(url) = url {
        v.url = url.to_string();
    }
    if let Some(loading) = loading {
        v.loading = loading;
    }
    if let Some(title) = title {
        v.title = title;
    }
    drop(v);
    wake();
}

/// What the address box sends: a URL as typed, `example.com` as https, anything else as a search.
pub fn address(typed: &str) -> String {
    let t = typed.trim();
    let lower = t.to_ascii_lowercase();
    if ["http://", "https://", "file://", "about:", "data:"].iter().any(|s| lower.starts_with(s)) {
        t.to_string()
    } else if lower.starts_with("localhost") || lower.starts_with("127.0.0.1") {
        format!("http://{t}")
    } else if !t.contains(' ') && t.contains('.') {
        format!("https://{t}")
    } else {
        format!("https://duckduckgo.com/?q={}", t.split_whitespace().collect::<Vec<_>>().join("+").replace('&', "%26").replace('#', "%23"))
    }
}

/// file:// for a path, with the third slash a Windows drive needs.
pub fn file_url(path: &Path) -> String {
    let text = path.display().to_string().replace('\\', "/");
    let text = text.strip_prefix("//?/").unwrap_or(&text).to_string();
    let encoded: String = text.chars().map(|c| match c {
        ' ' => "%20".to_string(),
        '#' => "%23".to_string(),
        '%' => "%25".to_string(),
        '?' => "%3F".to_string(),
        c => c.to_string(),
    }).collect();
    if encoded.starts_with('/') { format!("file://{encoded}") } else { format!("file:///{encoded}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_address_box_reads_what_was_typed() {
        assert_eq!(address("example.com/a"), "https://example.com/a");
        assert_eq!(address("localhost:8000"), "http://localhost:8000");
        assert_eq!(address("https://x.org"), "https://x.org");
        assert_eq!(address("rust borrow checker"), "https://duckduckgo.com/?q=rust+borrow+checker");
        assert_eq!(file_url(Path::new(r"C:\a b\i#1.html")), "file:///C:/a%20b/i%231.html");
    }

    #[test]
    fn a_page_reloads_for_the_files_it_is_made_of() {
        let dir = std::env::temp_dir().join(format!("apim live {}", std::process::id()));
        std::fs::create_dir_all(dir.join("css")).unwrap();
        for f in ["index.html", "css/site.css", "notes.md"] {
            std::fs::write(dir.join(f), "x").unwrap();
        }
        let page = file_url(&dir.join("index.html"));
        assert!(part_of(&page, &dir.join("index.html")));
        assert!(part_of(&page, &dir.join("css/site.css")), "a stylesheet in a subfolder, through a %20 in the URL");
        assert!(!part_of(&page, &dir.join("notes.md")), "not a web file");
        assert!(!part_of(&page, &dir.parent().unwrap().join("other.css")), "outside the page's folder");
        assert!(!part_of("https://example.com/index.html", &dir.join("index.html")), "only pages from disk");
        std::fs::remove_dir_all(dir).unwrap();
    }
}

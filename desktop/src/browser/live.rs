//! The browser the user can watch: one headless browser, a page of its own for each chat that browses, streamed into
//! the app as screencast frames (Claude's browser pane, with the agent and the user on the same page).
//!
//! Before, every `browse` call started a fresh browser and threw it away, so nobody saw what the agent saw and
//! nothing carried from one call to the next. Now a chat's page stays open: the agent's steps play out in the pane, the
//! user can click, scroll and type into the same page, and the next call starts where the last one left off.
//!
//! A page for each chat, not one for the app: with one, a video the agent opened in one chat played in the pane of
//! another chat the user had moved on to (2026-10-28). Only the page of the chat on screen is streamed, and only that
//! one is heard. Elsewhere a page is muted, and paused too unless the agent is still at work in its chat: a video
//! opened for the user waits for them, one the agent is studying plays on without sound.
//!
//! A page is known by its chat's workspace folder (`key`), which both the window and the tools have.

use super::cdp::Cdp;
use super::page::Page;
use super::Browser;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// The page's size in CSS pixels until the pane gives it its own (`Input::Size`).
pub const VIEWPORT: (u32, u32) = (1280, 800);
/// The widest the page is laid out beside the chat. A wider pane scales the frame up, so the agent's screenshots stay
/// this size at most. Stretched, the page takes the window up to `WIDEST_STRETCHED`.
pub const WIDEST: f32 = 1280.0;
pub const WIDEST_STRETCHED: f32 = 1920.0;
/// Closed and unused this long, the browser is shut to give its memory back.
const IDLE: Duration = Duration::from_secs(10 * 60);

/// What the pane draws for one chat's page, written by the page's event pump and read by the UI every frame.
#[derive(Default)]
pub struct View {
    /// The last frame, RGBA, and its size in pixels.
    pub rgba: Arc<Vec<u8>>,
    pub size: [usize; 2],
    /// Moves on with every frame, so the UI uploads a texture only when there is a new one.
    pub seq: u64,
    pub url: String,
    pub title: String,
    /// The page asked Cloudflare to check for a person (`page::asks_for_a_person`): its title need not say so.
    pub check: bool,
    pub loading: bool,
    /// The page's layout size in CSS pixels, which the pane's clicks are mapped into.
    pub viewport: (u32, u32),
    /// Agent calls on the page right now.
    pub driving: u32,
    /// The pane is open in this chat: the agent started browsing, a file was opened for preview, or the user opened it.
    pub wanted: bool,
    /// The page exists.
    pub running: bool,
    pub error: Option<String>,
    pub last_used: Option<Instant>,
    /// Where the agent last pointed, for the pane's cursor.
    pub pointer: Option<Pointer>,
    /// What was last asked of the page's sound and playback: (muted, held). None after a navigation, so it is asked again.
    media: Option<(bool, bool)>,
}

/// One move of the agent's pointer, in the page's CSS pixels.
#[derive(Clone, Debug)]
pub struct Pointer {
    pub from: (f32, f32),
    pub to: (f32, f32),
    pub when: Instant,
    /// What it is doing there: "Clicking “Search”", "Typing “deep sea”".
    pub what: String,
    pub click: bool,
}

struct Shared {
    browser: Browser,
    /// Each page's events, by its session id: the browser has one stream for all of them.
    subs: Arc<StdMutex<HashMap<String, mpsc::UnboundedSender<Value>>>>,
    alive: Arc<AtomicBool>,
    pages: HashMap<String, Arc<Page>>,
}

static VIEWS: LazyLock<StdMutex<HashMap<String, View>>> = LazyLock::new(Default::default);
/// A page's session id to its chat's key, for the events that name only the session.
static SIDS: LazyLock<StdMutex<HashMap<String, String>>> = LazyLock::new(Default::default);
static SESSION: LazyLock<tokio::sync::Mutex<Option<Shared>>> = LazyLock::new(Default::default);
/// The chat whose page is streamed to the pane.
static STREAMED: StdMutex<Option<String>> = StdMutex::new(None);
static WAKE: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
static RUNTIME: OnceLock<tokio::runtime::Handle> = OnceLock::new();

/// The name a chat's page goes by: its workspace folder, spelled one way.
pub fn key(root: &Path) -> String {
    root.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// One chat's view, made empty if it has none yet.
pub fn with<R>(root: &Path, f: impl FnOnce(&mut View) -> R) -> R {
    with_key(&key(root), f)
}

fn with_key<R>(key: &str, f: impl FnOnce(&mut View) -> R) -> R {
    let mut all = VIEWS.lock().unwrap_or_else(|e| e.into_inner());
    f(all.entry(key.to_string()).or_default())
}

fn with_sid(sid: &str, f: impl FnOnce(&mut View)) {
    let key = SIDS.lock().unwrap_or_else(|e| e.into_inner()).get(sid).cloned();
    if let Some(key) = key {
        with_key(&key, f);
    }
}

/// The UI's repaint, so a new frame is drawn when it arrives rather than on the next mouse move, and the runtime the
/// page's work runs on.
pub fn set_wake(wake: impl Fn() + Send + Sync + 'static, runtime: tokio::runtime::Handle) {
    let _ = WAKE.set(Box::new(wake));
    let _ = RUNTIME.set(runtime);
}

pub(super) fn wake() {
    if let Some(w) = WAKE.get() {
        w();
    }
}

fn spawn(work: impl std::future::Future<Output = ()> + Send + 'static) {
    if let Some(rt) = RUNTIME.get() {
        rt.spawn(work);
    } else if let Ok(rt) = tokio::runtime::Handle::try_current() {
        rt.spawn(work);
    }
}

/// Live reload: a workspace page on show is loaded again when a file it is made of is written (the page itself, its
/// styles, its scripts), so the user watches the page change as the agent edits it, with no Reload to press.
/// While the agent drives the page it is left alone: its own steps decide when the page loads.
pub fn written(root: &Path, path: &Path) {
    let (url, idle) = with(root, |v| (v.url.clone(), v.running && v.driving == 0));
    if idle && part_of(&url, path) {
        let root = root.to_path_buf();
        spawn(async move { act(&root, Input::Reload).await });
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

/// A chat's page, opened on first use; the browser is started with the first page. A page whose browser died is
/// replaced. A file on it may come only from `root`, the chat's workspace.
pub async fn page(root: &Path) -> Result<Arc<Page>, String> {
    let key = key(root);
    let mut session = SESSION.lock().await;
    if in_window_now() {
        return Err("The user has this browser's pages open in a window of its own, to sign in or to pass a site's check for a person. The browser is back once they close that window.".to_string());
    }
    if session.as_ref().is_some_and(|s| !s.alive.load(Ordering::SeqCst)) {
        *session = None;
        forget_all();
    }
    if session.is_none() {
        let (browser, events) = super::launch().await?;
        let subs: Arc<StdMutex<HashMap<String, mpsc::UnboundedSender<Value>>>> = Default::default();
        let alive = Arc::new(AtomicBool::new(true));
        tokio::spawn(route(events, subs.clone(), alive.clone()));
        *session = Some(Shared { browser, subs, alive, pages: HashMap::new() });
        watch_idle();
    }
    let shared = session.as_mut().expect("started above");
    if let Some(page) = shared.pages.get(&key).filter(|p| p.alive()) {
        with_key(&key, |v| v.last_used = Some(Instant::now()));
        return Ok(page.clone());
    }
    let subs = shared.subs.clone();
    let subscribe = move |sid: &str| {
        let (tx, rx) = mpsc::unbounded_channel();
        subs.lock().unwrap_or_else(|e| e.into_inner()).insert(sid.to_string(), tx);
        rx
    };
    let page = Arc::new(Page::open(shared.browser.cdp.clone(), subscribe, Some(root.to_path_buf())).await?);
    SIDS.lock().unwrap_or_else(|e| e.into_inner()).insert(page.sid().to_string(), key.clone());
    shared.pages.insert(key.clone(), page.clone());
    with_key(&key, |v| {
        reset(v);
        (v.running, v.error, v.last_used, v.viewport) = (true, None, Some(Instant::now()), VIEWPORT);
    });
    if STREAMED.lock().unwrap_or_else(|e| e.into_inner()).as_deref() == Some(key.as_str()) {
        let _ = page.screencast(true).await;
    }
    wake();
    Ok(page)
}

/// A chat's workspace folder was renamed (it follows the chat's title): its page, its pane and its stream follow it.
/// Left under the old name, the pane showed nothing, the next browse opened a second window, and the first one kept
/// the browser from ever idling out.
pub fn moved(from: &Path, to: &Path) {
    let (old, new) = (key(from), key(to));
    if old == new {
        return;
    }
    {
        let mut views = VIEWS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(v) = views.remove(&old) {
            views.insert(new.clone(), v);
        }
    }
    SIDS.lock().unwrap_or_else(|e| e.into_inner()).values_mut().filter(|k| **k == old).for_each(|k| *k = new.clone());
    let to = to.to_path_buf();
    spawn(async move {
        let page = SESSION.lock().await.as_mut().and_then(|shared| {
            let page = shared.pages.remove(&old)?;
            page.moved_to(to);
            shared.pages.insert(new.clone(), page.clone());
            Some(page)
        });
        // `sync` may have switched the stream to the new name before the page was there under it.
        if let Some(page) = page.filter(|_| STREAMED.lock().unwrap_or_else(|e| e.into_inner()).as_deref() == Some(new.as_str())) {
            let _ = page.screencast(true).await;
        }
    });
    // The stream follows on the next frame, when `sync` is told the chat's new name.
    wake();
}

/// A chat was deleted: its page is closed and its pane forgotten.
pub fn forget(root: &Path) {
    let root = root.to_path_buf();
    spawn(async move {
        discard(&root).await;
        VIEWS.lock().unwrap_or_else(|e| e.into_inner()).remove(&key(&root));
    });
}

/// A chat's page if it is open, without starting anything.
async fn open_page(key: &str) -> Option<Arc<Page>> {
    SESSION.lock().await.as_ref().and_then(|s| s.pages.get(key).cloned()).filter(|p| p.alive())
}

/// Hands each event to the page whose session it names.
async fn route(mut events: mpsc::UnboundedReceiver<Value>, subs: Arc<StdMutex<HashMap<String, mpsc::UnboundedSender<Value>>>>, alive: Arc<AtomicBool>) {
    while let Some(ev) = events.recv().await {
        let Some(sid) = ev["sessionId"].as_str() else { continue };
        let tx = subs.lock().unwrap_or_else(|e| e.into_inner()).get(sid).cloned();
        if let Some(tx) = tx {
            let _ = tx.send(ev);
        }
    }
    // The browser is gone: every page's pump ends with its channel, and the next use starts a new browser.
    alive.store(false, Ordering::SeqCst);
    subs.lock().unwrap_or_else(|e| e.into_inner()).clear();
    wake();
}

/// A view whose page is gone: no picture, no address, nothing loading. A page discarded mid-load kept its progress bar
/// and its last frame, and a mouse move over that frame opened a page again.
fn reset(v: &mut View) {
    (v.running, v.rgba, v.size, v.url, v.title, v.check, v.loading, v.pointer, v.media) = (false, Arc::default(), [0, 0], String::new(), String::new(), false, false, None, None);
    v.seq += 1;
}

fn forget_all() {
    SIDS.lock().unwrap_or_else(|e| e.into_inner()).clear();
    VIEWS.lock().unwrap_or_else(|e| e.into_inner()).values_mut().for_each(reset);
}

/// Ends the browser and every page. The next use starts a new one.
pub async fn shutdown() {
    end(&mut *SESSION.lock().await).await;
}

/// Ends the session held: the lock is kept until the browser is gone, so a page opened meanwhile cannot be forgotten
/// with the old ones.
async fn end(session: &mut Option<Shared>) {
    if let Some(old) = session.take() {
        old.browser.quit().await;
    }
    forget_all();
    wake();
}

/// Ends the browser at once, from a thread that is not async (the window closing).
pub fn shutdown_now() {
    if let Ok(mut session) = SESSION.try_lock() {
        session.take();
    }
}

/// A step that never answered leaves the page unusable (a script stuck in a loop): it is closed, and the chat's next
/// call opens a new one. When the browser will not even close it, the whole browser goes.
pub async fn discard(root: &Path) {
    let key = key(root);
    let mut session = SESSION.lock().await;
    let Some(shared) = session.as_mut() else { return };
    if let Some(page) = shared.pages.remove(&key) {
        shared.subs.lock().unwrap_or_else(|e| e.into_inner()).remove(page.sid());
        SIDS.lock().unwrap_or_else(|e| e.into_inner()).remove(page.sid());
        let closed = tokio::time::timeout(Duration::from_secs(5), page.close()).await;
        if !matches!(closed, Ok(Ok(()))) {
            *session = None;
            drop(session);
            forget_all();
        }
    }
    with_key(&key, reset);
    wake();
}

/// Set while the pane's profile is open in a window of its own: a browser started on the profile then would hand
/// itself over to that window and quit.
static IN_WINDOW: AtomicBool = AtomicBool::new(false);

pub fn in_window_now() -> bool {
    IN_WINDOW.load(Ordering::SeqCst)
}

/// Google's sign-in and a site's check for a person (Cloudflare's) turn away a browser that a program drives, and the
/// pane's is one. So the pane's profile is opened in an ordinary window of the same browser, nothing driving it, and the
/// user signs in or passes the check there. Once they close it the pane starts again on that profile, where what they
/// did holds, at the page it was for.
pub async fn in_window(root: PathBuf, url: String) {
    if IN_WINDOW.swap(true, Ordering::SeqCst) {
        return;
    }
    // Held until the browser is gone, so no page opens on the profile meanwhile.
    end(&mut *SESSION.lock().await).await;
    let then = after_window(&url);
    match super::open_window(&url) {
        Ok(mut window) => {
            let _ = tokio::task::spawn_blocking(move || window.wait()).await;
            IN_WINDOW.store(false, Ordering::SeqCst);
            act(&root, Input::Go(then)).await;
        }
        Err(e) => {
            IN_WINDOW.store(false, Ordering::SeqCst);
            with(&root, |v| v.error = Some(e));
            wake();
        }
    }
}

/// Where the pane goes once the window is closed. A sign-in goes on to the page Google's sign-in names in `continue`
/// (only a web page); a page that was behind Cloudflare's check loses the check's own `__cf_chl_…` marks.
fn after_window(url: &str) -> String {
    let Ok(mut parsed) = url::Url::parse(url) else { return url.to_string() };
    if let Some(to) = parsed.query_pairs().find(|(k, _)| k == "continue").map(|(_, to)| to.into_owned()).filter(|to| to.starts_with("https://") || to.starts_with("http://")) {
        return to;
    }
    let kept: Vec<(String, String)> = parsed.query_pairs().filter(|(k, _)| !k.starts_with("__cf_chl")).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    if parsed.query_pairs().count() == kept.len() {
        return url.to_string();
    }
    if kept.is_empty() {
        parsed.set_query(None);
    } else {
        parsed.query_pairs_mut().clear().extend_pairs(kept);
    }
    parsed.to_string()
}

fn watch_idle() {
    static WATCHING: AtomicBool = AtomicBool::new(false);
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            // Judged with the session held: a page being opened meanwhile is not shut with the browser.
            let mut session = SESSION.lock().await;
            let idle = VIEWS.lock().unwrap_or_else(|e| e.into_inner()).values().filter(|v| v.running).all(|v| !v.wanted && v.driving == 0 && v.last_used.is_none_or(|at| at.elapsed() > IDLE));
            if idle && session.is_some() {
                end(&mut session).await;
            }
        }
    });
}

/// The agent is driving its chat's page while this lives: the pane opens in that chat and says so.
pub struct Driving(String);

impl Driving {
    pub fn start(root: &Path) -> Driving {
        let key = key(root);
        with_key(&key, |v| {
            v.driving += 1;
            v.wanted = true;
        });
        wake();
        Driving(key)
    }
}

impl Drop for Driving {
    fn drop(&mut self) {
        with_key(&self.0, |v| {
            v.driving = v.driving.saturating_sub(1);
            v.last_used = Some(Instant::now());
        });
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
    /// Stretch on or off: the page's player (a video, or the YouTube player round it) fills the page.
    Stretch(bool),
}

/// The player pinned over the whole page: YouTube's own player, so its controls stay, else the largest video showing.
/// Pinned by a style rather than put in fullscreen: YouTube's player, asked from a script or by its `f` key while an
/// advert loaded, stayed in the page (2026-10-28). A style needs no permission and does the same on any site.
const STRETCH_JS: &str = r#"(() => {
  const shown = [...document.querySelectorAll('video')].filter(v => v.getBoundingClientRect().width > 0);
  shown.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
  const el = document.querySelector('#movie_player') || shown[0];
  if (!el) return false;
  el.setAttribute('data-apim-stretch', '');
  // The boxes between the player and its video fill it too: YouTube's video sits in one with no height of its own.
  const video = el.tagName === 'VIDEO' ? el : el.querySelector('video');
  for (let n = video && video.parentElement; n && n !== el; n = n.parentElement) n.setAttribute('data-apim-fill', '');
  let style = document.getElementById('apim-stretch');
  if (!style) { style = document.createElement('style'); style.id = 'apim-stretch'; document.documentElement.appendChild(style); }
  style.textContent = '[data-apim-stretch]{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;border-radius:0!important;z-index:2147483647!important;background:#000!important}'
    + '[data-apim-fill],[data-apim-stretch] video{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;transform:none!important}'
    + '[data-apim-stretch] video,video[data-apim-stretch]{object-fit:contain!important}'
    + 'html,body{overflow:hidden!important;background:#000!important}'
    // Everything else is hidden rather than covered: YouTube's stacking let its header and side column paint over a
    // pinned player whatever its z-index.
    + 'body *{visibility:hidden!important}[data-apim-stretch],[data-apim-stretch] *{visibility:visible!important}';
  window.dispatchEvent(new Event('resize'));
  return true;
})()"#;
const UNSTRETCH_JS: &str = r#"(() => {
  document.querySelectorAll('[data-apim-stretch],[data-apim-fill]').forEach(el => { el.removeAttribute('data-apim-stretch'); el.removeAttribute('data-apim-fill'); });
  const style = document.getElementById('apim-stretch');
  if (style) style.remove();
  window.dispatchEvent(new Event('resize'));
})()"#;

/// Runs a user's action on a chat's page. Errors land in the view for the pane to show.
pub async fn act(root: &Path, input: Input) {
    // The pane says what is going on meanwhile (`in_window_now`); a click on it would only start nothing.
    if in_window_now() {
        return;
    }
    let key = key(root);
    // A page that is gone has nothing to put back: no browser is started for it.
    if matches!(input, Input::Stretch(false)) && open_page(&key).await.is_none() {
        return;
    }
    let page = match page(root).await {
        Ok(p) => p,
        Err(e) => {
            with_key(&key, |v| v.error = Some(e));
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
                with_key(&key, |v| v.viewport = (width, height));
            }
            sized.map(|_| ())
        }
        Input::Stretch(on) => {
            page.raw("Runtime.evaluate", json!({ "expression": if on { STRETCH_JS } else { UNSTRETCH_JS }, "returnByValue": true })).await.map(|_| ())
        }
    };
    with_key(&key, |v| v.error = done.err());
    wake();
}

/// What the window says each frame: the chat on screen, whether its pane is open, whether the user can hear it (the
/// pane open and the window not minimised), and the chats whose agent is at work. Only the open pane's page is
/// streamed; only it is heard; a page elsewhere plays on muted while its agent works, and is paused otherwise.
pub fn sync(here: &Path, open: bool, audible: bool, working: &[PathBuf]) {
    let here = key(here);
    // Nobody sees a minimised window: its page is not streamed either.
    let streamed = (open && audible).then(|| here.clone());
    {
        let mut current = STREAMED.lock().unwrap_or_else(|e| e.into_inner());
        if *current != streamed {
            *current = streamed;
            spawn(restream());
        }
    }
    let working: HashSet<String> = working.iter().map(|p| key(p)).collect();
    let mut asks = Vec::new();
    for (k, v) in VIEWS.lock().unwrap_or_else(|e| e.into_inner()).iter_mut().filter(|(_, v)| v.running) {
        let want = if *k == here && open && audible {
            (false, false)
        } else if working.contains(k) || v.driving > 0 {
            (true, false)
        } else {
            (true, true)
        };
        if v.media != Some(want) {
            v.media = Some(want);
            asks.push((k.clone(), want));
        }
    }
    // Each task applies what is wanted when it runs, not when it was asked: two asks a frame apart may run either way round.
    for (k, _) in asks {
        spawn(async move {
            if let Some(page) = open_page(&k).await {
                if let Some((muted, held)) = with_key(&k, |v| v.media) {
                    let js = format!("window.__apimMedia && window.__apimMedia({muted}, {held})");
                    let _ = page.raw("Runtime.evaluate", json!({ "expression": js })).await;
                }
            }
        });
    }
}

/// Brings the screencast in line with `STREAMED`, one switch at a time. Switches spawned a frame apart (A to B and back)
/// could land out of order and leave two pages streaming, or the shown one frozen.
async fn restream() {
    static ON: tokio::sync::Mutex<Option<String>> = tokio::sync::Mutex::const_new(None);
    let mut on = ON.lock().await;
    let want = STREAMED.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if *on == want {
        return;
    }
    if let Some(page) = match on.take() {
        Some(old) => open_page(&old).await,
        None => None,
    } {
        let _ = page.screencast(false).await;
    }
    if let Some(page) = match &want {
        Some(new) => open_page(new).await,
        None => None,
    } {
        let _ = page.screencast(true).await;
    }
    *on = want;
}

/// Sound and playback, held by the app rather than the page: installed in every document before the page's own
/// scripts, so a video that starts later is caught as it starts. What the app muted or paused, and only that, it
/// unmutes or plays again. A player that is in no document (`new Audio().play()`) is caught by its `play`, and a
/// WebAudio context is suspended while the page is muted: neither reaches a listener on the document.
/// ponytail: the main document only; a player in an iframe is not reached. Reach frames with
/// `Page.createIsolatedWorld` per frame if embedded players matter.
pub(super) const MEDIA_JS: &str = r#"(() => {
  if (window.__apimMedia) return;
  let muted = false, held = false;
  const players = new Set(), contexts = new Set();
  const keep = m => {
    players.add(m);
    if (muted && !m.muted) { m.muted = true; m.dataset.apimMuted = '1'; }
    if (held && !m.paused) { m.dataset.apimHeld = '1'; m.pause(); }
  };
  document.addEventListener('play', e => keep(e.target), true);
  document.addEventListener('playing', e => keep(e.target), true);
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { const started = play.call(this); keep(this); return started; };
  const hush = c => { if (muted && c.state === 'running') { c.apimSuspended = true; c.suspend(); } };
  if (window.AudioContext) {
    const Real = window.AudioContext;
    window.AudioContext = class extends Real { constructor(...a) { super(...a); contexts.add(this); hush(this); } };
  }
  window.__apimMedia = (m, h) => {
    muted = m; held = h;
    for (const el of new Set([...players, ...document.querySelectorAll('video, audio')])) {
      keep(el);
      if (!m && el.dataset.apimMuted) { el.muted = false; delete el.dataset.apimMuted; }
      if (!h && el.dataset.apimHeld) { delete el.dataset.apimHeld; el.play().catch(() => {}); }
    }
    for (const c of contexts) {
      hush(c);
      if (!m && c.apimSuspended) { delete c.apimSuspended; c.resume(); }
    }
  };
})();"#;

/// Whether a page is streamed to the pane right now: the agent's pointer slows down for someone watching.
pub(super) fn watched(sid: &str) -> bool {
    let key = SIDS.lock().unwrap_or_else(|e| e.into_inner()).get(sid).cloned();
    key.is_some() && *STREAMED.lock().unwrap_or_else(|e| e.into_inner()) == key
}

/// Where the agent's pointer is on a page, if it was put there lately: typing goes on where the click landed.
pub(super) fn with_sid_pointer(sid: &str) -> Option<(f32, f32)> {
    let mut at = None;
    with_sid(sid, |v| at = v.pointer.as_ref().filter(|p| p.when.elapsed() < Duration::from_secs(30)).map(|p| p.to));
    at
}

/// The agent's pointer moved to a point of the page, to click there or type.
pub(super) fn pointer(sid: &str, x: f64, y: f64, what: String, click: bool) {
    with_sid(sid, |v| {
        let to = (x as f32, y as f32);
        let from = v.pointer.as_ref().filter(|p| p.when.elapsed() < Duration::from_secs(6)).map_or(to, |p| p.to);
        v.pointer = Some(Pointer { from, to, when: Instant::now(), what, click });
    });
    wake();
}

/// The page sent for Cloudflare's check for a person.
pub(super) fn checked(sid: &str) {
    let mut fresh = false;
    with_sid(sid, |v| fresh = !std::mem::replace(&mut v.check, true));
    if fresh {
        wake();
    }
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
        with_sid(&sid, |v| {
            (v.rgba, v.size) = (Arc::new(img.into_raw()), size);
            v.seq += 1;
        });
        wake();
    });
}

/// The main frame went somewhere, or started or finished loading. A new document starts with its sound and playback
/// untouched, so they are asked for again.
pub(super) fn navigated(sid: &str, url: Option<&str>, loading: Option<bool>, title: Option<String>) {
    with_sid(sid, |v| {
        if let Some(url) = url {
            v.url = url.to_string();
            v.media = None;
            v.check = false;
        }
        if let Some(loading) = loading {
            v.loading = loading;
        }
        if let Some(title) = title {
            v.title = title;
        }
    });
    // A stream started on the blank page before the first address loaded sometimes never sent a frame: the page moved
    // to another renderer, and a page that does not move paints no more. Asked again, it sends one.
    if loading == Some(false) {
        let sid = sid.to_string();
        spawn(async move {
            tokio::time::sleep(Duration::from_millis(700)).await;
            let Some(key) = SIDS.lock().unwrap_or_else(|e| e.into_inner()).get(&sid).cloned() else { return };
            if with_key(&key, |v| v.running && v.size[0] == 0) {
                if let Some(page) = open_page(&key).await {
                    page.recast().await;
                }
            }
        });
    }
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
    fn a_sign_in_goes_on_to_the_page_it_was_for() {
        assert_eq!(after_window("https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dx&hl=en"), "https://www.youtube.com/watch?v=x");
        let odd = "https://accounts.google.com/signin?continue=javascript:alert(1)";
        assert_eq!(after_window(odd), odd);
        assert_eq!(after_window("https://accounts.google.com/signin"), "https://accounts.google.com/signin");
        // Past Cloudflare's check, the page itself, without the check's marks.
        assert_eq!(after_window("https://stats.example.com/players?id=7&__cf_chl_rt_tk=abc.def-123"), "https://stats.example.com/players?id=7");
        assert_eq!(after_window("https://stats.example.com/?__cf_chl_tk=x&__cf_chl_f_tk=y"), "https://stats.example.com/");
        assert_eq!(after_window("https://stats.example.com/a?b=1"), "https://stats.example.com/a?b=1");
    }

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

    #[test]
    fn a_chat_is_known_by_one_spelling_of_its_folder() {
        assert_eq!(key(Path::new(r"C:\Data\Workspaces\Hello-3\")), key(Path::new("c:/data/workspaces/hello-3")));
        assert_ne!(key(Path::new(r"C:\data\workspaces\a")), key(Path::new(r"C:\data\workspaces\b")));
    }
}

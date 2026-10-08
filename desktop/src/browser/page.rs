//! What a page does. Port of browser.ts (action validation, the session, the challenge check,
//! result formatting, selector extraction) and browser-playwright.ts (the page calls, here over CDP).
//!
//! ponytail: a click is a real mouse event at the element's centre, with no hit-test that the element is uncovered.
//! ponytail: `type` sends one key event per character and does not do Playwright's full key sequence.
//! ponytail: a redirect to a blocked address shows as chrome-error:// rather than the address that was blocked.
//! ponytail: two requests to a new host that start together may both run the host check.

use crate::browser::cdp::Cdp;
use crate::browser::policy;
use base64::Engine;
use regex::Regex;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch};

/// A page that has not settled by now is not going to.
pub const NAV_TIMEOUT: Duration = Duration::from_secs(30);
/// Individual waits are shorter: the agent can always ask again.
pub const ACTION_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_TEXT_CHARS: usize = 30_000;
pub const MAX_ACTIONS: usize = 25;
pub const MAX_CONSOLE_LINES: usize = 40;
/// Screenshots land here inside the workspace, so they can be viewed later.
pub const SCREENSHOT_DIR: &str = ".agent-browser/screenshots";

fn clip(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or("")
}

fn trimmed(a: &Value, key: &str) -> Option<String> {
    a[key].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Scroll {
    Top,
    Bottom,
    Px(f64),
}

impl Scroll {
    fn label(&self) -> String {
        match self {
            Scroll::Top => "top".into(),
            Scroll::Bottom => "bottom".into(),
            Scroll::Px(n) => render(&json!(n)),
        }
    }
}

/// One validated instruction. The first step of a list is always Goto.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Goto(String),
    Html(Option<String>),
    Click { selector: String, force: bool },
    Type { selector: String, text: String, press_enter: bool },
    WaitFor { selector: Option<String>, ms: Option<u64> },
    Scroll(Scroll),
    Screenshot { name: Option<String>, full_page: bool },
    Evaluate(String),
    Extract(String),
}

impl Step {
    fn name(&self) -> &'static str {
        match self {
            Step::Goto(_) => "goto",
            Step::Html(_) => "html",
            Step::Click { .. } => "click",
            Step::Type { .. } => "type",
            Step::WaitFor { .. } => "wait_for",
            Step::Scroll(_) => "scroll",
            Step::Screenshot { .. } => "screenshot",
            Step::Evaluate(_) => "evaluate",
            Step::Extract(_) => "extract",
        }
    }
}

/// Check the list before a browser is started, so a malformed list fails at once with the reason.
pub fn validate_actions(raw: &Value) -> Result<Vec<Step>, String> {
    let list = match raw.as_array() {
        Some(a) if !a.is_empty() => a,
        _ => return Err("actions must be a non-empty list, e.g. [{\"action\":\"goto\",\"url\":\"https://example.com\"},{\"action\":\"screenshot\"}]".into()),
    };
    if list.len() > MAX_ACTIONS {
        return Err(format!("Too many actions ({}). The limit is {MAX_ACTIONS} per call; split the work across several calls so you can read the result in between.", list.len()));
    }
    let mut out = Vec::new();
    for (i, a) in list.iter().enumerate() {
        let kind = a["action"].as_str().unwrap_or("");
        let at = format!("Action {}", i + 1);
        let step = match kind {
            "goto" => Step::Goto(trimmed(a, "url").ok_or(format!("{at}: goto needs a url."))?),
            "click" => Step::Click {
                selector: trimmed(a, "selector").ok_or(format!("{at}: click needs a selector."))?,
                force: a["force"].as_bool() == Some(true),
            },
            "extract" => Step::Extract(trimmed(a, "selector").ok_or(format!("{at}: extract needs a selector."))?),
            "html" => Step::Html(trimmed(a, "selector")),
            "type" => {
                let selector = trimmed(a, "selector").ok_or(format!("{at}: type needs a selector."))?;
                let typed = a["text"].as_str().ok_or(format!("{at}: type needs text."))?.to_string();
                Step::Type {
                    selector,
                    text: typed,
                    press_enter: a["press_enter"].as_bool() == Some(true) || a["pressEnter"].as_bool() == Some(true),
                }
            }
            "wait_for" => {
                let selector = trimmed(a, "selector");
                let ms = a["ms"].as_f64().filter(|m| m.is_finite()).map(|m| m.clamp(0.0, ACTION_TIMEOUT.as_millis() as f64) as u64);
                if selector.is_none() && ms.is_none() {
                    return Err(format!("{at}: wait_for needs either a selector or ms."));
                }
                Step::WaitFor { selector, ms }
            }
            "scroll" => Step::Scroll(match &a["to"] {
                v if v.as_str() == Some("top") => Scroll::Top,
                v if v.as_str() == Some("bottom") => Scroll::Bottom,
                v => Scroll::Px(v.as_f64().ok_or(format!("{at}: scroll needs to be \"top\", \"bottom\" or a pixel offset."))?),
            }),
            "screenshot" => Step::Screenshot {
                name: trimmed(a, "name"),
                full_page: a["full_page"].as_bool() == Some(true) || a["fullPage"].as_bool() == Some(true),
            },
            "evaluate" => Step::Evaluate(
                a["script"].as_str().filter(|s| !s.trim().is_empty()).ok_or(format!("{at}: evaluate needs a script."))?.to_string(),
            ),
            other => {
                return Err(format!(
                    "{at}: unknown action \"{other}\". Valid actions are goto, html, click, type, wait_for, scroll, screenshot, evaluate and extract."
                ));
            }
        };
        out.push(step);
    }
    if !matches!(out.first(), Some(Step::Goto(_))) {
        return Err("The first action must be goto — there is no page open until you navigate to one.".into());
    }
    Ok(out)
}

/// The file name for a screenshot: letters, digits, dash and underscore only, at most 60 characters.
pub fn safe_name(name: Option<&str>, index: usize) -> String {
    let fallback = format!("shot-{index}");
    let raw = name.map(str::to_string).unwrap_or_else(|| fallback.clone());
    let replaced = Regex::new(r"[^a-zA-Z0-9_-]+").expect("valid pattern").replace_all(&raw, "-");
    let base: String = replaced.trim_matches('-').chars().take(60).collect();
    format!("{}.png", if base.is_empty() { fallback } else { base })
}

const SIGNATURES: [(&str, &str); 12] = [
    (r"just a moment\.\.\.", "Cloudflare"),
    (r"checking your browser before accessing", "Cloudflare"),
    (r"enable javascript and cookies to continue", "Cloudflare"),
    (r"cf-browser-verification|cf_chl_|__cf_chl", "Cloudflare"),
    (r"attention required!? \| cloudflare", "Cloudflare"),
    (r"verify you are (a )?human", "a bot check"),
    (r"ddos protection by", "a DDoS filter"),
    (r"please complete the security check", "a security check"),
    (r"access denied.{0,40}(reference #|error \d{4})", "an edge block"),
    (r"are you a robot|i'm not a robot|recaptcha", "a CAPTCHA"),
    (r"px-captcha|perimeterx|human challenge", "PerimeterX"),
    (r"incapsula incident id", "Imperva"),
];

/// Is this an anti-bot challenge rather than the page that was asked for? Returns who it is from.
/// A long page that merely mentions a captcha is an article, so a short body is required for most signatures.
pub fn detect_challenge(title: &str, text: &str) -> Option<&'static str> {
    let t = format!("{title}\n{text}").to_lowercase();
    let short = text.trim().chars().count() < 2000;
    let always = Regex::new("just a moment|cf_chl_|incapsula incident").expect("valid pattern").is_match(&t);
    for (pattern, who) in SIGNATURES {
        if !Regex::new(pattern).expect("valid pattern").is_match(&t) {
            continue;
        }
        if !short && !always {
            continue;
        }
        return Some(who);
    }
    None
}

fn strip_noise(html: &str) -> String {
    let mut s = html.to_string();
    for pattern in [r"(?is)<script\b[^>]*>.*?</script>", r"(?is)<style\b[^>]*>.*?</style>", r"(?is)<noscript\b[^>]*>.*?</noscript>", r"(?is)<svg\b[^>]*>.*?</svg>", r"(?s)<!--.*?-->"] {
        s = Regex::new(pattern).expect("valid pattern").replace_all(&s, "").into_owned();
    }
    s
}

#[derive(Debug, Default, PartialEq)]
pub struct Selectors {
    pub ids: Vec<String>,
    pub classes: Vec<String>,
    pub data_attrs: Vec<String>,
}

fn unique(items: impl Iterator<Item = String>, limit: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    items.filter(|s| seen.insert(s.clone())).take(limit).collect()
}

/// The ids, classes and data attributes in the markup, first-seen order, each list capped at `limit`.
/// Utility soup (classes of 2 characters or fewer, or 60 or more) is dropped, as the web does.
pub fn extract_selectors(html: &str, limit: usize) -> Selectors {
    let clean = strip_noise(html);
    let id_re = Regex::new(r#"\sid=["']([^"']+)["']"#).expect("valid pattern");
    let class_re = Regex::new(r#"\bclass=["']([^"']+)["']"#).expect("valid pattern");
    let data_re = Regex::new(r"(?i)\b(data-[a-z0-9-]+)=").expect("valid pattern");
    let ids = id_re.captures_iter(&clean).map(|c| c[1].trim().to_string()).filter(|v| !v.is_empty());
    let classes = class_re
        .captures_iter(&clean)
        .flat_map(|c| c[1].split_whitespace().map(str::to_string).collect::<Vec<_>>())
        .filter(|c| c.chars().count() > 2 && c.chars().count() < 60);
    let data = data_re.captures_iter(&clean).map(|c| c[1].to_lowercase());
    Selectors { ids: unique(ids, limit), classes: unique(classes, limit), data_attrs: unique(data, limit) }
}

/// A shell with scripts and an empty mount point, or a lot of markup and almost no words: the page is built by JavaScript.
pub fn looks_like_app_shell(html: &str, text: &str) -> bool {
    if !Regex::new(r"(?i)<script\b").expect("valid pattern").is_match(html) {
        return false;
    }
    let visible = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().count();
    let mount = Regex::new(r#"(?i)<div[^>]+id=["'](root|app|__next|__nuxt|main-app)["'][^>]*>\s*</div>"#).expect("valid pattern").is_match(html)
        || Regex::new(r#"(?i)<div[^>]+id=["'](root|app|__next)["'][^>]*/?>\s*(</div>)?\s*</body>"#).expect("valid pattern").is_match(html);
    if mount && visible < 2000 {
        return true;
    }
    html.chars().count() > 1000 && visible < 200
}

#[derive(Debug)]
pub struct ActionResult {
    pub action: &'static str,
    pub ok: bool,
    pub detail: String,
}

/// What a browse session produced. An empty string means the field is absent.
#[derive(Debug, Default)]
pub struct Session {
    pub results: Vec<ActionResult>,
    pub final_url: String,
    pub title: String,
    pub text: String,
    pub selectors: Option<Selectors>,
    pub screenshots: Vec<String>,
    pub console: Vec<String>,
    pub failed_requests: Vec<String>,
    pub blocked: Option<&'static str>,
}

/// Render a session for the model. The challenge note comes first, then steps, then selectors (before text).
pub fn format_session(s: &Session) -> String {
    let mut lines: Vec<String> = Vec::new();
    if let Some(who) = s.blocked {
        lines.push(format!("NOTE: this page is {who}'s anti-bot challenge, not the site's real content. The selectors and text below describe the challenge page, not the site."));
        lines.push("The raw page data below is still available — proceed with the task however you judge best.".into());
        lines.push(String::new());
    }
    for r in &s.results {
        lines.push(format!("{} {}: {}", if r.ok { "OK  " } else { "FAIL" }, r.action, r.detail));
    }
    if !s.final_url.is_empty() {
        lines.push(String::new());
        lines.push(format!("Final URL: {}", s.final_url));
    }
    if !s.title.is_empty() {
        lines.push(format!("Page title: {}", s.title));
    }
    if !s.console.is_empty() {
        lines.push(String::new());
        lines.push("Browser console:".into());
        lines.extend(s.console.iter().map(|l| format!("  {l}")));
    }
    if !s.failed_requests.is_empty() {
        lines.push(String::new());
        lines.push("Requests that failed:".into());
        lines.extend(s.failed_requests.iter().map(|l| format!("  {l}")));
    }
    if let Some(sel) = &s.selectors {
        lines.push(String::new());
        lines.push("Selectors on the rendered page (use these, do not guess):".into());
        if !sel.ids.is_empty() {
            lines.push(format!("  ids: {}", sel.ids.iter().take(80).cloned().collect::<Vec<_>>().join(", ")));
        }
        if !sel.classes.is_empty() {
            lines.push(format!("  classes: {}", sel.classes.iter().take(120).cloned().collect::<Vec<_>>().join(", ")));
        }
        if !sel.data_attrs.is_empty() {
            lines.push(format!("  data attributes: {}", sel.data_attrs.iter().take(40).cloned().collect::<Vec<_>>().join(", ")));
        }
    }
    if !s.text.is_empty() {
        lines.push(String::new());
        lines.push("Visible text:".into());
        lines.push(s.text.clone());
    }
    lines.join("\n")
}

/// Render a JS value the way JSON.stringify would, with whole numbers printed without a fraction.
fn render(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
            _ => v.to_string(),
        },
        _ => v.to_string(),
    }
}

/// Run the steps in order on one page. A failed step is recorded and the rest still run.
/// `save` writes a screenshot's bytes into the workspace and returns the workspace-relative path.
pub async fn run_session(page: &Page, steps: &[Step], save: &mut (dyn FnMut(&str, &[u8]) -> Result<String, String> + Send)) -> Session {
    let mut s = Session::default();
    let mut navigated = false;
    for (i, step) in steps.iter().enumerate() {
        let outcome: Result<String, String> = match step {
            Step::Goto(url) => match page.goto(url).await {
                Ok((landed, status)) => {
                    navigated = true;
                    Ok(format!("Loaded {landed}{}", status.map(|c| format!(" — HTTP {c}")).unwrap_or_default()))
                }
                Err(e) => Err(e),
            },
            Step::Html(sel) => page.html(sel.as_deref()).await.map(|h| clip(&h, MAX_TEXT_CHARS)),
            Step::Click { selector, force } => page.click(selector, *force).await.map(|_| format!("Clicked {selector}")),
            Step::Type { selector, text, press_enter } => page.type_text(selector, text, *press_enter).await.map(|_| format!("Typed into {selector}")),
            Step::WaitFor { selector: Some(sel), .. } => page.wait_for(sel, ACTION_TIMEOUT).await.map(|_| format!("{sel} appeared")),
            Step::WaitFor { selector: None, ms } => {
                let ms = ms.unwrap_or(0);
                tokio::time::sleep(Duration::from_millis(ms)).await;
                Ok(format!("Waited {ms}ms"))
            }
            Step::Scroll(to) => page.scroll(to).await.map(|_| format!("Scrolled to {}", to.label())),
            Step::Screenshot { name, full_page } => match page.screenshot(*full_page).await {
                Ok(bytes) => save(&safe_name(name.as_deref(), i), &bytes).map(|saved| {
                    s.screenshots.push(saved.clone());
                    format!("Saved {saved} — open it with view_image")
                }),
                Err(e) => Err(e),
            },
            Step::Evaluate(script) => page.evaluate(script).await.map(|v| clip(&render(&v), 2000)),
            Step::Extract(sel) => page.extract(sel).await.map(|vals| {
                if vals.is_empty() {
                    format!("No elements matched {sel}")
                } else {
                    let shown: Vec<String> = vals.iter().take(50).map(|v| format!("  {}", clip(v, 200))).collect();
                    format!("{} match(es):\n{}", vals.len(), shown.join("\n"))
                }
            }),
        };
        s.results.push(match outcome {
            Ok(detail) => ActionResult { action: step.name(), ok: true, detail },
            Err(e) => ActionResult { action: step.name(), ok: false, detail: clip(first_line(&e), 300) },
        });
    }

    let (console, failed) = page.logs();
    s.console = console[console.len().saturating_sub(MAX_CONSOLE_LINES)..].to_vec();
    s.failed_requests = failed[failed.len().saturating_sub(20)..].to_vec();
    if navigated {
        s.final_url = page.url().await.unwrap_or_default();
        s.title = page.eval_string("document.title").await.unwrap_or_default();
        let text = page.eval_string("(document.body && document.body.innerText) || ''").await.unwrap_or_default();
        s.blocked = detect_challenge(&s.title, &text);
        s.text = clip(&text, MAX_TEXT_CHARS);
        let html = page.html(None).await.unwrap_or_default();
        if !html.is_empty() {
            s.selectors = Some(extract_selectors(&html, 400));
        }
    }
    s
}

#[derive(Default)]
struct Log {
    console: Vec<String>,
    failed: Vec<String>,
    /// requestId -> "METHOD url", so a failure can name the request.
    requests: HashMap<String, String>,
    /// Status of the last main-document response.
    doc_status: Option<u16>,
}

/// One attached page target. Everything goes through `sid`.
pub struct Page {
    cdp: Cdp,
    sid: String,
    log: Arc<StdMutex<Log>>,
    /// Counts DOMContentLoaded events, so a navigation can wait for the next one.
    dom: watch::Receiver<u64>,
}

impl Page {
    /// Open a blank page on the browser and turn on the events and the request check.
    pub async fn open(cdp: Cdp, events: mpsc::UnboundedReceiver<Value>) -> Result<Page, String> {
        let target = cdp.call("Target.createTarget", json!({ "url": "about:blank" }), None).await?;
        let attached = cdp.call("Target.attachToTarget", json!({ "targetId": target["targetId"], "flatten": true }), None).await?;
        let sid = attached["sessionId"].as_str().ok_or_else(|| "the browser did not attach a page".to_string())?.to_string();
        for method in ["Page.enable", "Runtime.enable", "Network.enable"] {
            cdp.call(method, json!({}), Some(&sid)).await?;
        }
        cdp.call("Emulation.setDeviceMetricsOverride", json!({ "width": 1280, "height": 900, "deviceScaleFactor": 1, "mobile": false }), Some(&sid)).await?;
        // Every request pauses here, so a non-public address is refused before the browser opens it.
        cdp.call("Fetch.enable", json!({ "patterns": [{ "urlPattern": "*" }] }), Some(&sid)).await?;

        let log = Arc::new(StdMutex::new(Log::default()));
        let (dom_tx, dom_rx) = watch::channel(0u64);
        tokio::spawn(pump(events, cdp.clone(), sid.clone(), log.clone(), dom_tx));
        Ok(Page { cdp, sid, log, dom: dom_rx })
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.cdp.call(method, params, Some(&self.sid)).await
    }

    /// Evaluate an expression in the page. A thrown error comes back as its first line.
    async fn eval(&self, expression: &str) -> Result<Value, String> {
        let r = self.call("Runtime.evaluate", json!({ "expression": expression, "returnByValue": true, "awaitPromise": true })).await?;
        if let Some(d) = r.get("exceptionDetails") {
            let msg = d["exception"]["description"].as_str().or(d["text"].as_str()).unwrap_or("evaluation failed");
            return Err(first_line(msg).to_string());
        }
        Ok(r["result"]["value"].clone())
    }

    async fn eval_string(&self, expression: &str) -> Result<String, String> {
        Ok(self.eval(expression).await?.as_str().unwrap_or("").to_string())
    }

    /// Poll an expression until it returns something other than null, or the timeout passes.
    async fn poll(&self, expression: &str, timeout: Duration) -> Result<Value, String> {
        let started = Instant::now();
        loop {
            let v = self.eval(expression).await?;
            if !v.is_null() {
                return Ok(v);
            }
            if started.elapsed() > timeout {
                return Err(format!("Timeout {}ms exceeded.", timeout.as_millis()));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Wait until the element is there (and shown, unless forced), scroll it into view, and return its centre.
    async fn locate(&self, selector: &str, force: bool, timeout: Duration) -> Result<(f64, f64), String> {
        let sel = serde_json::to_string(selector).unwrap_or_default();
        let js = format!(
            r#"(() => {{ const el = document.querySelector({sel}); if (!el) return null; el.scrollIntoView({{block: "center", inline: "center"}}); const r = el.getBoundingClientRect(); const shown = r.width > 0 && r.height > 0; if (!shown && !{force}) return null; return [r.left + r.width / 2, r.top + r.height / 2]; }})()"#
        );
        let v = self.poll(&js, timeout).await?;
        Ok((v[0].as_f64().unwrap_or(0.0), v[1].as_f64().unwrap_or(0.0)))
    }

    pub async fn click(&self, selector: &str, force: bool) -> Result<(), String> {
        let (x, y) = self.locate(selector, force, NAV_TIMEOUT).await?;
        for kind in ["mousePressed", "mouseReleased"] {
            self.call("Input.dispatchMouseEvent", json!({ "type": kind, "x": x, "y": y, "button": "left", "clickCount": 1 })).await?;
        }
        Ok(())
    }

    /// Click to focus, clear the field the way fill("") does, then send one key event per character.
    pub async fn type_text(&self, selector: &str, text: &str, press_enter: bool) -> Result<(), String> {
        self.click(selector, false).await?;
        let sel = serde_json::to_string(selector).unwrap_or_default();
        self.eval(&format!(
            r#"(() => {{ const el = document.querySelector({sel}); if (!el) return; el.focus(); try {{ const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ""); }} catch (e) {{}} el.dispatchEvent(new Event("input", {{bubbles: true}})); }})()"#
        ))
        .await?;
        for c in text.chars() {
            let key = c.to_string();
            self.call("Input.dispatchKeyEvent", json!({ "type": "keyDown", "key": key, "text": key, "unmodifiedText": key })).await?;
            self.call("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": key })).await?;
        }
        if press_enter {
            self.call("Input.dispatchKeyEvent", json!({ "type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "text": "\r" })).await?;
            self.call("Input.dispatchKeyEvent", json!({ "type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13 })).await?;
        }
        Ok(())
    }

    /// Wait until the selector matches a shown element.
    pub async fn wait_for(&self, selector: &str, timeout: Duration) -> Result<(), String> {
        let sel = serde_json::to_string(selector).unwrap_or_default();
        self.poll(&format!("(() => {{ const el = document.querySelector({sel}); if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? true : null; }})()"), timeout).await.map(|_| ())
    }

    pub async fn scroll(&self, to: &Scroll) -> Result<(), String> {
        let js = match to {
            Scroll::Top => "window.scrollTo(0, 0)".to_string(),
            Scroll::Bottom => "window.scrollTo(0, document.body.scrollHeight)".to_string(),
            Scroll::Px(n) => format!("window.scrollTo(0, {n})"),
        };
        self.eval(&js).await.map(|_| ())
    }

    pub async fn screenshot(&self, full_page: bool) -> Result<Vec<u8>, String> {
        let r = self.call("Page.captureScreenshot", json!({ "format": "png", "captureBeyondViewport": full_page })).await?;
        base64::engine::general_purpose::STANDARD.decode(r["data"].as_str().unwrap_or("")).map_err(|e| format!("the screenshot was not image data: {e}"))
    }

    /// The outer HTML of one element (after waiting for it), or of the whole document.
    pub async fn html(&self, selector: Option<&str>) -> Result<String, String> {
        match selector {
            None => self.eval_string("document.documentElement.outerHTML").await,
            Some(sel) => {
                let lit = serde_json::to_string(sel).unwrap_or_default();
                self.poll(&format!("document.querySelector({lit}) ? true : null"), NAV_TIMEOUT).await?;
                self.eval_string(&format!("document.querySelector({lit}).outerHTML")).await
            }
        }
    }

    /// Text of every node matching the selector, trimmed, empties dropped.
    pub async fn extract(&self, selector: &str) -> Result<Vec<String>, String> {
        let lit = serde_json::to_string(selector).unwrap_or_default();
        let v = self.eval(&format!("Array.from(document.querySelectorAll({lit}), n => (n.textContent ?? \"\").trim()).filter(Boolean)")).await?;
        Ok(v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default())
    }

    /// Evaluate as an expression first. If that is a syntax error, run it as statements (so `return` works).
    pub async fn evaluate(&self, script: &str) -> Result<Value, String> {
        let wrap = |inner: &str| format!("(() => {{ const value = {inner}; if (value instanceof Element) return value.outerHTML; if (typeof value === \"number\" && !Number.isFinite(value)) return null; return value === undefined ? null : value; }})()");
        match self.eval(&wrap(&format!("({script})"))).await {
            Err(e) if e.contains("SyntaxError") => self.eval(&wrap(&format!("(() => {{ {script} }})()"))).await,
            other => other,
        }
    }

    /// Navigate and wait for DOMContentLoaded. Returns the landed URL and the document's HTTP status.
    pub async fn goto(&self, url: &str) -> Result<(String, Option<u16>), String> {
        crate::search::assert_public_url_resolved(url, false).await?;
        let mut dom = self.dom.clone();
        dom.borrow_and_update();
        self.log.lock().unwrap().doc_status = None;
        let nav = self.call("Page.navigate", json!({ "url": url })).await?;
        if let Some(err) = nav["errorText"].as_str() {
            return Err(format!("{err} at {url}"));
        }
        match tokio::time::timeout(NAV_TIMEOUT, dom.changed()).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => return Err("the browser closed the connection".to_string()),
            Err(_) => return Err(format!("Timeout {}ms exceeded.", NAV_TIMEOUT.as_millis())),
        }
        let landed = self.url().await?;
        let status = self.log.lock().unwrap().doc_status;
        // A redirect hop is not always stopped by the request check, so the final address is checked too.
        if !policy::url_allowed(&landed).await {
            let _ = self.call("Page.navigate", json!({ "url": "about:blank" })).await;
            return Err(format!("Redirected to {landed}, which is not on the public web — not loaded."));
        }
        Ok((landed, status))
    }

    pub async fn url(&self) -> Result<String, String> {
        self.eval_string("location.href").await
    }

    /// Console lines and failed requests so far, as copies.
    pub fn logs(&self) -> (Vec<String>, Vec<String>) {
        let log = self.log.lock().unwrap();
        (log.console.clone(), log.failed.clone())
    }
}

/// Reads the browser's events for one page: console, exceptions, network failures, DOM events, and paused requests.
async fn pump(mut events: mpsc::UnboundedReceiver<Value>, cdp: Cdp, sid: String, log: Arc<StdMutex<Log>>, dom: watch::Sender<u64>) {
    let verdicts: Arc<StdMutex<HashMap<String, bool>>> = Default::default();
    while let Some(ev) = events.recv().await {
        if ev["sessionId"].as_str() != Some(sid.as_str()) {
            continue;
        }
        let p = &ev["params"];
        match ev["method"].as_str().unwrap_or("") {
            "Runtime.consoleAPICalled" => {
                let kind = p["type"].as_str().unwrap_or("");
                if matches!(kind, "error" | "warning" | "log") {
                    let text = p["args"].as_array().map(|a| a.iter().map(remote_text).collect::<Vec<_>>().join(" ")).unwrap_or_default();
                    log.lock().unwrap().console.push(format!("[{kind}] {}", clip(&text, 300)));
                }
            }
            "Runtime.exceptionThrown" => {
                let d = &p["exceptionDetails"];
                let msg = d["exception"]["description"].as_str().or(d["text"].as_str()).unwrap_or("");
                log.lock().unwrap().console.push(format!("[uncaught] {}", clip(first_line(msg), 300)));
            }
            "Network.requestWillBeSent" => {
                let mut l = log.lock().unwrap();
                if l.requests.len() > 2000 {
                    l.requests.clear();
                }
                let what = format!("{} {}", p["request"]["method"].as_str().unwrap_or("GET"), clip(p["request"]["url"].as_str().unwrap_or(""), 200));
                l.requests.insert(p["requestId"].as_str().unwrap_or("").to_string(), what);
            }
            "Network.loadingFailed" => {
                let mut l = log.lock().unwrap();
                let what = l.requests.remove(p["requestId"].as_str().unwrap_or("")).unwrap_or_else(|| "request".to_string());
                let why = p["errorText"].as_str().unwrap_or("failed");
                l.failed.push(format!("{what} — {why}"));
            }
            "Network.responseReceived" => {
                let status = p["response"]["status"].as_u64().unwrap_or(0) as u16;
                let mut l = log.lock().unwrap();
                if p["type"].as_str() == Some("Document") {
                    l.doc_status = Some(status);
                }
                if status >= 400 {
                    l.failed.push(format!("{status} {}", clip(p["response"]["url"].as_str().unwrap_or(""), 200)));
                }
            }
            "Page.domContentEventFired" => dom.send_modify(|n| *n += 1),
            "Fetch.requestPaused" => {
                let id = p["requestId"].as_str().unwrap_or("").to_string();
                let url = p["request"]["url"].as_str().unwrap_or("").to_string();
                let (cdp, sid, verdicts) = (cdp.clone(), sid.clone(), verdicts.clone());
                tokio::spawn(async move {
                    let ok = allowed_cached(&verdicts, &url).await;
                    let (method, params) = if ok {
                        ("Fetch.continueRequest", json!({ "requestId": id }))
                    } else {
                        ("Fetch.failRequest", json!({ "requestId": id, "errorReason": "BlockedByClient" }))
                    };
                    let _ = cdp.call(method, params, Some(&sid)).await;
                });
            }
            _ => {}
        }
    }
}

/// The request rule, with one verdict kept per scheme and host.
async fn allowed_cached(cache: &StdMutex<HashMap<String, bool>>, url: &str) -> bool {
    let Some(key) = policy::host_key(url) else { return false };
    if let Some(v) = cache.lock().unwrap().get(&key).copied() {
        return v;
    }
    let v = policy::url_allowed(url).await;
    cache.lock().unwrap().insert(key, v);
    v
}

/// The text of one console argument: a string as is, anything else by its value or description.
fn remote_text(v: &Value) -> String {
    if let Some(s) = v["value"].as_str() {
        return s.to_string();
    }
    if !v["value"].is_null() {
        return v["value"].to_string();
    }
    v["description"].as_str().unwrap_or("").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures() -> Value {
        serde_json::from_str(include_str!("fixtures.json")).unwrap()
    }

    #[test]
    fn validation_matches_typescript_fixtures() {
        let f = fixtures();
        let cases = f["validate"].as_array().unwrap();
        assert_eq!(cases.len(), 13);
        for case in cases {
            let got = validate_actions(&case[0]);
            match case[1].get("error").and_then(Value::as_str) {
                Some(want) => assert_eq!(got.unwrap_err(), want, "{}", case[0]),
                None => assert!(got.is_ok(), "{} should validate: {got:?}", case[0]),
            }
        }
    }

    #[test]
    fn challenge_detection_matches_typescript_fixtures() {
        let f = fixtures();
        for case in f["challenge"].as_array().unwrap() {
            let got = detect_challenge(case[0]["title"].as_str().unwrap(), case[0]["text"].as_str().unwrap());
            assert_eq!(got, case[1].as_str(), "{}", case[0]);
        }
    }

    #[test]
    fn screenshot_names_are_safe_and_fall_back() {
        assert_eq!(safe_name(Some("shop page!!"), 3), "shop-page.png");
        assert_eq!(safe_name(None, 3), "shot-3.png");
        assert_eq!(safe_name(Some("!!"), 2), "shot-2.png");
    }

    #[test]
    fn selectors_skip_noise_and_dedupe() {
        let html = r#"<html><script>var a = '<div id="fake">'</script><div id="app" class="card hero x"><span id="app" data-match-id="1" data-Score="2"></span></div></html>"#;
        let s = extract_selectors(html, 400);
        assert_eq!(s.ids, vec!["app"]);
        assert_eq!(s.classes, vec!["card", "hero"]);
        assert_eq!(s.data_attrs, vec!["data-match-id", "data-score"]);
    }

    #[test]
    fn shell_needs_scripts_and_an_empty_mount() {
        assert!(looks_like_app_shell(r#"<body><div id="root"></div><script src="x.js"></script></body>"#, ""));
        assert!(!looks_like_app_shell(r#"<body><div id="root"></div></body>"#, ""));
    }

    #[test]
    fn session_text_puts_the_note_and_selectors_in_order() {
        let s = Session {
            results: vec![ActionResult { action: "goto", ok: true, detail: "Loaded https://x.test/ — HTTP 200".into() }],
            title: "Just a moment...".into(),
            blocked: Some("Cloudflare"),
            selectors: Some(Selectors { ids: vec!["a".into()], ..Default::default() }),
            text: "hi".into(),
            ..Default::default()
        };
        let out = format_session(&s);
        assert!(out.starts_with("NOTE: this page is Cloudflare's anti-bot challenge"));
        assert!(out.find("Selectors on the rendered page").unwrap() < out.find("Visible text:").unwrap());
        assert!(out.contains("OK   goto: Loaded https://x.test/ — HTTP 200"));
    }
}

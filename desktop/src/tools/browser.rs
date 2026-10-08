//! The three browser tools: inspect_page, browse and screenshot_window. Port of their cases in tools.ts.
//! Result texts, summaries, limits and error messages are the web's, because the model reads them.
//! None of the three asks for approval, as on the web: they read pages and capture windows and change nothing the user sees.
//!
//! ponytail: inspect_page stops reading a body at the byte cap and says so, but does not report the full size the web gives.
//! ponytail: redirect hops are followed by the shared HTTP client without a per-hop public-address check. fetch_url has the same gap.

use crate::browser::page::{self, Page, Selectors, SCREENSHOT_DIR};
use crate::browser::window;
use crate::tools::{Ctx, Output, bool_arg, num_arg, str_arg};
use futures_util::StreamExt;
use serde_json::Value;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) apiM/0.1";
const FETCH_TIMEOUT: Duration = Duration::from_secs(25);

fn fail(text: impl Into<String>, summary: &str) -> Output {
    Output { ok: false, text: text.into(), summary: summary.into(), ..Default::default() }
}

/// The listing for inspect_page: header, one block per kind that has matches, then the closing line.
/// Empty blocks are dropped, as the web's filter(Boolean) drops them.
pub fn listing(page_url: &str, filter: &str, ids: &[String], classes: &[String], attrs: &[String]) -> String {
    let section = |label: &str, list: &[String]| (!list.is_empty()).then(|| format!("{label} ({}):\n{}", list.len(), list.join("\n")));
    let header = format!("Selectors on {page_url}{}:", if filter.is_empty() { String::new() } else { format!(" matching \"{filter}\"") });
    let mut lines = vec![header];
    lines.extend([section("IDs", ids), section("Classes", classes), section("Data attributes", attrs)].into_iter().flatten());
    lines.push("These are the real names on the page. Target these exactly rather than inventing selectors.".into());
    lines.join("\n")
}

/// Look at the selectors of a page as the server sends it. Refuses an app shell: its selectors would not exist in the live page.
pub async fn inspect_page(ctx: &Ctx, args: &Value) -> Output {
    let url = match crate::search::assert_public_url_resolved(str_arg(args, "url"), false).await {
        Ok(u) => u,
        Err(e) => return Output::fail(e),
    };
    let host = url.host_str().unwrap_or("").to_string();
    let resp = match ctx.client.get(url.clone()).header("User-Agent", USER_AGENT).header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8").header("Accept-Language", "en-US,en;q=0.9").timeout(FETCH_TIMEOUT).send().await {
        Ok(r) => r,
        Err(e) if e.is_timeout() => return Output::fail(format!("{host} did not respond within 25 seconds.")),
        Err(e) => return Output::fail(format!("Could not reach {host}: {e}")),
    };
    let page_url = resp.url().clone();
    let kind = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let lower = kind.to_ascii_lowercase();
    if lower.starts_with("image/") || lower.starts_with("video/") || lower.starts_with("audio/") || ["application/zip", "application/octet-stream", "application/pdf", "application/x-"].iter().any(|t| lower.contains(t)) {
        return Output::fail(format!("That URL is {}, which this tool cannot read. It reads web pages and text.", kind.split(';').next().unwrap_or("")));
    }
    let content_type = kind.split(';').next().filter(|s| !s.is_empty()).unwrap_or("unknown").to_string();

    let cap = ctx.limits.fetch_bytes as usize;
    let mut bytes: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => return Output::fail(format!("Could not reach {host}: {e}")),
        };
        if bytes.len() + chunk.len() > cap {
            return Output::fail(format!("That page is over the {:.1}MB limit.", cap as f64 / 1_048_576.0));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8_lossy(&bytes).into_owned();
    let lead = body.trim_start().to_ascii_lowercase();
    let is_html = lower.contains("html") || lower.contains("xml") || lead.starts_with("<!doctype") || lead.starts_with("<html");
    if !is_html {
        return Output { ok: false, text: format!("{page_url} returned {content_type}, not HTML, so it has no selectors to inspect."), summary: "Not an HTML page".into(), ..Default::default() };
    }

    let text = crate::tools::web::html_to_text(&body);
    if page::looks_like_app_shell(&body, &text) {
        return Output {
            ok: false,
            text: format!(
                "{page_url} is an app shell: the markup the server sent contains no real content, because the page is built by JavaScript that has not run. Any selector taken from it would not exist in the live page.\n\nUse browse on this URL — it runs the scripts and returns the rendered DOM."
            ),
            summary: "Needs a browser, not a fetch".into(),
            ..Default::default()
        };
    }

    let html: String = body.chars().take(ctx.limits.fetch_chars as usize).collect();
    let found: Selectors = page::extract_selectors(&html, 400);
    let filter = str_arg(args, "contains").to_lowercase();
    let keep = |list: &[String]| -> Vec<String> { list.iter().filter(|v| filter.is_empty() || v.to_lowercase().contains(&filter)).cloned().collect() };
    let (ids, classes, attrs) = (keep(&found.ids), keep(&found.classes), keep(&found.data_attrs));

    if ids.is_empty() && classes.is_empty() && attrs.is_empty() {
        let text = if filter.is_empty() {
            format!(
                "{page_url} has no ids, classes or data attributes to list. That is valid for a simple static page built from plain tags; there is no evidence here that JavaScript is involved. Read the raw HTML with fetch_url if tag structure is enough, or inspect a more specific page."
            )
        } else {
            format!(
                "No ids, classes or data-attributes on {page_url} contain \"{filter}\". The page has {} ids and {} classes in total — try a different word, or call again without a filter.",
                found.ids.len(),
                found.classes.len()
            )
        };
        return Output { ok: true, text, summary: "No selectors found".into(), ..Default::default() };
    }

    Output {
        ok: true,
        text: listing(page_url.as_str(), &filter, &ids, &classes, &attrs),
        summary: format!("Inspected {host} — {} selectors", ids.len() + classes.len()),
        ..Default::default()
    }
}

/// Run a list of actions on one live page and report what rendered. Screenshots are saved under .agent-browser/screenshots.
pub async fn browse(ctx: &Ctx, args: &Value) -> Output {
    let steps = match page::validate_actions(&args["actions"]) {
        Ok(s) => s,
        Err(e) => return fail(format!("Error: {e}"), "Invalid browser actions"),
    };
    let (browser, events) = match crate::browser::launch().await {
        Ok(b) => b,
        Err(e) => return fail(format!("Error: {e}"), "Browser not available"),
    };
    let session_page = match Page::open(browser.cdp.clone(), events).await {
        Ok(p) => p,
        Err(e) => return fail(format!("Error: {e}"), "Browser not available"),
    };

    let root = ctx.root.clone();
    let mut shots: Vec<PathBuf> = Vec::new();
    let mut save = |name: &str, data: &[u8]| -> Result<String, String> {
        let rel = format!("{SCREENSHOT_DIR}/{name}");
        let abs = root.join(&rel);
        if let Some(dir) = abs.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("could not save the screenshot: {e}"))?;
        }
        std::fs::write(&abs, data).map_err(|e| format!("could not save the screenshot: {e}"))?;
        shots.push(abs);
        Ok(rel)
    };
    let result = page::run_session(&session_page, &steps, &mut save).await;
    drop(session_page);
    drop(browser);

    let failed = result.results.iter().filter(|r| !r.ok).count();
    let summary = if failed > 0 {
        format!("Browsed with {failed} step(s) failing")
    } else {
        format!("Browsed {}", if result.title.is_empty() { "page" } else { &result.title })
    };
    Output {
        ok: result.results.iter().any(|r| r.ok),
        text: page::format_session(&result),
        summary,
        image: shots.last().cloned(),
        ..Default::default()
    }
}

/// The success text for a capture. `by_id` is true when the window was picked by pid or process id.
pub fn capture_receipt(relative: &str, shot: &window::Captured, by_id: bool) -> String {
    let aim = if !shot.window_title.is_empty() {
        let mut s = format!("\n\nWindow captured: \"{}\".", shot.window_title);
        if !shot.also_matched.is_empty() {
            let others = shot.also_matched.iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(", ");
            s += &format!(" Other windows also matched that title: {others}. If the image is not the app, capture by process_id or pid instead of by title.");
        }
        s
    } else if by_id {
        String::new()
    } else {
        "\n\nMatched by title, which is a guess. Prefer process_id (from start_process) or pid — a title can belong to any window.".to_string()
    };
    let kb = (shot.bytes as f64 / 1024.0).round() as u64;
    format!(
        "Saved {relative} ({}x{}, {kb}KB, via {}).{aim}\n\nCall view_image on it now — the file existing is not the same as you having looked at it.",
        shot.width, shot.height, shot.method
    )
}

/// Capture a running window, or the whole screen, to a PNG in the workspace.
pub async fn screenshot_window(ctx: &Ctx, args: &Value) -> Output {
    let given = str_arg(args, "path").trim().to_string();
    let relative = if given.is_empty() {
        format!("screenshots/window-{}.png", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0))
    } else {
        given
    };
    let out = match crate::tools::files::resolve(&ctx.root, &relative) {
        Ok(p) => p,
        Err(_) => return fail("Error: the screenshot path must stay inside the workspace.", "Path outside the workspace"),
    };

    // A process this app started is the best aim: its pid is known, so no title guessing is needed.
    let process_id = str_arg(args, "process_id").trim().to_string();
    let mut pid = num_arg(args, "pid").map(|p| p as u32);
    if !process_id.is_empty() {
        let Some(tracked) = ctx.procs.list().into_iter().find(|p| p.id == process_id) else {
            return fail(format!("Error: no process with id \"{process_id}\". Use list_processes to see what is running."), "No such process");
        };
        if let Some(code) = tracked.exit {
            return fail(
                format!("Error: {} has already exited (code {code}), so it has no window. Start it again before capturing.", tracked.display),
                "Process already exited",
            );
        }
        pid = Some(tracked.pid);
    }
    let by_id = pid.is_some_and(|p| p > 0);

    let _ = std::fs::remove_file(&out);
    let request = window::Request { title: args["title"].as_str().map(str::to_string), pid, out: out.clone(), full_screen: bool_arg(args, "full_screen") };
    let shot = match window::capture(&request) {
        Ok(s) => s,
        Err(e) => return fail(format!("Error: {e}\n\nNothing was saved. Do not describe the window as if you had seen it."), "Could not capture the window"),
    };
    Output {
        ok: true,
        text: capture_receipt(&relative, &shot, by_id),
        summary: format!("Captured {relative}"),
        // Attached for a model that can see; the text above tells every model to call view_image anyway.
        image: Some(out.clone()),
        look: Some(out),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_drops_empty_blocks_and_keeps_the_closing_line() {
        let ids = vec!["app".to_string()];
        let text = listing("https://x.test/", "", &ids, &[], &[]);
        assert_eq!(text, "Selectors on https://x.test/:\nIDs (1):\napp\nThese are the real names on the page. Target these exactly rather than inventing selectors.");
        assert!(listing("https://x.test/", "score", &[], &[], &[]).starts_with("Selectors on https://x.test/ matching \"score\":\n"));
    }

    #[test]
    fn receipt_names_the_window_and_the_other_matches() {
        let shot = window::Captured { window_title: "Settings".into(), also_matched: vec!["Settings - Help".into()], width: 640, height: 480, bytes: 2048, method: "PrintWindow" };
        let text = capture_receipt("screenshots/a.png", &shot, false);
        assert!(text.starts_with("Saved screenshots/a.png (640x480, 2KB, via PrintWindow).\n\nWindow captured: \"Settings\"."));
        assert!(text.contains("Other windows also matched that title: \"Settings - Help\"."));
    }

    #[test]
    fn receipt_warns_about_a_title_guess_only_when_no_pid_was_used() {
        let shot = window::Captured { width: 1, height: 1, bytes: 1024, method: "screen copy", ..Default::default() };
        assert!(capture_receipt("a.png", &shot, false).contains("Matched by title, which is a guess."));
        assert!(!capture_receipt("a.png", &shot, true).contains("guess"));
    }
}

//! Web tools: read a page, call an API, download a file, search.

use super::{Ctx, Output, bool_arg, clip, files, str_arg};
use futures_util::StreamExt;
use regex::Regex;
use serde_json::Value;
use std::net::IpAddr;
use std::sync::LazyLock;
use std::time::Duration;

const DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024;
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) apiM/0.1";

/// Refuses addresses on this machine and the local network, so a page or a model
/// cannot use these tools to reach a router, a NAS or a cloud metadata service.
/// `allow_loopback` opens only localhost, for testing a development server.
fn check_url(raw: &str, allow_loopback: bool) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| format!("Not a valid URL: {raw}. Include https://"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("Only http and https URLs are supported, not {}:", url.scheme()));
    }
    let host = url.host_str().unwrap_or("").trim_matches(['[', ']']).to_ascii_lowercase();
    let ip: Option<IpAddr> = host.parse().ok();
    let loopback = host == "localhost" || host.ends_with(".localhost") || ip.is_some_and(|i| i.is_loopback());
    let private = match ip {
        Some(IpAddr::V4(v4)) => v4.is_private() || v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast() || v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64,
        Some(IpAddr::V6(v6)) => v6.is_unspecified() || (v6.segments()[0] & 0xfe00) == 0xfc00 || (v6.segments()[0] & 0xffc0) == 0xfe80,
        None => host.is_empty() || host.ends_with(".local") || host.ends_with(".internal") || !host.contains('.') && !loopback,
    };
    if private {
        return Err(format!("{host} is a private network address. These tools only reach the public internet."));
    }
    if loopback && !allow_loopback {
        return Err(format!("{host} is this machine. Use http_request with allow_local: true to test a development server here."));
    }
    Ok(url)
}

/// `check_url`, then the same question asked of the addresses the name really resolves to,
/// so a public-looking name that points at this machine or the LAN is refused too.
async fn public_url(raw: &str, allow_loopback: bool) -> Result<reqwest::Url, String> {
    check_url(raw, allow_loopback)?;
    crate::search::assert_public_url_resolved(raw, allow_loopback).await
}

/// Reads a response body up to `max` bytes. Returns the bytes and whether more was left.
async fn read_capped(resp: reqwest::Response, max: usize) -> Result<(Vec<u8>, bool), String> {
    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("The download broke off: {e}"))?;
        if body.len() + chunk.len() > max {
            body.extend_from_slice(&chunk[..max - body.len()]);
            return Ok((body, true));
        }
        body.extend_from_slice(&chunk);
    }
    Ok((body, false))
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid pattern")
}

/// HTML to readable text.
// ponytail: regex-based, good for articles and docs. Swap in a real HTML parser if pages with odd markup read badly.
pub fn html_to_text(html: &str) -> String {
    static DROP: LazyLock<Regex> = LazyLock::new(|| re(r"(?is)<(script|style|noscript|svg|template|head)\b.*?</(script|style|noscript|svg|template|head)\s*>|<!--.*?-->"));
    static BREAK: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)<br\s*/?>|</?(p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|pre|blockquote|dd|dt)\b[^>]*>"));
    static TAG: LazyLock<Regex> = LazyLock::new(|| re(r"(?s)<[^>]*>"));
    static ENTITY: LazyLock<Regex> = LazyLock::new(|| re(r"&(#x?[0-9a-fA-F]+|[a-zA-Z]+);"));
    static SPACES: LazyLock<Regex> = LazyLock::new(|| re(r"[ \t\r\f]+"));
    static BLANKS: LazyLock<Regex> = LazyLock::new(|| re(r"\n\s*\n\s*(\n\s*)+"));

    let text = DROP.replace_all(html, " ");
    let text = BREAK.replace_all(&text, "\n");
    let text = TAG.replace_all(&text, "");
    let text = ENTITY.replace_all(&text, |c: &regex::Captures| {
        let name = &c[1];
        let named = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            "mdash" => Some('—'),
            "ndash" => Some('–'),
            "hellip" => Some('…'),
            "copy" => Some('©'),
            _ => None,
        };
        let numeric = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")).and_then(|h| u32::from_str_radix(h, 16).ok()).or_else(|| name.strip_prefix('#').and_then(|d| d.parse().ok())).and_then(char::from_u32);
        named.or(numeric).map_or_else(|| c[0].to_string(), |ch| ch.to_string())
    });
    let text = SPACES.replace_all(&text, " ");
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    BLANKS.replace_all(&lines.join("\n"), "\n\n").trim().to_string()
}

/// Only the lines matching `find`, each with a little context.
fn find_lines(text: &str, find: &str, max: usize) -> String {
    let needle = Regex::new(&format!("(?i){find}")).unwrap_or_else(|_| re(&format!("(?i){}", regex::escape(find))));
    let lines: Vec<&str> = text.lines().collect();
    let hits: Vec<usize> = (0..lines.len()).filter(|&i| needle.is_match(lines[i])).collect();
    if hits.is_empty() {
        return format!("`{find}` does not appear in the page ({} lines).", lines.len());
    }
    let mut out = format!("{} matching lines (showing up to {max}):\n", hits.len());
    for &i in hits.iter().take(max) {
        for n in i.saturating_sub(1)..(i + 2).min(lines.len()) {
            let line: String = lines[n].chars().take(600).collect();
            out.push_str(&format!("{}{} {line}\n", n + 1, if n == i { ":" } else { "-" }));
        }
        out.push_str("--\n");
    }
    out
}

pub async fn fetch_url(ctx: &Ctx, args: &Value) -> Output {
    let url = match public_url(str_arg(args, "url"), false).await {
        Ok(u) => u,
        Err(e) => return Output::fail(e),
    };
    let resp = match ctx.client.get(url.clone()).header("User-Agent", USER_AGENT).header("Accept", "text/html,application/json,text/plain,*/*").timeout(Duration::from_secs(30)).send().await {
        Ok(r) => r,
        Err(e) => return Output::fail(format!("Could not open {url}: {e}")),
    };
    let status = resp.status();
    let kind = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let (bytes, cut) = match read_capped(resp, ctx.limits.fetch_bytes as usize).await {
        Ok(b) => b,
        Err(e) => return Output::fail(e),
    };
    let body = String::from_utf8_lossy(&bytes);
    let is_html = kind.contains("html") || body.trim_start().starts_with("<!") || body.trim_start().to_ascii_lowercase().starts_with("<html");
    let text = if is_html && !bool_arg(args, "raw") { html_to_text(&body) } else { body.into_owned() };
    let find = str_arg(args, "find");
    let shown = if find.is_empty() { clip(&text, ctx.limits.fetch_chars as usize) } else { find_lines(&text, find, ctx.limits.fetch_find_matches as usize) };
    let header = format!("{url} answered {} ({kind}, {} chars{})", status.as_u16(), text.len(), if cut { format!(", cut at {} MB", ctx.limits.fetch_bytes >> 20) } else { String::new() });
    Output { ok: status.is_success(), ..Output::ok(format!("{header}\n\n{shown}"), format!("Read {} ({})", url.host_str().unwrap_or(""), status.as_u16())) }
}

pub async fn http_request(ctx: &Ctx, args: &Value) -> Output {
    let url = match public_url(str_arg(args, "url"), bool_arg(args, "allow_local")).await {
        Ok(u) => u,
        Err(e) => return Output::fail(e),
    };
    let method = str_arg(args, "method").to_ascii_uppercase();
    let method = if method.is_empty() { "GET".to_string() } else { method };
    if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS") {
        return Output::fail(format!("Unsupported method {method}."));
    }
    let mut req = ctx.client.request(method.parse().expect("checked above"), url.clone()).header("User-Agent", USER_AGENT).timeout(Duration::from_secs(30));
    let mut has_type = false;
    for (name, value) in args["headers"].as_object().into_iter().flatten() {
        if let Some(v) = value.as_str() {
            has_type |= name.eq_ignore_ascii_case("content-type");
            req = req.header(name.as_str(), v);
        }
    }
    let body = str_arg(args, "body");
    if !body.is_empty() {
        if !has_type && serde_json::from_str::<Value>(body).is_ok() {
            req = req.header("Content-Type", "application/json");
        }
        req = req.body(body.to_string());
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return Output::fail(format!("{method} {url} failed: {e}")),
    };
    let status = resp.status();
    let headers: String = resp.headers().iter().take(30).map(|(k, v)| format!("{k}: {}\n", v.to_str().unwrap_or("?"))).collect();
    let (bytes, _) = match read_capped(resp, ctx.limits.fetch_bytes as usize).await {
        Ok(b) => b,
        Err(e) => return Output::fail(e),
    };
    let raw = String::from_utf8_lossy(&bytes);
    // JSON comes back indented so it can be read.
    let body = serde_json::from_str::<Value>(&raw).ok().and_then(|v| serde_json::to_string_pretty(&v).ok()).unwrap_or_else(|| raw.into_owned());
    let summary = format!("{method} {} → {}", url.path(), status.as_u16());
    Output { ok: status.is_success(), ..Output::ok(format!("{method} {url}\nStatus {status}\n{headers}\n{}", clip(&body, 60_000)), summary) }
}

pub async fn download_file(ctx: &Ctx, args: &Value) -> Output {
    let rel = str_arg(args, "path");
    let url = match public_url(str_arg(args, "url"), bool_arg(args, "allow_local")).await {
        Ok(u) => u,
        Err(e) => return Output::fail(e),
    };
    let path = match files::resolve(&ctx.root, rel) {
        Ok(p) if p != ctx.root => p,
        Ok(_) => return Output::fail("path is required: where to save the file in the workspace."),
        Err(e) => return Output::fail(e),
    };
    let resp = match ctx.client.get(url.clone()).header("User-Agent", USER_AGENT).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => return Output::fail(format!("{url} answered {}. Nothing was saved.", r.status())),
        Err(e) => return Output::fail(format!("Could not download {url}: {e}")),
    };
    if resp.content_length().is_some_and(|n| n > DOWNLOAD_BYTES) {
        return Output::fail(format!("The file is {} MB, over the 200 MB limit.", resp.content_length().unwrap_or(0) >> 20));
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut file = match tokio::fs::File::create(&path).await {
        Ok(f) => f,
        Err(e) => return Output::fail(format!("Cannot create {rel}: {e}")),
    };
    let mut stream = resp.bytes_stream();
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    let mut size = 0u64;
    while let Some(chunk) = stream.next().await {
        let ok = match chunk {
            Ok(c) => {
                size += c.len() as u64;
                sha2::Digest::update(&mut hasher, &c);
                size <= DOWNLOAD_BYTES && tokio::io::AsyncWriteExt::write_all(&mut file, &c).await.is_ok()
            }
            Err(_) => false,
        };
        if !ok {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Output::fail(format!("The download of {url} did not finish (network error, disk error, or over 200 MB). Nothing was kept."));
        }
    }
    let hash: String = sha2::Digest::finalize(hasher).iter().map(|b| format!("{b:02x}")).collect();
    Output::ok(format!("Saved {url} to {rel}: {size} bytes, sha256 {hash}."), format!("Downloaded {rel} ({} KB)", size / 1024)).changed(rel)
}

pub async fn web_search(ctx: &Ctx, args: &Value) -> Output {
    let s = &ctx.settings;
    let keys = crate::search::Keys { tavily: s.tavily(), exa: s.exa(), tavily_enabled: s.tavily_enabled, exa_enabled: s.exa_enabled };
    let reply = crate::search::web_search(&ctx.client, str_arg(args, "query"), &s.search_profile, &keys, ctx.planner.as_ref()).await;
    Output { ok: reply.ok, text: reply.content, summary: reply.summary, search: reply.search, ..Default::default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_addresses_are_refused() {
        assert!(check_url("https://example.com/a", false).is_ok());
        for bad in ["http://192.168.1.1/", "http://10.0.0.5", "http://169.254.169.254/latest", "http://[fd00::1]/", "http://router/", "http://nas.local", "file:///etc/passwd", "ftp://x.com"] {
            assert!(check_url(bad, true).is_err(), "{bad}");
        }
        assert!(check_url("http://localhost:3000", false).is_err());
        assert!(check_url("http://127.0.0.1:3000", true).is_ok());
        assert!(check_url("http://[::1]:3000", true).is_ok());
    }

    #[test]
    fn html_becomes_text() {
        let html = "<html><head><title>T</title><style>p{}</style></head><body><h1>Hi &amp; bye</h1><script>x()</script><p>One<br>two&nbsp;&#33;</p><!-- c --></body></html>";
        assert_eq!(html_to_text(html), "Hi & bye\n\nOne\ntwo !");
        assert!(find_lines("a\nversion: 2\nb", "version", 20).contains("2: version: 2"));
    }

    /// A search lands on the reply it ran for: each source and query once, and its cost.
    #[test]
    fn a_search_lands_on_its_reply_once_per_source_and_query() {
        let source = |url: &str| crate::search::SearchResult { title: url.into(), url: url.into(), domain: "example.com".into(), ..Default::default() };
        let mut reply = crate::store::Message::new(crate::store::Role::Assistant, "");
        let found = crate::search::SearchOutcome { results: vec![source("https://a"), source("https://b")], queries: vec!["rust".into(), "rust".into()], estimated_usd: 0.008, ..Default::default() };
        crate::search::record_on(&mut reply, &found);
        crate::search::record_on(&mut reply, &found);
        assert_eq!(reply.search_results.iter().map(|r| r.url.as_str()).collect::<Vec<_>>(), ["https://a", "https://b"]);
        assert_eq!(reply.search_queries, ["rust"]);
        assert!((reply.search_usd - 0.016).abs() < 1e-9);
    }
}

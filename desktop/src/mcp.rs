//! MCP servers: the client, the saved server list, and one function per thing the UI does with them.
//! Ported from the web app (src/lib/mcp.ts, src/lib/mcp-store.ts, src/app/api/mcp/*), which stays the reference.
//!
//! Transport is streamable HTTP only, as on the web (no stdio there, none here). The client is stateless and
//! only ever POSTs: the first server it had to reach answers GET with 405, answers a POST as either plain JSON
//! or SSE frames, and never issues a session id. A server that insists on a session id refuses the second
//! message here exactly as it does on the web. Auth is a bearer token on every call.
//!
//! The saved list is `<data_dir>/mcp-servers.json`, the file the web app reads and writes: a pretty-printed
//! array of `{ id, name, url, token: string | null, enabled, createdAt, updatedAt }`. The token grants whatever
//! the server can do, so the UI gets `McpServerPublic` (which says only whether a token is set).
//!
//! # Wiring into the agent loop
//!
//! What the web chat route (src/app/api/chat/route.ts) does around these functions. It is not ported.
//!
//! 1. Offer. Each round, after the built-in tools, append `tools_for_model` to the request's `tools`
//!    (`tool_choice` is "auto"). A server that is down adds nothing that round and never fails the reply.
//! 2. Spot. A tool call whose name starts with `mcp__` is `mcp__<serverId>__<tool>`. Its arguments must be a
//!    JSON object (empty text counts as `{}`). `bridged` resolves it; `None` (bad name, server gone or
//!    disabled) means the tool result is `unavailable()`.
//! 3. Ask, always, as for run_command: a remote tool can run code on the user's machine. Skip the question
//!    only when commands auto-run, or the user chose "Always allow this" for the same server, tool and
//!    arguments in this chat (`BridgedCall::remember_key`; the web remembers command "mcp:<serverId>:<tool>"
//!    with args [arguments JSON, keys sorted]). The request is `{ command: "mcp", args: [server name, tool,
//!    arguments JSON], display, reason: "" }`, where display is `<server name> · <tool>` plus
//!    `(<arguments JSON>)` unless that is `{}`, the JSON cut to 120 characters and then followed by `…`.
//!    The card is titled "Call this MCP tool?" (not "Run this command?"), shows `display` without the "$ "
//!    prefix, and has Run, Skip and "Always allow this". It waits 5 minutes. A refusal carries a reason:
//!    "The user declined to run this command.", "The user did not respond to the approval prompt within 5
//!    minutes." or "The user stopped the reply."; the tool result is then `declined(display, reason)`.
//! 4. Call. `call_bridged`, limited to 120 s. Stop cancels it: drop the future. A transport failure and a
//!    tool-level `isError` both come back as a failed result, never as an error to handle.
//! 5. Feed back. `content` goes in whole as the `role: "tool"` message for that call id; `ok` and `summary`
//!    ("MCP <tool>: <first line, 120 characters>" or "MCP <tool> failed: <same>") go to the step row, whose
//!    label is `display_name` ("MCP <tool>"). Nothing shortens an MCP result when it arrives. Only the
//!    general history trim applies later (the web's pruneTranscript: once the transcript passes 24,000
//!    characters, tool results older than the newest 8 and longer than 1,500 characters collapse to a
//!    short placeholder).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

pub const MCP_PROTOCOL_VERSION: &str = "2024-11-05";
/// Timeouts are tight on purpose: MCP servers are usually localhost.
pub const MCP_CONNECT_TIMEOUT_MS: u64 = 15_000;
pub const MCP_CALL_TIMEOUT_MS: u64 = 120_000;
/// Prefix of the tool names offered to the model.
pub const MCP_TOOL_PREFIX: &str = "mcp__";
/// Model function names must fit this (OpenAI and DeepSeek limits).
pub const MCP_TOOL_NAME_MAX: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    Auth,
    Connect,
    Http,
    Protocol,
    Timeout,
}

/// A failed exchange. `message` already says what the user can do about it.
#[derive(Clone, Debug, PartialEq)]
pub struct McpError {
    pub kind: ErrorKind,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct McpTool {
    pub name: String,
    /// Empty when the server gave none.
    pub description: String,
    /// Null when the server gave none.
    pub input_schema: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct McpServerInfo {
    pub name: String,
    pub version: String,
    pub protocol_version: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct McpConnection {
    pub server: McpServerInfo,
    pub tools: Vec<McpTool>,
}

/// What a tool call hands back: `content` for the model, `summary` for the step row.
#[derive(Clone, Debug, PartialEq)]
pub struct CallResult {
    pub ok: bool,
    pub content: String,
    pub summary: String,
}

/// A number no other call in this process got: JSON-RPC ids, new server ids, temp file names.
fn unique() -> u64 {
    static N: AtomicU64 = AtomicU64::new(1);
    N.fetch_add(1, Ordering::Relaxed)
}

/// The first `n` characters.
fn head(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

// ---------------------------------------------------------------- client

/// One JSON-RPC message as one POST. Gives back its `result` (Null when there is none).
async fn rpc(client: &reqwest::Client, url: &str, token: Option<&str>, method: &str, params: Option<Value>, timeout_ms: u64) -> Result<Value, McpError> {
    let fail = |kind, message: String| McpError { kind, message };
    let notification = method.starts_with("notifications/");
    let mut body = json!({ "jsonrpc": "2.0", "method": method });
    // A notification carries no id: that absence is what makes it one.
    if !notification {
        body["id"] = json!(unique());
    }
    if let Some(params) = params {
        body["params"] = params;
    }
    // Both Accept types, together: RMCP servers reject a client that sends only application/json.
    let mut req = client.post(url).header("Accept", "application/json, text/event-stream").json(&body);
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        req = req.bearer_auth(token);
    }
    // The limit covers the whole answer. The web's stops at the headers, so an SSE answer that never ends hangs it.
    let exchange = async {
        let res = req.send().await?;
        let status = res.status();
        let text = res.text().await;
        // An error answer whose body cannot be read is still that error answer.
        Ok::<_, reqwest::Error>((status, if status.is_success() { text? } else { text.unwrap_or_default() }))
    };
    let (status, text) = match tokio::time::timeout(Duration::from_millis(timeout_ms), exchange).await {
        Err(_) => return Err(fail(ErrorKind::Timeout, format!("MCP server did not answer within {}s — is it running at {url}?", (timeout_ms + 500) / 1000))),
        Ok(Err(_)) => return Err(fail(ErrorKind::Connect, format!("Cannot reach the MCP server at {url} — is it running?"))),
        Ok(Ok(answer)) => answer,
    };
    let code = status.as_u16();
    if code == 401 {
        return Err(fail(ErrorKind::Auth, "The MCP server rejected the bearer token (401). Check the token in Settings → MCP.".into()));
    }
    if code == 404 {
        return Err(fail(ErrorKind::Http, format!("Nothing answers at {url} (404). The MCP endpoint path is usually /mcp — check the URL in Settings → MCP.")));
    }
    if !status.is_success() {
        return Err(fail(ErrorKind::Http, if text.is_empty() { format!("MCP server answered {code}") } else { format!("MCP server answered {code}: {}", head(&text, 200)) }));
    }
    // A notification is answered 202 with nothing to parse.
    if notification || text.trim().is_empty() {
        return Ok(Value::Null);
    }
    let Some(mut payload) = parse_rpc_payload(&text) else {
        return Err(fail(ErrorKind::Protocol, "The MCP server answered with something that is neither JSON nor an SSE stream.".into()));
    };
    // Some servers send `"error": null` beside a result; that is not an error.
    if let Some(error) = payload.get("error").filter(|e| !e.is_null()) {
        return Err(fail(ErrorKind::Protocol, format!("MCP error: {}", error["message"].as_str().unwrap_or("unknown"))));
    }
    Ok(payload.get_mut("result").map(Value::take).unwrap_or_default())
}

/// A POST is answered with one JSON-RPC object, or with SSE frames (`data: {...}` lines among `event:` and
/// `:comment` lines). Among frames the first response wins, meaning the first with a `result` or an `error`.
/// The web takes the first JSON object of any kind, so a log or progress notification sent ahead of the
/// answer becomes an empty result there.
pub fn parse_rpc_payload(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if trimmed.starts_with('{') {
        return serde_json::from_str(trimmed).ok();
    }
    text.lines()
        .filter_map(|line| line.trim().strip_prefix("data:"))
        .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
        .find(|frame| frame.get("result").is_some() || frame.get("error").is_some())
}

/// Connects: initialize, then notifications/initialized, then tools/list.
pub async fn connect_server(client: &reqwest::Client, url: &str, token: Option<&str>, timeout_ms: u64) -> Result<McpConnection, McpError> {
    let hello = json!({ "protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {}, "clientInfo": { "name": "apiM", "version": "1.0" } });
    let init = rpc(client, url, token, "initialize", Some(hello), timeout_ms).await?;
    rpc(client, url, token, "notifications/initialized", None, timeout_ms).await?;
    // ponytail: first page only, like the web. Follow `nextCursor` if a server ever pages its tools.
    let listed = rpc(client, url, token, "tools/list", Some(json!({})), timeout_ms).await?;
    let text = |value: &Value, default: &str| value.as_str().unwrap_or(default).to_string();
    let info = &init["serverInfo"];
    Ok(McpConnection {
        server: McpServerInfo { name: text(&info["name"], "MCP server"), version: text(&info["version"], ""), protocol_version: text(&init["protocolVersion"], MCP_PROTOCOL_VERSION) },
        // An entry without a name cannot be called, so it is left out.
        tools: listed["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| Some(McpTool { name: t["name"].as_str()?.into(), description: t["description"].as_str().unwrap_or("").into(), input_schema: t["inputSchema"].clone() }))
            .collect(),
    })
}

/// MCP content blocks as the plain text the model reads.
pub fn content_to_text(result: &Value) -> String {
    let blocks = match result {
        Value::Null => return "(no output)".into(),
        Value::String(text) => return text.clone(),
        _ => result["content"].as_array().map_or(std::slice::from_ref(result), Vec::as_slice),
    };
    let parts: Vec<String> = blocks
        .iter()
        .map(|block| {
            if let Some(text) = block.as_str().or(block["text"].as_str()) {
                text.to_string()
            } else if let (Some("image"), Some(mime)) = (block["type"].as_str(), block["mimeType"].as_str()) {
                format!("[image: {mime}]")
            } else if block["type"] == "resource" && block.get("resource").is_some() {
                format!("[resource: {}]", head(&block["resource"].to_string(), 200))
            } else {
                block.to_string()
            }
        })
        .collect();
    let text = parts.join("\n");
    if text.is_empty() { "(no output)".into() } else { text }
}

/// Calls one tool. A transport failure and a tool-level `isError` both come back as a failed result with
/// the text to show, so the agent loop has one shape to handle, like its own tools.
pub async fn call_tool(client: &reqwest::Client, url: &str, token: Option<&str>, tool: &str, args: &Value) -> CallResult {
    let args = if args.is_object() { args.clone() } else { json!({}) };
    let result = match rpc(client, url, token, "tools/call", Some(json!({ "name": tool, "arguments": args })), MCP_CALL_TIMEOUT_MS).await {
        Err(e) => return CallResult { ok: false, content: e.message.clone(), summary: e.message },
        Ok(Value::Null) => json!({}),
        Ok(result) => result,
    };
    let ok = result["isError"] != true;
    let content = content_to_text(&result);
    let first = head(content.split('\n').next().unwrap_or(""), 120);
    CallResult { ok, summary: if ok { format!("MCP {tool}: {first}") } else { format!("MCP {tool} failed: {first}") }, content }
}

// ---------------------------------------------------------------- names
//
// The model sees remote tools as ordinary functions. The name is the only thing that survives the round
// trip, so it carries both addresses: mcp__<serverId>__<tool>.

fn clean(text: &str) -> String {
    text.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect()
}

/// The model-facing name. Capped at 64; the cut eats the tool end, never the server id, so a cut name
/// still leads back to the right server.
pub fn tool_name(server_id: &str, tool: &str) -> String {
    let (mut id, mut tail) = (clean(server_id), clean(tool));
    id.truncate(32);
    if id.is_empty() {
        id.push('x');
    }
    if tail.is_empty() {
        tail.push_str("tool");
    }
    let mut name = format!("{MCP_TOOL_PREFIX}{id}__{tail}");
    name.truncate(MCP_TOOL_NAME_MAX);
    name
}

/// (server id, tool) from a model-facing name. None for any other tool's name.
pub fn parse_tool_name(name: &str) -> Option<(&str, &str)> {
    let (id, tool) = name.strip_prefix(MCP_TOOL_PREFIX)?.split_once("__")?;
    (!id.is_empty() && !tool.is_empty()).then_some((id, tool))
}

/// What the step row shows instead of the raw name.
pub fn display_name(name: &str) -> String {
    parse_tool_name(name).map_or_else(|| name.to_string(), |(_, tool)| format!("MCP {tool}"))
}

/// Remote tools as OpenAI-style definitions. The description names the server, because the model cannot
/// otherwise tell two servers' same-named tools apart. A missing schema becomes an open object, since some
/// servers leave it out.
pub fn tool_definitions(server_name: &str, server_id: &str, tools: &[McpTool]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            let described = tool.description.trim();
            let base = if described.is_empty() { format!("Call the {} tool.", tool.name) } else { described.to_string() };
            let parameters = if tool.input_schema.is_object() { tool.input_schema.clone() } else { json!({ "type": "object", "properties": {} }) };
            let description = format!("{base} (via MCP server \"{server_name}\")");
            json!({ "type": "function", "function": { "name": tool_name(server_id, &tool.name), "description": description, "parameters": parameters } })
        })
        .collect()
}

// ---------------------------------------------------------------- saved servers

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub url: String,
    /// Bearer token. None means the server needs no auth.
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    /// Fields a newer web app may add, kept so saving here loses nothing.
    #[serde(flatten)]
    other: Map<String, Value>,
}

/// What the UI may show: everything but the token.
#[derive(Clone, Debug, PartialEq)]
pub struct McpServerPublic {
    pub id: String,
    pub name: String,
    pub url: String,
    pub has_token: bool,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

pub fn to_public(server: &McpServer) -> McpServerPublic {
    McpServerPublic {
        id: server.id.clone(),
        name: server.name.clone(),
        url: server.url.clone(),
        has_token: server.token.as_deref().is_some_and(|t| !t.is_empty()),
        enabled: server.enabled,
        created_at: server.created_at.clone(),
        updated_at: server.updated_at.clone(),
    }
}

#[derive(Clone, Debug, Default)]
pub struct McpServerInput {
    /// The server to update. None creates one.
    pub id: Option<String>,
    pub name: String,
    pub url: String,
    /// Empty keeps the stored token on update, and means none on create.
    pub token: String,
    /// True removes the stored token.
    pub clear_token: bool,
    /// None keeps the current setting (a new server starts enabled).
    pub enabled: Option<bool>,
}

/// `<data_dir>/mcp-servers.json`, next to the chats, where the web app keeps it.
pub fn store_file(data_dir: &Path) -> PathBuf {
    data_dir.join("mcp-servers.json")
}

/// Every saved server, tokens included. A missing or unreadable file is an empty list, and an entry without
/// a string id, name and url is skipped, as on the web.
// ponytail: an entry whose token or enabled has the wrong JSON type is skipped too (the web keeps it). Only a
// hand-edited file has one. Read those two leniently if that ever bites.
// ponytail: plain blocking reads of a file of a few hundred bytes, also from the async functions. Use tokio::fs
// if the file ever sits on a slow disk.
pub fn load(data_dir: &Path) -> Vec<McpServer> {
    let Ok(bytes) = std::fs::read(store_file(data_dir)) else { return Vec::new() };
    let Ok(Value::Array(items)) = serde_json::from_slice(&bytes) else { return Vec::new() };
    items.into_iter().filter_map(|item| serde_json::from_value(item).ok()).collect()
}

pub fn get(data_dir: &Path, id: &str) -> Option<McpServer> {
    load(data_dir).into_iter().find(|s| s.id == id)
}

/// Writes through a temp file so a crash mid-write never leaves half a list.
// ponytail: read, change, write with no lock, like the web. Two saves at the same instant (here and in the web
// app) keep one. Add a lock file if that happens.
fn write_all(data_dir: &Path, servers: &[McpServer]) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let tmp = data_dir.join(format!("mcp-servers.json.{}.{}.tmp", std::process::id(), unique()));
    let done = std::fs::write(&tmp, serde_json::to_vec_pretty(servers)?).and_then(|()| std::fs::rename(&tmp, store_file(data_dir)));
    if done.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    done
}

fn normalise_url(raw: &str) -> Result<String, String> {
    let url = raw.trim().trim_end_matches('/');
    let parsed = reqwest::Url::parse(url).map_err(|_| "That is not a URL — an MCP endpoint looks like http://127.0.0.1:8225/mcp.")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("MCP servers must be http(s) URLs.".into());
    }
    Ok(url.to_string())
}

// ---------------------------------------------------------------- what the UI calls

/// The saved servers, safe to show.
pub fn list(data_dir: &Path) -> Vec<McpServerPublic> {
    load(data_dir).iter().map(to_public).collect()
}

/// Creates a server, or updates the one `input.id` names. The error is the web's validation message, or
/// "Failed to save" / "Failed to update" when the file cannot be written.
pub fn save(data_dir: &Path, input: &McpServerInput) -> Result<McpServerPublic, String> {
    // Lengths are counted the web's way (UTF-16 units), so both apps accept the same names.
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Name is required.".into());
    }
    if name.encode_utf16().count() > 40 {
        return Err("Name must be 40 characters or fewer.".into());
    }
    if input.url.trim().is_empty() {
        return Err("Endpoint URL is required.".into());
    }
    let url = normalise_url(&input.url)?;
    let token = input.token.trim();
    if token.encode_utf16().count() > 2000 {
        return Err("Token is implausibly long.".into());
    }

    let mut all = load(data_dir);
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let saved = match &input.id {
        Some(id) => {
            let server = all.iter_mut().find(|s| &s.id == id).ok_or("No such MCP server.")?;
            server.name = name.to_string();
            server.url = url;
            if input.clear_token {
                server.token = None;
            } else if !token.is_empty() {
                server.token = Some(token.to_string());
            }
            server.enabled = input.enabled.unwrap_or(server.enabled);
            server.updated_at = now;
            server.clone()
        }
        None => {
            // Letters and digits only, so the id survives inside a tool name untouched.
            let id = format!("mcp{:x}{:03x}", chrono::Utc::now().timestamp_millis(), unique() & 0xfff);
            let token = (!token.is_empty()).then(|| token.to_string());
            let server = McpServer { id, name: name.to_string(), url, token, enabled: input.enabled.unwrap_or(true), created_at: now.clone(), updated_at: now, other: Map::new() };
            all.push(server.clone());
            server
        }
    };
    write_all(data_dir, &all).map_err(|_| if input.id.is_some() { "Failed to update" } else { "Failed to save" })?;
    Ok(to_public(&saved))
}

/// Removes a server. False when there was none with that id.
pub fn delete(data_dir: &Path, id: &str) -> Result<bool, String> {
    let mut all = load(data_dir);
    let before = all.len();
    all.retain(|s| s.id != id);
    if all.len() == before {
        return Ok(false);
    }
    write_all(data_dir, &all).map(|()| true).map_err(|_| "Failed to delete".into())
}

/// Tests a connection: a saved server by id (its stored token is used), or, with `server_id` empty, a URL and
/// token not saved yet. Gives the server's name and tools, or the sentence to show.
pub async fn test(client: &reqwest::Client, data_dir: &Path, server_id: &str, url: &str, token: &str) -> Result<McpConnection, String> {
    let (url, token) = if !server_id.is_empty() {
        let saved = get(data_dir, server_id).ok_or("No such MCP server.")?;
        (saved.url, saved.token)
    } else if !url.trim().is_empty() {
        (url.trim().to_string(), (!token.is_empty()).then(|| token.to_string()))
    } else {
        return Err("Give a server or a URL to test.".into());
    };
    connect_server(client, &url, token.as_deref(), MCP_CONNECT_TIMEOUT_MS).await.map_err(|e| e.message)
}

/// The console's Run button: one tool on a saved server, with the arguments as typed. No approval, because
/// the user composed the call themselves. `Ok` is the tool's output; `Err` is why it failed, the tool's own
/// error text included.
pub async fn call(client: &reqwest::Client, data_dir: &Path, server_id: &str, tool: &str, args_json: &str) -> Result<String, String> {
    let args = serde_json::from_str::<Value>(args_json).ok().filter(Value::is_object).ok_or("Arguments must be a JSON object.")?;
    if server_id.is_empty() {
        return Err("serverId is required.".into());
    }
    if tool.is_empty() {
        return Err("tool is required.".into());
    }
    let saved = get(data_dir, server_id).ok_or("No such MCP server.")?;
    let out = call_tool(client, &saved.url, saved.token.as_deref(), tool, &args).await;
    if out.ok { Ok(out.content) } else { Err(out.content) }
}

// ---------------------------------------------------------------- what the agent loop calls

/// Tool lists by server id and URL, so an edited server is asked again at once. An entry is reused for 60 s:
/// the agent loop builds its tool list every round, and asking every server every round would slow each
/// reply.
// ponytail: a failed connect is not remembered (same on the web), so a server that is enabled but not running
// costs one connect attempt per round, about a second for a refused local port on Windows. Remember the failure
// for a few seconds if replies drag.
static TOOL_CACHE: Mutex<BTreeMap<String, (Instant, Vec<McpTool>)>> = Mutex::new(BTreeMap::new());
const TOOL_CACHE_TTL: Duration = Duration::from_secs(60);

fn cache_key(server: &McpServer) -> String {
    format!("{}|{}", server.id, server.url)
}

/// Forgets every cached tool list.
pub fn clear_tool_cache() {
    TOOL_CACHE.lock().unwrap().clear();
}

/// The tools of every enabled server, as definitions to append to the request. A server that is down or slow
/// is skipped: a dead sidecar must never break the reply.
pub async fn tools_for_model(client: &reqwest::Client, data_dir: &Path) -> Vec<Value> {
    let servers: Vec<McpServer> = load(data_dir).into_iter().filter(|s| s.enabled).collect();
    let lists = futures_util::future::join_all(servers.iter().map(|server| async move {
        let key = cache_key(server);
        let cached = TOOL_CACHE.lock().unwrap().get(&key).filter(|(at, _)| at.elapsed() < TOOL_CACHE_TTL).map(|(_, tools)| tools.clone());
        let tools = match cached {
            Some(tools) => tools,
            None => match connect_server(client, &server.url, server.token.as_deref(), MCP_CONNECT_TIMEOUT_MS).await {
                Ok(connection) => {
                    TOOL_CACHE.lock().unwrap().insert(key, (Instant::now(), connection.tools.clone()));
                    connection.tools
                }
                Err(e) => {
                    eprintln!("MCP server \"{}\" unreachable, tools withheld: {}", server.name, e.message);
                    return Vec::new();
                }
            },
        };
        tool_definitions(&server.name, &server.id, &tools)
    }))
    .await;
    lists.into_iter().flatten().collect()
}

/// A tool call the model made on an MCP server, resolved and ready to ask the user about.
#[derive(Clone, Debug)]
pub struct BridgedCall {
    pub server: McpServer,
    /// The tool's own name on that server.
    pub tool: String,
    /// The arguments, always a JSON object.
    pub args: Value,
    /// The line the approval card shows.
    pub display: String,
    /// What "Always allow this" remembers: this exact call, not the shortened `display`.
    pub remember_key: String,
}

/// Resolves a call to a `mcp__<serverId>__<tool>` name. None when the name is not one, or its server is
/// unknown, disabled or removed: answer the model with `unavailable()`.
pub fn bridged(data_dir: &Path, name: &str, args: &Value) -> Option<BridgedCall> {
    let (id, tool) = parse_tool_name(name)?;
    let server = get(data_dir, id).filter(|s| s.enabled)?;
    // The model-facing name is sanitised and capped, so the real one is looked up in the list it was made
    // from. The web sends the sanitised name instead, which a tool called `a.b` never answers to.
    let listed = TOOL_CACHE.lock().unwrap().get(&cache_key(&server)).and_then(|(_, tools)| tools.iter().find(|t| tool_name(&server.id, &t.name) == name)).map(|t| t.name.clone());
    let tool = listed.unwrap_or_else(|| tool.to_string());
    let args = if args.is_object() { args.clone() } else { json!({}) };
    // Every key shows, nested ones too. The web's key list drops nested keys from this text, which hides
    // them from the user and lets "Always allow this" cover calls that differ only there.
    // ponytail: sorted keys come from serde_json's default map. If a dependency turns on its preserve_order
    // feature, sort here (the end_to_end test then fails).
    let text = args.to_string();
    let shown = if text.len() > 2 { format!("({}{})", head(&text, 120), if text.chars().count() > 120 { "…" } else { "" }) } else { String::new() };
    Some(BridgedCall { display: format!("{} · {tool}{shown}", server.name), remember_key: format!("mcp:{}:{tool} {text}", server.id), server, tool, args })
}

/// Runs an approved call.
pub async fn call_bridged(client: &reqwest::Client, call: &BridgedCall) -> CallResult {
    call_tool(client, &call.server.url, call.server.token.as_deref(), &call.tool, &call.args).await
}

/// What the model is told when `bridged` found no server to call.
pub fn unavailable() -> CallResult {
    let content = "That MCP tool is not available: its server is unknown, disabled, or was removed. Do not call it again — say what you were trying to do instead.";
    CallResult { ok: false, content: content.into(), summary: "MCP tool unavailable".into() }
}

/// What the model is told when the user did not allow the call. `reason` is a whole sentence, such as
/// "The user declined to run this command."
pub fn declined(display: &str, reason: &str) -> CallResult {
    let content = format!("The MCP call was not run. {reason} Do not retry it — explain what you were trying to do, or suggest a different approach.");
    CallResult { ok: false, content, summary: format!("Skipped: {display}") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn temp(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("apim-mcp-{tag}-{}-{}", std::process::id(), unique()))
    }

    fn input(name: &str, url: &str) -> McpServerInput {
        McpServerInput { name: name.into(), url: url.into(), ..Default::default() }
    }

    #[test]
    fn payloads() {
        assert_eq!(parse_rpc_payload(r#" {"jsonrpc":"2.0","id":1,"result":{"a":1}} "#).unwrap()["result"]["a"], 1);
        // Comments, event lines, a notification ahead of the answer, CRLF and [DONE] are all stepped over.
        let sse = ": hi\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\"}\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"b\":2}}\r\n\r\ndata: [DONE]\n";
        assert_eq!(parse_rpc_payload(sse).unwrap()["result"]["b"], 2);
        assert_eq!(parse_rpc_payload("data:{\"error\":{\"message\":\"no\"}}").unwrap()["error"]["message"], "no");
        assert_eq!(parse_rpc_payload("not json\nnor sse"), None);
        assert_eq!(parse_rpc_payload("{broken"), None);
    }

    #[test]
    fn tool_names() {
        let name = tool_name("mcpabc123", "execute_script");
        assert_eq!(name, "mcp__mcpabc123__execute_script");
        assert_eq!(parse_tool_name(&name), Some(("mcpabc123", "execute_script")));
        assert_eq!(tool_name("a/b c", "x.y:z"), "mcp__a_b_c__x_y_z");
        assert_eq!(tool_name("", ""), "mcp__x__tool");
        // The cap eats the tool, never the server.
        let long = tool_name("mcpabc123", &"t".repeat(100));
        assert_eq!((long.len(), parse_tool_name(&long).unwrap().0), (64, "mcpabc123"));
        assert_eq!(tool_name(&"s".repeat(50), "t"), format!("mcp__{}__t", "s".repeat(32)));
        for other in ["read_file", "mcp__incomplete", "mcp____tool", "mcp__id__"] {
            assert_eq!(parse_tool_name(other), None);
        }
        assert_eq!((display_name(&name), display_name("read_file")), ("MCP execute_script".to_string(), "read_file".to_string()));

        // The server is named in every description, and a tool without a schema becomes an open object.
        let schema = json!({ "type": "object", "required": ["code"] });
        let tools = [
            McpTool { name: "tabs".into(), description: "  List tabs. ".into(), input_schema: Value::Null },
            McpTool { name: "run".into(), description: String::new(), input_schema: schema.clone() },
        ];
        let defs = tool_definitions("Potassium", "id", &tools);
        let open = json!({ "type": "object", "properties": {} });
        assert_eq!(defs[0], json!({ "type": "function", "function": { "name": "mcp__id__tabs", "description": "List tabs. (via MCP server \"Potassium\")", "parameters": open } }));
        assert_eq!(defs[1]["function"], json!({ "name": "mcp__id__run", "description": "Call the run tool. (via MCP server \"Potassium\")", "parameters": schema }));
    }

    #[test]
    fn content_text() {
        assert_eq!(content_to_text(&json!("hi")), "hi");
        assert_eq!(content_to_text(&Value::Null), "(no output)");
        assert_eq!(content_to_text(&json!({ "content": [] })), "(no output)");
        let image = json!({ "type": "image", "mimeType": "image/png", "data": "AAAA" });
        let blocks = json!({ "content": [{ "type": "text", "text": "a" }, "b", image, { "type": "resource", "resource": { "uri": "file:///x" } }, 7] });
        assert_eq!(content_to_text(&blocks), "a\nb\n[image: image/png]\n[resource: {\"uri\":\"file:///x\"}]\n7");
        assert_eq!(content_to_text(&json!({ "structured": true })), "{\"structured\":true}");
    }

    #[test]
    fn store() {
        let dir = temp("store");
        let read = || std::fs::read_to_string(store_file(&dir)).unwrap();

        // Refused in the web's words, and nothing is written.
        let refused = |i: McpServerInput| save(&dir, &i).unwrap_err();
        assert_eq!(refused(input("  ", "http://h/mcp")), "Name is required.");
        assert_eq!(refused(input(&"n".repeat(41), "http://h/mcp")), "Name must be 40 characters or fewer.");
        assert_eq!(refused(input("x", " ")), "Endpoint URL is required.");
        assert_eq!(refused(input("x", "not a url")), "That is not a URL — an MCP endpoint looks like http://127.0.0.1:8225/mcp.");
        assert_eq!(refused(input("x", "ftp://example.com/mcp")), "MCP servers must be http(s) URLs.");
        assert_eq!(refused(McpServerInput { token: "t".repeat(2001), ..input("x", "http://h/mcp") }), "Token is implausibly long.");
        assert_eq!(refused(McpServerInput { id: Some("gone".into()), ..input("x", "http://h/mcp") }), "No such MCP server.");
        assert!(!store_file(&dir).exists());

        // Create trims and normalises. The public view says only that a token exists.
        let made = save(&dir, &McpServerInput { token: "  s3cret ".into(), ..input(" K ", " http://127.0.0.1:8225/mcp// ") }).unwrap();
        assert_eq!((made.name.as_str(), made.url.as_str(), made.has_token, made.enabled), ("K", "http://127.0.0.1:8225/mcp", true, true));
        assert!(made.id.starts_with("mcp") && made.id.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_eq!(list(&dir), vec![made.clone()]);
        assert_eq!(get(&dir, &made.id).unwrap().token.as_deref(), Some("s3cret"));

        // On disk it is the web app's file: its layout, its field names, its timestamps.
        assert!(read().starts_with("[\n  {\n    \"id\": \"mcp"));
        let mut raw: Value = serde_json::from_str(&read()).unwrap();
        assert_eq!(raw[0]["token"], "s3cret");
        assert_eq!((raw[0]["createdAt"].as_str().unwrap().len(), raw[0]["createdAt"] == raw[0]["updatedAt"]), ("2026-01-01T00:00:00.000Z".len(), true));

        // What the web wrote survives an edit here, fields this app does not know included. A broken entry is dropped.
        raw[0]["futureField"] = json!(1);
        raw.as_array_mut().unwrap().push(json!({ "id": 5, "name": "not a server" }));
        std::fs::write(store_file(&dir), raw.to_string()).unwrap();
        let kept = save(&dir, &McpServerInput { id: Some(made.id.clone()), ..input("K2", "http://h/mcp") }).unwrap();
        assert_eq!((kept.name.as_str(), kept.url.as_str(), kept.has_token, kept.enabled, &kept.created_at), ("K2", "http://h/mcp", true, true, &made.created_at));
        let raw: Value = serde_json::from_str(&read()).unwrap();
        assert_eq!((raw.as_array().unwrap().len(), &raw[0]["futureField"], &raw[0]["token"]), (1, &json!(1), &json!("s3cret")));

        let cleared = save(&dir, &McpServerInput { id: Some(made.id.clone()), clear_token: true, enabled: Some(false), ..input("K2", "http://h/mcp") }).unwrap();
        assert_eq!((cleared.has_token, cleared.enabled, get(&dir, &made.id).unwrap().token), (false, false, None));
        assert_eq!(serde_json::from_str::<Value>(&read()).unwrap()[0]["token"], Value::Null);

        assert_eq!((delete(&dir, &made.id), delete(&dir, &made.id)), (Ok(true), Ok(false)));
        assert!(list(&dir).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A strict server, like the mock in the web's scripts/test-mcp.mjs: only POST /mcp exists, the bearer
    /// token and both Accept types are required, a notification must carry no id, and one tool answers as
    /// SSE with a notification ahead of the result.
    fn answer(head: &str, body: &str) -> (&'static str, &'static str, String) {
        let lower = head.to_ascii_lowercase();
        if !head.starts_with("POST /mcp ") {
            return if head.starts_with("POST") { ("404 Not Found", "text/plain", String::new()) } else { ("405 Method Not Allowed", "text/plain", "Method Not Allowed".into()) };
        }
        if !lower.contains("authorization: bearer test-token") {
            return ("401 Unauthorized", "text/plain", "A valid bearer token is required.".into());
        }
        if !lower.contains("application/json, text/event-stream") {
            return ("400 Bad Request", "text/plain", "Accept must include application/json and text/event-stream.".into());
        }
        let msg: Value = serde_json::from_str(body).unwrap();
        let reply = |result: Value| ("200 OK", "application/json", json!({ "jsonrpc": "2.0", "id": msg["id"], "result": result }).to_string());
        match (msg["method"].as_str().unwrap(), msg["params"]["name"].as_str().unwrap_or("")) {
            ("initialize", _) => reply(json!({ "protocolVersion": "2024-11-05", "serverInfo": { "name": "Potassium-test", "version": "0.1" }, "capabilities": { "tools": {} } })),
            ("notifications/initialized", _) if msg.get("id").is_none() => ("202 Accepted", "text/plain", String::new()),
            ("tools/list", _) => {
                let script = json!({ "name": "execute_script", "description": "Run Lua.", "inputSchema": { "type": "object", "properties": { "code": { "type": "string" } } } });
                reply(json!({ "tools": [script, { "name": "read.console" }, { "nameless": true }] }))
            }
            ("tools/call", "boom") => reply(json!({ "isError": true, "content": [{ "type": "text", "text": "script blew up" }] })),
            ("tools/call", "execute_script") => {
                let note = json!({ "jsonrpc": "2.0", "method": "notifications/message", "params": { "level": "info" } });
                let ran = format!("ran {}", msg["params"]["arguments"]["code"].as_str().unwrap());
                let result = json!({ "jsonrpc": "2.0", "id": msg["id"], "result": { "content": [{ "type": "text", "text": ran }] } });
                ("200 OK", "text/event-stream", format!(": keep-alive\nevent: message\ndata: {note}\n\nevent: message\ndata: {result}\n\n"))
            }
            ("tools/call", name) => reply(json!({ "content": [{ "type": "text", "text": format!("called {name}") }] })),
            _ => ("200 OK", "application/json", json!({ "jsonrpc": "2.0", "id": msg["id"], "error": { "code": -32601, "message": "no such method" } }).to_string()),
        }
    }

    /// Serves `answer` on a free local port and gives back the endpoint URL. `POST /slow` is never answered.
    async fn mock() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/mcp", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    // The headers, then as many body bytes as Content-Length says.
                    let (mut seen, mut chunk) = (Vec::new(), [0u8; 4096]);
                    let (head, body) = loop {
                        match socket.read(&mut chunk).await {
                            Ok(n) if n > 0 => seen.extend_from_slice(&chunk[..n]),
                            _ => return,
                        }
                        let text = String::from_utf8_lossy(&seen);
                        let Some((head, body)) = text.split_once("\r\n\r\n") else { continue };
                        let length = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:")?.trim().parse::<usize>().ok()).unwrap_or(0);
                        if body.len() >= length {
                            break (head.to_string(), body.to_string());
                        }
                    };
                    if head.starts_with("POST /slow") {
                        std::future::pending::<()>().await;
                    }
                    let (status, kind, out) = answer(&head, &body);
                    let _ = socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len()).as_bytes()).await;
                });
            }
        });
        base
    }

    #[tokio::test]
    async fn end_to_end() {
        let base = mock().await;
        // No proxy: a system proxy must not sit between the test and 127.0.0.1.
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let token = Some("test-token");

        let conn = connect_server(&client, &base, token, MCP_CONNECT_TIMEOUT_MS).await.unwrap();
        assert_eq!(conn.server, McpServerInfo { name: "Potassium-test".into(), version: "0.1".into(), protocol_version: "2024-11-05".into() });
        assert_eq!(conn.tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["execute_script", "read.console"]);

        // Both answer shapes, and a tool that fails on its own terms.
        let sse = call_tool(&client, &base, token, "execute_script", &json!({ "code": "print(1)" })).await;
        assert_eq!(sse, CallResult { ok: true, content: "ran print(1)".into(), summary: "MCP execute_script: ran print(1)".into() });
        let failed = call_tool(&client, &base, token, "boom", &Value::Null).await;
        assert_eq!(failed, CallResult { ok: false, content: "script blew up".into(), summary: "MCP boom failed: script blew up".into() });

        // Failures say what to do.
        let auth = connect_server(&client, &base, Some("wrong"), 5_000).await.unwrap_err();
        assert_eq!(auth, McpError { kind: ErrorKind::Auth, message: "The MCP server rejected the bearer token (401). Check the token in Settings → MCP.".into() });
        let lost = connect_server(&client, &format!("{base}/x"), token, 5_000).await.unwrap_err();
        assert_eq!(lost.kind, ErrorKind::Http);
        assert_eq!(lost.message, format!("Nothing answers at {base}/x (404). The MCP endpoint path is usually /mcp — check the URL in Settings → MCP."));
        let slow = connect_server(&client, &base.replace("/mcp", "/slow"), token, 1_000).await.unwrap_err();
        assert!(slow.kind == ErrorKind::Timeout && slow.message.starts_with("MCP server did not answer within 1s — is it running at http://127.0.0.1:"), "{}", slow.message);
        assert_eq!(rpc(&client, &base, token, "nope", None, 5_000).await.unwrap_err(), McpError { kind: ErrorKind::Protocol, message: "MCP error: no such method".into() });
        assert_eq!(rpc(&client, &base, None, "nope", None, 5_000).await.unwrap_err().kind, ErrorKind::Auth);

        // What the settings tab and the console call, against a saved server.
        let dir = temp("e2e");
        let live = save(&dir, &McpServerInput { token: "test-token".into(), ..input("Live", &base) }).unwrap();
        assert_eq!(test(&client, &dir, &live.id, "", "").await.unwrap().tools.len(), 2);
        assert_eq!(test(&client, &dir, "", &format!(" {base} "), "test-token").await.unwrap().server.name, "Potassium-test");
        assert_eq!(test(&client, &dir, "", " ", "").await.unwrap_err(), "Give a server or a URL to test.");
        assert_eq!(test(&client, &dir, "gone", "", "").await.unwrap_err(), "No such MCP server.");
        assert_eq!(call(&client, &dir, &live.id, "list_clients", "{}").await, Ok("called list_clients".to_string()));
        assert_eq!(call(&client, &dir, &live.id, "boom", "{}").await, Err("script blew up".to_string()));
        assert_eq!(call(&client, &dir, &live.id, "boom", "[1]").await, Err("Arguments must be a JSON object.".to_string()));
        assert_eq!(call(&client, &dir, "gone", "boom", "{}").await, Err("No such MCP server.".to_string()));

        // The model is offered the live tools, and a call under the model-facing name reaches the real tool.
        clear_tool_cache();
        let defs = tools_for_model(&client, &dir).await;
        let name = format!("mcp__{}__read_console", live.id);
        assert_eq!(defs.iter().map(|d| d["function"]["name"].as_str().unwrap()).collect::<Vec<_>>(), [format!("mcp__{}__execute_script", live.id), name.clone()]);
        assert_eq!(defs[0]["function"]["description"], "Run Lua. (via MCP server \"Live\")");
        let asked = bridged(&dir, &name, &json!({ "b": 1, "a": { "z": 2, "y": "x".repeat(200) } })).unwrap();
        assert_eq!(asked.display, format!("Live · read.console({{\"a\":{{\"y\":\"{}…)", "x".repeat(120 - 11)));
        assert_eq!(asked.remember_key, format!("mcp:{}:read.console {{\"a\":{{\"y\":\"{}\",\"z\":2}},\"b\":1}}", live.id, "x".repeat(200)));
        assert_eq!(call_bridged(&client, &asked).await, CallResult { ok: true, content: "called read.console".into(), summary: "MCP read.console: called read.console".into() });
        assert_eq!(bridged(&dir, &name, &Value::Null).unwrap().display, "Live · read.console");

        // A warm list is reused, not asked for again: a change made only in the cache shows up.
        TOOL_CACHE.lock().unwrap().get_mut(&format!("{}|{base}", live.id)).unwrap().1.truncate(1);
        assert_eq!(tools_for_model(&client, &dir).await.len(), 1);

        // A disabled server offers nothing and its tools stop resolving. A dead one is skipped, never an error.
        let update = |url: &str, enabled| McpServerInput { id: Some(live.id.clone()), enabled: Some(enabled), ..input("Live", url) };
        save(&dir, &update(&base, false)).unwrap();
        clear_tool_cache();
        assert!(tools_for_model(&client, &dir).await.is_empty() && bridged(&dir, &name, &json!({})).is_none());
        assert!(bridged(&dir, "read_file", &json!({})).is_none() && bridged(&dir, "mcp__gone__tool", &json!({})).is_none());
        save(&dir, &update("http://127.0.0.1:1/mcp", true)).unwrap();
        assert!(tools_for_model(&client, &dir).await.is_empty());
        assert_eq!(test(&client, &dir, &live.id, "", "").await.unwrap_err(), "Cannot reach the MCP server at http://127.0.0.1:1/mcp — is it running?");

        assert_eq!(unavailable().summary, "MCP tool unavailable");
        let skipped = declined("Live · boom", "The user declined to run this command.");
        assert_eq!(skipped.summary, "Skipped: Live · boom");
        assert_eq!(skipped.content, "The MCP call was not run. The user declined to run this command. Do not retry it — explain what you were trying to do, or suggest a different approach.");
        let _ = std::fs::remove_dir_all(dir);
    }
}

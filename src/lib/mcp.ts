/**
 * MCP client: streamable HTTP, stateless, and deliberately undemanding.
 *
 * The first server this had to talk to was a Potassium MCP bridge
 * (rmcp 2.2.0, protocol 2024-11-05, tools only) with three quirks that
 * break naive clients:
 *
 *   1. GET /mcp answers 405. The streamable-HTTP spec lets a client open
 *      a GET SSE stream for server-initiated messages — but it is
 *      OPTIONAL, and this server rejects it outright. So this client
 *      never issues GET at all: everything is a plain POST, which is a
 *      legal stateless client. A client that does the GET-first dance
 *      throws here, which is exactly why "my AI can't connect" happened.
 *   2. The server may answer a POST with `text/event-stream` (SSE frames
 *      carrying the JSON-RPC response) or plain JSON. Both are parsed.
 *   3. No Mcp-Session-Id is ever issued. Fine — nothing here needs one.
 *
 * Auth is a bearer token on every call; there is no session cookie and no
 * login step. A 401 means the token is missing or wrong, and the error
 * says exactly that instead of "request failed".
 */

export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** Timeouts are tight on purpose: MCP servers are usually localhost. */
export const MCP_CONNECT_TIMEOUT_MS = 15_000;
export const MCP_CALL_TIMEOUT_MS = 120_000;

/** Prefix for bridged tool names offered to the model. */
export const MCP_TOOL_PREFIX = "mcp__";

/** Model function names must fit this (OpenAI/DeepSeek-shape limits). */
export const MCP_TOOL_NAME_MAX = 64;

export type McpErrorKind =
  | "auth"
  | "connect"
  | "http"
  | "protocol"
  | "timeout";

export class McpError extends Error {
  readonly kind: McpErrorKind;
  constructor(kind: McpErrorKind, message: string) {
    super(message);
    this.name = "McpError";
    this.kind = kind;
  }
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
}

export interface McpConnection {
  server: McpServerInfo;
  tools: McpTool[];
}

export interface McpCallResult {
  ok: boolean;
  content: string;
  summary: string;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * One JSON-RPC message over streamable HTTP. POST only — see the header.
 * Resolves with the `result` payload, or throws an McpError that already
 * says what the user can do about it.
 */
async function rpc(
  url: string,
  token: string | null,
  method: string,
  params: Record<string, unknown> | undefined,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combined =
    signal !== undefined && signal !== null
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
  let res: Response;
  const isNotification = method.startsWith("notifications/");
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Both, together. RMCP transports reject a client that sends only
        // application/json — measured against the Potassium bridge.
        Accept: "application/json, text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        // Notifications carry no id — that absence is what makes them
        // notifications rather than requests awaiting a response.
        ...(isNotification
          ? {}
          : { id: Math.floor(Math.random() * 1_000_000_000) }),
        method,
        ...(params !== undefined ? { params } : {}),
      }),
      signal: combined,
    });
  } catch (error) {
    throw new McpError(
      "connect",
      error instanceof Error && error.name === "AbortError"
        ? `MCP server did not answer within ${Math.round(timeoutMs / 1000)}s — is it running at ${url}?`
        : `Cannot reach the MCP server at ${url} — is it running?`
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    throw new McpError(
      "auth",
      "The MCP server rejected the bearer token (401). Check the token in Settings → MCP."
    );
  }
  if (res.status === 404) {
    throw new McpError(
      "http",
      `Nothing answers at ${url} (404). The MCP endpoint path is usually /mcp — check the URL in Settings → MCP.`
    );
  }
  // Notifications answer 202 with an empty body — no payload to parse.
  if (isNotification) {
    // A JSON-RPC notification has no id and no response; anything 2xx is
    // success. (Kept as a branch rather than a pre-check so the status
    // mapping above still applies to notifications too.)
    if (res.ok) return null;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new McpError(
      "http",
      `MCP server answered ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`
    );
  }
  const text = await res.text();
  if (!text.trim()) return null;
  const payload = parseRpcPayload(text);
  if (payload === null) {
    throw new McpError(
      "protocol",
      "The MCP server answered with something that is neither JSON nor an SSE stream."
    );
  }
  if (payload.error !== undefined) {
    throw new McpError(
      "protocol",
      `MCP error: ${payload.error.message ?? "unknown"}`
    );
  }
  return payload.result ?? null;
}

/**
 * A POST answer is either a JSON-RPC object or SSE frames (`data: {...}`
 * lines, optionally with `event:` / `:comment` lines around them). The
 * first parseable JSON-RPC response wins; anything else is skipped.
 */
export function parseRpcPayload(text: string): JsonRpcResponse | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      return null;
    }
  }
  for (const line of text.split("\n")) {
    const match = /^data:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    if (match[1] === "[DONE]") continue;
    try {
      const parsed = JSON.parse(match[1]) as JsonRpcResponse;
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Connect: initialize → notifications/initialized → tools/list.
 * Throws McpError; the message is already user-readable.
 */
export async function connectMcpServer(
  url: string,
  token: string | null,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<McpConnection> {
  const timeoutMs = options.timeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
  const init = (await rpc(
    url,
    token,
    "initialize",
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "apiM", version: "1.0" },
    },
    timeoutMs,
    options.signal
  )) as {
    protocolVersion?: string;
    serverInfo?: { name?: string; version?: string };
  } | null;
  await rpc(
    url,
    token,
    "notifications/initialized",
    undefined,
    timeoutMs,
    options.signal
  );
  const listed = (await rpc(
    url,
    token,
    "tools/list",
    {},
    timeoutMs,
    options.signal
  )) as { tools?: McpTool[] } | null;
  const tools = Array.isArray(listed?.tools) ? listed.tools : [];
  return {
    server: {
      name:
        typeof init?.serverInfo?.name === "string"
          ? init.serverInfo.name
          : "MCP server",
      version:
        typeof init?.serverInfo?.version === "string"
          ? init.serverInfo.version
          : "",
      protocolVersion:
        typeof init?.protocolVersion === "string"
          ? init.protocolVersion
          : MCP_PROTOCOL_VERSION,
    },
    tools: tools.filter(
      (t): t is McpTool => t !== null && typeof t === "object" && typeof t.name === "string"
    ),
  };
}

/** Flatten MCP content blocks to the plain text the model reads. */
export function mcpContentToText(result: unknown): string {
  if (result === null || result === undefined) return "(no output)";
  if (typeof result === "string") return result;
  const blocks = (
    typeof result === "object" && result !== null && Array.isArray((result as { content?: unknown }).content)
      ? (result as { content: unknown[] }).content
      : [result]
  ) as Array<Record<string, unknown>>;
  const parts: string[] = [];
  for (const block of blocks) {
    if (block === null || typeof block !== "object") {
      parts.push(String(block));
      continue;
    }
    if (typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "image" && typeof block.mimeType === "string") {
      parts.push(`[image: ${block.mimeType}]`);
      continue;
    }
    if (block.type === "resource" && block.resource !== undefined) {
      parts.push(`[resource: ${JSON.stringify(block.resource).slice(0, 200)}]`);
      continue;
    }
    parts.push(JSON.stringify(block));
  }
  return parts.join("\n") || "(no output)";
}

/**
 * Call one remote tool. A tool-level `isError` is a failed call with the
 * server's own text — not a transport failure — so it resolves rather
 * than throws, exactly like the local dispatcher does.
 */
export async function callMcpTool(
  url: string,
  token: string | null,
  toolName: string,
  args: Record<string, unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<McpCallResult> {
  const timeoutMs = options.timeoutMs ?? MCP_CALL_TIMEOUT_MS;
  let result: unknown;
  try {
    result =
      (await rpc(
        url,
        token,
        "tools/call",
        { name: toolName, arguments: args },
        timeoutMs,
        options.signal
      )) ?? {};
  } catch (error) {
    if (error instanceof McpError) {
      return { ok: false, content: error.message, summary: error.message };
    }
    throw error;
  }
  const failed =
    typeof result === "object" &&
    result !== null &&
    (result as { isError?: unknown }).isError === true;
  const content = mcpContentToText(result);
  const firstLine = content.split("\n")[0].slice(0, 120);
  return {
    ok: !failed,
    content,
    summary: failed ? `MCP ${toolName} failed: ${firstLine}` : `MCP ${toolName}: ${firstLine}`,
  };
}

/*
 * Bridged tool names: mcp__<serverId>__<tool>.
 *
 * The model sees remote tools as ordinary functions; the name is the only
 * channel that survives the round trip, so it carries both addresses.
 * Names are sanitised to the function-name alphabet and capped at 64
 * characters — truncation eats the tool end, never the prefix, so a
 * truncated name still parses back to the right server.
 */
export function mcpToolName(serverId: string, tool: string): string {
  const clean = (s: string): string =>
    s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32) || "x";
  const head = `${MCP_TOOL_PREFIX}${clean(serverId)}__`;
  const tail = tool.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
  return (head + tail).slice(0, MCP_TOOL_NAME_MAX);
}

export function parseMcpToolName(name: string): {
  serverId: string;
  tool: string;
} | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0 || sep + 2 >= rest.length) return null;
  return { serverId: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/** What the transcript row shows instead of the raw bridged name. */
export function mcpDisplayName(name: string): string {
  const parsed = parseMcpToolName(name);
  if (!parsed) return name;
  return `MCP ${parsed.tool}`;
}

/**
 * Remote tools as model-facing definitions. The description suffix names
 * the server, because the model otherwise cannot tell two servers'
 * same-named tools apart — and a missing inputSchema becomes an open
 * object rather than a refusal, since some servers omit it.
 */
export function mcpToolDefinitions(
  serverName: string,
  serverId: string,
  tools: McpTool[]
): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((tool) => {
    const schema =
      tool.inputSchema !== undefined &&
      typeof tool.inputSchema === "object" &&
      tool.inputSchema !== null
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: "object", properties: {} };
    const base =
      typeof tool.description === "string" && tool.description.trim()
        ? tool.description.trim()
        : `Call the ${tool.name} tool.`;
    return {
      type: "function",
      function: {
        name: mcpToolName(serverId, tool.name),
        description: `${base} (via MCP server "${serverName}")`,
        parameters: schema,
      },
    };
  });
}

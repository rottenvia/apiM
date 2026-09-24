/**
 * MCP client: talking to fussy streamable-HTTP servers.
 *
 * Run:  npm run test:mcp
 *
 * The first server this had to reach was a Potassium MCP bridge with three
 * quirks that break naive clients: GET answers 405, a POST may come back
 * as SSE frames or plain JSON, and no session id is ever issued. The mock
 * below reproduces all three plus strict bearer auth, and the suite proves
 * the client connects, lists, calls — and never issues the GET that 405s.
 */
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { mkdtemp, readFile as readFsFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// The store resolves its data dir at import time, so a standalone run
// (no runner-provided APIM_DATA_ROOT) gets a temp dir BEFORE importing it.
let ownedDataRoot = null;
if (!process.env.APIM_DATA_ROOT) {
  ownedDataRoot = await mkdtemp(path.join(os.tmpdir(), "apim-mcp-"));
  process.env.APIM_DATA_ROOT = ownedDataRoot;
}

const ROOT = path.resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const read = (p) => readFsFile(path.join(ROOT, p), "utf8");

const M = await load("src/lib/mcp.ts");
const store = await load("src/lib/mcp-store.ts");
const route = await read("src/app/api/chat/route.ts");
const settingsModal = await read("src/components/SettingsModal.tsx");
const sidebar = await read("src/components/Sidebar.tsx");
const page = await read("src/app/page.tsx");
const approvalPrompt = await read("src/components/ApprovalPrompt.tsx");
const toolActivity = await read("src/components/ToolActivity.tsx");
const mcpConsole = await read("src/components/McpConsole.tsx");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0,
  fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

const TOKEN = "test-token";
const seen = { get: 0, post: 0, acceptHeaders: [] };

const TOOLS = [
  {
    name: "execute_script",
    description: "Run Lua on every attached client.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
  },
  { name: "list_clients", description: "List attached clients." },
  { name: "read_console", description: "Read console output." },
  { name: "clear_console", description: "Clear the console." },
  { name: "tabs", description: "List tabs." },
];

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

const mock = http.createServer(async (req, res) => {
  if (req.method === "GET") {
    seen.get += 1;
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return;
  }
  if (req.url === "/slow") return; // never answers — the timeout case
  seen.post += 1;
  seen.acceptHeaders.push(req.headers.accept ?? "");
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end("A valid Potassium MCP bearer token is required.");
    return;
  }
  const accept = req.headers.accept ?? "";
  // The real bridge rejects json-only clients; the mock enforces it so a
  // regression in our headers fails loudly instead of silently.
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Accept must include application/json and text/event-stream.");
    return;
  }
  let msg = null;
  try {
    msg = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400);
    res.end("bad json");
    return;
  }
  const answer = (result) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  };
  if (msg.method === "initialize") {
    answer({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "Potassium-test", version: "0.1" },
      capabilities: { tools: {} },
    });
    return;
  }
  if (msg.method === "notifications/initialized") {
    res.writeHead(202);
    res.end();
    return;
  }
  if (msg.method === "tools/list") {
    answer({ tools: TOOLS });
    return;
  }
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    if (name === "boom") {
      answer({ isError: true, content: [{ type: "text", text: "script blew up" }] });
      return;
    }
    if (name === "execute_script") {
      // SSE-framed answer, like the real bridge sends for some calls.
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `: keep-alive comment\nevent: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: "eni probe 1790203915" }] },
        })}\n\n`
      );
      return;
    }
    answer({ content: [{ type: "text", text: `called ${name}` }] });
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } })
  );
});

await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mock.address().port}/mcp`;

console.log("\napiM MCP client checks\n");
console.log("1. Connecting to a strict server");
{
  const conn = await M.connectMcpServer(base, TOKEN);
  check(
    "initialize + list returns the server and its tools",
    conn.server.name === "Potassium-test" && conn.tools.length === 5,
    `${conn.tools.length} tools`
  );
  check(
    "the client never issues GET",
    seen.get === 0,
    "no GET-first dance — the 405 is never met"
  );
  check(
    "every POST carries both Accept types",
    seen.acceptHeaders.length > 0 &&
      seen.acceptHeaders.every(
        (a) => a.includes("application/json") && a.includes("text/event-stream")
      )
  );
}

console.log("\n2. Calling tools through both answer shapes");
{
  const sse = await M.callMcpTool(base, TOKEN, "execute_script", { code: "print(1)" });
  check(
    "an SSE-framed answer parses",
    sse.ok && sse.content.includes("eni probe"),
    sse.summary
  );
  const json = await M.callMcpTool(base, TOKEN, "read_console", {});
  check(
    "a JSON answer flattens its content blocks",
    json.ok && json.content === "called read_console"
  );
  const failed = await M.callMcpTool(base, TOKEN, "boom", {});
  check(
    "a tool-level isError resolves as a failed call, not a throw",
    !failed.ok && failed.content.includes("script blew up")
  );
}

console.log("\n3. Failures say what to do");
{
  let auth = null;
  try {
    await M.connectMcpServer(base, "wrong-token");
  } catch (e) {
    auth = e;
  }
  check(
    "a wrong token names the token and where it lives",
    auth instanceof M.McpError &&
      auth.kind === "auth" &&
      /bearer token/i.test(auth.message) &&
      /Settings/.test(auth.message)
  );
  let down = null;
  try {
    await M.connectMcpServer("http://127.0.0.1:1/mcp", TOKEN);
  } catch (e) {
    down = e;
  }
  check(
    "an unreachable server asks whether it is running",
    down instanceof M.McpError && /is it running/.test(down.message),
    down?.message ?? ""
  );
  let slow = null;
  try {
    await M.connectMcpServer(base.replace("/mcp", "/slow"), TOKEN, { timeoutMs: 1000 });
  } catch (e) {
    slow = e;
  }
  check(
    "a silent server times out with its wait stated",
    slow instanceof M.McpError && /within 1s/.test(slow.message)
  );
}

console.log("\n4. Payload and content parsing");
{
  check(
    "plain JSON parses",
    M.parseRpcPayload('{"jsonrpc":"2.0","id":1,"result":{"a":1}}')?.result?.a === 1
  );
  check(
    "SSE frames parse around comments and [DONE]",
    M.parseRpcPayload(
      ': hi\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"b":2}}\n\ndata: [DONE]\n'
    )?.result?.b === 2
  );
  check("garbage parses to null", M.parseRpcPayload("not json\nnor sse") === null);
  check("a bare string passes through", M.mcpContentToText("hi") === "hi");
  check(
    "blocks join",
    M.mcpContentToText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }) ===
      "a\nb"
  );
  check("nothing gives (no output)", M.mcpContentToText(null) === "(no output)");
}

console.log("\n5. Bridged names survive the round trip");
{
  const name = M.mcpToolName("mcpabc123", "execute_script");
  check("the bridge format is mcp__server__tool", name === "mcp__mcpabc123__execute_script");
  const back = M.parseMcpToolName(name);
  check(
    "parsing recovers both addresses",
    back?.serverId === "mcpabc123" && back?.tool === "execute_script"
  );
  check(
    "hostile characters are sanitised",
    /^[a-zA-Z0-9_-]+$/.test(M.mcpToolName("a/b c", "x.y:z")) &&
      M.parseMcpToolName(M.mcpToolName("a/b c", "x.y:z")) !== null
  );
  const long = M.mcpToolName("mcpabc123", "t".repeat(100));
  check(
    "names cap at 64 characters and still parse to the right server",
    long.length <= 64 && M.parseMcpToolName(long)?.serverId === "mcpabc123",
    `${long.length} chars`
  );
  check(
    "non-bridged names are left alone",
    M.parseMcpToolName("read_file") === null &&
      M.parseMcpToolName("mcp__incomplete") === null
  );
  check(
    "the transcript shows the tool, not the address",
    M.mcpDisplayName(name) === "MCP execute_script"
  );
  const defs = M.mcpToolDefinitions("Potassium", "mcpabc123", TOOLS);
  check(
    "definitions name the server in every description",
    defs.length === 5 &&
      defs.every((d) => d.function.description.includes('(via MCP server "Potassium")'))
  );
  check(
    "a tool without a schema becomes an open object",
    JSON.stringify(
      M.mcpToolDefinitions("S", "id", [{ name: "tabs" }])[0].function.parameters
    ) === JSON.stringify({ type: "object", properties: {} })
  );
}

console.log("\n6. The server store keeps tokens server-side");
{
  const created = await store.saveMcpServer({ name: "K", url: `${base}/`, token: "  s3cret " });
  check("create trims and normalises", created.token === "s3cret" && !created.url.endsWith("/"));
  check("create returns the stored shape", typeof created.id === "string" && created.enabled === true);
  const list = await store.listMcpServers();
  check("list finds it", list.some((s) => s.id === created.id));
  check("get returns it with the token", (await store.getMcpServer(created.id))?.token === "s3cret");
  const pub = store.toPublic(created);
  check(
    "the public view carries no token",
    !("token" in pub) && pub.hasToken === true
  );
  const kept = await store.saveMcpServer({ id: created.id, name: "K2", url: base });
  check("updating without a token keeps the stored one", kept.token === "s3cret" && kept.name === "K2");
  const cleared = await store.saveMcpServer({ id: created.id, name: "K2", url: base, clearToken: true });
  check("clearToken drops it", cleared.token === null && store.toPublic(cleared).hasToken === false);
  let bad = null;
  try {
    await store.saveMcpServer({ name: "x", url: "not a url" });
  } catch (e) {
    bad = e;
  }
  check(
    "a bad URL is refused with an example",
    bad instanceof store.McpValidationError && /127\.0\.0\.1/.test(bad.message)
  );
  let nonHttp = null;
  try {
    await store.saveMcpServer({ name: "x", url: "ftp://example.com/mcp" });
  } catch (e) {
    nonHttp = e;
  }
  check("non-http is refused", nonHttp instanceof store.McpValidationError);
  check("delete removes it", (await store.deleteMcpServer(created.id)) === true);
  check("deleting twice reports false", (await store.deleteMcpServer(created.id)) === false);
}

console.log("\n7. The model is offered live tools, best-effort");
{
  const live = await store.saveMcpServer({ name: "Live", url: base, token: TOKEN });
  store.clearMcpToolCache();
  const defs = await store.mcpToolsForModel();
  check(
    "an enabled server contributes its tools",
    defs.length === 5 && defs.every((d) => d.function.name.startsWith("mcp__")),
    `${defs.length} bridged defs`
  );
  await store.saveMcpServer({ id: live.id, name: "Live", url: base, enabled: false });
  store.clearMcpToolCache();
  check("a disabled server contributes nothing", (await store.mcpToolsForModel()).length === 0);
  await store.saveMcpServer({ id: live.id, name: "Live", url: "http://127.0.0.1:1/mcp", enabled: true });
  store.clearMcpToolCache();
  const down = await store.mcpToolsForModel();
  check(
    "a dead server is skipped, never thrown",
    down.length === 0,
    "the reply must not break over a sidecar"
  );
  await store.deleteMcpServer(live.id);
  store.clearMcpToolCache();
}

console.log("\n8. The route bridges and gates MCP calls");
{
  check(
    "the route imports the MCP client and store",
    /from "@\/lib\/mcp"/.test(route) && /from "@\/lib\/mcp-store"/.test(route)
  );
  check("the route appends remote tools per round", /await mcpToolsForModel\(\)/.test(route));
  check(
    "the route intercepts bridged calls",
    /\.startsWith\(MCP_TOOL_PREFIX\)/.test(route) && /parseMcpToolName\(/.test(route)
  );
  check(
    "bridged calls ask permission as mcp",
    /command: "mcp"/.test(route) && /type: "approval_request"/.test(route)
  );
  check(
    "a vanished server tells the model to stop calling",
    /Do not call it again/.test(route)
  );
}

console.log("\n9. The UI surfaces servers and the console");
{
  check("settings has an MCP tab", /id: "mcp"/.test(settingsModal) && /McpServersSettings/.test(settingsModal));
  check(
    "the sidebar opens the console",
    /onOpenMcp/.test(sidebar) && /MCP console/.test(sidebar)
  );
  check("the page mounts the console", /<McpConsole/.test(page));
  check("the console calls through the API", /\/api\/mcp\/call/.test(mcpConsole));
  check(
    "approvals title MCP calls correctly",
    /Call this MCP tool\?/.test(approvalPrompt)
  );
  check(
    "the transcript pretty-prints bridged names",
    /mcpDisplayName\(event\.name\)/.test(toolActivity)
  );
}

mock.close();
if (ownedDataRoot) await rm(ownedDataRoot, { recursive: true, force: true });

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

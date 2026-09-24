import { promises as fs } from "node:fs";
import path from "node:path";
import {
  connectMcpServer,
  mcpToolDefinitions,
  type McpTool,
} from "@/lib/mcp";

/**
 * File-backed store for MCP server connections.
 *
 * Saved next to the chats in ./data so everything the user configures
 * lives in one place. The bearer token grants script execution on the
 * attached clients, so it is stored server-side only: list endpoints
 * return the public view (which says only whether a token is set), and
 * the token itself never leaves this file except inside an Authorization
 * header to the server it belongs to.
 */

/** Overridable so parallel test suites do not share one server store. */
const DATA_DIR = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.resolve(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "mcp-servers.json");

export interface McpServer {
  id: string;
  name: string;
  url: string;
  /** Bearer token. Absent means the server needs no auth. */
  token: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What the browser may see: everything but the token. */
export interface McpServerPublic {
  id: string;
  name: string;
  url: string;
  hasToken: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toPublic(server: McpServer): McpServerPublic {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    hasToken: Boolean(server.token),
    enabled: server.enabled,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}

async function readAll(): Promise<McpServer[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as McpServer[]).filter(
      (s) =>
        s !== null &&
        typeof s === "object" &&
        typeof s.id === "string" &&
        typeof s.name === "string" &&
        typeof s.url === "string"
    );
  } catch {
    return [];
  }
}

async function writeAll(servers: McpServer[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(servers, null, 2), "utf8");
    await fs.rename(tmp, FILE);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

export class McpValidationError extends Error {}

export interface McpServerInput {
  name?: string;
  url?: string;
  /** Omit or empty to keep the stored token on update, none on create. */
  token?: string;
  /** False clears a stored token. */
  clearToken?: boolean;
  enabled?: boolean;
}

function normaliseUrl(raw: string): string {
  const url = raw.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new McpValidationError(
      "That is not a URL — an MCP endpoint looks like http://127.0.0.1:8225/mcp."
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new McpValidationError("MCP servers must be http(s) URLs.");
  }
  return url;
}

function makeId(): string {
  return (
    "mcp" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  ).replace(/[^a-zA-Z0-9]/g, "");
}

export async function listMcpServers(): Promise<McpServer[]> {
  return readAll();
}

export async function getMcpServer(id: string): Promise<McpServer | null> {
  const all = await readAll();
  return all.find((s) => s.id === id) ?? null;
}

export async function saveMcpServer(input: McpServerInput & { id?: string }): Promise<McpServer> {
  const name = (input.name ?? "").trim();
  if (name.length < 1) throw new McpValidationError("Name is required.");
  if (name.length > 40)
    throw new McpValidationError("Name must be 40 characters or fewer.");
  if (input.url === undefined || !input.url.trim())
    throw new McpValidationError("Endpoint URL is required.");
  const url = normaliseUrl(input.url);
  const token = (input.token ?? "").trim();
  if (token.length > 2000)
    throw new McpValidationError("Token is implausibly long.");

  const all = await readAll();
  const now = new Date().toISOString();
  if (input.id !== undefined) {
    const index = all.findIndex((s) => s.id === input.id);
    if (index < 0) throw new McpValidationError("No such MCP server.");
    const current = all[index];
    const next: McpServer = {
      ...current,
      name,
      url,
      token: input.clearToken ? null : token ? token : current.token,
      enabled: input.enabled ?? current.enabled,
      updatedAt: now,
    };
    all[index] = next;
    await writeAll(all);
    return next;
  }
  const created: McpServer = {
    id: makeId(),
    name,
    url,
    token: token ? token : null,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
  all.push(created);
  await writeAll(all);
  return created;
}

export async function deleteMcpServer(id: string): Promise<boolean> {
  const all = await readAll();
  const next = all.filter((s) => s.id !== id);
  if (next.length === all.length) return false;
  await writeAll(next);
  return true;
}

/*
 * Remote tools, cached per server.
 *
 * The chat route assembles the tool list every round; asking every MCP
 * server for tools/list on every round would tax remote servers and slow
 * local ones. Entries live 60 seconds and are keyed on id + url, so an
 * edited server re-lists immediately. A server that is down or slow is
 * skipped — its tools simply are not offered that round — because a dead
 * sidecar must never break the reply.
 */
const TOOL_CACHE_TTL_MS = 60_000;
const toolCache = new Map<string, { at: number; tools: McpTool[] }>();

export async function mcpToolsForModel(): Promise<
  ReturnType<typeof mcpToolDefinitions>
> {
  const servers = (await listMcpServers()).filter((s) => s.enabled);
  const out: ReturnType<typeof mcpToolDefinitions> = [];
  await Promise.all(
    servers.map(async (server) => {
      const key = `${server.id}|${server.url}`;
      const cached = toolCache.get(key);
      let tools: McpTool[];
      if (cached && Date.now() - cached.at < TOOL_CACHE_TTL_MS) {
        tools = cached.tools;
      } else {
        try {
          tools = (await connectMcpServer(server.url, server.token)).tools;
        } catch (error) {
          console.error(
            `MCP server "${server.name}" unreachable, tools withheld:`,
            error instanceof Error ? error.message : error
          );
          return;
        }
        toolCache.set(key, { at: Date.now(), tools });
      }
      out.push(...mcpToolDefinitions(server.name, server.id, tools));
    })
  );
  return out;
}

/** Test hook: forget every cached tool list. */
export function clearMcpToolCache(): void {
  toolCache.clear();
}

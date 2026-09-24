import { NextRequest, NextResponse } from "next/server";
import { connectMcpServer, McpError } from "@/lib/mcp";
import { getMcpServer } from "@/lib/mcp-store";

export const dynamic = "force-dynamic";

/**
 * Test a connection. Either `{ serverId }` for a saved server (the token
 * stays server-side) or `{ url, token }` for one not saved yet.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      serverId?: string;
      url?: string;
      token?: string;
    };
    let url: string;
    let token: string | null;
    if (typeof body.serverId === "string" && body.serverId) {
      const saved = await getMcpServer(body.serverId);
      if (!saved) {
        return NextResponse.json(
          { ok: false, error: "No such MCP server." },
          { status: 404 }
        );
      }
      url = saved.url;
      token = saved.token;
    } else if (typeof body.url === "string" && body.url.trim()) {
      url = body.url.trim();
      token = typeof body.token === "string" && body.token ? body.token : null;
    } else {
      return NextResponse.json(
        { ok: false, error: "Give a server or a URL to test." },
        { status: 400 }
      );
    }
    const connection = await connectMcpServer(url, token);
    return NextResponse.json({
      ok: true,
      server: connection.server,
      tools: connection.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? null,
      })),
    });
  } catch (error) {
    if (error instanceof McpError) {
      return NextResponse.json({ ok: false, error: error.message });
    }
    console.error("MCP test failed:", error);
    return NextResponse.json(
      { ok: false, error: "Connection test failed." },
      { status: 500 }
    );
  }
}

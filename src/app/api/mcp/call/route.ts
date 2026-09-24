import { NextRequest, NextResponse } from "next/server";
import { callMcpTool, McpError } from "@/lib/mcp";
import { getMcpServer } from "@/lib/mcp-store";

export const dynamic = "force-dynamic";

/**
 * Call one tool on a saved server, for the manual console. No approval
 * step: the user composed the call and clicked it themselves. (Agent
 * calls go through the chat route, where approval applies.)
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      serverId?: string;
      tool?: string;
      args?: unknown;
    };
    if (typeof body.serverId !== "string" || !body.serverId) {
      return NextResponse.json(
        { ok: false, error: "serverId is required." },
        { status: 400 }
      );
    }
    if (typeof body.tool !== "string" || !body.tool) {
      return NextResponse.json(
        { ok: false, error: "tool is required." },
        { status: 400 }
      );
    }
    const saved = await getMcpServer(body.serverId);
    if (!saved) {
      return NextResponse.json(
        { ok: false, error: "No such MCP server." },
        { status: 404 }
      );
    }
    const args =
      body.args !== undefined && typeof body.args === "object" && body.args !== null
        ? (body.args as Record<string, unknown>)
        : {};
    const result = await callMcpTool(saved.url, saved.token, body.tool, args);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof McpError) {
      return NextResponse.json({ ok: false, error: error.message });
    }
    console.error("MCP call failed:", error);
    return NextResponse.json(
      { ok: false, error: "MCP call failed." },
      { status: 500 }
    );
  }
}

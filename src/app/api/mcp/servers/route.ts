import { NextRequest, NextResponse } from "next/server";
import {
  listMcpServers,
  saveMcpServer,
  McpValidationError,
  toPublic,
} from "@/lib/mcp-store";

export const dynamic = "force-dynamic";

/** Configured servers, public view — tokens never leave the server. */
export async function GET() {
  try {
    return NextResponse.json((await listMcpServers()).map(toPublic));
  } catch (error) {
    console.error("Failed to list MCP servers:", error);
    return NextResponse.json([]);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    return NextResponse.json(toPublic(await saveMcpServer(body)));
  } catch (error) {
    if (error instanceof McpValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Failed to save MCP server:", error);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}

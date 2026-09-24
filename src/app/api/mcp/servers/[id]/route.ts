import { NextRequest, NextResponse } from "next/server";
import {
  deleteMcpServer,
  saveMcpServer,
  McpValidationError,
  toPublic,
} from "@/lib/mcp-store";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    return NextResponse.json(toPublic(await saveMcpServer({ ...body, id })));
  } catch (error) {
    if (error instanceof McpValidationError) {
      const missing = error.message === "No such MCP server.";
      return NextResponse.json(
        { error: error.message },
        { status: missing ? 404 : 400 }
      );
    }
    console.error("Failed to update MCP server:", error);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    return NextResponse.json({ ok: await deleteMcpServer(id) });
  } catch (error) {
    console.error("Failed to delete MCP server:", error);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}

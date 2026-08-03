import { NextRequest, NextResponse } from "next/server";
import {
  deletePlugin,
  PluginValidationError,
  updatePlugin,
} from "@/lib/plugin-store";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const updated = await updatePlugin(id, body);
    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof PluginValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Failed to update plugin:", error);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    return NextResponse.json({ ok: await deletePlugin(id) });
  } catch (error) {
    console.error("Failed to delete plugin:", error);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}

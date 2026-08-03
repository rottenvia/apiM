import { NextRequest, NextResponse } from "next/server";
import {
  createPlugin,
  listCustomPlugins,
  PluginValidationError,
} from "@/lib/plugin-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await listCustomPlugins());
  } catch (error) {
    console.error("Failed to list plugins:", error);
    return NextResponse.json([]);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    return NextResponse.json(await createPlugin(body));
  } catch (error) {
    if (error instanceof PluginValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Failed to create plugin:", error);
    return NextResponse.json({ error: "Failed to create" }, { status: 500 });
  }
}

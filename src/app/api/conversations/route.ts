import { NextResponse } from "next/server";
import { listConversations } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await listConversations());
  } catch (error) {
    console.error("Error listing conversations:", error);
    return NextResponse.json([]);
  }
}

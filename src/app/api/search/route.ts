import { NextRequest, NextResponse } from "next/server";
import { searchConversations } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams.get("q") ?? "";
    if (q.trim().length < 2) return NextResponse.json([]);
    return NextResponse.json(await searchConversations(q));
  } catch (error) {
    console.error("Search failed:", error);
    return NextResponse.json([]);
  }
}

import { NextResponse } from "next/server";
import { db, isDatabaseConfigured } from "@/db";
import { conversations } from "@/db/schema";
import { desc } from "drizzle-orm";

export async function GET() {
  // Without a database there is simply no history to show; an empty list keeps
  // the UI working instead of surfacing an error.
  if (!isDatabaseConfigured) return NextResponse.json([]);

  try {
    const convs = await db
      .select()
      .from(conversations)
      .orderBy(desc(conversations.updatedAt))
      .limit(50);
    return NextResponse.json(convs);
  } catch (error) {
    console.error("Error fetching conversations:", error);
    return NextResponse.json([], { status: 200 });
  }
}

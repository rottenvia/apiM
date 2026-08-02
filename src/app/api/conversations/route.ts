import { NextResponse } from "next/server";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import { desc } from "drizzle-orm";

export async function GET() {
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

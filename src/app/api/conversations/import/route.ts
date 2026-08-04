import { NextRequest, NextResponse } from "next/server";
import { importConversations } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const result = await importConversations(body);

    if (result.imported === 0) {
      return NextResponse.json(
        {
          error:
            result.errors[0] ??
            "No conversations found in that file. Expected a chat exported as JSON.",
        },
        { status: 400 }
      );
    }

    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "That file isn't valid JSON" },
      { status: 400 }
    );
  }
}

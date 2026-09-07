import { NextRequest, NextResponse } from "next/server";
import { gitHubWorkspaceChanges } from "@/lib/github";

/**
 * What the connected workspace changes relative to the base branch —
 * per-file line counts, commits ahead, uncommitted edits, and a capped
 * unified diff. Reads the local clone only, so no token and no network.
 */
export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get("workspaceId") ?? "";
  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });
  }
  try {
    const changes = await gitHubWorkspaceChanges(workspaceId);
    return NextResponse.json(changes);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not read changes" },
      { status: 500 }
    );
  }
}

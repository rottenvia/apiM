import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_TOKEN_COOKIE,
  connectGitHubRepo,
  githubConfig,
  openGitHubToken,
  readGitHubConnection,
} from "@/lib/github";

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get("workspaceId") ?? "";
  if (!workspaceId) return NextResponse.json({ connection: null });
  return NextResponse.json({ connection: await readGitHubConnection(workspaceId) });
}

export async function POST(req: NextRequest) {
  const config = githubConfig();
  if (!config) return NextResponse.json({ error: "GitHub OAuth is not configured" }, { status: 503 });
  const token = await openGitHubToken(req.cookies.get(GITHUB_TOKEN_COOKIE)?.value, config.tokenSecret);
  if (!token) return NextResponse.json({ error: "GitHub is not connected" }, { status: 401 });
  let body: { workspaceId?: string; repo?: string; baseBranch?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.workspaceId || !body.repo || !body.baseBranch) {
    return NextResponse.json({ error: "workspaceId, repo and baseBranch are required" }, { status: 400 });
  }
  try {
    const connection = await connectGitHubRepo({
      workspaceId: body.workspaceId,
      token,
      repo: body.repo,
      baseBranch: body.baseBranch,
    });
    return NextResponse.json({ connection });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not connect repository" },
      { status: 409 }
    );
  }
}

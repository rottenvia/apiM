import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_TOKEN_COOKIE,
  clearGitHubConnection,
  connectGitHubRepo,
  readGitHubConnection,
  resolveGitHubToken,
} from "@/lib/github";

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get("workspaceId") ?? "";
  if (!workspaceId) return NextResponse.json({ connection: null });
  return NextResponse.json({ connection: await readGitHubConnection(workspaceId) });
}

/**
 * Turn OFF the GitHub link for one workspace. The workspace files are left
 * untouched — only the binding metadata is removed, so the agent stops
 * pushing and the connector can connect a different project.
 */
export async function DELETE(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get("workspaceId") ?? "";
  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });
  }
  await clearGitHubConnection(workspaceId);
  return NextResponse.json({ disconnected: true });
}

export async function POST(req: NextRequest) {
  let body: {
    workspaceId?: string;
    repo?: string;
    baseBranch?: string;
    token?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.workspaceId || !body.repo || !body.baseBranch) {
    return NextResponse.json(
      { error: "workspaceId, repo and baseBranch are required" },
      { status: 400 }
    );
  }

  // Accept a Personal Access Token in the body (the connector's no-OAuth
  // path), the GITHUB_TOKEN env var, or the OAuth cookie.
  let token: string | null;
  try {
    token = (
      await resolveGitHubToken({
        cookieValue: req.cookies.get(GITHUB_TOKEN_COOKIE)?.value,
        requestToken: body.token,
      })
    ).token;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Bad token" },
      { status: 400 }
    );
  }
  if (!token)
    return NextResponse.json(
      { error: "GitHub is not connected — add a Personal Access Token or sign in with GitHub OAuth." },
      { status: 401 }
    );

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

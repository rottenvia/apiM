import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_TOKEN_COOKIE,
  readGitHubConnection,
  resolveGitHubToken,
} from "@/lib/github";
import {
  createGitHubPullRequest,
  gitHubPullRequestStatus,
  suggestPullRequest,
} from "@/lib/git-agent";

async function tokenFor(req: NextRequest, bodyToken?: string) {
  return (
    await resolveGitHubToken({
      cookieValue: req.cookies.get(GITHUB_TOKEN_COOKIE)?.value,
      requestToken: bodyToken || req.headers.get("x-github-token") || undefined,
    })
  ).token;
}

/**
 * The working branch's pull request (state, mergeable, checks, review
 * comments) plus a title/body suggestion built from its commits. Without a
 * token only the suggestion and the stored PR link come back.
 */
export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get("workspaceId") ?? "";
  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });
  }
  const connection = await readGitHubConnection(workspaceId);
  if (!connection) return NextResponse.json({ pr: null, suggestion: null });
  const suggestion = await suggestPullRequest(workspaceId).catch(() => null);
  let token: string | null = null;
  try {
    token = await tokenFor(req);
  } catch {
    token = null;
  }
  const stored =
    connection.prUrl && connection.prBranch === connection.workingBranch
      ? { number: connection.prNumber, url: connection.prUrl }
      : null;
  if (!token) return NextResponse.json({ pr: null, stored, suggestion });
  try {
    const pr = await gitHubPullRequestStatus(workspaceId, token);
    return NextResponse.json({ pr, stored, suggestion });
  } catch (error) {
    return NextResponse.json({
      pr: null,
      stored,
      suggestion,
      error: error instanceof Error ? error.message : "Could not read the pull request",
    });
  }
}

/** Open (or return the existing) pull request — the button click is the approval. */
export async function POST(req: NextRequest) {
  let body: {
    workspaceId?: string;
    title?: string;
    body?: string;
    draft?: boolean;
    token?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.workspaceId || !body.title?.trim()) {
    return NextResponse.json({ error: "workspaceId and title are required" }, { status: 400 });
  }
  let token: string | null;
  try {
    token = await tokenFor(req, body.token);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Bad token" },
      { status: 400 }
    );
  }
  if (!token) return NextResponse.json({ error: "GitHub is not connected" }, { status: 401 });
  try {
    const result = await createGitHubPullRequest(body.workspaceId, token, {
      title: body.title,
      body: body.body ?? "",
      draft: body.draft === true,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not open the pull request" },
      { status: 409 }
    );
  }
}

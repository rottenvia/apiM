import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_TOKEN_COOKIE,
  githubConfig,
  listGitHubBranches,
  openGitHubToken,
} from "@/lib/github";

export async function GET(req: NextRequest) {
  const config = githubConfig();
  if (!config) return NextResponse.json({ error: "GitHub OAuth is not configured" }, { status: 503 });
  const token = await openGitHubToken(req.cookies.get(GITHUB_TOKEN_COOKIE)?.value, config.tokenSecret);
  if (!token) return NextResponse.json({ error: "GitHub is not connected" }, { status: 401 });
  const repo = req.nextUrl.searchParams.get("repo") ?? "";
  try {
    return NextResponse.json({ branches: await listGitHubBranches(token, repo) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not list branches" },
      { status: 502 }
    );
  }
}

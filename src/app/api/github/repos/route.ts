import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_TOKEN_COOKIE,
  githubConfig,
  listGitHubRepos,
  openGitHubToken,
} from "@/lib/github";

export async function GET(req: NextRequest) {
  const config = githubConfig();
  if (!config) return NextResponse.json({ error: "GitHub OAuth is not configured" }, { status: 503 });
  const token = await openGitHubToken(req.cookies.get(GITHUB_TOKEN_COOKIE)?.value, config.tokenSecret);
  if (!token) return NextResponse.json({ error: "GitHub is not connected" }, { status: 401 });
  try {
    const repos = await listGitHubRepos(token);
    const query = (req.nextUrl.searchParams.get("q") ?? "").toLowerCase();
    return NextResponse.json({
      repos: query ? repos.filter((repo) => repo.fullName.toLowerCase().includes(query)) : repos,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not list repositories" },
      { status: 502 }
    );
  }
}

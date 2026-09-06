import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_TOKEN_COOKIE,
  listGitHubRepos,
  resolveGitHubToken,
} from "@/lib/github";

export async function GET(req: NextRequest) {
  const requestToken = req.headers.get("x-github-token") ?? "";
  let token: string | null;
  try {
    token = (
      await resolveGitHubToken({
        cookieValue: req.cookies.get(GITHUB_TOKEN_COOKIE)?.value,
        requestToken: requestToken || undefined,
      })
    ).token;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Bad token" },
      { status: 400 }
    );
  }
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

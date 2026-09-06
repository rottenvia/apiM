import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_TOKEN_COOKIE,
  listGitHubBranches,
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

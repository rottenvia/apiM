import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_TOKEN_COOKIE,
  githubApi,
  githubConfig,
  openGitHubToken,
} from "@/lib/github";

export async function GET(req: NextRequest) {
  const config = githubConfig();
  if (!config) return NextResponse.json({ configured: false, connected: false });
  const token = await openGitHubToken(
    req.cookies.get(GITHUB_TOKEN_COOKIE)?.value,
    config.tokenSecret
  );
  if (!token) return NextResponse.json({ configured: true, connected: false });
  try {
    const user = await githubApi<{ login?: string; avatar_url?: string }>(token, "/user");
    return NextResponse.json({
      configured: true,
      connected: true,
      user: { login: user.login ?? "GitHub user", avatarUrl: user.avatar_url ?? "" },
    });
  } catch {
    return NextResponse.json({ configured: true, connected: false });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ disconnected: true });
  response.cookies.delete(GITHUB_TOKEN_COOKIE);
  return response;
}

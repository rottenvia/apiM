import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_TOKEN_COOKIE,
  githubApi,
  githubConfig,
  resolveGitHubToken,
  envGitHubToken,
} from "@/lib/github";

export async function GET(req: NextRequest) {
  // An OAuth app is optional: a Personal Access Token (supplied with each
  // request or via GITHUB_TOKEN env) works without one.
  const oauthConfig = githubConfig();
  const requestToken = req.headers.get("x-github-token") ?? "";

  if (!oauthConfig && !requestToken && !envGitHubToken()) {
    return NextResponse.json({ configured: false, oauth: false, connected: false });
  }

  try {
    const resolved = await resolveGitHubToken({
      cookieValue: req.cookies.get(GITHUB_TOKEN_COOKIE)?.value,
      requestToken: requestToken || undefined,
    });
    if (!resolved.token) {
      return NextResponse.json({
        configured: true,
        oauth: Boolean(oauthConfig),
        connected: false,
      });
    }
    const user = await githubApi<{ login?: string; avatar_url?: string }>(
      resolved.token,
      "/user"
    );
    return NextResponse.json({
      configured: true,
      oauth: Boolean(oauthConfig),
      connected: true,
      via: resolved.via,
      user: { login: user.login ?? "GitHub user", avatarUrl: user.avatar_url ?? "" },
    });
  } catch {
    return NextResponse.json({
      configured: true,
      oauth: Boolean(oauthConfig),
      connected: false,
    });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ disconnected: true });
  response.cookies.delete(GITHUB_TOKEN_COOKIE);
  return response;
}

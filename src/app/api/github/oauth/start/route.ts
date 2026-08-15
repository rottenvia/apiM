import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_POPUP_COOKIE,
  GITHUB_STATE_COOKIE,
  githubConfig,
} from "@/lib/github";

export async function GET(req: NextRequest) {
  const config = githubConfig();
  if (!config) {
    return NextResponse.json(
      { error: "GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET." },
      { status: 503 }
    );
  }
  const state = crypto.randomUUID();
  const callback =
    process.env.GITHUB_REDIRECT_URI?.trim() ||
    `${req.nextUrl.origin}/api/github/oauth/callback`;
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", callback);
  url.searchParams.set("scope", "repo read:user");
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");

  const response = NextResponse.redirect(url);
  response.cookies.set(GITHUB_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 10 * 60,
  });
  if (req.nextUrl.searchParams.get("popup") === "1") {
    response.cookies.set(GITHUB_POPUP_COOKIE, "1", {
      httpOnly: true,
      sameSite: "lax",
      secure: req.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 10 * 60,
    });
  }
  return response;
}

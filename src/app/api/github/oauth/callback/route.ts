import { NextRequest, NextResponse } from "next/server";
import {
  GITHUB_COOKIE_DAYS,
  GITHUB_POPUP_COOKIE,
  GITHUB_STATE_COOKIE,
  GITHUB_TOKEN_COOKIE,
  githubConfig,
  sealGitHubToken,
} from "@/lib/github";

export async function GET(req: NextRequest) {
  const config = githubConfig();
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const expected = req.cookies.get(GITHUB_STATE_COOKIE)?.value ?? "";
  const code = req.nextUrl.searchParams.get("code") ?? "";
  if (!config || !code || !state || state !== expected) {
    return NextResponse.redirect(new URL("/?github=error", req.url));
  }

  const callback =
    process.env.GITHUB_REDIRECT_URI?.trim() ||
    `${req.nextUrl.origin}/api/github/oauth/callback`;
  const exchange = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: callback,
      state,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await exchange.json().catch(() => ({}))) as {
    access_token?: string;
    error_description?: string;
  };
  if (!exchange.ok || !data.access_token) {
    return NextResponse.redirect(new URL("/?github=error", req.url));
  }

  const sealed = await sealGitHubToken(data.access_token, config.tokenSecret);
  const popup = req.cookies.get(GITHUB_POPUP_COOKIE)?.value === "1";
  const response = popup
    ? new NextResponse(
        `<!doctype html><meta charset="utf-8"><title>GitHub connected</title>` +
          `<p style="font:14px system-ui;padding:24px">GitHub connected. You can close this window.</p>` +
          `<script>window.opener?.postMessage({type:'apim-github-connected'}, ${JSON.stringify(
            req.nextUrl.origin
          )});window.close();</script>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } }
      )
    : NextResponse.redirect(new URL("/?github=connected", req.url));
  response.cookies.set(GITHUB_TOKEN_COOKIE, sealed, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/",
    maxAge: GITHUB_COOKIE_DAYS * 24 * 60 * 60,
  });
  response.cookies.delete(GITHUB_STATE_COOKIE);
  response.cookies.delete(GITHUB_POPUP_COOKIE);
  return response;
}

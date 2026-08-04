import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession, authConfig } from "@/lib/auth";

/**
 * One gate in front of everything.
 *
 * Deliberately middleware rather than a check inside each route: there are
 * eleven API routes today and more later, and the failure mode of per-route
 * checks is forgetting one — which looks fine until someone finds it.
 */

/** Reachable without a session. Everything else requires one. */
const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/login",
  "/api/auth/status",
]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Next.js internals and static files — blocking these breaks the login page
  // itself, which would lock the user out entirely.
  return (
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt"
  );
}

export async function middleware(req: NextRequest) {
  const { enabled, required, secret } = authConfig();

  // Misconfiguration guard: if a deployment demands auth but no password is
  // set, refuse every request rather than serving the app unprotected. A hard
  // failure is recoverable; silently running open on a public IP is not.
  if (required && !enabled) {
    return NextResponse.json(
      {
        error:
          "Auth is required but not configured. Set APP_PASSWORD and AUTH_SECRET.",
      },
      { status: 503 }
    );
  }

  // No password configured and not required — local use, unchanged.
  if (!enabled || !secret) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySession(token, secret)) return NextResponse.next();

  // API calls get a status code; browsers get the login page. Redirecting a
  // fetch() to HTML is what produced the old "Unexpected token '<'" crashes.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};

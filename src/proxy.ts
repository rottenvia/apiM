import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession, authConfig } from "@/lib/auth";

/**
 * One gate in front of everything.
 *
 * Deliberately a proxy rather than a check inside each route: there are
 * eleven API routes today and more later, and the failure mode of per-route
 * checks is forgetting one — which looks fine until someone finds it.
 *
 * Named `proxy` because Next 16 renamed the `middleware` file convention and
 * warns on every dev start until you move. Same behaviour, same matcher — the
 * function name and filename are the whole change.
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

/**
 * Hosts a browser may reach the API through without a password.
 *
 * DNS rebinding: a page on evil.example re-points its own name at
 * 127.0.0.1, and to the browser every request it then makes is same-origin
 * — Origin and Host both say evil.example. Only the Host NAME gives it
 * away. An IP literal cannot be rebound, and localhost is loopback, so
 * those pass; any other name needs APIM_ALLOWED_HOSTS (or a password,
 * whose cookie a rebound origin never has).
 */
function hostAllowed(host: string | null): boolean {
  if (!host) return true; // HTTP/1.0 or a non-browser client: nothing to rebind
  const name = host
    .replace(/:\d+$/, "")
    .replace(/^\[(.*)\]$/, "$1")
    .toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
  if (name.includes(":")) return true; // IPv6 literal
  const extra = (process.env.APIM_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return extra.includes(name);
}

/**
 * Is this API request from some OTHER site?
 *
 * Measured by review: with no check, any web page the user visits could
 * POST text/plain (no CORS preflight) to localhost:3000/api/chat with
 * autoRunCommands and a model base URL it controls, and have the agent run
 * a command on the user's machine. Browsers label every request with
 * Sec-Fetch-Site, and send Origin on every cross-origin POST (no-cors
 * included) — "same-site" is refused too, because another app on a
 * different localhost port is the same site.
 */
function crossSite(req: NextRequest): string | null {
  // A top-level GET navigation cannot read the response, and the GitHub
  // OAuth callback arrives as one (a redirect from github.com is
  // cross-site). Everything a page script could do stays refused.
  if (
    req.method === "GET" &&
    req.headers.get("sec-fetch-mode") === "navigate" &&
    req.headers.get("sec-fetch-dest") === "document"
  ) {
    return null;
  }
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return `cross-site request (${site})`;
  }
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") {
    try {
      if (new URL(origin).host !== req.headers.get("host")) {
        return "cross-origin request";
      }
    } catch {
      return "malformed Origin";
    }
  } else if (origin === "null") {
    return "opaque origin";
  }
  // A state-changing call must be JSON (or an upload): a plain form or a
  // text/plain beacon from anywhere is refused even from an old browser.
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    const type = (req.headers.get("content-type") ?? "").toLowerCase();
    if (
      type &&
      !type.startsWith("application/json") &&
      !type.startsWith("multipart/form-data") &&
      !type.startsWith("application/octet-stream")
    ) {
      return `unexpected content type ${type.split(";")[0]}`;
    }
  }
  return null;
}

export async function proxy(req: NextRequest) {
  const { enabled, required, secret } = authConfig();

  if (req.nextUrl.pathname.startsWith("/api/")) {
    const why = crossSite(req);
    if (why) {
      return NextResponse.json(
        { error: `Refused: ${why}. The API only answers this app's own pages.` },
        { status: 403 }
      );
    }
    if (!(enabled && secret) && !hostAllowed(req.headers.get("host"))) {
      return NextResponse.json(
        {
          error:
            "Refused: unknown host name. Open the app at localhost or its IP, " +
            "or list the name in APIM_ALLOWED_HOSTS.",
        },
        { status: 403 }
      );
    }
  }

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

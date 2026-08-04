import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_DAYS,
  authConfig,
  createSession,
  safeEqual,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Rate limiting, in memory.
 *
 * A password endpoint on a public IP gets found by scanners within hours. In
 * memory is enough here: a restart clears it, but a restart also drops the
 * attacker's progress, and there is one user and one process.
 */
const attempts = new Map<string, { count: number; resetAt: number }>();

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function clientKey(req: NextRequest): string {
  // Behind a reverse proxy the socket address is the proxy, so prefer the
  // forwarded header. Spoofable in general, but the proxy sets it here.
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "unknown";
}

function rateLimited(key: string): number | null {
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 0, resetAt: now + WINDOW_MS });
    return null;
  }
  if (entry.count >= MAX_ATTEMPTS) {
    return Math.ceil((entry.resetAt - now) / 1000);
  }
  return null;
}

function recordFailure(key: string): void {
  const entry = attempts.get(key);
  if (entry) entry.count += 1;
}

export async function POST(req: NextRequest) {
  const { enabled, passwordHash, secret } = authConfig();

  if (!enabled || !passwordHash || !secret) {
    return NextResponse.json(
      { error: "Auth is not configured on this server" },
      { status: 400 }
    );
  }

  const key = clientKey(req);
  const wait = rateLimited(key);
  if (wait !== null) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.` },
      { status: 429 }
    );
  }

  let body: { password?: string };
  try {
    body = (await req.json()) as { password?: string };
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const supplied = typeof body.password === "string" ? body.password : "";

  if (!safeEqual(supplied, passwordHash)) {
    recordFailure(key);
    // Deliberately vague: "wrong password" versus "no such user" is only
    // useful to someone guessing.
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  attempts.delete(key);

  const token = await createSession(secret);
  const res = NextResponse.json({ ok: true });

  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, // unreadable from JavaScript, so XSS can't steal it
    sameSite: "lax", // not sent from other sites, blocking CSRF
    // Only over HTTPS in production. Not in dev, or localhost login breaks.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });

  return res;
}

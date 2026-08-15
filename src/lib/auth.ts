/**
 * Single-user password authentication.
 *
 * On localhost this is unnecessary — nobody else can reach the app. On a
 * public server it is the only thing between the internet and a workspace
 * where a language model writes files, plus stored API keys that cost real
 * money to use.
 *
 * Deliberately minimal: one password, one signed cookie. No accounts, no
 * registration, no password reset. Every one of those is another way to get
 * it wrong, and there is exactly one user.
 */

/** How long a session lasts. Long enough not to be annoying daily. */
export const SESSION_DAYS = 30;
export const SESSION_COOKIE = "apim_session";

/** Rejects a password short enough to be brute-forced. */
export const MIN_PASSWORD_LENGTH = 8;

function enc(s: string): ArrayBuffer {
  // Returned as a plain ArrayBuffer: TextEncoder yields
  // Uint8Array<ArrayBufferLike>, which WebCrypto's BufferSource does not
  // accept, since it could in principle be backed by a SharedArrayBuffer.
  const view = new TextEncoder().encode(s);
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength
  ) as ArrayBuffer;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): ArrayBuffer {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out.buffer;
}

/**
 * Compares two strings in time that does not depend on where they differ.
 *
 * A normal `===` returns faster the earlier a mismatch occurs, which leaks the
 * correct value one character at a time to anyone measuring carefully.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do the work, so a length mismatch isn't faster than a value one.
    let dummy = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      dummy |= (a.charCodeAt(i % a.length || 0) || 0) ^ 0;
    }
    return dummy === -1; // always false
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/**
 * Derives a verifier from the password so the plain password never has to be
 * compared directly, and salts it with the secret.
 */
export async function hashPassword(
  password: string,
  secret: string
): Promise<string> {
  const key = await hmacKey(secret);
  return toHex(await crypto.subtle.sign("HMAC", key, enc(password)));
}

/**
 * Issues a session token: `expiry.signature`.
 *
 * The expiry is inside the signed payload, so it cannot be edited by the
 * client to extend the session — any change invalidates the signature.
 */
export async function createSession(secret: string): Promise<string> {
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = String(expiresAt);
  const key = await hmacKey(secret);
  const sig = toHex(await crypto.subtle.sign("HMAC", key, enc(payload)));
  return `${payload}.${sig}`;
}

/** Verifies a session token's signature and expiry. */
export async function verifySession(
  token: string | undefined,
  secret: string
): Promise<boolean> {
  if (!token) return false;

  const dot = token.lastIndexOf(".");
  if (dot < 1) return false;

  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt)) return false;

  let valid: boolean;
  try {
    const key = await hmacKey(secret);
    valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromHex(sig),
      enc(payload)
    );
  } catch {
    return false;
  }
  if (!valid) return false;

  // Checked after the signature, so an expired-but-forged token is rejected
  // as forged rather than merely expired.
  return Date.now() < expiresAt;
}

/**
 * Whether auth is switched on.
 *
 * Off when no password is configured, which keeps local development exactly
 * as it was. `REQUIRE_AUTH=1` forces it on, so a server deployment fails
 * loudly rather than silently running wide open if the password is missing.
 */
export function authConfig(): {
  enabled: boolean;
  required: boolean;
  passwordHash: string | null;
  secret: string | null;
} {
  const password = process.env.APP_PASSWORD?.trim() || null;
  const secret = process.env.AUTH_SECRET?.trim() || null;
  const required = process.env.REQUIRE_AUTH === "1";

  return {
    enabled: Boolean(password && secret),
    required,
    passwordHash: password,
    secret,
  };
}

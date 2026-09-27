/**
 * Custom Next.js dev/prod server.
 *
 * The app is normally run with `next dev` / `next start`. Next's internal
 * HTTP adapter clones request bodies (getCloneableBody) with a hard 10MB cap
 * BEFORE a route handler runs, which truncated large binary uploads: a 37MB
 * client.dll was saved as 10MB no matter how the route streamed it.
 *
 * This server intercepts the one large-upload endpoint
 * (POST /api/workspace/:id/binary-raw) and pipes the raw Node request
 * straight to disk with a byte counter, bypassing Next's body handling.
 * Every other request is delegated to Next unchanged.
 *
 * Run with:  node server.mjs   (instead of `next dev`)
 * For production: NEXT_PHASE=production node server.mjs
 */
import { createServer } from "node:http";
import {
  createWriteStream,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { stat, rename, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "node:url";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

// Match the app's limits.
const MAX_BINARY_BYTES = 256 * 1024 * 1024;
const DATA_DIR = process.env.APIM_DATA_ROOT
  ? path.join(path.resolve(process.env.APIM_DATA_ROOT), "workspaces")
  : path.join(__dirname, "data", "workspaces");

// Crude guard: a workspace id used on disk is a short slug.
function safeId(id) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

/** Same id → folder mapping as src/lib/workspace.ts (.workspace-id marker). */
function resolveWorkspaceDir(id) {
  const direct = path.join(DATA_DIR, id);
  if (existsSync(direct)) return direct;
  try {
    for (const name of readdirSync(DATA_DIR)) {
      try {
        const marker = readFileSync(
          path.join(DATA_DIR, name, ".workspace-id"),
          "utf8"
        ).trim();
        if (marker === id) return path.join(DATA_DIR, name);
      } catch {
        /* not a workspace */
      }
    }
  } catch {
    /* no workspaces yet */
  }
  return direct;
}
function safeRel(p) {
  // Reject absolute paths and traversal.
  if (!p || /[<>]/.test(p)) return null;
  const decoded = decodeURIComponent(p).replace(/\\/g, "/");
  if (path.isAbsolute(decoded)) return null;
  const parts = decoded.split("/");
  if (parts.some((s) => s === "..")) return null;
  return parts.join(path.sep);
}

// Defer loading Next until needed so the help/errors are fast.
let nextAppPromise;
function getNextApp() {
  if (!nextAppPromise) {
    nextAppPromise = (async () => {
      const mod = await import("next");
      const next = mod.default;
      const app = next({ dev, dir: __dirname, port, hostname: HOST });
      await app.prepare();
      return app;
    })();
  }
  return nextAppPromise;
}

const JSON_HEADERS = { "Content-Type": "application/json" };
function send(res, status, obj) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(obj));
}

/** Stream a raw upload to disk, enforcing the cap. */
function handleBinaryUpload(req, res, workspaceId) {
  const id = safeId(workspaceId);
  const rel = safeRel(req.headers["x-binary-path"]);
  if (!id) return send(res, 400, { error: "invalid workspace id" });
  if (!rel) return send(res, 400, { error: "X-Binary-Path header is required" });

  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > MAX_BINARY_BYTES) {
    return send(res, 413, {
      error: `File is ${(declared / 1024 / 1024).toFixed(1)}MB; cap is ${MAX_BINARY_BYTES / 1024 / 1024}MB.`,
    });
  }

  const wsDir = resolveWorkspaceDir(id);
  mkdirSync(wsDir, { recursive: true });
  const dest = path.join(wsDir, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = path.join(wsDir, `.upload-${Date.now()}-${randomBytes(4).toString("hex")}.tmp`);

  let received = 0;
  let aborted = false;
  const writer = createWriteStream(tmp);

  const cleanup = () => {
    aborted = true;
    try { writer.destroy(); } catch {}
    unlink(tmp).catch(() => {});
  };
  req.on("aborted", cleanup);
  req.on("error", () => {
    cleanup();
    if (!res.writableEnded) send(res, 500, { error: "upload stream error" });
  });

  req.on("data", (chunk) => {
    if (aborted) return;
    received += chunk.length;
    if (received > MAX_BINARY_BYTES) {
      aborted = true;
      req.destroy();
      writer.destroy();
      unlink(tmp).catch(() => {});
      return send(res, 413, {
        error: `Upload exceeds ${MAX_BINARY_BYTES / 1024 / 1024}MB cap (received ${received} bytes).`,
      });
    }
    if (!writer.write(chunk)) {
      req.pause();
      writer.once("drain", () => { if (!aborted) req.resume(); });
    }
  });

  req.on("end", async () => {
    if (aborted) return;
    writer.end(async () => {
      try {
        const info = await stat(tmp);
        if (info.size < 2 || info.size > MAX_BINARY_BYTES) {
          await unlink(tmp).catch(() => {});
          return send(res, 400, { error: `invalid file size: ${info.size}` });
        }
        await rename(tmp, dest);
        try {
          const marker = path.join(wsDir, ".workspace-id");
          if (!existsSync(marker)) writeFileSync(marker, id, "utf8");
        } catch {
          /* best effort — the in-app route also stamps this */
        }
        send(res, 200, {
          path: rel.split(path.sep).join("/"),
          bytes: info.size,
          executableWasRun: false,
        });
      } catch (e) {
        await unlink(tmp).catch(() => {});
        send(res, 500, { error: "Binary upload failed: " + (e?.message || e) });
      }
    });
  });
}

const BINARY_ROUTE = /^\/api\/workspace\/([^/]+)\/binary-raw\/?$/;

/*
 * The raw upload is handled here, before Next — so src/proxy.ts never sees
 * it. Found by review: with auth on, this path took uploads from anyone,
 * and it never had the cross-site check at all. Both mirrored here (same
 * token format as src/lib/auth.ts: `expiry.hmacSha256Hex(expiry)`).
 */
function sessionValid(req) {
  const password = process.env.APP_PASSWORD?.trim();
  const secret = process.env.AUTH_SECRET?.trim();
  if (!password || !secret) return process.env.REQUIRE_AUTH !== "1";
  const cookie = String(req.headers.cookie || "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("apim_session="));
  const token = cookie ? decodeURIComponent(cookie.slice("apim_session=".length)) : "";
  const dot = token.lastIndexOf(".");
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  if (sig.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Date.now() < Number(payload);
}

function crossSiteUpload(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (origin === "null" || new URL(origin).host !== req.headers.host) return true;
    } catch {
      return true;
    }
  }
  return false;
}

const server = createServer(async (req, res) => {
  try {
    const parsed = parse(req.url || "", true);
    const m = req.method === "POST" && BINARY_ROUTE.exec(parsed.pathname || "");
    if (m) {
      if (crossSiteUpload(req)) return send(res, 403, { error: "Refused: cross-site request" });
      if (!sessionValid(req)) return send(res, 401, { error: "Not signed in" });
      return handleBinaryUpload(req, res, decodeURIComponent(m[1]));
    }
    // Everything else goes through Next exactly as `next dev` would.
    const app = await getNextApp();
    const handler = app.getRequestHandler();
    return handler(req, res, parsed);
  } catch (err) {
    console.error("server error:", err);
    if (!res.writableEnded) send(res, 500, { error: "internal error" });
  }
});

server.listen(port, HOST, () => {
  console.log(`> apiM custom server on http://${HOST}:${port} (${dev ? "dev" : "production"})`);
  console.log(`> large binary uploads bypass Next at /api/workspace/:id/binary-raw`);
  if (dev) {
    console.log(`> (Next is booted lazily; the first page load compiles routes.)`);
  }
});

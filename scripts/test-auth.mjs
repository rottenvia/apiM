/**
 * Checks that the password gate actually blocks people.
 *
 * Run:  npm run test:auth
 *
 * This is the code standing between the internet and a workspace where a
 * language model writes files, so it is worth proving rather than assuming.
 */
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  nextBin,
  findFreePort,
  killTree,
  spawnTracked,
  waitForServer,
  finishSuite,
} from "./lib/proc.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
/*
 * Where this suite keeps its files.
 *
 * Several suites clear `data/` to start from a known state, which is correct
 * alone and destructive in parallel — they delete each other's fixtures. The
 * runner gives each suite its own directory through APIM_DATA_ROOT, and the
 * app reads the same variable, so the code under test and the test agree.
 */
const DATA_ROOT = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.join(ROOT, "data");
const PASSWORD = "correct-horse-battery";
const SECRET = "test-secret-not-for-production";

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (c) => (s) => (COLOR ? `\x1b[${c}m${s}\x1b[0m` : s);
const green = wrap(32);
const red = wrap(31);
const dim = wrap(2);
const bold = wrap(1);

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  ${green("PASS")}  ${label}${detail ? dim("  " + detail) : ""}`);
  } else {
    failed++;
    console.log(`  ${red("FAIL")}  ${label}${detail ? "  " + detail : ""}`);
  }
};

const children = [];
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const c of children) killTree(c);
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

async function main() {
  console.log(bold("\napiM auth checks\n"));

  await rm(DATA_ROOT, { recursive: true, force: true });
  await mkdir(DATA_ROOT, { recursive: true });

  const port = await findFreePort();
  const base = `http://127.0.0.1:${port}`;

  console.log(dim("  starting the app with a password set…\n"));

  const app = spawnTracked(
    process.execPath,
    [nextBin(ROOT), "dev", "--port", String(port)],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        APP_PASSWORD: PASSWORD,
        AUTH_SECRET: SECRET,
        REQUIRE_AUTH: "1",
      },
    }
  );
  children.push(app);
  const echo = (d) => {
    if (process.env.VERBOSE) process.stdout.write(dim(`[app] ${d}`));
  };
  app.stdout.on("data", echo);
  app.stderr.on("data", echo);
  app.on("error", (err) => {
    console.log(red(`\n  Could not start the app: ${err.message}\n`));
    cleanup();
    process.exit(1);
  });

  const up = await waitForServer(
    `${base}/api/auth/status`,
    180_000,
    () => app.exitCode !== null || app.signalCode !== null
  );
  if (!up) {
    console.log(red("\n  The app didn't start. Run with VERBOSE=1.\n"));
    cleanup();
    process.exit(1);
  }

  // ------------------------------------------------------------------
  console.log(bold("1. Locked out without a password"));
  // ------------------------------------------------------------------
  const noAuth = await fetch(`${base}/api/conversations`, { redirect: "manual" });
  check("the API refuses anonymous requests", noAuth.status === 401,
    `HTTP ${noAuth.status}`);

  const chatBlocked = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi", deepseekApiKey: "sk-x" }),
    redirect: "manual",
  });
  check("the chat endpoint is blocked", chatBlocked.status === 401,
    `HTTP ${chatBlocked.status}`);

  const wsBlocked = await fetch(`${base}/api/workspace/anything`, {
    redirect: "manual",
  });
  check("the workspace files are blocked", wsBlocked.status === 401,
    `HTTP ${wsBlocked.status}`);

  const pageRedirect = await fetch(base, { redirect: "manual" });
  const loc = pageRedirect.headers.get("location") ?? "";
  check("the app page redirects to login",
    pageRedirect.status >= 300 && pageRedirect.status < 400 && loc.includes("/login"),
    `HTTP ${pageRedirect.status} → ${loc || "(none)"}`);

  // A fetch must never receive an HTML redirect — that produced the old
  // "Unexpected token '<'" crashes in the client.
  const isJson = (noAuth.headers.get("content-type") ?? "").includes("json");
  check("blocked API calls return JSON, not an HTML page", isJson);

  // ------------------------------------------------------------------
  console.log(bold("\n2. The login endpoint itself"));
  // ------------------------------------------------------------------
  const loginPage = await fetch(`${base}/login`, { redirect: "manual" });
  check("the login page is reachable without a session", loginPage.status === 200,
    `HTTP ${loginPage.status}`);

  const wrongPw = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "wrong" }),
  });
  check("a wrong password is rejected", wrongPw.status === 401,
    `HTTP ${wrongPw.status}`);
  check("no cookie is issued on failure",
    !(wrongPw.headers.get("set-cookie") ?? "").includes("apim_session="));

  const rightPw = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  check("the correct password is accepted", rightPw.status === 200,
    `HTTP ${rightPw.status}`);

  const setCookie = rightPw.headers.get("set-cookie") ?? "";
  check("a session cookie is issued", setCookie.includes("apim_session="));
  check("the cookie is HttpOnly (unreadable by scripts)",
    /httponly/i.test(setCookie));
  check("the cookie is SameSite (blocks cross-site use)",
    /samesite/i.test(setCookie));

  const cookie = setCookie.split(";")[0];

  // ------------------------------------------------------------------
  console.log(bold("\n3. Signed in, everything works"));
  // ------------------------------------------------------------------
  const withAuth = await fetch(`${base}/api/conversations`, {
    headers: { cookie },
  });
  check("the API works with a valid session", withAuth.status === 200,
    `HTTP ${withAuth.status}`);

  const pageOk = await fetch(base, { headers: { cookie }, redirect: "manual" });
  check("the app page loads with a valid session", pageOk.status === 200,
    `HTTP ${pageOk.status}`);

  // ------------------------------------------------------------------
  console.log(bold("\n4. Forged and tampered cookies"));
  // ------------------------------------------------------------------
  const forged = await fetch(`${base}/api/conversations`, {
    headers: { cookie: "apim_session=99999999999999.deadbeef" },
    redirect: "manual",
  });
  check("a made-up cookie is rejected", forged.status === 401,
    `HTTP ${forged.status}`);

  // Change the expiry but keep the real signature: the classic attempt to
  // extend a session forever. The signature covers the expiry, so it fails.
  const raw = decodeURIComponent(cookie.split("=").slice(1).join("="));
  const dot = raw.lastIndexOf(".");
  const tampered = `9999999999999.${raw.slice(dot + 1)}`;
  const tamperRes = await fetch(`${base}/api/conversations`, {
    headers: { cookie: `apim_session=${encodeURIComponent(tampered)}` },
    redirect: "manual",
  });
  check("an extended expiry with a stolen signature is rejected",
    tamperRes.status === 401, `HTTP ${tamperRes.status}`);

  const empty = await fetch(`${base}/api/conversations`, {
    headers: { cookie: "apim_session=" },
    redirect: "manual",
  });
  check("an empty cookie is rejected", empty.status === 401,
    `HTTP ${empty.status}`);

  // ------------------------------------------------------------------
  console.log(bold("\n5. Brute force is throttled"));
  // ------------------------------------------------------------------
  let sawLimit = false;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "203.0.113.99",
      },
      body: JSON.stringify({ password: `guess-${i}` }),
    });
    if (r.status === 429) {
      sawLimit = true;
      break;
    }
  }
  check("repeated wrong passwords get rate-limited", sawLimit);

  // ------------------------------------------------------------------
  console.log(bold("\n6. Signing out"));
  // ------------------------------------------------------------------
  const out = await fetch(`${base}/api/auth/logout`, {
    method: "POST",
    headers: { cookie },
  });
  const cleared = out.headers.get("set-cookie") ?? "";
  check("logout clears the cookie",
    out.status === 200 && /max-age=0/i.test(cleared));

  console.log(
    "\n" +
      (failed === 0
        ? green(bold(`All ${passed} checks passed.`))
        : red(bold(`${failed} of ${passed + failed} checks failed.`)))
  );
  console.log("");

  cleanup();
  await finishSuite(failed !== 0);
}

main().catch((err) => {
  console.error(red("\n  Crashed: " + (err?.stack || err?.message || err)));
  cleanup();
  process.exit(1);
});

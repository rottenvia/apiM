/**
 * One-shot bench: boots `next dev` (from the real repo that has node_modules),
 * points APIM_DATA_ROOT at the seeded .bench-data archive, waits for health,
 * times the exact endpoints a chat-open travels through, isolates the raw
 * archive-scan cost (what folderIndex does per open), then kills the server.
 *
 * Usage: node bench/run-bench.mjs
 */
import { spawn } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHAT_WS = path.dirname(SCRIPT_DIR); // workspace copy that holds .bench-data
const BENCH_DATA = path.join(CHAT_WS, ".bench-data");
const PORT = 3211;
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * Walk up from CHAT_WS until node_modules/next exists DIRECTLY in the dir.
 * Module resolution walks up too, so `require.resolve` finds next one level
 * above the workspace copy — that's how the first run picked the copy itself.
 */
function findRepoRoot() {
  let dir = CHAT_WS;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "node_modules", "next", "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`no repo with node_modules/next found walking up from ${CHAT_WS}`);
}

const REPO_ROOT = findRepoRoot();
const require = createRequire(path.join(REPO_ROOT, "package.json"));
const nextBin = require.resolve("next/dist/bin/next");

async function timed(label, url) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    const body = await res.arrayBuffer();
    const ms = performance.now() - t0;
    console.log(
      `${label.padEnd(40)} ${res.status}  ${ms.toFixed(0).padStart(7)} ms  ${(body.byteLength / 1048576).toFixed(2)} MB`
    );
    return res.status;
  } catch (err) {
    console.log(`${label.padEnd(40)} ERR   ${(performance.now() - t0).toFixed(0).padStart(7)} ms  ${String(err).slice(0, 100)}`);
    return 0;
  }
}

/** Isolates the folderIndex() cost shape: readdir + read + JSON.parse every chat. */
async function scanArchiveBench() {
  const t0 = performance.now();
  const chatsDir = path.join(BENCH_DATA, "chats");
  const entries = await fs.readdir(chatsDir, { withFileTypes: true });
  let bytes = 0;
  let folders = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    folders++;
    const raw = await fs.readFile(path.join(chatsDir, entry.name, "chat.json"), "utf8");
    const conv = JSON.parse(raw);
    if (conv.id) folders; // parse-then-use, like folderIndex
    bytes += Buffer.byteLength(raw);
  }
  const ms = performance.now() - t0;
  console.log(
    `\nraw archive scan (folderIndex shape): ${folders} chats, ${(bytes / 1048576).toFixed(1)} MB parsed in ${ms.toFixed(0)} ms — this cost is paid on EVERY conversation open + EVERY streaming checkpoint (via getConversation→folderFor)`
  );
}

async function main() {
  console.log(`repo root (runs next dev): ${REPO_ROOT}`);
  console.log(`bench data root:           ${BENCH_DATA}\n`);

  // Bench-only scaffolding: junction the real node_modules into the workspace
  // copy so `next dev` can boot from the copy with its own .next (no lock fight
  // with the live app on the real root). Reversible; no app code is touched.
  const junction = path.join(CHAT_WS, "node_modules");
  try {
    const st = await fs.lstat(junction);
    if (!st.isSymbolicLink()) {
      console.log(`note: ${junction} already exists as a real dir; leaving it alone`);
    }
  } catch {
    await fs.symlink(path.join(REPO_ROOT, "node_modules"), junction, "junction");
    console.log(`junction created: ${junction} -> ${path.join(REPO_ROOT, "node_modules")}`);
  }

  const child = spawn(process.execPath, [nextBin, "dev", "-p", String(PORT)], {
    cwd: CHAT_WS,
    stdio: "inherit",
    env: {
      ...process.env,
      APIM_DATA_ROOT: BENCH_DATA,
      APIM_PASSWORD: "", // auth off for the probe; real app unaffected
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });

  try {
    // Wait for the server, then give turbopack a beat to settle.
    const t0 = performance.now();
    let up = false;
    while (performance.now() - t0 < 90000) {
      if (child.exitCode !== null) throw new Error(`next dev exited early (code ${child.exitCode})`);
      try {
        const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(4000) });
        if (res.ok) { up = true; break; }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) throw new Error("server never became healthy in 90s");
    console.log(`server healthy after ${((performance.now() - t0) / 1000).toFixed(1)}s\n`);

    console.log("--- endpoint timings (the chat-open path) ---");
    await timed("warmup  GET /api/health", `${BASE}/api/health`);
    await timed("list    GET /api/conversations", `${BASE}/api/conversations`);
    await timed("list    GET /api/conversations (warm)", `${BASE}/api/conversations`);
    await timed("open    GET /api/conversations/fat-00", `${BASE}/api/conversations/fat-00`);
    await timed("open    GET /api/conversations/fat-00 (warm)", `${BASE}/api/conversations/fat-00`);
    await timed("open    GET /api/conversations/fat-01", `${BASE}/api/conversations/fat-01`);
    await timed("open    GET /api/conversations/fat-01 (warm)", `${BASE}/api/conversations/fat-01`);
    await timed("open    GET /api/conversations/small-00", `${BASE}/api/conversations/small-00`);
    await timed("list    GET /api/conversations (after opens)", `${BASE}/api/conversations`);

    console.log("");
    await scanArchiveBench();
    console.log("\nBENCH OK");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 800));
    try { child.kill("SIGKILL"); } catch {}
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("BENCH FAILED:", err);
    process.exit(1);
  }
);

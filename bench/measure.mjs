/**
 * Times the exact endpoints a chat-open travels through, against the dev
 * server on 127.0.0.1:3211 with the bench archive loaded.
 *
 *   GET /api/conversations            (sidebar list — cold then warm)
 *   GET /api/conversations/fat-00     (open a fat chat — cold then repeat)
 *   GET /api/conversations/fat-01     (open a different fat chat — repeat cost)
 *   GET /api/conversations/small-00   (open a small chat)
 *
 * Usage: node bench/measure.mjs
 */
import { performance } from "node:perf_hooks";

const BASE = "http://127.0.0.1:3211";

async function timed(label, url) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    const body = await res.arrayBuffer();
    const ms = performance.now() - t0;
    const mb = body.byteLength / 1048576;
    console.log(
      `${label.padEnd(34)} ${res.status}  ${ms.toFixed(0).padStart(6)} ms  ${(mb).toFixed(2)} MB body`
    );
  } catch (err) {
    console.log(`${label.padEnd(34)} ERROR ${performance.now() - t0 | 0} ms  ${String(err).slice(0, 120)}`);
  }
}

async function main() {
  await timed("warmup GET /api/health", `${BASE}/api/health`);
  await timed("list  (cold cache)  /api/conversations", `${BASE}/api/conversations`);
  await timed("list  (warm cache)  /api/conversations", `${BASE}/api/conversations`);
  await timed("open  fat-00 (1st)    /api/conversations/fat-00", `${BASE}/api/conversations/fat-00`);
  await timed("open  fat-00 (2nd)    /api/conversations/fat-00", `${BASE}/api/conversations/fat-00`);
  await timed("open  fat-01 (1st)    /api/conversations/fat-01", `${BASE}/api/conversations/fat-01`);
  await timed("open  fat-01 (2nd)    /api/conversations/fat-01", `${BASE}/api/conversations/fat-01`);
  await timed("open  small-00        /api/conversations/small-00", `${BASE}/api/conversations/small-00`);
  await timed("list  (again)         /api/conversations", `${BASE}/api/conversations`);
}

main();

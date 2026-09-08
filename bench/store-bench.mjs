/**
 * Direct store bench — no web server.
 *
 * Turbopack refuses to boot the workspace copy (node_modules junction "points
 * out of the filesystem root"), and a second dev server on the real repo root
 * would fight the live app for .next. None of that matters: the cost of a
 * chat-open lives in src/lib/store.ts. This bench imports the REAL store with
 * APIM_DATA_ROOT pointed at the seeded .bench-data archive and times exactly
 * what a click and a streaming checkpoint pay.
 *
 * Usage: npx tsx bench/store-bench.mjs
 */
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHAT_WS = path.dirname(SCRIPT_DIR);
const BENCH_DATA = path.join(CHAT_WS, ".bench-data");

/* ---------- cleanup of earlier HTTP-bench residue ---------- */
async function cleanup() {
  const junction = path.join(CHAT_WS, "node_modules");
  try {
    const st = await fs.lstat(junction);
    if (st.isSymbolicLink()) {
      await fs.unlink(junction); // removes the link only, never the target
      console.log(`cleaned up junction: ${junction}`);
    }
  } catch { /* not there */ }
  for (const name of await fs.readdir(CHAT_WS)) {
    if (name.startsWith("next-panic-")) {
      await fs.rm(path.join(CHAT_WS, name), { force: true });
      console.log(`cleaned up panic log: ${name}`);
    }
  }
  const nextDir = path.join(CHAT_WS, ".next");
  if (existsSync(nextDir)) {
    await fs.rm(nextDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    console.log("cleaned up bench .next/");
  }
}

/* ---------- env BEFORE the store module loads (DATA_DIR is read at import) ---------- */
process.env.APIM_DATA_ROOT = BENCH_DATA;
// Windows: dynamic import of an absolute path needs a file:// URL, not "C:\...".
const store = await import(pathToFileURL(path.join(CHAT_WS, "src/lib/store.ts")).href);

function ms(t0) {
  return (performance.now() - t0).toFixed(0).padStart(7) + " ms";
}

async function scanArchiveShape() {
  const chatsDir = path.join(BENCH_DATA, "chats");
  const entries = await fs.readdir(chatsDir, { withFileTypes: true });
  let bytes = 0;
  let folders = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    folders++;
    const raw = await fs.readFile(path.join(chatsDir, entry.name, "chat.json"), "utf8");
    JSON.parse(raw);
    bytes += Buffer.byteLength(raw);
  }
  return { folders, mb: bytes / 1048576 };
}

/** Replicates GET /api/conversations/[id] payload transform, byte for byte. */
function routePayload(conv) {
  const messages = conv.messages.map((m) => {
    const { resumeState, ...rest } = m;
    const canResume =
      Boolean(resumeState?.messages?.length) ||
      (m.role === "assistant" &&
        (Boolean(m.toolEvents?.length) ||
          Boolean(m.reasoningContent?.trim()) ||
          Boolean(m.content?.trim())));
    const { reasoningContent, ...withoutReasoning } = rest;
    return { ...withoutReasoning, reasoningLength: reasoningContent?.length ?? 0, canResume };
  });
  return JSON.stringify({ ...conv, messages });
}

async function main() {
  await cleanup();
  console.log(`APIM_DATA_ROOT = ${BENCH_DATA}`);
  console.log(`store module   = ${path.join(CHAT_WS, "src/lib/store.ts")}`);
  console.log(`exports        = ${Object.keys(store).filter((k) => typeof store[k] === "function").join(", ")}\n`);

  console.log("--- the click: open a chat ---");
  let t0 = performance.now();
  const list1 = await store.listConversations();
  console.log(`listConversations()          (cold — full read+parse)      ${ms(t0)}  (${list1.length} chats)`);

  t0 = performance.now();
  await store.listConversations();
  console.log(`listConversations()          (warm — summary cache)        ${ms(t0)}`);

  const { folders, mb } = await scanArchiveShape();
  console.log(`raw archive scan shape       (${folders} chats, ${mb.toFixed(1)} MB)   ${ms(t0 = performance.now())}`);

  t0 = performance.now();
  const fat = await store.getConversation("fat-00");
  console.log(`getConversation("fat-00")    (scan + read + parse 4.8MB)   ${ms(t0)}`);

  t0 = performance.now();
  await store.getConversation("fat-00");
  console.log(`getConversation("fat-00")    (repeat — scan happens AGAIN) ${ms(t0)}`);

  t0 = performance.now();
  await store.getConversation("fat-01");
  console.log(`getConversation("fat-01")    (different chat, same scan)   ${ms(t0)}`);

  t0 = performance.now();
  await store.getConversation("small-00");
  console.log(`getConversation("small-00")  (small chat, still full scan) ${ms(t0)}\n`);

  console.log("--- the reply: streaming checkpoints on a fat chat ---");
  const target = fat.messages[0];
  for (let i = 0; i < 5; i++) {
    t0 = performance.now();
    await store.upsertMessage("fat-00", fat.title, { ...target, content: `${target.content} [frame ${i}]` });
    console.log(`upsertMessage #${i + 1}        (scan + parse + stringify + write) ${ms(t0)}`);
  }
  console.log(`  -> a 60-frame reply re-pays that per-frame cost ~60 times\n`);

  console.log("--- payload sizes (what the browser downloads per open) ---");
  const full = JSON.stringify(fat);
  const wire = routePayload(fat);
  const lean = JSON.stringify({
    ...fat,
    messages: fat.messages.map((m) => ({
      ...m,
      toolEvents: m.toolEvents?.map((t) => ({ ...t, args: undefined })) ?? [],
    })),
  });
  console.log(`full conversation JSON:      ${(full.length / 1048576).toFixed(2)} MB`);
  console.log(`GET [id] wire payload:       ${(wire.length / 1048576).toFixed(2)} MB  (reasoning+resume stripped, toolEvents args kept)`);
  console.log(`if toolEvents.args dropped:  ${(lean.length / 1048576).toFixed(2)} MB`);
  const pretty = JSON.stringify(fat, null, 2);
  console.log(`pretty-print write size:     ${(pretty.length / 1048576).toFixed(2)} MB  (compact: ${(full.length / 1048576).toFixed(2)} MB, +${(((pretty.length - full.length) / full.length) * 100).toFixed(0)}% inflation per checkpoint write)`);

  console.log("\nSTORE BENCH OK");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("STORE BENCH FAILED:", err);
    process.exit(1);
  }
);

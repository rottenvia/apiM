/**
 * Bench fixture: fabricates a realistic chat archive under .bench-data/chats.
 *
 * 60 conversations: 20 "agent-heavy" fat ones (~4MB each — long toolEvents with
 * big args, like a session where the agent read a lot of files), 40 small ones.
 * Written pretty-printed, exactly like writeConversationNow does, so the
 * folderIndex scan and the GET payload behave like the real store.
 *
 * Usage: node bench/seed-chats.mjs
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHATS = path.join(ROOT, ".bench-data", "chats");

// One toolEvent arg blob ≈ 15KB of plausible file-ish text.
function argBlob(seed) {
  const line = `function module_${seed}_handler(req, res, next) { /* realistic padding */ return res.status(200).json({ ok: true, seed: ${seed} }); }\n`;
  return line.repeat(160); // ~15.7KB
}

function makeConv(id, title, messages) {
  return {
    id,
    title,
    archived: false,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-09-07T10:00:00.000Z",
    messages,
  };
}

function userMsg(i) {
  return {
    id: `u-${i}`,
    role: "user",
    content: `Question number ${i} about the module layout — please read the files and summarize.`,
    createdAt: "2026-08-01T10:00:00.000Z",
  };
}

/** One fat assistant turn: 8 toolEvents with ~15KB args each ≈ 125KB stored. */
function fatAssistantMsg(i, seedBase) {
  const toolEvents = [];
  for (let t = 0; t < 8; t++) {
    toolEvents.push({
      id: `t-${i}-${t}`,
      name: "read_file",
      args: JSON.stringify({ path: `src/mod${seedBase + t}.ts`, mode: "read" }) + argBlob(seedBase + t),
      ok: true,
      summary: `read src/mod${seedBase + t}.ts`,
      changedPath: `src/mod${seedBase + t}.ts`,
    });
  }
  return {
    id: `a-${i}`,
    role: "assistant",
    content: `Summary number ${i}. The modules look consistent; see the tool output above for details.`.repeat(3),
    toolEvents,
    model: "deepseek-chat",
    tokenCount: 900,
    createdAt: "2026-08-01T10:01:00.000Z",
  };
}

function smallMsg(i) {
  return {
    id: `m-${i}`,
    role: i % 2 ? "assistant" : "user",
    content: `Short exchange ${i} — quick answer, no tools involved.`,
    createdAt: "2026-08-01T10:00:00.000Z",
  };
}

async function main() {
  await fs.rm(path.join(ROOT, ".bench-data"), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await fs.mkdir(CHATS, { recursive: true });

  let totalBytes = 0;

  // 20 fat agent chats: 30 user turns × (1 user + 1 fat assistant) = 60 msgs,
  // 30 × 8 toolEvents × ~15.7KB args ≈ 3.8MB per chat.
  for (let c = 0; c < 20; c++) {
    const id = `fat-${String(c).padStart(2, "0")}`;
    const messages = [];
    for (let i = 0; i < 30; i++) {
      messages.push(userMsg(i));
      messages.push(fatAssistantMsg(i, c * 1000 + i * 10));
    }
    const conv = makeConv(id, `Agent session ${c}`, messages);
    const dir = path.join(CHATS, id);
    await fs.mkdir(dir, { recursive: true });
    const raw = JSON.stringify(conv, null, 2); // pretty, like the store writes
    await fs.writeFile(path.join(dir, "chat.json"), raw, "utf8");
    totalBytes += Buffer.byteLength(raw);
  }

  // 40 small chats: 20 messages each, no tool events.
  for (let c = 0; c < 40; c++) {
    const id = `small-${String(c).padStart(2, "0")}`;
    const messages = [];
    for (let i = 0; i < 20; i++) messages.push(smallMsg(i));
    const conv = makeConv(id, `Quick chat ${c}`, messages);
    const dir = path.join(CHATS, id);
    await fs.mkdir(dir, { recursive: true });
    const raw = JSON.stringify(conv, null, 2);
    await fs.writeFile(path.join(dir, "chat.json"), raw, "utf8");
    totalBytes += Buffer.byteLength(raw);
  }

  console.log(`seeded 60 conversations under ${CHATS}`);
  console.log(`total archive bytes: ${(totalBytes / 1048576).toFixed(1)} MB`);
  console.log(`fat chat to measure: /api/conversations/fat-00`);
}

main();

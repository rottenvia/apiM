#!/usr/bin/env node
/**
 * Markdown parse bench — the frontend cost of opening a fat chat.
 *
 * MessageList mounts the most recent WINDOW_SIZE (60) bubbles in one commit;
 * each bubble parses its content through react-markdown + remark-gfm. This
 * bench runs that exact parse (renderToStaticMarkup over ReactMarkdown) for
 * the last 60 messages of a chat.json and reports where the time goes, so
 * render work is measured against the real archive rather than guessed.
 *
 * Usage: node bench/markdown-bench.mjs [chat.json] [windowSize]
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const chatPath = resolve(process.argv[2] ?? ".bench-data/chats/fat-01/chat.json");
const windowSize = Number(process.argv[3] ?? 60);

const raw = JSON.parse(readFileSync(chatPath, "utf8"));
const messages = Array.isArray(raw) ? raw : (raw.messages ?? []);
if (!messages.length) {
  console.error(`no messages found in ${chatPath}`);
  process.exit(1);
}

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { default: ReactMarkdown } = await import("react-markdown");
const { default: remarkGfm } = await import("remark-gfm");

const slice = messages.slice(-windowSize);
const contents = slice.map((m) => {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    // multimodal content arrays: keep the text parts, like the bubble does
    return c
      .filter((p) => p?.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
  }
  return "";
});

const format = (ms) => (ms >= 100 ? `${Math.round(ms)}ms` : `${ms.toFixed(1)}ms`);

console.log(`chat: ${chatPath}`);
console.log(`messages total: ${messages.length}, window: ${slice.length}`);
const windowBytes = contents.reduce((n, c) => n + c.length, 0);
console.log(
  `window content: ${(windowBytes / 1024 / 1024).toFixed(2)}MB across ${slice.length} messages`
);
console.log(`parsing with react-markdown + remark-gfm (same as MarkdownBody)...\n`);

const perMessage = [];
let total = 0;
for (let i = 0; i < slice.length; i++) {
  const msg = slice[i];
  const content = contents[i];
  const t0 = performance.now();
  renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, content)
  );
  const dt = performance.now() - t0;
  total += dt;
  perMessage.push({
    role: msg.role ?? "?",
    id: msg.id ?? `#${i}`,
    len: content.length,
    ms: dt,
  });
}

// First parse pays module/JIT warmup; report both cold-open and steady-state.
let warm = 0;
for (let i = 0; i < slice.length; i++) {
  const t0 = performance.now();
  renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, contents[i])
  );
  warm += performance.now() - t0;
}

perMessage.sort((a, b) => b.ms - a.ms);
console.log("slowest messages (cold pass):");
for (const m of perMessage.slice(0, 5)) {
  console.log(
    `  ${format(m.ms).padStart(8)}  ${(m.len / 1024).toFixed(1).padStart(8)}KB  ${m.role.padEnd(9)} ${m.id}`
  );
}

console.log(`\ncold open total (what the user waits through): ${format(total)}`);
console.log(`steady-state total (re-render, warm JIT):     ${format(warm)}`);
console.log(
  `rate: ${((windowBytes / 1024 / 1024) / (total / 1000)).toFixed(2)}MB/s cold, ` +
    `${((windowBytes / 1024 / 1024) / (warm / 1000)).toFixed(2)}MB/s warm`
);

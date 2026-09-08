#!/usr/bin/env node
/**
 * Render bench — what a chat open actually costs in the browser.
 *
 * The store bench measures the backend; this one measures the part the user
 * feels: click a chat, wait for the bubbles. It boots `next dev` against the
 * bench archive, seeds a chat whose content is realistic model output (the
 * seed fixture's fat chats carry their bulk in toolEvents args, not content,
 * so they never exercised the markdown/DOM path), then opens it in headless
 * Chromium through the app's own Playwright adapter and reports:
 *
 *   click → first bubble visible → all bubbles mounted
 *   long-task blocking time (the main-thread freeze), DOM node count
 *   the /api/conversations/:id fetch timing
 *
 * Cold (first open of the conversation) and warm (reopen) passes.
 *
 * Run: node --import tsx bench/render-bench.mjs
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  nextBin,
  findFreePort,
  killTree,
  spawnTracked,
  waitForServer,
  finishSuite,
} from "../scripts/lib/proc.mjs";
import { launch, browserAvailable } from "../src/lib/browser-playwright";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHATS = path.join(ROOT, ".bench-data", "chats");

// Three digits: 60 measured messages (000-059) and 8 switcher messages
// (100-107) must all be distinct under /RENDER_BENCH_TOKEN_\d{3}/g.
const pad = (n) => String(n).padStart(3, "0");
const token = (i) => `RENDER_BENCH_TOKEN_${pad(i)}`;

/* ------------------------------------------------------------------ seed */

/** One rich assistant message: the markdown shapes real model replies have. */
function richContent(i, big) {
  const lines = [];
  lines.push(`## Review of module ${i}`);
  lines.push("");
  lines.push(
    `The layout holds together better than the last pass suggested. ` +
      `The request pipeline narrows in three stages, each guarded, and the ` +
      `failure paths all funnel through the same handler so retries stay ` +
      `honest. Two spots still bother me, detailed below.`
  );
  lines.push("");
  lines.push("### What I checked");
  lines.push("");
  for (let k = 0; k < 5; k++) {
    lines.push(
      `- **Stage ${k}** — boundary checks run before the handler, \`${
        k * 7 + 3
      }\`ms budget, no known leaks`
    );
  }
  lines.push("");
  lines.push("### The core loop");
  lines.push("");
  lines.push("```ts");
  const fence = big ? 28 : 12;
  for (let k = 0; k < fence; k++) {
    lines.push(
      `export function stage${k}(input) {` +
        `  const guard = validate(input, schema${k});` +
        `  if (!guard.ok) return Promise.reject(new GuardError(guard.reason));` +
        `  return pipe${k}(guard.value).then(shape${k}).catch(logAndRethrow);` +
        `}`
    );
  }
  lines.push("```");
  lines.push("");
  lines.push("| Stage | Guard | Notes |");
  lines.push("| --- | --- | --- |");
  for (let k = 0; k < 4; k++) {
    lines.push(`| ${k + 1} | \`schema${k}\` | retried \`${k + 1}\`x on 5xx |`);
  }
  lines.push("");
  lines.push(
    `> The second spot is the cache: it trusts \`mtime\` only, so a same-size ` +
      `rewrite inside one tick can serve stale bytes. Low odds, real cost.`
  );
  if (big) {
    lines.push("");
    lines.push("### Deeper trace");
    lines.push("");
    lines.push("```python");
    for (let k = 0; k < 30; k++) {
      lines.push(`def trace_${k}(payload):`);
      lines.push(`    parsed = parse_headers(payload)`);
      lines.push(`    return normalize(parsed, strict=True, budget_ms=${k * 3 + 5})`);
    }
    lines.push("```");
  }
  lines.push("");
  lines.push(`Bottom line: ship it after the cache fix. ${token(i)}`);
  return lines.join("\n");
}

function userContent(i) {
  return (
    `Question ${i}: walk me through stage ${i % 5} again, I lost the thread ` +
    `halfway through the guard discussion. ${token(i)}`
  );
}

function toolEvent(i, j) {
  return {
    id: `t-${i}-${j}`,
    name: "read_file",
    args: JSON.stringify({
      path: `src/lib/stage${j}.ts`,
      mode: "read",
      excerpt: "x".repeat(1100),
    }),
    ok: true,
    summary: `read src/lib/stage${j}.ts`,
    changedPath: `src/lib/stage${j}.ts`,
  };
}

/** 60 messages: 30 user + 30 assistant with realistic markdown bodies. */
async function seedRenderChats() {
  const messages = [];
  for (let i = 0; i < 30; i++) {
    messages.push({
      id: `u-${i}`,
      role: "user",
      content: userContent(i),
      createdAt: `2026-08-01T10:${pad(i)}:00.000Z`,
    });
    const big = i % 4 === 0;
    messages.push({
      id: `a-${i}`,
      role: "assistant",
      content: richContent(i, big),
      toolEvents: [0, 1, 2, 3].map((j) => toolEvent(i, j)),
      model: "deepseek-chat",
      tokenCount: Math.round(big ? 4200 : 900),
      createdAt: `2026-08-01T10:${pad(i)}:30.000Z`,
    });
  }
  const conv = {
    id: "render-fat",
    title: "Render bench fat 01",
    archived: false,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-09-07T10:05:00.000Z",
    messages,
  };
  const dir = path.join(CHATS, "render-fat");
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "chat.json"),
    JSON.stringify(conv, null, 2),
    "utf8"
  );

  // A small switcher chat with a unique title: opens between measured passes
  // so every measured open starts from "another chat is on screen".
  const small = {
    id: "render-small",
    title: "Render bench small 01",
    archived: false,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-09-07T10:06:00.000Z",
    messages: Array.from({ length: 8 }, (_, i) => ({
      id: `s-${i}`,
      role: i % 2 ? "assistant" : "user",
      content: i % 2
        ? `Short answer ${i}, nothing heavy here. ${token(100 + i)}`
        : `Follow-up ${i}? ${token(100 + i)}`,
      createdAt: `2026-08-01T11:0${i}:00.000Z`,
    })),
  };
  const sdir = path.join(CHATS, "render-small");
  await rm(sdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await mkdir(sdir, { recursive: true });
  await writeFile(
    path.join(sdir, "chat.json"),
    JSON.stringify(small, null, 2),
    "utf8"
  );
  return { messages: messages.length };
}

/* ---------------------------------------------------------------- bench */

async function injectInstrumentation(driver, expectTokens) {
  await driver.evaluate(
    `(() => {
      window.__benchExpect = ${expectTokens};
      window.__tokensSeen = new Set();
      window.__marks = { first: 0, count: 0, all: 0 };
      window.__lt = [];
      if (!window.__benchObs) {
        window.__benchObs = true;
        new MutationObserver((muts) => {
          for (const m of muts) {
            for (const n of m.addedNodes) {
              const t = n.textContent || "";
              if (!t.includes("RENDER_BENCH_TOKEN_")) continue;
              for (const tok of t.match(/RENDER_BENCH_TOKEN_\\d{3}/g) || []) {
                window.__tokensSeen.add(tok);
              }
              window.__marks.count = window.__tokensSeen.size;
              if (!window.__marks.first) window.__marks.first = performance.now();
              if (
                window.__benchExpect > 0 &&
                window.__tokensSeen.size >= window.__benchExpect &&
                !window.__marks.all
              ) {
                window.__marks.all = performance.now();
              }
            }
          }
        }).observe(document.body, { childList: true, subtree: true });
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__lt.push(e.duration);
        }).observe({ type: "longtask", buffered: true });
      }
      return "injected";
    })()`
  );
}

/** Find the deepest element naming `title`, mark it, wait for hydration. */
async function markSidebarEntry(driver, title) {
  return driver.evaluate(
    `(() => new Promise((resolve) => {
      const depth = (n) => { let d = 0; let c = n; while (c.parentElement) { d++; c = c.parentElement; } return d; };
      const deadline = Date.now() + 20000;
      const attempt = () => {
        const items = Array.from(document.querySelectorAll("button, a, [role='button'], li, div"));
        const matches = items.filter((n) => (n.textContent || "").includes(${JSON.stringify(title)}));
        matches.sort((a, b) => depth(b) - depth(a));
        const el = matches[0];
        if (!el) {
          if (Date.now() > deadline) return resolve({ marked: false });
          return setTimeout(attempt, 100);
        }
        document.querySelectorAll("[data-bench-click]").forEach((n) => n.removeAttribute("data-bench-click"));
        el.setAttribute("data-bench-click", "1");
        // Hydration gate: React owns a node only once the fiber key exists.
        // Sidebar TEXT renders in server HTML long before that, so clicking
        // on text alone can land on inert HTML — the exact race that made
        // the bench fail on freshly-booted servers while the app was fine.
        const hydrated = Object.keys(el).some((k) => k.startsWith("__reactFiber"));
        if (hydrated || Date.now() > deadline) {
          window.__benchT0 = null;
          // One-shot listener: the clock starts the instant the REAL pointer
          // lands on the row, so no CDP round-trip pollutes the measurement.
          document.addEventListener("pointerdown", (e) => {
            if (window.__benchT0 === null) window.__benchT0 = performance.now();
          }, { once: true, capture: true });
          return resolve({ marked: true, hydrated, tag: el.tagName });
        }
        setTimeout(attempt, 100);
      };
      attempt();
    }))()`
  );
}

/** Click a sidebar entry by title, wait for the expected tokens to mount. */
async function openChat(driver, title, expectTokens) {
  const marked = await markSidebarEntry(driver, title);
  if (!marked?.marked) throw new Error(`sidebar entry not found: ${title}`);
  if (expectTokens === 0) {
    // Warmup: wait on the new-chat page WITHOUT opening anything. Clicking
    // here would leave agent-session-0's bench tokens on screen as leftovers,
    // and every fixture shares the same token ids (000-029), so the later
    // fat passes could not distinguish "new content mounted" from "old
    // content still there" — the small passes false-positived on the
    // leftovers and the fat pre-count equaled the post-swap count. The
    // measured small passes absorb the route-compile cost instead.
    await driver.waitMs(8000);
    return {
      firstMs: null,
      allMs: null,
      bubbles: 0,
      domNodes: 0,
      longTasks: 0,
      blockingMs: 0,
      maxTaskMs: 0,
      fetchMs: null,
    };
  }
  await injectInstrumentation(driver, expectTokens);
  // The click goes through the driver — a REAL mouse press (pointerdown →
  // mousedown → mouseup → click). A synthetic el.click() never opens these
  // rows: verified live, el.click() left the welcome screen up for 30s while
  // the real click mounted 8 bubbles instantly, so the bench never completed
  // a run until this was fixed.
  // Capture the pre-click token count BEFORE the press lands: after the
  // click the swap may already have painted, and a post-click capture sees
  // the new content as "pre", making first-token detection impossible (the
  // -1ms column in an earlier run).
  const preCount = await driver.evaluate(
    "(document.body.innerText.match(/RENDER_BENCH_TOKEN_\\d{3}/g) || []).length"
  );

  await driver.click("[data-bench-click='1']");

  // All timing state lives in THESE locals. The page is only ever READ:
  // every tick returns a pure snapshot, so no in-page observer, interval or
  // window global can hold stale closures across opens (three separate
  // ghosts did exactly that before this design).
  const deadline = Date.now() + 30_000;
  let firstMs = null;
  let allMs = null;
  let reclicked = false;
  while (Date.now() < deadline) {
    await driver.waitMs(40);
    const snap = await driver.evaluate(
      `(() => {
        // OCCURRENCES, not distinct ids: the fixtures reuse the same token ids
        // (000-029 everywhere), so distinct counting cannot see a swap between
        // two chats — the count never changes. Occurrences track the mounted
        // message content (each message carries its token), which is exactly
        // what "all 60 mounted" means, and matches the original baseline
        // semantics.
        const n = (document.body.innerText.match(/RENDER_BENCH_TOKEN_\\d{3}/g) || []).length;
        const marked = document.querySelector("[data-bench-click='1']");
        const current = Boolean(marked && /(^|\\s)is-current(\\s|$)/.test(marked.className));
        return { n, current, now: performance.now(), t0: window.__benchT0 };
      })()`
    );
    if (snap.t0 && snap.current) {
      // First = the first NEW token beyond the pre-click leftovers (the
      // first freshly mounted bubble). All = the expected token count
      // readable in the page (the whole chat mounted).
      if (firstMs === null && snap.n > preCount) {
        firstMs = Math.round(snap.now - snap.t0);
      }
      if (allMs === null && snap.n >= expectTokens) {
        allMs = Math.round(snap.now - snap.t0);
      }
    }
    if (allMs !== null) break;
    // Safety net: if 10s pass with no mount (a hydration race survived the
    // gate, an overlay swallowed the press), re-mark and re-click once.
    if (!reclicked && Date.now() > deadline - 20_000) {
      reclicked = true;
      await markSidebarEntry(driver, title);
      await driver.click("[data-bench-click='1']");
    }
  }
  if (allMs === null) {
    // The old failure message peeked at the first 300 chars of innerText —
    // which is the SIDEBAR (it renders before the chat area in DOM order),
    // so it could not tell "open failed" from "open worked, observer missed
    // it". Dump the real state instead: the token counts, the marked row,
    // the conversation fetches, and the END of the page text where the chat
    // area actually lives.
    const diag = await driver.evaluate(
      `(() => {
        const text = document.body.innerText;
        const marked = document.querySelector("[data-bench-click='1']");
        return {
          distinctTokens: new Set(text.match(/RENDER_BENCH_TOKEN_\\d{3}/g) || []).size,
          tokenOccurrences: (text.match(/RENDER_BENCH_TOKEN_\\d{3}/g) || []).length,
          markedPresent: Boolean(marked),
          markedHtml: marked ? marked.outerHTML.slice(0, 300) : null,
          fetches: (performance.getEntriesByType("resource") || [])
            .filter((e) => e.name.includes("/api/conversations/"))
            .slice(-4)
            .map((e) => Math.round(e.duration) + "ms " + e.name.slice(-36)),
          textTail: text.slice(-400).replace(/\\s+/g, " "),
        };
      })()`
    );
    throw new Error(
      `open "${title}" never mounted ${expectTokens} bubbles ` +
        `(pre=${preCount}, firstMs=${firstMs}); diag: ` +
        JSON.stringify(diag)
    );
  }

  // Settle: let idle work finish before counting DOM and tasks.
  await driver.waitMs(400);
  const final = await driver.evaluate(
    `(() => {
      const text = document.body.innerText;
      return {
        bubbles: (text.match(/RENDER_BENCH_TOKEN_\\d{3}/g) || []).length,
        domNodes: document.querySelectorAll("*").length,
        lt: window.__lt,
        fetches: (performance.getEntriesByType("resource") || [])
          .filter((e) => e.name.includes("/api/conversations/"))
          .slice(-2)
          .map((e) => Math.round(e.duration)),
      };
    })()`
  );
  return {
    firstMs: firstMs === null ? -1 : firstMs,
    allMs: allMs,
    bubbles: final.bubbles,
    domNodes: final.domNodes,
    longTasks: final.lt.length,
    blockingMs: Math.round(
      final.lt.reduce((s, d) => s + Math.max(0, d - 50), 0)
    ),
    maxTaskMs: Math.round(final.lt.reduce((m, d) => Math.max(m, d), 0)),
    fetchMs: final.fetches.length
      ? final.fetches[final.fetches.length - 1]
      : null,
  };
}

async function main() {
  let failed = false;
  if (!(await browserAvailable())) {
    console.error(
      "Chromium is not installed — run `npm run browser:install` once."
    );
    await finishSuite(true);
    return;
  }
  const { messages } = await seedRenderChats();
  console.log(`seeded render chats (${messages} messages in render-fat)`);

  const port = await findFreePort();
  const server = spawnTracked(
    process.execPath,
    [nextBin(ROOT), "dev", "-p", String(port)],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        APIM_DATA_ROOT: path.join(ROOT, ".bench-data"),
        NEXT_TELEMETRY_DISABLED: "1",
      },
    }
  );
  let serverOut = "";
  server.stdout?.on("data", (d) => (serverOut += d));
  server.stderr?.on("data", (d) => (serverOut += d));

  const base = `http://127.0.0.1:${port}`;
  const up = await waitForServer(
    `${base}/api/health`,
    180_000,
    () => server.exitCode !== null
  );
  if (!up) {
    console.error("dev server never came up; last output:");
    console.error(serverOut.slice(-1500));
    killTree(server);
    await finishSuite(true);
    return;
  }

  // Keep the browser profile OUTSIDE the project: a profile inside the tree
  // feeds Turbopack's watcher hundreds of writes per session (cache, code
  // cache, cookies), which surfaced as Fast Refresh cycles right when the
  // bench was measuring. tmpdir keeps the watched tree clean.
  const profileHome = path.join(tmpdir(), "apim-render-bench");
  await mkdir(profileHome, { recursive: true });
  const { driver, console: pageConsole, failedRequests } = await launch(
    profileHome
  );
  const rows = [];
  try {
    await driver.goto(`${base}/`);
    // Wait until the sidebar has rendered the bench chats.
    const readyDeadline = Date.now() + 30_000;
    for (;;) {
      const text = await driver.innerText();
      if (
        text.includes("Render bench fat 01") &&
        text.includes("Agent session 0")
      )
        break;
      if (Date.now() > readyDeadline)
        throw new Error("sidebar never listed the bench chats");
      await driver.waitMs(300);
    }
    // Warmup: compiles the routes, mounts nothing we measure.
    await openChat(driver, "Agent session 0", 0);
    await openChat(driver, "Render bench small 01", 8);

    await openChat(driver, "Render bench small 01", 8);
    rows.push({
      label: "render-fat cold",
      r: await openChat(driver, "Render bench fat 01", 60),
    });

    await openChat(driver, "Render bench small 01", 8);
    rows.push({
      label: "render-fat warm",
      r: await openChat(driver, "Render bench fat 01", 60),
    });
  } catch (error) {
    failed = true;
    console.error(
      "bench failed:",
      error instanceof Error ? error.message : error
    );
    console.error("page console tail:");
    for (const line of pageConsole.slice(-12)) console.error("  " + line);
    if (failedRequests.length) {
      console.error("failed requests:");
      for (const line of failedRequests.slice(-8)) console.error("  " + line);
    }
  } finally {
    await driver.close().catch(() => undefined);
    killTree(server);
  }

  const fmt = (v, suf = "ms") => (v === null ? "—" : `${v}${suf}`);
  console.log(
    "\n" +
      "open".padEnd(22) +
      "first".padStart(8) +
      "all60".padStart(8) +
      "blocking".padStart(10) +
      "maxTask".padStart(9) +
      "fetch".padStart(7) +
      "dom".padStart(8) +
      "bubbles".padStart(9)
  );
  for (const { label, r } of rows) {
    console.log(
      label.padEnd(22) +
        fmt(r.firstMs).padStart(8) +
        fmt(r.allMs).padStart(8) +
        fmt(r.blockingMs).padStart(10) +
        fmt(r.maxTaskMs).padStart(9) +
        fmt(r.fetchMs).padStart(7) +
        String(r.domNodes).padStart(8) +
        String(r.bubbles).padStart(9)
    );
  }
  const errors = pageConsole.filter(
    (l) => l.startsWith("[error]") || l.startsWith("[uncaught]")
  );
  if (errors.length) {
    console.error(`\npage errors during bench (${errors.length}):`);
    for (const line of errors.slice(-6)) console.error("  " + line);
  }
  console.log(
    "\n(dev mode: React is its slower development build — ratios are what matter)"
  );
  await finishSuite(failed);
}

main();

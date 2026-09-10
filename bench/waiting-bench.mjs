#!/usr/bin/env node
/**
 * Waiting-state bench — what the user actually SEES during the silent gap.
 *
 * The waiting state (between sending and the first reasoning token) lived for
 * milliseconds with the standard mock, so the double-loader bug shipped
 * despite suite pins: the pins checked code shape, not pixels. This bench
 * stretches the gap on purpose — scripts/mock-gap.mjs holds six seconds of
 * total silence (after firing one 500 to wake the transient retry banner) —
 * then drives the real UI and captures the gap twice:
 *
 *   1. pixels:  bench-shots/gap-during.png (mid-gap) and gap-after.png
 *   2. DOM:     is a thinking panel mounted during the gap? (expect false —
 *               the status row owns the gap alone)
 *
 * Run: node --import tsx bench/waiting-bench.mjs
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
const SHOTS = path.join(ROOT, "bench-shots");

/** A tiny chat whose last message is the assistant's, so it opens ready. */
async function seedGapChat() {
  const conv = {
    id: "gap-test",
    title: "Gap test 01",
    archived: false,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-09-07T10:07:00.000Z",
    messages: [
      {
        id: "u-0",
        role: "user",
        content: "Hello there, seeded opener.",
        createdAt: "2026-08-01T10:00:00.000Z",
      },
      {
        id: "a-0",
        role: "assistant",
        content: "Seeded reply. Send something to start the gap.",
        model: "deepseek-chat",
        createdAt: "2026-08-01T10:00:30.000Z",
      },
    ],
  };
  const dir = path.join(CHATS, "gap-test");
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "chat.json"),
    JSON.stringify(conv, null, 2),
    "utf8"
  );
  return conv;
}

/** The gap in-page: what is mounted RIGHT NOW in the waiting region? */
async function snapshotWaitingState(driver) {
  return driver.evaluate(
    `(() => {
      const panel = document.querySelector(".thinking-panel");
      const text = document.body.innerText;
      return {
        panelMounted: Boolean(panel),
        panelText: panel ? panel.innerText.slice(0, 120) : null,
        retryVisible: /Waiting on/.test(text),
        elapsedVisible: /elapsed/.test(text),
        tail: text.slice(-500).replace(/\\s+/g, " "),
      };
    })()`
  );
}

async function main() {
  let failed = false;
  if (!(await browserAvailable())) {
    console.error("Chromium is not installed — run `npm run browser:install` once.");
    await finishSuite(true);
    return;
  }
  await seedGapChat();
  console.log("seeded gap-test chat");

  const gapPort = await findFreePort();
  const gapMock = spawnTracked(process.execPath, ["scripts/mock-gap.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      MOCK_GAP_PORT: String(gapPort),
      GAP_MS: "6000",
      FAIL_FIRST: "1",
    },
  });

  const port = await findFreePort();
  const server = spawnTracked(
    process.execPath,
    [nextBin(ROOT), "dev", "-p", String(port)],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        APIM_DATA_ROOT: path.join(ROOT, ".bench-data"),
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${gapPort}`,
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
    () => server.exitCode !== null || gapMock.exitCode !== null
  );
  if (!up) {
    console.error("dev server never came up; last output:");
    console.error(serverOut.slice(-1500));
    killTree(server);
    killTree(gapMock);
    await finishSuite(true);
    return;
  }

  // Keep the browser profile OUTSIDE the project (the Turbopack watcher
  // lesson from render-bench).
  const profileHome = path.join(tmpdir(), "apim-waiting-bench");
  await mkdir(profileHome, { recursive: true });
  await mkdir(path.join(ROOT, "bench-shots"), { recursive: true });
  const { driver, console: pageConsole, failedRequests } = await launch(
    profileHome
  );

  let diag = null;
  try {
    await driver.goto(`${base}/`);
    // The composer gates on hasKeyForModel — keys live in localStorage under
    // "nexusai-settings" (page.tsx), and a fresh bench profile has none, so
    // the textarea rendered disabled ("Add your API keys in Settings") on the
    // first run. Seed a bench key before the app hydrates and reload, so the
    // app reads it on mount: the default model deepseek-v4-pro rides the
    // deepseek provider, whose base URL points at the gap mock.
    await driver.evaluate(
      `localStorage.setItem("nexusai-settings", JSON.stringify({ deepseekKey: "bench-key", model: "deepseek-v4-pro" }))`
    );
    await driver.goto(`${base}/`);
    const readyDeadline = Date.now() + 30_000;
    for (;;) {
      const text = await driver.innerText();
      if (text.includes("Gap test 01")) break;
      if (Date.now() > readyDeadline)
        throw new Error("sidebar never listed the gap-test chat");
      await driver.waitMs(300);
    }

    // Open the seeded chat (real pointer events only — the lesson).
    const marked = await driver.evaluate(
      `(() => new Promise((resolve) => {
        const depth = (n) => { let d = 0; let c = n; while (c.parentElement) { d++; c = c.parentElement; } return d; };
        const deadline = Date.now() + 20000;
        const attempt = () => {
          const items = Array.from(document.querySelectorAll("button, a, [role='button'], li, div"));
          const matches = items.filter((n) => (n.textContent || "").includes("Gap test 01"));
          matches.sort((a, b) => depth(b) - depth(a));
          const el = matches[0];
          if (!el) {
            if (Date.now() > deadline) return resolve({ marked: false });
            return setTimeout(attempt, 100);
          }
          document.querySelectorAll("[data-bench-click]").forEach((n) => n.removeAttribute("data-bench-click"));
          el.setAttribute("data-bench-click", "1");
          const hydrated = Object.keys(el).some((k) => k.startsWith("__reactFiber"));
          if (hydrated || Date.now() > deadline) return resolve({ marked: true, tag: el.tagName });
          setTimeout(attempt, 100);
        };
        attempt();
      }))()`
    );
    if (!marked?.marked) throw new Error("could not mark the gap-test row");
    await driver.click("[data-bench-click='1']");
    await driver.waitMs(1200);

    // The message autoThinkingEffort scores "max" (debug + analyze +
    // refactor + algorithm = complexScore 4), so thinkingRequested is true
    // on the live bubble — the discriminating state for the panel gate.
    const MESSAGE =
      "Debug this crash, analyze the performance, and refactor the broken algorithm";
    await driver.type("textarea", MESSAGE, true);

    // Wait into the middle of the silent gap: attempt 1 500s at ~1s, the
    // retry lands, attempt 2 holds 6s of total silence. 4.5s in, the gap is
    // live with the retry banner showing.
    await driver.waitMs(4500);
    diag = { during: await snapshotWaitingState(driver) };
    const shot1 = await driver.screenshot(false);
    await writeFile(path.join(ROOT, "bench-shots", "gap-during.png"), shot1);

    // Wait for the stream to finish, then capture the after state.
    const doneDeadline = Date.now() + 40_000;
    for (;;) {
      const s = await snapshotWaitingState(driver);
      if (!s.elapsedVisible || s.tail.includes("The gap closed")) break;
      if (Date.now() > doneDeadline) break;
      await driver.waitMs(400);
    }
    await driver.waitMs(800);
    diag.after = await snapshotWaitingState(driver);
    const shot2 = await driver.screenshot();
    await writeFile(path.join(ROOT, "bench-shots", "gap-after.png"), shot2);

    console.log("\nWAITING-STATE DIAG:");
    console.log(JSON.stringify(diag, null, 2));

    // The assertion behind the pixels: no thinking panel in the gap.
    if (diag.during.panelMounted) {
      failed = true;
      console.error(
        "FAIL: a thinking panel is mounted during the silent gap (the double-loader is back)"
      );
    } else {
      console.log(
        "PASS: no thinking panel during the gap — the status row owns it alone"
      );
    }
  } catch (error) {
    failed = true;
    console.error("bench failed:", error instanceof Error ? error.message : error);
    console.error("page console tail:");
    for (const line of pageConsole.slice(-12)) console.error("  " + line);
    if (failedRequests.length) {
      console.error("failed requests:");
      for (const line of failedRequests.slice(-8)) console.error("  " + line);
    }
    console.error("server output tail:");
    console.error(serverOut.slice(-1200));
  } finally {
    await driver.close().catch(() => undefined);
    killTree(server);
    killTree(gapMock);
  }
  await finishSuite(failed);
}

main();

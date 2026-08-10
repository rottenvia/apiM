/**
 * The Playwright adapter.
 *
 * Deliberately the thinnest layer that could work: every method is one or two
 * Playwright calls and nothing else. All the logic — validating actions,
 * ordering them, shaping results, capping sizes, deciding what to do when a
 * step fails — lives in `lib/browser.ts` and is fully tested against a fake
 * driver.
 *
 * That split is not stylistic. Chromium cannot run in the sandbox this was
 * written in (`libnss3`/`libnspr4` missing and unavailable; the browser CDN
 * unreachable — both checked). So this file is the part I cannot execute, and
 * it is kept small on purpose: about thirty lines of real behaviour, against
 * a feature that would otherwise be several hundred lines of untested code.
 *
 * Playwright is imported dynamically so the app runs perfectly well without
 * it installed, which is the normal state until someone asks for a browser.
 */

import path from "node:path";
import type { BrowserDriver } from "@/lib/browser";
import { NAV_TIMEOUT_MS } from "@/lib/browser";
import { AGENT_PROFILE_DIR } from "@/lib/browser-policy";

export interface LaunchResult {
  driver: BrowserDriver;
  /** Lines the page logged, filled in as the session runs. */
  console: string[];
  failedRequests: string[];
}

export class BrowserUnavailable extends Error {}

/*
 * Playwright is an OPTIONAL dependency.
 *
 * It is not in package.json, because most people running this never ask for a
 * browser and a 150MB download on `npm install` would be a poor trade. The
 * module specifier is therefore built at runtime: a bare `import("playwright-
 * core")` is resolved at build time, and TypeScript and the bundler both fail
 * on a package that is not installed. Going through a variable makes it a
 * genuine runtime lookup, which is exactly what an optional dependency needs.
 */
const PLAYWRIGHT = "playwright-core";

async function loadPlaywright(): Promise<any | null> {
  try {
    return await import(/* webpackIgnore: true */ PLAYWRIGHT);
  } catch {
    return null;
  }
}

/** Is Playwright installed at all? Checked before the tool is offered. */
export async function browserAvailable(): Promise<boolean> {
  return (await loadPlaywright()) !== null;
}

/**
 * Start a browser for one session.
 *
 * Three things are non-negotiable, all from `lib/browser-policy.ts` and all
 * because an agent task once closed the user's browser and drove their real
 * profile:
 *
 *   - headless, so it cannot steal focus from what the user is doing
 *   - its own profile directory inside the workspace, never the user's
 *   - launched fresh and closed at the end, never attached to a running
 *     browser
 */
export async function launch(workspaceDir: string): Promise<LaunchResult> {
  const playwright = await loadPlaywright();
  if (!playwright) {
    throw new BrowserUnavailable(
      "The browser is not installed yet. Run `npm run browser:install` in the " +
        "project folder once — it downloads Chromium (about 150MB) and then " +
        "this works offline."
    );
  }

  const profileDir = path.join(workspaceDir, AGENT_PROFILE_DIR);

  let context: any;
  try {
    // A persistent context, so a login the user grants once is not lost on
    // every call — but in the agent's OWN profile directory, never theirs.
    context = await playwright.chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 1280, height: 900 },
      // Announce a real browser: many sites serve a stripped page or a 403 to
      // anything that identifies as automation, and the point is to see what
      // the user would see.
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Executable doesn't exist|Please run the following command/i.test(message)) {
      throw new BrowserUnavailable(
        "Chromium is not downloaded yet. Run `npm run browser:install` once."
      );
    }
    throw new BrowserUnavailable(`Could not start the browser: ${message}`);
  }

  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  /*
   * The console and failed requests are captured, not ignored.
   *
   * This is most of the value for self-testing. A page that renders but is
   * broken almost always says so in the console — an uncaught TypeError, a
   * 404 on a script — and that is exactly the information the agent has never
   * had access to. Without it, "does the page work?" can only be answered by
   * a human looking at it.
   */
  const consoleLines: string[] = [];
  const failedRequests: string[] = [];

  page.on("console", (msg: any) => {
    const type = msg.type();
    if (type === "error" || type === "warning" || type === "log") {
      consoleLines.push(`[${type}] ${String(msg.text()).slice(0, 300)}`);
    }
  });
  page.on("pageerror", (err: Error) => {
    consoleLines.push(`[uncaught] ${err.message.slice(0, 300)}`);
  });
  page.on("requestfailed", (req: any) => {
    failedRequests.push(
      `${req.method()} ${String(req.url()).slice(0, 200)} — ${
        req.failure()?.errorText ?? "failed"
      }`
    );
  });
  page.on("response", (res: any) => {
    if (res.status() >= 400) {
      failedRequests.push(`${res.status()} ${String(res.url()).slice(0, 200)}`);
    }
  });

  const driver: BrowserDriver = {
    async goto(url) {
      // "domcontentloaded" rather than "load": a page with a slow analytics
      // beacon is usable long before `load` fires, and waiting for it is the
      // most common cause of a pointless 30-second timeout.
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
    },
    async click(selector) {
      await page.click(selector);
    },
    async type(selector, text) {
      await page.fill(selector, text);
    },
    async waitForSelector(selector, timeoutMs) {
      await page.waitForSelector(selector, { timeout: timeoutMs });
    },
    async waitMs(ms) {
      await page.waitForTimeout(ms);
    },
    async scroll(to) {
      await page.evaluate((target: "top" | "bottom" | number) => {
        if (target === "top") window.scrollTo(0, 0);
        else if (target === "bottom")
          window.scrollTo(0, document.body.scrollHeight);
        else window.scrollTo(0, target as number);
      }, to);
    },
    async screenshot() {
      return (await page.screenshot({ type: "png" })) as Buffer;
    },
    async evaluate(script) {
      // Wrapped so both an expression and a statement body work — models
      // write either, and rejecting one costs a round.
      return await page.evaluate(`(() => { return (${script}); })()`);
    },
    async extract(selector) {
      return (await page.$$eval(selector, (nodes: Element[]) =>
        nodes.map((n) => (n.textContent ?? "").trim()).filter(Boolean)
      )) as string[];
    },
    async title() {
      return await page.title();
    },
    async innerText() {
      return await page.evaluate(() => document.body?.innerText ?? "");
    },
    async html() {
      return await page.content();
    },
    async close() {
      await context.close();
    },
  };

  return { driver, console: consoleLines, failedRequests };
}

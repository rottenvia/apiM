/**
 * Giving the agent eyes.
 *
 * ## The problem this exists for
 *
 * `inspect_page` fetches the HTML a server returns. For a React, Vue or
 * Angular site that is an empty shell — measured, on a real app shell it
 * returns `ids: ["root"], classes: []`. So when the agent was asked to build
 * an overlay for a Faceit match page, it was shown a single empty div and
 * wrote a plausible overlay that hooked into nothing. That is not a reasoning
 * failure. **No model can write a selector for a DOM it has never seen.**
 *
 * A real browser runs the JavaScript, so the agent sees the page as the user
 * does. It also unlocks the thing that actually makes an agent autonomous: it
 * can look at its own work. Write a page, open it, screenshot it, read the
 * console, fix it. Today the loop stops at "write" and asks the user.
 *
 * ## Why the driver is an interface
 *
 * Playwright cannot run in the sandbox this was developed in: Chromium needs
 * `libnss3`/`libnspr4`, which are absent and cannot be installed, and the
 * browser CDN is unreachable — both verified, not assumed. Writing browser
 * automation that has never once been executed is how the last Windows-only
 * fix went out at 90% confidence.
 *
 * So the logic lives here, behind `BrowserDriver`, and the Playwright
 * implementation is a thin adapter loaded at runtime. Everything that can be
 * wrong in the logic — action validation, ordering, error text, result
 * shaping, the size caps — is exercised against a fake driver in
 * `test:browser`. What remains untested is the adapter's twenty lines of
 * Playwright calls, which is a far smaller surface than the whole feature.
 *
 * ## Not installed by default
 *
 * Chromium is ~150MB. It is fetched on first use, with a clear message, and
 * the tool is only offered to the model once it is actually available —
 * offering a tool that cannot run wastes a round and produces an apology.
 */

/** One instruction in a browser session. */
export type BrowserAction =
  | { action: "goto"; url: string }
  | { action: "html"; selector?: string }
  | { action: "click"; selector: string; force?: boolean }
  | { action: "type"; selector: string; text: string; pressEnter?: boolean }
  | { action: "wait_for"; selector?: string; ms?: number }
  | { action: "scroll"; to: "top" | "bottom" | number }
  | { action: "screenshot"; name?: string; fullPage?: boolean }
  | { action: "evaluate"; script: string }
  | { action: "extract"; selector: string };

export interface ActionResult {
  action: string;
  ok: boolean;
  /** What happened, for the model to read. */
  detail: string;
}

export interface BrowserSessionResult {
  results: ActionResult[];
  /** Final URL after redirects/navigation. */
  finalUrl?: string;
  /** Final page title, when a page was loaded. */
  title?: string;
  /** Visible text of the rendered page, capped. */
  text?: string;
  /** Selectors present AFTER JavaScript ran — the whole point. */
  selectors?: { ids: string[]; classes: string[]; dataAttrs: string[] };
  /** Workspace-relative paths of any screenshots taken. */
  screenshots: string[];
  /** console.log/error from the page, which is where real bugs announce. */
  console: string[];
  /** Failed network requests, the other place bugs hide. */
  failedRequests: string[];
  /**
   * Set when the page is an anti-bot challenge rather than the real content.
   *
   * Without this the agent scrapes the block page and reports on THAT — the
   * selectors it returns are Cloudflare's, the text is "Verify you are a
   * human", and nothing says the real page was never seen. Naming it is the
   * difference between a useful failure and a confidently wrong answer.
   */
  blocked?: string;
}

/**
 * What a driver must provide.
 *
 * Deliberately small: every method maps to one Playwright call, so the
 * adapter has nowhere to hide a bug that the fake would not also have.
 */
export interface BrowserDriver {
  goto(url: string): Promise<{ url: string; status: number | null }>;
  click(selector: string, force?: boolean): Promise<void>;
  type(selector: string, text: string, pressEnter?: boolean): Promise<void>;
  waitForSelector(selector: string, timeoutMs: number): Promise<void>;
  waitMs(ms: number): Promise<void>;
  scroll(to: "top" | "bottom" | number): Promise<void>;
  screenshot(fullPage?: boolean): Promise<Buffer>;
  evaluate(script: string): Promise<unknown>;
  /** Text content of every node matching a selector. */
  extract(selector: string): Promise<string[]>;
  url(): Promise<string>;
  title(): Promise<string>;
  /** Rendered visible text. */
  innerText(): Promise<string>;
  /** Full rendered HTML, or one element's outerHTML. */
  html(selector?: string): Promise<string>;
  close(): Promise<void>;
}

/** A page that has not settled by now is not going to. */
export const NAV_TIMEOUT_MS = 30_000;
/** Individual waits are shorter: the agent can always ask again. */
export const ACTION_TIMEOUT_MS = 10_000;
/** Rendered text sent back to the model. */
export const MAX_TEXT_CHARS = 30_000;
/** Actions in one call, so a runaway script cannot loop forever. */
export const MAX_ACTIONS = 25;
/** Console lines kept — enough to see an error, not a whole log. */
export const MAX_CONSOLE_LINES = 40;

export class BrowserError extends Error {}

/**
 * Validate a list of actions before the browser is even started.
 *
 * Launching a browser costs a second or two, so a malformed script should
 * fail instantly with an explanation rather than after the cost is paid.
 */
export function validateActions(raw: unknown): BrowserAction[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BrowserError(
      "actions must be a non-empty list, e.g. " +
        '[{"action":"goto","url":"https://example.com"},{"action":"screenshot"}]'
    );
  }
  if (raw.length > MAX_ACTIONS) {
    throw new BrowserError(
      `Too many actions (${raw.length}). The limit is ${MAX_ACTIONS} per call; ` +
        `split the work across several calls so you can read the result in between.`
    );
  }

  const out: BrowserAction[] = [];
  for (const [i, entry] of raw.entries()) {
    const a = entry as Record<string, unknown>;
    const kind = String(a.action ?? "");
    const where = `Action ${i + 1}`;

    switch (kind) {
      case "goto": {
        if (typeof a.url !== "string" || !a.url.trim()) {
          throw new BrowserError(`${where}: goto needs a url.`);
        }
        out.push({ action: "goto", url: a.url.trim() });
        break;
      }
      case "click":
      case "extract": {
        if (typeof a.selector !== "string" || !a.selector.trim()) {
          throw new BrowserError(`${where}: ${kind} needs a selector.`);
        }
        out.push(
          kind === "click"
            ? {
                action: "click",
                selector: a.selector.trim(),
                force: a.force === true,
              }
            : { action: "extract", selector: a.selector.trim() }
        );
        break;
      }
      case "html": {
        out.push({
          action: "html",
          selector:
            typeof a.selector === "string" && a.selector.trim()
              ? a.selector.trim()
              : undefined,
        });
        break;
      }
      case "type": {
        if (typeof a.selector !== "string" || !a.selector.trim()) {
          throw new BrowserError(`${where}: type needs a selector.`);
        }
        if (typeof a.text !== "string") {
          throw new BrowserError(`${where}: type needs text.`);
        }
        out.push({
          action: "type",
          selector: a.selector.trim(),
          text: a.text,
          pressEnter: a.press_enter === true || a.pressEnter === true,
        });
        break;
      }
      case "wait_for": {
        const selector =
          typeof a.selector === "string" && a.selector.trim()
            ? a.selector.trim()
            : undefined;
        const ms =
          typeof a.ms === "number" && Number.isFinite(a.ms)
            ? Math.min(Math.max(0, a.ms), ACTION_TIMEOUT_MS)
            : undefined;
        if (!selector && ms === undefined) {
          throw new BrowserError(
            `${where}: wait_for needs either a selector or ms.`
          );
        }
        out.push({ action: "wait_for", selector, ms });
        break;
      }
      case "scroll": {
        const to = a.to;
        if (to !== "top" && to !== "bottom" && typeof to !== "number") {
          throw new BrowserError(
            `${where}: scroll needs to be "top", "bottom" or a pixel offset.`
          );
        }
        out.push({ action: "scroll", to: to as "top" | "bottom" | number });
        break;
      }
      case "screenshot": {
        out.push({
          action: "screenshot",
          name: typeof a.name === "string" ? a.name.trim() : undefined,
          fullPage: a.full_page === true || a.fullPage === true,
        });
        break;
      }
      case "evaluate": {
        if (typeof a.script !== "string" || !a.script.trim()) {
          throw new BrowserError(`${where}: evaluate needs a script.`);
        }
        out.push({ action: "evaluate", script: a.script });
        break;
      }
      default:
        throw new BrowserError(
          `${where}: unknown action "${kind}". Valid actions are goto, html, ` +
            `click, type, wait_for, scroll, screenshot, evaluate and extract.`
        );
    }
  }

  // A session that never navigates has no page to act on.
  if (out[0]?.action !== "goto") {
    throw new BrowserError(
      "The first action must be goto — there is no page open until you " +
        "navigate to one."
    );
  }

  return out;
}

/** Screenshots land here inside the workspace, so they can be viewed later. */
export const SCREENSHOT_DIR = ".agent-browser/screenshots";

function safeName(name: string | undefined, index: number): string {
  const base = (name ?? `shot-${index}`)
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || `shot-${index}`}.png`;
}

/**
 * Run a session.
 *
 * `saveScreenshot` is injected rather than imported so this module never
 * touches the filesystem directly — which is what lets the whole thing be
 * tested without a browser or a workspace.
 */
export async function runSession(
  driver: BrowserDriver,
  actions: BrowserAction[],
  saveScreenshot: (name: string, data: Buffer) => Promise<string>,
  collect: { console: string[]; failedRequests: string[] }
): Promise<BrowserSessionResult> {
  const results: ActionResult[] = [];
  const screenshots: string[] = [];
  let navigated = false;

  try {
    for (const [i, step] of actions.entries()) {
      try {
        switch (step.action) {
          case "goto": {
            const navigation = await driver.goto(step.url);
            navigated = true;
            results.push({
              action: "goto",
              ok: true,
              detail:
                `Loaded ${navigation.url}` +
                (navigation.status === null ? "" : ` — HTTP ${navigation.status}`),
            });
            break;
          }

          case "html": {
            const html = await driver.html(step.selector);
            results.push({
              action: "html",
              ok: true,
              detail: html.slice(0, MAX_TEXT_CHARS),
            });
            break;
          }

          case "click":
            await driver.click(step.selector, step.force);
            results.push({
              action: "click",
              ok: true,
              detail: `Clicked ${step.selector}`,
            });
            break;

          case "type":
            await driver.type(step.selector, step.text, step.pressEnter);
            results.push({
              action: "type",
              ok: true,
              detail: `Typed into ${step.selector}`,
            });
            break;

          case "wait_for":
            if (step.selector) {
              await driver.waitForSelector(step.selector, ACTION_TIMEOUT_MS);
              results.push({
                action: "wait_for",
                ok: true,
                detail: `${step.selector} appeared`,
              });
            } else {
              await driver.waitMs(step.ms ?? 0);
              results.push({
                action: "wait_for",
                ok: true,
                detail: `Waited ${step.ms}ms`,
              });
            }
            break;

          case "scroll":
            await driver.scroll(step.to);
            results.push({
              action: "scroll",
              ok: true,
              detail: `Scrolled to ${step.to}`,
            });
            break;

          case "screenshot": {
            const data = await driver.screenshot(step.fullPage);
            const saved = await saveScreenshot(safeName(step.name, i), data);
            screenshots.push(saved);
            results.push({
              action: "screenshot",
              ok: true,
              detail: `Saved ${saved} — open it with view_image`,
            });
            break;
          }

          case "evaluate": {
            const value = await driver.evaluate(step.script);
            const rendered =
              typeof value === "string" ? value : JSON.stringify(value);
            results.push({
              action: "evaluate",
              ok: true,
              detail: (rendered ?? "undefined").slice(0, 2000),
            });
            break;
          }

          case "extract": {
            const values = await driver.extract(step.selector);
            results.push({
              action: "extract",
              ok: true,
              detail: values.length
                ? `${values.length} match(es):\n` +
                  values.slice(0, 50).map((v) => `  ${v.slice(0, 200)}`).join("\n")
                : `No elements matched ${step.selector}`,
            });
            break;
          }
        }
      } catch (error) {
        /*
         * One failed step does not end the session.
         *
         * A click on a selector that has not appeared yet is the single most
         * common browser error, and aborting there would throw away the
         * navigation that already succeeded — and the screenshot that would
         * have shown why. The failure is recorded and the run continues, so
         * the model gets a full picture instead of one error message.
         */
        results.push({
          action: step.action,
          ok: false,
          detail:
            error instanceof Error
              ? error.message.split("\n")[0].slice(0, 300)
              : "failed",
        });
      }
    }

    const out: BrowserSessionResult = {
      results,
      screenshots,
      console: collect.console.slice(-MAX_CONSOLE_LINES),
      failedRequests: collect.failedRequests.slice(-20),
    };

    if (navigated) {
      out.finalUrl = await driver.url().catch(() => "");
      out.title = await driver.title().catch(() => "");
      const text = await driver.innerText().catch(() => "");
      out.text = text.slice(0, MAX_TEXT_CHARS);

      // Flagged before the selectors are gathered below, so the warning is
      // attached to the same result that carries the challenge page's markup.
      const challenge = detectChallenge(out.title ?? "", text);
      if (challenge) out.blocked = challenge;
      const html = await driver.html().catch(() => "");
      if (html) {
        const { extractSelectors } = await import("@/lib/web");
        out.selectors = extractSelectors(html);
      }
    }

    return out;
  } finally {
    await driver.close().catch(() => {});
  }
}

/**
 * Is this an anti-bot challenge rather than the page that was asked for?
 *
 * Detected and named, so the model knows what it is looking at. A challenge
 * page looks like a successful load —
 * HTTP 200 or 403 with real HTML — so without this the agent happily reports
 * the selectors and text of the block page as though they were the site's,
 * and the user gets a scraper built against Cloudflare's markup.
 *
 * The signatures are the interstitials themselves, which are boilerplate and
 * stable. Deliberately narrow: a page that merely mentions "captcha" in an
 * article is not a challenge, so a title or a very short body is required
 * alongside the marker.
 */
export function detectChallenge(
  title: string,
  text: string
): string | null {
  const t = `${title}\n${text}`.toLowerCase();
  const shortPage = text.trim().length < 2000;

  const signatures: [RegExp, string][] = [
    [/just a moment\.\.\./, "Cloudflare"],
    [/checking your browser before accessing/, "Cloudflare"],
    [/enable javascript and cookies to continue/, "Cloudflare"],
    // Named vendors first: "verify you are a human" appears on Cloudflare's
    // own page too, and attributing it to a generic "bot check" loses the
    // one detail that tells the user what they are up against.
    [/cf-browser-verification|cf_chl_|__cf_chl/, "Cloudflare"],
    [/attention required!? \| cloudflare/, "Cloudflare"],
    [/verify you are (a )?human/, "a bot check"],
    [/ddos protection by/, "a DDoS filter"],
    [/please complete the security check/, "a security check"],
    [/access denied.{0,40}(reference #|error \d{4})/, "an edge block"],
    [/are you a robot|i'm not a robot|recaptcha/, "a CAPTCHA"],
    [/px-captcha|perimeterx|human challenge/, "PerimeterX"],
    [/incapsula incident id/, "Imperva"],
  ];

  for (const [re, who] of signatures) {
    if (!re.test(t)) continue;
    // A long page that happens to mention a captcha is an article about
    // captchas, not a challenge. A challenge page is nearly always short.
    if (!shortPage && !/just a moment|cf_chl_|incapsula incident/.test(t)) {
      continue;
    }
    return who;
  }
  return null;
}

/** Render a session result for the model. */
export function formatSession(result: BrowserSessionResult): string {
  const lines: string[] = [];

  /*
   * The note comes first, before anything scraped from the challenge page.
   *
   * Everything below — selectors, text, title — belongs to the challenge,
   * not to the site. Naming that up front stops the model writing a scraper
   * against Cloudflare's markup and passing it off as the site's. It is a
   * label, not a stop sign: the raw page data is still returned and the
   * model is free to proceed with the task however it judges best.
   */
  if (result.blocked) {
    lines.push(
      `NOTE: this page is ${result.blocked}'s anti-bot challenge, not the ` +
        `site's real content. The selectors and text below describe the ` +
        `challenge page, not the site.`,
      `The raw page data below is still available — proceed with the task ` +
        `however you judge best.`,
      ""
    );
  }

  for (const r of result.results) {
    lines.push(`${r.ok ? "OK  " : "FAIL"} ${r.action}: ${r.detail}`);
  }

  if (result.finalUrl) lines.push("", `Final URL: ${result.finalUrl}`);
  if (result.title) lines.push(`Page title: ${result.title}`);

  if (result.console.length) {
    lines.push("", "Browser console:");
    for (const line of result.console) lines.push(`  ${line}`);
  }

  if (result.failedRequests.length) {
    lines.push("", "Requests that failed:");
    for (const line of result.failedRequests) lines.push(`  ${line}`);
  }

  /*
   * Selectors before text.
   *
   * This is the reason the tool exists: these are the ids and classes as they
   * are AFTER JavaScript has run, which is what a content script or scraper
   * has to target. Putting them above the page text keeps them from being
   * buried under thousands of words of prose.
   */
  if (result.selectors) {
    const { ids, classes, dataAttrs } = result.selectors;
    lines.push("", "Selectors on the rendered page (use these, do not guess):");
    if (ids.length) lines.push(`  ids: ${ids.slice(0, 80).join(", ")}`);
    if (classes.length)
      lines.push(`  classes: ${classes.slice(0, 120).join(", ")}`);
    if (dataAttrs.length)
      lines.push(`  data attributes: ${dataAttrs.slice(0, 40).join(", ")}`);
  }

  if (result.text) {
    lines.push("", "Visible text:", result.text);
  }

  return lines.join("\n");
}

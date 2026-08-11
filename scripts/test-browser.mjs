/**
 * The browser tool's logic, tested without a browser.
 *
 * Run:  npm run test:browser
 *
 * Chromium cannot run in the sandbox this was developed in — `libnss3` and
 * `libnspr4` are missing and unavailable through apt, and Playwright's binary
 * CDN is unreachable. Both verified rather than assumed.
 *
 * Writing several hundred lines of untested browser code and calling it done
 * is how the last platform-specific fix shipped at 90% confidence. So the
 * feature is split: all the logic lives in `lib/browser.ts` behind a
 * `BrowserDriver` interface and is fully exercised here against a fake, and
 * the Playwright adapter is kept to roughly thirty lines of one-to-one calls.
 *
 * What this proves: action validation, ordering, failure handling, result
 * shaping, screenshot naming and containment, and — most importantly — that
 * the selectors come from the RENDERED DOM, which is the entire reason the
 * tool exists.
 *
 * What it does not prove: that Playwright's API behaves as documented. That
 * is the residual risk, and it is small and clearly located.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const browser = await load("src/lib/browser.ts");
const { WORKSPACE_TOOLS } = await load("src/lib/tools.ts");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0,
  fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

/**
 * A fake browser.
 *
 * Models the one behaviour that matters: the HTML BEFORE scripts run is an
 * empty shell, and after `goto` resolves it is the real DOM. That is the
 * difference between fetch_url and this tool, stated as a test.
 */
function makeDriver(overrides = {}) {
  const calls = [];
  const SHELL = '<html><body><div id="root"></div></body></html>';
  const RENDERED =
    '<div class="match-header"><span id="score" class="match-header__score">16-14</span>' +
    '<div data-testid="team-a" class="team team--home">NAVI</div></div>';
  let loaded = false;

  return {
    calls,
    driver: {
      async goto(url) {
        calls.push(`goto:${url}`);
        loaded = true;
      },
      async click(sel) {
        calls.push(`click:${sel}`);
      },
      async type(sel, text) {
        calls.push(`type:${sel}:${text}`);
      },
      async waitForSelector(sel) {
        calls.push(`wait:${sel}`);
      },
      async waitMs(ms) {
        calls.push(`waitms:${ms}`);
      },
      async scroll(to) {
        calls.push(`scroll:${to}`);
      },
      async screenshot() {
        calls.push("screenshot");
        return Buffer.from("PNGDATA");
      },
      async evaluate(script) {
        calls.push(`eval:${script}`);
        return 42;
      },
      async extract(sel) {
        calls.push(`extract:${sel}`);
        return ["16-14", "NAVI"];
      },
      async title() {
        return "FACEIT Match";
      },
      async innerText() {
        return "16-14 NAVI";
      },
      async html() {
        return loaded ? RENDERED : SHELL;
      },
      async close() {
        calls.push("close");
      },
      ...overrides,
    },
  };
}

const saved = [];
const saveShot = async (name, data) => {
  saved.push({ name, bytes: data.length });
  return `${browser.SCREENSHOT_DIR}/${name}`;
};
const noLogs = () => ({ console: [], failedRequests: [] });

console.log("\napiM browser checks (logic, against a fake driver)\n");

// ---------------------------------------------------------------------------
console.log("1. Bad scripts fail before a browser is started");

const bad = [
  [[], "an empty list"],
  [[{ action: "click", selector: ".x" }], "not starting with goto"],
  [[{ action: "goto" }], "goto with no url"],
  [[{ action: "goto", url: "u" }, { action: "click" }], "click with no selector"],
  [[{ action: "goto", url: "u" }, { action: "type", selector: "#a" }], "type with no text"],
  [[{ action: "goto", url: "u" }, { action: "wait_for" }], "wait_for with neither selector nor ms"],
  [[{ action: "goto", url: "u" }, { action: "teleport" }], "an unknown action"],
  [[{ action: "goto", url: "u" }, { action: "evaluate" }], "evaluate with no script"],
];
for (const [actions, why] of bad) {
  let threw = "";
  try {
    browser.validateActions(actions);
  } catch (e) {
    threw = e.message;
  }
  check(`rejects ${why}`, threw.length > 0, threw.slice(0, 60));
}

let threw = "";
try {
  browser.validateActions(
    Array.from({ length: 40 }, () => ({ action: "goto", url: "https://x" }))
  );
} catch (e) {
  threw = e.message;
}
check(
  "rejects a runaway script",
  /Too many actions/.test(threw),
  `limit is ${browser.MAX_ACTIONS}`
);

const good = browser.validateActions([
  { action: "goto", url: " https://example.com " },
  { action: "wait_for", selector: ".score" },
  { action: "screenshot", name: "after" },
]);
check("accepts a valid script", good.length === 3);
check("trims the url", good[0].url === "https://example.com");

// ---------------------------------------------------------------------------
console.log("\n2. Selectors come from the RENDERED page — the whole point");

let { driver, calls } = makeDriver();
let result = await browser.runSession(
  driver,
  browser.validateActions([{ action: "goto", url: "https://faceit.com/m/1" }]),
  saveShot,
  noLogs()
);

check(
  "the class list is the real one, not an empty shell",
  result.selectors.classes.includes("match-header__score"),
  result.selectors.classes.join(", ")
);
check("ids come from the rendered DOM", result.selectors.ids.includes("score"));
check("data attributes too", result.selectors.dataAttrs.includes("data-testid"));
check(
  "this is what fetch_url could not do",
  !result.selectors.ids.includes("root") || result.selectors.classes.length > 0,
  "a static fetch sees only id=root"
);
check("the page title is reported", result.title === "FACEIT Match");
check("visible text is returned", result.text === "16-14 NAVI");
check("the browser is always closed", calls.includes("close"));

// ---------------------------------------------------------------------------
console.log("\n3. Every action reaches the driver, in order");

({ driver, calls } = makeDriver());
await browser.runSession(
  driver,
  browser.validateActions([
    { action: "goto", url: "https://x" },
    { action: "wait_for", selector: ".ready" },
    { action: "click", selector: "#accept" },
    { action: "type", selector: "#q", text: "hello" },
    { action: "scroll", to: "bottom" },
    { action: "extract", selector: ".score" },
    { action: "evaluate", script: "1+1" },
    { action: "screenshot", name: "final" },
  ]),
  saveShot,
  noLogs()
);
check(
  "the order is preserved exactly",
  calls.slice(0, 8).join("|") ===
    "goto:https://x|wait:.ready|click:#accept|type:#q:hello|scroll:bottom|extract:.score|eval:1+1|screenshot",
  calls.slice(0, 3).join(" ")
);

// ---------------------------------------------------------------------------
console.log("\n4. One broken step does not throw the session away");

({ driver, calls } = makeDriver({
  async click() {
    throw new Error("locator.click: Timeout 10000ms exceeded.\nwaiting for #gone");
  },
}));
result = await browser.runSession(
  driver,
  browser.validateActions([
    { action: "goto", url: "https://x" },
    { action: "click", selector: "#gone" },
    { action: "screenshot" },
  ]),
  saveShot,
  noLogs()
);

check("the failing step is recorded", result.results[1].ok === false);
check(
  "with a one-line reason",
  !result.results[1].detail.includes("\n"),
  result.results[1].detail
);
check(
  "and the steps after it still ran",
  result.results[2].ok === true,
  "aborting would lose the screenshot that shows WHY the click failed"
);
check("the page was still inspected", Boolean(result.selectors));

// ---------------------------------------------------------------------------
console.log("\n5. Screenshots are saved safely and pointed at");

saved.length = 0;
({ driver } = makeDriver());
result = await browser.runSession(
  driver,
  browser.validateActions([
    { action: "goto", url: "https://x" },
    { action: "screenshot", name: "../../escape attempt" },
    { action: "screenshot" },
  ]),
  saveShot,
  noLogs()
);

check("both screenshots were saved", saved.length === 2);
check(
  "a path-traversing name is neutralised",
  !saved[0].name.includes("..") && !saved[0].name.includes("/"),
  saved[0].name
);
check("an unnamed shot still gets a name", saved[1].name.endsWith(".png"), saved[1].name);
check("real bytes are written, not a string", saved[0].bytes === 7);
check(
  "the model is told how to look at it",
  result.results[1].detail.includes("view_image"),
  "a screenshot it does not know it can open is useless"
);
check(
  "they are stored inside the agent's own folder",
  result.screenshots[0].startsWith(".agent-browser/"),
  result.screenshots[0]
);

// ---------------------------------------------------------------------------
console.log("\n6. The console and failed requests come back");

({ driver } = makeDriver());
result = await browser.runSession(
  driver,
  browser.validateActions([{ action: "goto", url: "https://x" }]),
  saveShot,
  {
    console: ["[error] Uncaught TypeError: x is not a function"],
    failedRequests: ["404 https://x/app.js"],
  }
);
const text = browser.formatSession(result);
check("console errors are surfaced", /Uncaught TypeError/.test(text));
check("failed requests are surfaced", /404 https:\/\/x\/app\.js/.test(text));
check(
  "this is what makes self-checking possible",
  /Browser console/.test(text),
  "a page that renders but is broken says so in the console"
);

// ---------------------------------------------------------------------------
console.log("\n7. The output puts selectors above the prose");

check(
  "selectors are listed before the page text",
  text.indexOf("Selectors on the rendered page") < text.indexOf("Visible text"),
  "thousands of words of prose would otherwise bury them"
);
check("and the model is told not to guess", /do not guess/.test(text));

// ---------------------------------------------------------------------------
console.log("\n8. Wiring");

const names = WORKSPACE_TOOLS.map((t) => t.function.name);
check("browse is registered", names.includes("browse"));

const schema = JSON.stringify(WORKSPACE_TOOLS.find((t) => t.function.name === "browse"));
check(
  "its description says when to prefer it",
  /empty shell/.test(schema),
  "otherwise the model keeps reaching for fetch_url on app sites"
);
check("it mentions checking your own work", /your own work/.test(schema));

const { readFile } = await import("node:fs/promises");
const route = (await readFile(path.join(ROOT, "src/app/api/chat/route.ts"), "utf8")).replace(/\r\n/g, "\n");
check(
  "it is withheld when the browser is not installed",
  /name === "browse"\) return hasBrowser/.test(route),
  "offering an unavailable tool buys an error and an apology"
);

const adapter = (await readFile(
  path.join(ROOT, "src/lib/browser-playwright.ts"),
  "utf8"
)).replace(/\r\n/g, "\n");
check(
  "the adapter launches headless",
  /headless: true/.test(adapter),
  "a visible window would steal focus from the user"
);
check(
  "and uses the agent's own profile, never the user's",
  /AGENT_PROFILE_DIR/.test(adapter)
);
check(
  "playwright is optional, so the app runs without it",
  !/from "playwright/.test(adapter) && /loadPlaywright/.test(adapter)
);
check(
  "a missing browser explains how to install it",
  /browser:install/.test(adapter)
);

const pkg = JSON.parse((await readFile(path.join(ROOT, "package.json"), "utf8")).replace(/\r\n/g, "\n"));
check(
  "chromium is not forced on everyone at npm install",
  !pkg.dependencies?.["playwright-core"] && !pkg.dependencies?.playwright,
  "150MB for a feature most runs never use"
);
check("there is a one-command installer", Boolean(pkg.scripts["browser:install"]));

console.log(
  `\n${pass + fail} checks · ${pass} passed${fail ? ` · ${r(`${fail} failed`)}` : ""}\n`
);
process.exit(fail ? 1 : 0);

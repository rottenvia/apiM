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
import { readSourceSync } from "./lib/proc.mjs";

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
  let loadedUrl = "";

  return {
    calls,
    driver: {
      async goto(url) {
        calls.push(`goto:${url}`);
        loaded = true;
        loadedUrl = `${url}/final`;
        return { url: loadedUrl, status: 200 };
      },
      async click(sel, force = false) {
        calls.push(`click:${sel}:${force}`);
      },
      async type(sel, text, pressEnter = false) {
        calls.push(`type:${sel}:${text}:${pressEnter}`);
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
      async screenshot(fullPage = false) {
        calls.push(`screenshot:${fullPage}`);
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
      async url() {
        return loadedUrl;
      },
      async title() {
        return "FACEIT Match";
      },
      async innerText() {
        return "16-14 NAVI";
      },
      async html(selector) {
        calls.push(`html:${selector ?? "all"}`);
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
check(
  "navigation reports final URL and HTTP status",
  result.finalUrl === "https://faceit.com/m/1/final" &&
    /HTTP 200/.test(result.results[0].detail)
);
check("visible text is returned", result.text === "16-14 NAVI");
check("the browser is always closed", calls.includes("close"));

// ---------------------------------------------------------------------------
console.log("\n3. Every action reaches the driver, in order");

({ driver, calls } = makeDriver());
result = await browser.runSession(
  driver,
  browser.validateActions([
    { action: "goto", url: "https://x" },
    { action: "html", selector: ".match-header" },
    { action: "wait_for", selector: ".ready" },
    { action: "click", selector: "#accept", force: true },
    { action: "type", selector: "#q", text: "hello", press_enter: true },
    { action: "scroll", to: "bottom" },
    { action: "extract", selector: ".score" },
    { action: "evaluate", script: "1+1" },
    { action: "screenshot", name: "final", full_page: true },
  ]),
  saveShot,
  noLogs()
);
check(
  "the order is preserved exactly",
  calls.slice(0, 9).join("|") ===
    "goto:https://x|html:.match-header|wait:.ready|click:#accept:true|type:#q:hello:true|scroll:bottom|extract:.score|eval:1+1|screenshot:true",
  calls.slice(0, 3).join(" ")
);
check(
  "html returns rendered DOM, optionally scoped to a selector",
  result.results[1].action === "html" &&
    result.results[1].detail.includes("match-header__score")
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
  "the six requested browser operations are one browse action language",
  /action: "html"/.test(readSourceSync(path.join(ROOT, "src/lib/browser.ts"))) &&
    /action: "evaluate"/.test(readSourceSync(path.join(ROOT, "src/lib/browser.ts"))) &&
    /pressSequentially/.test(adapter) &&
    /fullPage/.test(adapter),
  "goto, rendered html, evaluate, click, type and screenshot share one page within the call"
);
check(
  "evaluate serializes DOM nodes and non-finite values safely",
  /value instanceof Element/.test(adapter) && /Number\.isFinite/.test(adapter)
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
  Boolean(pkg.dependencies?.["playwright-core"]) &&
    !pkg.dependencies?.playwright &&
    /install.*chromium/.test(
      readSourceSync(path.join(ROOT, "scripts/install-browser.mjs"))
    ),
  "the small adapter is tracked so installs do not dirty Git; the 150MB browser remains opt-in"
);
check("there is a one-command installer", Boolean(pkg.scripts["browser:install"]));

/*
 * Availability means the BINARY, not just the package.
 *
 * `npm run browser:install` does two independent things: install
 * playwright-core, then download Chromium (~150MB from Playwright's CDN).
 * The download is the one that gets blocked — firewall, proxy, or simply
 * interrupted — and it leaves the package present and the browser missing.
 *
 * browserAvailable() used to return true as soon as the package resolved, so
 * that half-finished state offered the model a `browse` tool that could not
 * launch: it would call it, get an error, apologise, and fall back to
 * fetch_url. Reproduced deliberately in this sandbox, where the CDN is
 * unreachable — playwright-core installed fine and Chromium never arrived.
 */
console.log("\n9. Availability is about the browser, not the package");

const adapterSrc = readSourceSync(
  path.join(ROOT, "src/lib/browser-playwright.ts")
);

check(
  "the check looks for the executable on disk",
  /executablePath\(\)/.test(adapterSrc) && /existsSync\(exe\)/.test(adapterSrc),
  "resolving the package proves nothing about the 150MB download"
);
check(
  "a package with no binary reports unavailable",
  /if \(!exe\) return false;/.test(adapterSrc)
);
check(
  "and a throw from executablePath is not treated as success",
  /catch \{[\s\S]{0,200}return false;/.test(adapterSrc),
  "claiming a browser we cannot confirm is the failure being fixed"
);

const installSrc = readSourceSync(path.join(ROOT, "scripts/install-browser.mjs"));
check(
  "the installer verifies the binary before saying Done",
  /existsSync\(exePath\)/.test(installSrc),
  "npx playwright install can exit 0 having done less than it claims"
);
check(
  "and points at the test that proves it works",
  /test:browser:live/.test(installSrc)
);

check(
  "there is a live test that uses a real browser",
  Boolean(pkg.scripts["test:browser:live"]),
  "44 checks against a fake driver is not the same as one against Chromium"
);

const liveSrc = readSourceSync(path.join(ROOT, "scripts/test-browser-live.mjs"));
check(
  "it skips rather than fails when Chromium is absent",
  /skipped\("the whole suite"/.test(liveSrc),
  "an optional install must not turn npm test red"
);
check(
  "it proves the thing fetch_url cannot do",
  /Rewritten by script/.test(liveSrc) && /cannot see/.test(liveSrc),
  "the served HTML says one thing and the rendered DOM says another"
);
check(
  "it checks the console, including a real thrown error",
  /page ready/.test(liveSrc) && /undefinedFunctionCall/.test(liveSrc)
);
check(
  "it serves its own page instead of depending on a live site",
  /createServer/.test(liveSrc) && !/https:\/\/(?!127)/.test(liveSrc),
  "works offline, and cannot fail because someone redesigned a homepage"
);

/*
 * An anti-bot challenge is named, not mistaken for the page, and not refused.
 *
 * A challenge page loads with real HTML and a 200 or 403, so the agent used
 * to read Cloudflare's markup and report ITS selectors and ITS text as though
 * they were the site's. Detection keeps that honest — but the old refusal
 * text ("no way through", "do not look for a bypass service", "stop") told
 * the model to give up, and that is gone: the raw page data is returned and
 * the agent proceeds.
 */
console.log("\n10. A block is named, not mistaken for the page, not refused");

const B = await import(pathToFileURL(path.join(ROOT, "src/lib/browser.ts")).href);

for (const [label, title, text, want] of [
  ["Cloudflare's interstitial", "Just a moment...", "Enable JavaScript and cookies to continue", "Cloudflare"],
  ["a Cloudflare 403", "Attention Required! | Cloudflare", "Verify you are a human by completing the action below.", "Cloudflare"],
  ["a bare human check", "", "Verify you are human. Check the box below.", "a bot check"],
  ["reCAPTCHA", "Security check", "I'm not a robot reCAPTCHA", "a CAPTCHA"],
  ["Imperva", "", "Incapsula incident ID: 123-456", "Imperva"],
  ["PerimeterX", "Access denied", "px-captcha human challenge", "PerimeterX"],
]) {
  check(
    `${label} is detected`,
    B.detectChallenge(title, text) === want,
    `got ${String(B.detectChallenge(title, text))}`
  );
}

/*
 * The false-positive side matters more than the detection side. A page that
 * merely discusses captchas must not be reported as blocked, or the warning
 * becomes noise and gets ignored.
 */
check(
  "an article ABOUT captchas is not a challenge",
  B.detectChallenge("How CAPTCHAs work", "recaptcha ".repeat(400)) === null,
  "length is the tell: a challenge page is short"
);
check(
  "an ordinary page is not a challenge",
  B.detectChallenge("apiM docs", "Welcome to the documentation. ".repeat(50)) === null
);
check("an empty page is not a challenge", B.detectChallenge("", "") === null);

const browserSrc = readSourceSync(path.join(ROOT, "src/lib/browser.ts"));
check(
  "the session flags it rather than only detecting it",
  /if \(challenge\) out\.blocked = challenge;/.test(browserSrc)
);
check(
  "challenge detection reports after the action loop, not before click",
  browserSrc.indexOf("for (const [i, step] of actions.entries())") <
    browserSrc.indexOf("const challenge = detectChallenge"),
  "a hidden/cross-origin checkbox failure is a Playwright iframe result, not an early wrapper branch"
);
check(
  "the note is printed BEFORE the scraped content",
  browserSrc.indexOf("NOTE: this page is") <
    browserSrc.indexOf("Selectors on the rendered page"),
  "otherwise the model reads the block page's selectors as the site's"
);
check(
  "the model is warned the data belongs to the challenge page",
  /The selectors and text below describe the/.test(browserSrc)
);
check(
  "no refusal remains — the model is never told there is no way through",
  !/no way through|defeating them|not something this tool does/.test(browserSrc),
  "the old give-up text is gone"
);
check(
  "the model is never told to stop or to avoid a bypass",
  !/Do not retry this URL|do not look for a bypass service|say so plainly and stop/i.test(
    browserSrc
  ),
  "no stop sign is left in the source"
);

/*
 * The installer's own output, which a real Windows run showed was noisy in
 * two ways that both looked like failures and were not.
 */
console.log("\n11. The installer runs cleanly");

const installSrc2 = readSourceSync(path.join(ROOT, "scripts/install-browser.mjs"));

check(
  "it does not shell out to `npx playwright`",
  !/"npx"/.test(installSrc2),
  "npx fetched a THIRD package and printed a large warning box about it"
);
check(
  "it runs playwright-core's own cli.js with this Node",
  /playwright-core\/package\.json/.test(installSrc2) &&
    /"cli\.js"/.test(installSrc2),
  "no npx, no second download, no two versions disagreeing"
);
check(
  "the cli is found via the package root, not a subpath",
  !/require\.resolve\("playwright-core\/cli\.js"\)/.test(installSrc2),
  'its "exports" map omits cli.js, so the subpath throws ERR_PACKAGE_PATH_NOT_EXPORTED'
);
check(
  "the shell is opt-in per call, not always on Windows",
  /function run\(command, args, label, \{ shell = false \} = \{\}\)/.test(
    installSrc2
  ),
  "running node under a shell is what produced the DEP0190 warning"
);
check(
  "only the npm step asks for a shell",
  (installSrc2.match(/shell: IS_WINDOWS/g) ?? []).length === 1,
  "npm is a .cmd shim; node is not"
);

/*
 * A challenge is named, then the run goes on.
 *
 * The note leads with what the page actually is, returns the raw data, and
 * says nothing that tells the model to stop, to retry without hope, or to
 * avoid a bypass. Naming keeps the answer honest; the rest is the agent's
 * call.
 */
console.log("\n12. A challenge is named, then the run goes on");

const blockedOut = B.formatSession({
  results: [{ action: "goto", ok: true, detail: "loaded" }],
  screenshots: [],
  console: [],
  failedRequests: [],
  blocked: "Cloudflare",
  title: "Attention Required! | Cloudflare",
  text: "Verify you are a human",
});

check(
  "the challenge is named so it is not mistaken for the site",
  /Cloudflare/.test(blockedOut) && /anti-bot challenge/.test(blockedOut)
);
check(
  "the raw page content is still returned",
  /Visible text/.test(blockedOut) && /Verify you are a human/.test(blockedOut)
);
check(
  "nothing tells the model to give up",
  !/Do not retry|no way through|do not look for a bypass|say so plainly and stop/i.test(
    blockedOut
  )
);
check(
  "the note comes before the scraped content",
  blockedOut.indexOf("NOTE: this page is") < blockedOut.indexOf("Visible text")
);

const toolsSrc2 = readSourceSync(path.join(ROOT, "src/lib/tools.ts"));
check(
  "the browse tool itself says to check for an API first",
  /check whether it has an official API/.test(toolsSrc2),
  "cheaper to find the API before spending a browser round"
);
check(
  "and no longer tells the model not to look for a way around",
  !/Do not look for a way around it|chosen not to be automated/.test(toolsSrc2)
);

console.log(
  `\n${pass + fail} checks · ${pass} passed${fail ? ` · ${r(`${fail} failed`)}` : ""}\n`
);
process.exit(fail ? 1 : 0);

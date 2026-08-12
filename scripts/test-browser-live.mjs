/**
 * Does the browser adapter actually work?
 *
 * Run:  npm run test:browser:live
 *
 * `npm run test:browser` has 44 checks and every one of them runs against a
 * FAKE driver. That was the right call — the logic is worth testing and
 * Chromium cannot run in the sandbox this was written in — but it means the
 * thirty-odd lines in `browser-playwright.ts` that talk to a real browser
 * have never executed. Untested code is not working code; it is an
 * assumption.
 *
 * This is the test that removes the assumption. It serves a small page from
 * localhost and drives it with the real adapter: navigate, read the title,
 * pull text out with a selector, click something, watch the DOM change, catch
 * a deliberate console error, and take a screenshot.
 *
 * Local, not the open web, for three reasons: it works offline, it cannot
 * fail because a site changed, and the expected values are known exactly
 * rather than "the page probably still says that".
 *
 * Skips cleanly when Chromium is not installed, so `npm test` stays green on
 * a machine that never ran the install.
 */
import path from "node:path";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { rm, mkdir } from "node:fs/promises";
import { finishSuite } from "./lib/proc.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_ROOT = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.join(ROOT, "data");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const y = (s) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0;
let fail = 0;
let skip = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};
const skipped = (label, why) => {
  console.log(`  ${y("SKIP")}  ${label}${why ? d("  " + why) : ""}`);
  skip++;
};

console.log("\napiM — the browser, for real\n");

const { browserAvailable, launch } = await load("src/lib/browser-playwright.ts");

if (!(await browserAvailable())) {
  /*
   * Not a failure. The browser is an optional install and most people never
   * ask for one — treating its absence as a broken test trains people to
   * ignore red output, which is worse than not running this at all.
   */
  skipped("the whole suite", "Chromium is not installed — run: npm run browser:install");
  console.log(
    d("\n  Nothing was tested. Install the browser and run this again to\n") +
      d("  actually exercise the adapter.\n")
  );
  // The runner's summary format, so a skipped suite reads as "1 skipped"
  // rather than "no summary" — which looks like a crash.
  console.log(
    `\n${pass + fail + skip} checks · ${pass} passed · ${skip} skipped\n`
  );
  await finishSuite(false);
}

/*
 * A page with something to find, something to click, and a deliberate bug.
 *
 * The console error is the point of the third section: reading what a page
 * logged is the one thing fetch_url can never do, and it is the reason to
 * have a browser at all.
 */
const PAGE = `<!doctype html>
<html>
<head><title>apiM browser check</title></head>
<body>
  <h1 id="heading">Original heading</h1>
  <ul>
    <li class="item">alpha</li>
    <li class="item">beta</li>
    <li class="item">gamma</li>
  </ul>
  <button id="go">Reveal</button>
  <p id="hidden" style="display:none">the secret value is 4711</p>
  <script>
    // Only visible to something that runs JavaScript.
    document.getElementById('heading').textContent = 'Rewritten by script';
    document.getElementById('go').addEventListener('click', function () {
      document.getElementById('hidden').style.display = 'block';
      var d = document.createElement('div');
      d.id = 'appeared';
      d.textContent = 'clicked';
      document.body.appendChild(d);
    });
    console.log('page ready');
    // A real error, so the console capture has something true to catch.
    undefinedFunctionCall();
  </script>
</body>
</html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const WS_DIR = path.join(DATA_ROOT, "workspaces", "browserlive");
await rm(WS_DIR, { recursive: true, force: true });
await mkdir(WS_DIR, { recursive: true });

let session;
try {
  console.log("1. It launches");
  const started = Date.now();
  session = await launch(WS_DIR);
  check(
    "a real Chromium starts",
    Boolean(session?.driver),
    `${((Date.now() - started) / 1000).toFixed(1)}s`
  );

  const { driver } = session;

  console.log("\n2. It loads a page and reads it");
  await driver.goto(url);
  check("navigation completes", true, url);

  const title = await driver.title();
  check("the title comes back", title === "apiM browser check", title);

  /*
   * The difference from fetch_url, in one assertion.
   *
   * The HTML says "Original heading". A script rewrites it on load. Anything
   * reading the raw response sees the former; only a real browser sees the
   * latter — which is the entire argument for this tool existing.
   */
  const text = await driver.innerText();
  check(
    "JavaScript has run — this is what fetch_url cannot see",
    text.includes("Rewritten by script") && !text.includes("Original heading"),
    "the served HTML says 'Original heading'"
  );

  const html = await driver.html();
  check(
    "the HTML is the rendered DOM, not the raw response",
    html.includes("Rewritten by script")
  );

  console.log("\n3. Selectors");
  const items = await driver.extract(".item");
  check(
    "extract returns every match, in order",
    items.join(",") === "alpha,beta,gamma",
    items.join(",")
  );

  const missing = await driver.extract(".does-not-exist");
  check(
    "a selector matching nothing returns empty, not an error",
    Array.isArray(missing) && missing.length === 0,
    "the model needs to learn the selector was wrong, not that the tool broke"
  );

  console.log("\n4. Interacting");
  await driver.click("#go");
  await driver.waitForSelector("#appeared", 5000);
  check("a click runs the page's own handler", true);

  const after = await driver.innerText();
  check(
    "the DOM changed as a result",
    after.includes("the secret value is 4711"),
    "hidden until the button was pressed"
  );

  const evaluated = await driver.evaluate("document.querySelectorAll('.item').length");
  check("evaluate returns a real value from the page", evaluated === 3, String(evaluated));

  console.log("\n5. The console — the reason to have a browser at all");
  check(
    "what the page logged was captured",
    session.console.some((line) => line.includes("page ready")),
    session.console[0] ?? "(nothing)"
  );
  check(
    "and so was the error it threw",
    session.console.some((line) => /undefinedFunctionCall|not defined/i.test(line)),
    session.console.find((l) => /not defined/i.test(l)) ?? "(no error seen)"
  );

  console.log("\n6. Screenshot");
  const shot = await driver.screenshot();
  const isPng =
    Buffer.isBuffer(shot) &&
    shot.length > 1000 &&
    shot[0] === 0x89 &&
    shot[1] === 0x50;
  check("a real PNG comes back", isPng, `${(shot?.length ?? 0)} bytes`);

  console.log("\n7. Containment");
  const { existsSync } = await import("node:fs");
  const { AGENT_PROFILE_DIR } = await load("src/lib/browser-policy.ts");
  check(
    "it used its own profile inside the workspace",
    existsSync(path.join(WS_DIR, AGENT_PROFILE_DIR)),
    `${AGENT_PROFILE_DIR}/ — never the user's real browser profile`
  );

  console.log("\n8. Failure paths");
  let threw = false;
  try {
    await driver.waitForSelector("#never-appears", 1200);
  } catch {
    threw = true;
  }
  check(
    "waiting for something that never appears times out",
    threw,
    "rather than hanging until the model gives up"
  );

  let navThrew = false;
  try {
    await driver.goto("http://127.0.0.1:1/nothing");
  } catch {
    navThrew = true;
  }
  check("an unreachable page fails rather than hanging", navThrew);
} catch (error) {
  check(
    "the session ran without an unexpected error",
    false,
    error instanceof Error ? error.message.split("\n")[0] : String(error)
  );
} finally {
  try {
    await session?.driver?.close();
  } catch {
    /* closing a browser that already died is not a failure */
  }
  server.closeAllConnections?.();
  await Promise.race([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  await rm(WS_DIR, { recursive: true, force: true });
}

console.log(
  `\n${pass + fail + skip} checks · ${g(pass + " passed")}` +
    `${fail ? " · " + r(fail + " failed") : ""}` +
    `${skip ? " · " + y(skip + " skipped") : ""}\n`
);
await finishSuite(fail);

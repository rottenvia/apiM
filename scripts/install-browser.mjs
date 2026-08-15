/**
 * Install the browser the agent uses.
 *
 * Run:  npm run browser:install
 *
 * Separate from `npm install` on purpose. Chromium is about 150MB, and most
 * people never ask the agent to look at a page — making everyone download it
 * to enable a feature they may not use is a poor trade. So `playwright-core`
 * is an optional dependency, the `browse` tool is only offered to the model
 * once this has been run, and everything else works exactly the same without
 * it.
 *
 * Two steps, because they fail for different reasons and the messages should
 * say which:
 *   1. install the playwright-core package (needs npm)
 *   2. download the Chromium binary (needs Playwright's CDN)
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");
const IS_WINDOWS = process.platform === "win32";

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (c) => (s) => (COLOR ? `\x1b[${c}m${s}\x1b[0m` : s);
const bold = wrap(1);
const dim = wrap(2);
const green = wrap(32);
const red = wrap(31);

console.log(bold("\nInstalling the agent's browser\n"));

/**
 * Spawn a step, with a shell only where one is genuinely needed.
 *
 * npm is a .cmd shim on Windows and cannot be spawned without a shell. Node
 * itself can, and running `process.execPath` under a shell is what produced
 * the DEP0190 deprecation warning at the end of a real Windows run:
 *
 *   Passing args to a child process with shell option true can lead to
 *   security vulnerabilities, as the arguments are not escaped
 *
 * So the shell is now opt-in per call rather than "always on Windows". Only
 * the npm step asks for it; the Chromium download runs Node directly and
 * needs nothing.
 */
function run(command, args, label, { shell = false } = {}) {
  console.log(dim(`  ${label}…`));
  const res = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell,
  });
  return res.status === 0;
}

const require = createRequire(path.join(ROOT, "package.json"));
let installed = false;
try {
  require.resolve("playwright-core");
  installed = true;
  console.log(dim("  playwright-core is already installed"));
} catch {
  /* fall through to installing it */
}

if (!installed) {
  if (
    !run(
      "npm",
      ["install", "playwright-core@1.62.1", "--no-audit", "--no-fund"],
      "downloading playwright-core",
      // npm is a .cmd shim here and cannot be spawned without one.
      { shell: IS_WINDOWS }
    )
  ) {
    console.log(red("\n  Could not install playwright-core."));
    console.log("  Check your internet connection and try again.\n");
    process.exit(1);
  }
}

/*
 * Run playwright-core's OWN cli.js, not `npx playwright`.
 *
 * Reported from a real Windows run: `npx playwright install` printed a large
 * warning box —
 *
 *   WARNING: It looks like you are running 'npx playwright install' without
 *   first installing your project's dependencies.
 *
 * — which is alarming, and looks like the install failed. It had not, but the
 * warning is fair: `npx playwright` is not the package we just installed.
 * `playwright` and `playwright-core` are different packages, so npx went off
 * and fetched a THIRD one into its cache purely to run the downloader. That
 * is a needless download and an opportunity for the two versions to disagree
 * about which Chromium build to fetch.
 *
 * playwright-core ships its own cli.js. Running it with the Node we are
 * already using needs no npx, no shell, and no second package — the same
 * trick nextBin() uses for Next. It also removes the Node 24 deprecation
 * warning about shell arguments, which was the other line of noise in that
 * output.
 */
/*
 * Located from the package root, not via require.resolve("…/cli.js").
 *
 * playwright-core has an "exports" map that does not list cli.js, so asking
 * for the subpath directly throws ERR_PACKAGE_PATH_NOT_EXPORTED. Found by
 * running this, not by reading it. The package.json IS exported, so resolving
 * that and walking to its sibling works on every platform.
 */
const cliPath = path.join(
  path.dirname(require.resolve("playwright-core/package.json")),
  "cli.js"
);
if (
  !run(
    process.execPath,
    [cliPath, "install", "chromium"],
    "downloading Chromium (~150MB, one time)"
  )
) {
  console.log(red("\n  Could not download Chromium."));
  console.log(
    "  The package is installed but the browser binary is missing, so the\n" +
      "  browse tool will report that it is unavailable. This usually means\n" +
      "  the download was blocked — try again on a different network, or set\n" +
      "  PLAYWRIGHT_DOWNLOAD_HOST if you use a mirror.\n"
  );
  process.exit(1);
}

/*
 * Confirm the binary is really there before saying "Done".
 *
 * `npx playwright install` can exit 0 having done less than it claims — a
 * partial download, a cached failure, a mirror that served the wrong thing.
 * Saying "Done" and then having the agent report the browser as unavailable
 * is the worst of both: the setup step lied, and the failure surfaces later
 * somewhere unrelated.
 *
 * This is the same check `browserAvailable()` makes, so what this prints and
 * what the agent sees cannot disagree.
 */
let exePath = null;
try {
  const pw = require("playwright-core");
  exePath = pw.chromium.executablePath();
} catch {
  /* handled below */
}

const { existsSync } = await import("node:fs");
if (!exePath || !existsSync(exePath)) {
  console.log(red("\n  Chromium still is not on disk."));
  console.log(
    "  The command reported success but the binary is missing, so `browse`\n" +
      "  will stay unavailable. Try again, or set PLAYWRIGHT_DOWNLOAD_HOST if\n" +
      "  you are behind a mirror.\n"
  );
  process.exit(1);
}

console.log(green("\n  Done."));
console.log(dim(`  Chromium: ${exePath}`));
console.log(
  "\n  The agent can now open pages in a real browser, take screenshots and\n" +
    "  read the console. It always uses its own profile inside the workspace\n" +
    "  and runs headless — it will never touch the browser you are using.\n"
);
console.log(bold("  Check it worked:") + "  npm run test:browser:live\n");

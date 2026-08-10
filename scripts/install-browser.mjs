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
 * npm is a .cmd shim on Windows and cannot be spawned without a shell, which
 * is the exact bug that made run_command fail there. `shell: true` on Windows
 * only — the arguments here are constants in this file, not model output, so
 * there is nothing to inject.
 */
function run(command, args, label) {
  console.log(dim(`  ${label}…`));
  const res = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: IS_WINDOWS,
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
  if (!run("npm", ["install", "playwright-core@1.62.1", "--no-audit", "--no-fund"], "downloading playwright-core")) {
    console.log(red("\n  Could not install playwright-core."));
    console.log("  Check your internet connection and try again.\n");
    process.exit(1);
  }
}

if (!run("npx", ["playwright", "install", "chromium"], "downloading Chromium (~150MB, one time)")) {
  console.log(red("\n  Could not download Chromium."));
  console.log(
    "  The package is installed but the browser binary is missing, so the\n" +
      "  browse tool will report that it is unavailable. This usually means\n" +
      "  the download was blocked — try again on a different network, or set\n" +
      "  PLAYWRIGHT_DOWNLOAD_HOST if you use a mirror.\n"
  );
  process.exit(1);
}

console.log(green("\n  Done."));
console.log(
  "  The agent can now open pages in a real browser, take screenshots and\n" +
    "  read the console. It always uses its own profile inside the workspace\n" +
    "  and runs headless — it will never touch the browser you are using.\n"
);

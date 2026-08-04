/**
 * Starts the app pointed at the fake DeepSeek, for hand-testing the workspace.
 *
 * Run:  npm run dev:mock
 *
 * Exists because `DEEPSEEK_BASE_URL=... next dev` is Unix shell syntax that
 * Windows cmd does not understand — it reports "'DEEPSEEK_BASE_URL' is not
 * recognized". Setting the variable in Node works everywhere.
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { nextBin } from "./lib/proc.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const MOCK_PORT = process.env.MOCK_PORT ?? "8820";

console.log(
  `[dev:mock] app will call the fake DeepSeek at http://127.0.0.1:${MOCK_PORT}`
);
console.log(`[dev:mock] start it in another terminal with: npm run mock:deepseek\n`);

// Run Next's JS entry point directly: `npx` is a .cmd shim on Windows and
// cannot be spawned without a shell.
const child = spawn(
  process.execPath,
  [nextBin(ROOT), "dev", ...process.argv.slice(2)],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    },
  }
);

child.on("exit", (code) => process.exit(code ?? 0));

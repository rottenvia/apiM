/**
 * Boots `next dev` on port 3211 wired to scripts/mock-gap.mjs, with
 * APIM_DATA_ROOT pointed at the bench archive — the launch-dev.mjs pattern
 * plus the DEEPSEEK_BASE_URL wiring from dev-mock.mjs, so the waiting-state
 * UI can be screenshotted against a provider that holds a real silent gap.
 *
 * Start the gap mock first: MOCK_GAP_PORT=8826 node scripts/mock-gap.mjs
 * Then:                     node bench/launch-dev-gap.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(ROOT, "package.json"));
const nextBin = require.resolve("next/dist/bin/next");

const child = spawn(
  process.execPath,
  [nextBin, "dev", "-p", "3211"],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      APIM_DATA_ROOT: path.join(ROOT, ".bench-data"),
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${process.env.MOCK_GAP_PORT ?? 8826}`,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  }
);

child.on("exit", (code) => process.exitCode = code ?? 0);

/**
 * Boots `next dev` on port 3211 with APIM_DATA_ROOT pointed at the bench
 * archive, so measurement never touches the real data/ directory.
 *
 * Spawned via process.execPath on Next's plain .js bin — no npx/.cmd on Windows.
 *
 * Usage: node bench/launch-dev.mjs
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
      NEXT_TELEMETRY_DISABLED: "1",
    },
  }
);

child.on("exit", (code) => process.exitCode = code ?? 0);

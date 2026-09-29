// Hidden grader for ts-inventory-feature. cwd = copy of the agent's workspace.
// The .ts sources must load with plain type stripping, so the real checks
// run in a child `node --experimental-strip-types` process.
import path from "node:path";
import { spawnSync } from "node:child_process";

const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", path.join(".bench_check", "run.mjs")], {
  encoding: "utf8",
  timeout: 25_000,
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
});
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
if (out) console.log(out);
if (r.error) console.log(`FAIL could not run checks: ${r.error.message}`);
if (!/SCORE \d+\/\d+/.test(out)) console.log("SCORE 0/1");
process.exit(r.status === 0 ? 0 : 1);

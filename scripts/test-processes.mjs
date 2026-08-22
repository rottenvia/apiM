/**
 * Checks long-running processes start, report, and always stop.
 *
 * Run:  npm run test:processes
 *
 * A leaked process holds a port and is invisible — the user would have to
 * find it in Task Manager. Most of these checks are about it stopping.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  rm,
  writeFile as fsWrite,
  mkdir,
  readFile,
} from "node:fs/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
/*
 * Where this suite keeps its files.
 *
 * Several suites clear `data/` to start from a known state, which is correct
 * alone and destructive in parallel — they delete each other's fixtures. The
 * runner gives each suite its own directory through APIM_DATA_ROOT, and the
 * app reads the same variable, so the code under test and the test agree.
 */
const DATA_ROOT = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.join(ROOT, "data");
const P = await import(pathToFileURL(path.join(ROOT, "src/lib/processes.ts")).href);
const { runTool } = await import(pathToFileURL(path.join(ROOT, "src/lib/tools.ts")).href);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WS = "proctest";
const DIR = path.join(DATA_ROOT, "workspaces", WS);
await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });

/*
 * Fixtures in Node, not Python.
 *
 * This suite tests process MANAGEMENT — starting, reading, stopping — and
 * the language of the child is irrelevant to any of it. Using Python meant
 * every check failed on a Windows machine without it ("Failed to start:
 * python3 server.py"), reporting a broken process manager when the process
 * manager was fine.
 *
 * Node is guaranteed present: it is running this file.
 */
// A stand-in for a dev server: prints, then stays alive forever.
await fsWrite(path.join(DIR, "server.js"),
  "console.log('listening on port 1234');\nsetInterval(() => {}, 200);\n");
// Something that fails instantly, like a port already in use.
await fsWrite(path.join(DIR, "broken.js"),
  "console.error('cannot bind: address in use');\nprocess.exit(1);\n");
// Something noisy, to test log capping.
await fsWrite(path.join(DIR, "noisy.js"),
  "for (let i = 0; i < 200000; i++) console.log('x'.repeat(100));\nsetTimeout(() => {}, 30000);\n");

console.log("\napiM background process checks\n");

const processSource = await readFile(
  path.join(ROOT, "src/lib/processes.ts"),
  "utf8"
);
check(
  "background and foreground commands share the platform-name resolver",
  /platformCommandName\(check\.command\)/.test(processSource),
  "run_command mapped python3 on Windows while start_process hit the Store shim"
);
check(
  "Ghidra leftovers can be adopted, listed and killed",
  /export function adoptProcess/.test(processSource) &&
    /export function listLeftoverDecompilers/.test(processSource) &&
    /export function stopLeftoverDecompilers/.test(processSource)
);
const leftover = await runTool(WS, "stop_process", { id: "leftover" });
check(
  "stop leftover is a real tool path even when nothing is running",
  leftover.ok && /leftover/i.test(leftover.content + leftover.summary)
);

console.log("1. Starting something that keeps running");
let res = await runTool(WS, "start_process", { command: "node", args: ["server.js"] });
check("it starts", res.ok, res.summary);
check("it reports still running", /still running/.test(res.content));
check("early output is captured", /listening on port 1234/.test(res.content));
const idMatch = res.content.match(/id (proc-[\w-]+)/);
const id = idMatch?.[1];
check("an id is returned", Boolean(id), id ?? "none");

console.log("\n2. Reading its output later");
res = await runTool(WS, "read_process", { id });
check("output is readable after the fact", /listening on port 1234/.test(res.content));
check("it is reported as running", /running/.test(res.content));

console.log("\n3. A process that dies immediately is a failure, not a success");
res = await runTool(WS, "start_process", { command: "node", args: ["broken.js"] });
check("reported as failed", !res.ok, res.summary);
check("the reason is included", /address in use/.test(res.content));
check("it does not claim to be running", !/still running/.test(res.content));

console.log("\n4. Stopping");
res = await runTool(WS, "stop_process", { id });
check("stop succeeds", res.ok, res.summary);
await sleep(500);
const proc = P.getProcess(id);
check("the process is actually dead", proc && !P.isRunning(proc));
res = await runTool(WS, "read_process", { id });
check("reading after stop says it stopped", /stopped/.test(res.content));

console.log("\n5. Output can't grow forever");
res = await runTool(WS, "start_process", { command: "node", args: ["noisy.js"] });
const noisyId = res.content.match(/id (proc-[\w-]+)/)?.[1];
await sleep(1500);
const noisy = P.getProcess(noisyId);
check("the log is capped", noisy && noisy.log.length <= P.MAX_LOG_CHARS + 200,
  `${noisy?.log.length} chars`);
check("truncation is flagged", noisy?.truncated === true);
P.stopProcess(noisyId);

console.log("\n6. Limits and isolation");
const ids = [];
for (let i = 0; i < P.MAX_PROCESSES_PER_WORKSPACE + 2; i++) {
  const r2 = await runTool(WS, "start_process", { command: "node", args: ["server.js"] });
  const m = r2.content.match(/id (proc-[\w-]+)/);
  if (m) ids.push(m[1]);
  if (!r2.ok && /limit/.test(r2.content)) break;
}
const running = P.listProcesses(WS).filter(P.isRunning).length;
check("the per-workspace limit is enforced",
  running <= P.MAX_PROCESSES_PER_WORKSPACE, `${running} running`);

res = await runTool("proctest-other", "read_process", { id });
check("another workspace can't read this one's process", !res.ok);
res = await runTool("proctest-other", "stop_process", { id });
check("another workspace can't stop it either", !res.ok);

console.log("\n7. Stop everything");
res = await runTool(WS, "stop_process", { id: "all" });
await sleep(500);
const stillAlive = P.listProcesses(WS).filter(P.isRunning).length;
check("nothing is left running", stillAlive === 0, `${stillAlive} alive`);

console.log("\n8. Deleting a chat kills its processes");
await runTool(WS, "start_process", { command: "node", args: ["server.js"] });
const store = await import(pathToFileURL(path.join(ROOT, "src/lib/store.ts")).href);
await store.deleteConversation(WS);
await sleep(500);
const orphans = P.listProcesses(WS).filter(P.isRunning).length;
check("no orphaned process after the chat is gone", orphans === 0, `${orphans} alive`);

console.log("\n9. Shells are still refused");
res = await runTool(WS, "start_process", { command: "bash", args: ["-c", "sleep 100"] });
check("a shell cannot be backgrounded either", !res.ok, res.summary);

// Safety net: never leave anything behind, even if a check above failed.
P.stopAll(WS);
P.stopAll("proctest-other");

console.log("\n" + (fail === 0 ? g(`All ${pass} checks passed.`) : r(`${fail} of ${pass + fail} failed.`)) + "\n");
process.exit(fail === 0 ? 0 : 1);

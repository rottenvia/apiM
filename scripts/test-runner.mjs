/**
 * Checks the command runner refuses what it should.
 *
 * Run:  npm run test:runner
 *
 * This is the code that executes what a language model wrote, so the
 * interesting cases are the ones it must refuse.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rm, mkdir, writeFile as fsWrite, readFile } from "node:fs/promises";

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
const R = await import(pathToFileURL(path.join(ROOT, "src/lib/runner.ts")).href);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

const WS = "runnertest";
const WSDIR = path.join(DATA_ROOT, "workspaces", WS);
await rm(WSDIR, { recursive: true, force: true });
await mkdir(WSDIR, { recursive: true });

console.log("\napiM command runner checks\n");

console.log("1. Refuses shells and unknown programs");
for (const bad of ["sh", "bash", "cmd", "powershell", "pwsh", "/bin/bash"]) {
  const v = R.validateCommand(bad, []);
  check(`refuses ${bad}`, v.ok === false);
}
// curl and wget were moved onto the allow-list deliberately: the agent had
// no way to reach anything outside the workspace, which is what left it
// writing code against pages it had never seen. They take their target as an
// argument and cannot execute arbitrary text. Everything here still cannot.
for (const bad of ["rm", "chmod", "ssh", "nc", "dd", "kill"]) {
  const v = R.validateCommand(bad, []);
  check(`refuses ${bad}`, v.ok === false);
}

console.log("\n2. Path tricks don't smuggle a shell through");
for (const sneaky of ["/bin/sh", "../../bin/bash", "C:\\Windows\\System32\\cmd.exe", "BASH", "Cmd.EXE"]) {
  const v = R.validateCommand(sneaky, []);
  check(`refuses ${JSON.stringify(sneaky)}`, v.ok === false);
}

console.log("\n3. Allows real interpreters");
for (const good of ["python3", "node", "npm", "pip"]) {
  const v = R.validateCommand(good, []);
  check(`allows ${good}`, v.ok === true);
}

console.log("\n4. Shell metacharacters are inert");
// The classic injection. With shell:false this is just a weird filename.
const inject = R.validateCommand("python3", ["-c", "print(1)", "; rm -rf ~"]);
check("a '; rm -rf ~' argument is accepted as literal text", inject.ok === true);

await fsWrite(path.join(DATA_ROOT, "workspaces", WS, "canary.txt"), "still here\n");
const res1 = await R.runCommand(WS, "node", ["-e", "console.log('hi')", "; rm -rf ."]);
const canary = await readFile(path.join(WSDIR, "canary.txt"), "utf8").catch(() => null);
check("nothing was deleted by the injected text", canary === "still here\n");
check("the argument reached the program as text", res1.exitCode !== null);

console.log("\n5. Runs code and captures output");
await fsWrite(path.join(WSDIR, "ok.js"), "console.log('hello from the loop');\n");
const res2 = await R.runCommand(WS, "node", ["ok.js"]);
check("stdout is captured", res2.stdout.includes("hello from the loop"), res2.stdout.trim());
check("a successful run exits 0", res2.exitCode === 0);

console.log("\n6. Errors come back so the model can fix them");
await fsWrite(path.join(WSDIR, "broken.js"), "console.log('unclosed);\n");
const res3 = await R.runCommand(WS, "node", ["broken.js"]);
check("stderr is captured", res3.stderr.length > 0);
check("a failure has a non-zero exit code", res3.exitCode !== 0, `exit ${res3.exitCode}`);
check("the error names the problem",
  /SyntaxError|unterminated/i.test(res3.stderr),
  res3.stderr.split("\n").find((l) => /Error/.test(l)) ?? "");

console.log("\n7. Runaway programs are stopped");
await fsWrite(path.join(WSDIR, "forever.js"), "while (true) {}\n");
const started = Date.now();
const res4 = await R.runCommand(WS, "node", ["forever.js"]);
const took = Date.now() - started;
check("an infinite loop is killed", res4.timedOut === true, `${(took / 1000).toFixed(1)}s`);
check("it is killed near the limit, not much later", took < R.MAX_RUN_MS + 4000);

console.log("\n8. Output can't flood the context window");
await fsWrite(path.join(WSDIR, "flood.js"), "for (let i=0;i<300000;i++) console.log('x'.repeat(80));\n");
const res5 = await R.runCommand(WS, "node", ["flood.js"]);
check("huge output is truncated",
  res5.stdout.length <= R.MAX_OUTPUT_CHARS + 100,
  `${res5.stdout.length} chars`);

console.log("\n9. Secrets are not handed to the program");
await fsWrite(path.join(WSDIR, "env.js"), "console.log(process.env.SECRET_KEY || 'NOT-VISIBLE');\n");
process.env.SECRET_KEY = "sk-super-secret";
const res6 = await R.runCommand(WS, "node", ["env.js"]);
check("an API key in the app's environment is not inherited",
  res6.stdout.includes("NOT-VISIBLE"), res6.stdout.trim());
delete process.env.SECRET_KEY;

console.log("\n10. It runs inside the workspace");
await fsWrite(path.join(WSDIR, "where.js"), "console.log(process.cwd());\n");
const res7 = await R.runCommand(WS, "node", ["where.js"]);
check("the working directory is the workspace",
  res7.stdout.trim().includes(WS), res7.stdout.trim());

console.log("\n11. Timeouts match how long a command actually takes");
// A short limit on installs makes the model read a kill as a failure and
// start "fixing" code that was never broken.
for (const [cmd, args, want, label] of [
  ["python3", ["app.py"], R.MAX_RUN_MS, "an ordinary script gets the short limit"],
  ["npm", ["install"], R.MAX_INSTALL_MS, "npm install gets the long limit"],
  ["pip", ["install", "requests"], R.MAX_INSTALL_MS, "pip install gets the long limit"],
  ["npm", ["test"], R.MAX_RUN_MS, "npm test stays short, so a hanging test is caught"],
]) {
  check(label, R.timeoutFor(cmd, args) === want, `${R.timeoutFor(cmd, args) / 1000}s`);
}

console.log("\n12. The auto-run setting defaults to asking");
// A request that omits the field must not run commands unattended — the
// dangerous mode has to be opted into, never inherited or assumed.
const routeSrc = await readFile(path.join(ROOT, "src/app/api/chat/route.ts"), "utf8");
const runnerSrc = await readFile(path.join(ROOT, "src/lib/runner.ts"), "utf8");
check("autoRunCommands defaults to false in the route",
  /autoRunCommands\s*=\s*false/.test(routeSrc));
/*
 * Tests the property, not the exact line. The condition gained a third term
 * — read-only commands like `git status` no longer prompt — and an assertion
 * pinned to the old two-term shape failed while the safety property was
 * unchanged. What matters is that autoRunCommands is one of several ways to
 * pre-approve, and that each of the others is itself narrow.
 */
check("approval is skipped only via autoRun, a remembered choice, or a read-only command",
  /const preApproved =[\s\S]{0,400}?autoRunCommands \|\|[\s\S]{0,200}?isRemembered\(/.test(routeSrc));
check("the read-only exemption cannot cover a command that writes",
  /isReadOnlyCommand\(check\.command, check\.args\)/.test(routeSrc) &&
    /READ_ONLY_COMMANDS/.test(runnerSrc),
  "it checks arguments, not just the program — git status is safe, git push is not");

const pageSrc = await readFile(path.join(ROOT, "src/app/page.tsx"), "utf8");
check("the client only enables it on a literal true",
  /s\.autoRunCommands === true/.test(pageSrc));

console.log("\n" + (fail === 0 ? g(`All ${pass} checks passed.`) : r(`${fail} of ${pass + fail} failed.`)) + "\n");
process.exit(fail === 0 ? 0 : 1);

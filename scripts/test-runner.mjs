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
const WSDIR = path.join(ROOT, "data", "workspaces", WS);
await rm(WSDIR, { recursive: true, force: true });
await mkdir(WSDIR, { recursive: true });

console.log("\napiM command runner checks\n");

console.log("1. Refuses shells and unknown programs");
for (const bad of ["sh", "bash", "cmd", "powershell", "pwsh", "/bin/bash"]) {
  const v = R.validateCommand(bad, []);
  check(`refuses ${bad}`, v.ok === false);
}
for (const bad of ["rm", "curl", "wget", "chmod", "ssh", "nc"]) {
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

await fsWrite(path.join(ROOT, "data", "workspaces", WS, "canary.txt"), "still here\n");
const res1 = await R.runCommand(WS, "python3", ["-c", "print('hi')", "; rm -rf ."]);
const canary = await readFile(path.join(WSDIR, "canary.txt"), "utf8").catch(() => null);
check("nothing was deleted by the injected text", canary === "still here\n");
check("the argument reached the program as text", res1.exitCode !== null);

console.log("\n5. Runs code and captures output");
await fsWrite(path.join(WSDIR, "ok.py"), "print('hello from the loop')\n");
const res2 = await R.runCommand(WS, "python3", ["ok.py"]);
check("stdout is captured", res2.stdout.includes("hello from the loop"), res2.stdout.trim());
check("a successful run exits 0", res2.exitCode === 0);

console.log("\n6. Errors come back so the model can fix them");
await fsWrite(path.join(WSDIR, "broken.py"), "print('unclosed\n");
const res3 = await R.runCommand(WS, "python3", ["broken.py"]);
check("stderr is captured", res3.stderr.length > 0);
check("a failure has a non-zero exit code", res3.exitCode !== 0, `exit ${res3.exitCode}`);
check("the error names the problem",
  /SyntaxError|unterminated/i.test(res3.stderr),
  res3.stderr.split("\n").find((l) => /Error/.test(l)) ?? "");

console.log("\n7. Runaway programs are stopped");
await fsWrite(path.join(WSDIR, "forever.py"), "while True:\n    pass\n");
const started = Date.now();
const res4 = await R.runCommand(WS, "python3", ["forever.py"]);
const took = Date.now() - started;
check("an infinite loop is killed", res4.timedOut === true, `${(took / 1000).toFixed(1)}s`);
check("it is killed near the limit, not much later", took < R.MAX_RUN_MS + 4000);

console.log("\n8. Output can't flood the context window");
await fsWrite(path.join(WSDIR, "flood.py"), "for i in range(300000):\n    print('x' * 80)\n");
const res5 = await R.runCommand(WS, "python3", ["flood.py"]);
check("huge output is truncated",
  res5.stdout.length <= R.MAX_OUTPUT_CHARS + 100,
  `${res5.stdout.length} chars`);

console.log("\n9. Secrets are not handed to the program");
await fsWrite(path.join(WSDIR, "env.py"), "import os\nprint(os.environ.get('SECRET_KEY', 'NOT-VISIBLE'))\n");
process.env.SECRET_KEY = "sk-super-secret";
const res6 = await R.runCommand(WS, "python3", ["env.py"]);
check("an API key in the app's environment is not inherited",
  res6.stdout.includes("NOT-VISIBLE"), res6.stdout.trim());
delete process.env.SECRET_KEY;

console.log("\n10. It runs inside the workspace");
await fsWrite(path.join(WSDIR, "where.py"), "import os\nprint(os.getcwd())\n");
const res7 = await R.runCommand(WS, "python3", ["where.py"]);
check("the working directory is the workspace",
  res7.stdout.trim().includes(WS), res7.stdout.trim());

console.log("\n" + (fail === 0 ? g(`All ${pass} checks passed.`) : r(`${fail} of ${pass + fail} failed.`)) + "\n");
process.exit(fail === 0 ? 0 : 1);

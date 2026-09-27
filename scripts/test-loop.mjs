/**
 * The agent loop against a flaky, slow endpoint — replayed for free.
 *
 * Every bug in this suite was first found by paying for live runs on
 * DeepSeek V4.1 Flash (Morph, max effort) and reading the logs; the unit
 * suites pinned the code's text and passed straight through each one. Here
 * the real route runs against scripts/mock-loop.mjs, which misbehaves the
 * way the endpoint did, and the checks read what the app SENT next — was
 * thinking on or off, what did it carry back — because that is where each
 * bug was visible:
 *
 *   - a think drafting a whole program is cut over, the next round writes
 *     without thinking, and the round after thinks again;
 *   - a connection drop mid-think is retried WITH thinking (it used to turn
 *     thinking off for the rest of the run) and carries the partial think;
 *   - a drop in the no-thinking round keeps the retry thought-less (it used
 *     to go back to a full think, which drafted and was cut again);
 *   - an answer cut by the output limit continues without thinking for one
 *     round only;
 *   - an edit with no path lands in the one file containing its text.
 */
import path from "node:path";
import { rm, readFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import {
  nextBin,
  findFreePort,
  killTree,
  spawnTracked,
  waitForServer,
  finishSuite,
} from "./lib/proc.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_ROOT = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.join(ROOT, ".test-data", "loop");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (c) => (s) => (COLOR ? `\x1b[${c}m${s}\x1b[0m` : s);
const bold = wrap(1);
const dim = wrap(2);
const green = wrap(32);
const red = wrap(31);

let pass = 0,
  fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? green("PASS") : red("FAIL")}  ${label}${detail ? dim("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

const children = [];
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const c of children) killTree(c);
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

function start(label, cmd, args, env) {
  const child = spawnTracked(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
  children.push(child);
  const echo = (d) => {
    if (process.env.VERBOSE) process.stdout.write(dim(`[${label}] ${d}`));
  };
  child.stdout.on("data", echo);
  child.stderr.on("data", echo);
  return child;
}

const LOG = path.join(os.tmpdir(), `apim-mock-loop-${process.pid}.jsonl`);

/** Requests the app sent for one scenario, in order. */
function requestsFor(scenario) {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.scenario === scenario);
}

const text = (m) =>
  typeof m?.content === "string"
    ? m.content
    : Array.isArray(m?.content)
      ? m.content.map((p) => p.text ?? "").join(" ")
      : "";

async function runScenario(appPort, scenario) {
  const workspaceId = `loop-${scenario}`;
  await rm(path.join(DATA_ROOT, "workspaces", workspaceId), { recursive: true, force: true });
  const res = await fetch(`http://127.0.0.1:${appPort}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      message: `Do the task [scenario:${scenario}]`,
      model: "deepseek-v4-flash",
      deepseekApiKey: "sk-mock",
      workspaceEnabled: true,
      workspaceId,
      webSearchMode: "off",
      thinkingEffort: "high",
      autoRunCommands: true,
    }),
  });
  const frames = [];
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        frames.push(JSON.parse(line.slice(6)));
      } catch {
        /* ignore */
      }
    }
  }
  const ws = (f) => path.join(DATA_ROOT, "workspaces", workspaceId, f);
  return {
    frames,
    requests: requestsFor(scenario),
    continuing: frames.filter((f) => f.type === "continuing").map((f) => f.reason),
    toolResults: frames.filter((f) => f.type === "tool_result"),
    done: frames.some((f) => f.type === "done"),
    errors: frames.filter((f) => f.type === "error").map((f) => f.error),
    file: async (f) => (existsSync(ws(f)) ? readFile(ws(f), "utf8") : null),
  };
}

async function main() {
  console.log(bold("\napiM agent loop against a flaky endpoint\n"));
  writeFileSync(LOG, "");

  const mockPort = await findFreePort();
  const mock = start("mock", process.execPath, ["scripts/mock-loop.mjs"], {
    MOCK_PORT: String(mockPort),
    MOCK_LOG: LOG,
  });
  const mockUp = await waitForServer(`http://127.0.0.1:${mockPort}/`, 15_000, () => mock.exitCode !== null);

  const appPort = await findFreePort();
  console.log(dim("  starting the app (first run compiles, ~40s)…\n"));
  const app = start("app", process.execPath, [nextBin(ROOT), "dev", "--port", String(appPort)], {
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${mockPort}`,
    APIM_DATA_ROOT: DATA_ROOT,
  });
  const appUp =
    mockUp &&
    (await waitForServer(`http://127.0.0.1:${appPort}/api/conversations`, 180_000, () => app.exitCode !== null));
  if (!appUp) {
    console.log(red("  the app or the mock did not start — run with VERBOSE=1\n"));
    cleanup();
    process.exit(1);
  }

  // ------------------------------------------------------------------
  console.log(bold("1. A think drafting a whole program is cut over to writing"));
  {
    const r = await runScenario(appPort, "draft_cutover");
    const [first, second, third] = r.requests;
    check("the live think is cut and the run continues", r.continuing.includes("code_draft"), r.continuing.join(", "));
    check("the round after the cut does not think", second?.thinking === "off", `thinking: ${second?.thinking}`);
    check("and it carries the think back verbatim",
      Boolean(second?.messages.some((m) => m.role === "assistant" && /^\[My reasoning so far, verbatim/.test(text(m)))));
    check("the round after that thinks again", third?.thinking === "on", `thinking: ${third?.thinking}`);
    check("the file from the draft is written", (await r.file("app.lua")) === "print('hi')\n");
    check("the reply ends cleanly", r.done && r.errors.length === 0, r.errors.join(" | "));
    void first;
  }

  // ------------------------------------------------------------------
  console.log(bold("\n2. A connection dropped mid-think does not switch thinking off"));
  {
    const r = await runScenario(appPort, "drop_mid_think");
    const [, retry, after] = r.requests;
    check("the drop is retried", r.continuing.includes("connection_cut"), r.continuing.join(", "));
    check("the retry still thinks", retry?.thinking === "on", `thinking: ${retry?.thinking}`);
    check("the partial think is carried, not redone",
      Boolean(retry?.messages.some((m) => m.role === "assistant" && /connection dropped mid-thought/.test(text(m)))));
    check("the model is not told it used the whole output budget",
      !r.requests.some((q) => q.messages.some((m) => /whole output budget/.test(text(m)))));
    check("later rounds think too", after?.thinking === "on", `thinking: ${after?.thinking}`);
    check("the work is done", (await r.file("x.txt")) === "x\n");
  }

  // ------------------------------------------------------------------
  console.log(bold("\n3. A drop in the no-thinking round keeps its retry thought-less"));
  {
    const r = await runScenario(appPort, "drop_after_cutover");
    const t = r.requests.map((q) => q.thinking);
    check("cut-over, then the no-thinking round", r.continuing[0] === "code_draft" && t[1] === "off", t.join(","));
    check("its retry after the drop is still no-thinking", t[2] === "off", t.join(","));
    check("and thinking comes back after it", t[3] === "on", t.join(","));
    check("the file is written", (await r.file("b.lua")) === "return 1\n");
  }

  // ------------------------------------------------------------------
  console.log(bold("\n4. An answer cut by the output limit continues, then thinking returns"));
  {
    const r = await runScenario(appPort, "length_cut");
    const t = r.requests.map((q) => q.thinking);
    check("the cut answer is continued", r.continuing.includes("output_limit"), r.continuing.join(", "));
    check("the continuation does not think", t[1] === "off", t.join(","));
    check("the next round thinks again — one round, not the rest of the run", t[2] === "on", t.join(","));
    check("the work after it is done", (await r.file("c.txt")) === "c\n");
  }

  // ------------------------------------------------------------------
  console.log(bold("\n5. An edit sent without a path"));
  {
    const r = await runScenario(appPort, "pathless_edit");
    check("lands in the one file containing its text", /return 2/.test((await r.file("mod.py")) ?? ""));
    // The model reads the full tool result on its next request.
    const told = r.requests.some((q) => q.messages.some((m) => m.role === "tool" && /no path was given — its old_text occurs only in mod\.py/.test(text(m))));
    check("and the model is told where it went", told);
  }

  // ------------------------------------------------------------------
  console.log(bold("\n6. Other websites cannot drive the local API"));
  {
    const base = `http://127.0.0.1:${appPort}`;
    const body = JSON.stringify({ message: "x", model: "deepseek-v4-flash", deepseekApiKey: "k" });
    const post = (headers, b = body) =>
      fetch(`${base}/api/chat`, { method: "POST", headers, body: b }).then((r) => r.status);
    // The measured exploit: a no-cors text/plain POST from any page.
    check("a cross-site request is refused",
      (await post({ "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" })) === 403);
    check("so is another app on a different localhost port (same-site)",
      (await post({ "Content-Type": "application/json", "Sec-Fetch-Site": "same-site", Origin: "http://localhost:5173" })) === 403);
    check("an Origin that is not this app is refused even without Sec-Fetch-Site",
      (await post({ "Content-Type": "application/json", Origin: "https://evil.example" })) === 403);
    check("a text/plain body is refused",
      (await post({ "Content-Type": "text/plain" })) === 403);
    // fetch() will not send a custom Host header; a raw request will.
    const { request } = await import("node:http");
    const rebound = await new Promise((resolve) => {
      const r = request({ host: "127.0.0.1", port: appPort, path: "/api/conversations", headers: { Host: "evil.example:3000" } },
        (res) => { res.resume(); resolve(res.statusCode); });
      r.on("error", () => resolve(0));
      r.end();
    });
    check("a rebound host name is refused (DNS rebinding)", rebound === 403, `status ${rebound}`);
    check("the app's own requests still work",
      (await fetch(`${base}/api/conversations`, { headers: { "Sec-Fetch-Site": "same-origin" } }).then((r) => r.status)) === 200);
  }

  cleanup();
  for (const s of ["draft_cutover", "drop_mid_think", "drop_after_cutover", "length_cut", "pathless_edit"]) {
    await rm(path.join(DATA_ROOT, "workspaces", `loop-${s}`), { recursive: true, force: true });
  }
  await rm(LOG, { force: true });
  console.log(`\n${pass + fail} checks · ${pass} passed${fail ? ` · ${red(`${fail} failed`)}` : ""}\n`);
  await finishSuite(fail);
}

main().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});

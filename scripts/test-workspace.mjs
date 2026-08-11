/**
 * One-command check of the workspace feature.
 *
 * Run:  npm run test:workspace
 *
 * Starts a fake DeepSeek, points the app at it, asks the app to create a file,
 * and then checks the file really exists on disk. Also tries to break out of
 * the workspace folder and confirms the workspace stays off when it's off.
 *
 * Nothing here touches the real DeepSeek API, so it costs nothing.
 *
 * Runs on Windows, macOS and Linux.
 */
import { rm, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  IS_WINDOWS,
  nextBin,
  findFreePort,
  killTree,
  spawnTracked,
  waitForServer,
} from "./lib/proc.mjs";

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
const WS_ID = "selftest";
const WS_DIR = path.join(DATA_ROOT, "workspaces", WS_ID);

// Colour codes confuse older Windows terminals, so only use them where the
// terminal says it can cope.
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = wrap(32);
const red = wrap(31);
const dim = wrap(2);
const bold = wrap(1);
const tick = COLOR ? "PASS" : "PASS";

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  ${green(tick)}  ${label}${detail ? dim("  " + detail) : ""}`);
  } else {
    failed++;
    console.log(`  ${red("FAIL")}  ${label}${detail ? "  " + detail : ""}`);
  }
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
  const child = spawnTracked(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
  });
  children.push(child);
  const echo = (d) => {
    if (process.env.VERBOSE) process.stdout.write(dim(`[${label}] ${d}`));
  };
  child.stdout.on("data", echo);
  child.stderr.on("data", echo);
  child.on("error", (err) => {
    console.log(red(`\n  Could not start ${label}: ${err.message}\n`));
    cleanup();
    process.exit(1);
  });
  return child;
}

/** Sends a chat request and collects the streamed frames. */
async function chat(appPort, payload) {
  // A hung request must fail loudly rather than freeze the whole test run.
  const res = await fetch(`http://127.0.0.1:${appPort}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      deepseekApiKey: "sk-mock",
      thinkingEffort: "high",
      webSearchMode: "off",
      ...payload,
    }),
  });

  const text = await res.text();
  const frames = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const rest = line.slice(6).trim();
    if (!rest || rest === "[DONE]") continue;
    try {
      frames.push(JSON.parse(rest));
    } catch {
      /* ignore */
    }
  }
  return frames;
}

async function main() {
  console.log(bold("\napiM workspace self-test\n"));

  await rm(WS_DIR, { recursive: true, force: true });
  await mkdir(DATA_ROOT, { recursive: true });

  // Asking the OS for free ports means a leftover server from an earlier run
  // can never be mistaken for ours — the old "tests pass against a stale
  // build" trap.
  const mockPort = await findFreePort();
  const appPort = await findFreePort();

  console.log(
    dim("  starting fake DeepSeek and the app (first run compiles, ~30s)…\n")
  );

  const mock = start("mock", process.execPath, ["scripts/mock-deepseek.mjs"], {
    MOCK_PORT: String(mockPort),
  });

  // Run Next's own JS entry point with this Node, rather than `npx`, which on
  // Windows is a .cmd shim that cannot be spawned without a shell.
  const app = start(
    "app",
    process.execPath,
    [nextBin(ROOT), "dev", "--port", String(appPort)],
    { DEEPSEEK_BASE_URL: `http://127.0.0.1:${mockPort}` }
  );

  const dead = (c) => () => c.exitCode !== null || c.signalCode !== null;

  const mockUp = await waitForServer(
    `http://127.0.0.1:${mockPort}/`,
    20_000,
    dead(mock)
  );
  if (!mockUp) {
    console.log(red("\n  The fake DeepSeek did not start. Run with VERBOSE=1 for details.\n"));
    cleanup();
    process.exit(1);
  }

  const appUp = await waitForServer(
    `http://127.0.0.1:${appPort}/api/conversations`,
    180_000,
    dead(app)
  );
  if (!appUp) {
    const why = dead(app)()
      ? "the app exited during startup"
      : "the app did not respond in time";
    console.log(red(`\n  Could not start the app — ${why}.`));
    console.log(red("  Run with VERBOSE=1 to see the reason.\n"));
    cleanup();
    process.exit(1);
  }

  // ------------------------------------------------------------------
  console.log(bold("1. The AI creates a real file"));
  // ------------------------------------------------------------------
  const frames = await chat(appPort, {
    message: "create hello.py that prints a greeting",
    workspaceEnabled: true,
    workspaceId: WS_ID,
  });

  const toolStarts = frames.filter((f) => f.type === "tool_start");
  const toolResults = frames.filter((f) => f.type === "tool_result");
  const answer = frames
    .filter((f) => f.type === "content")
    .map((f) => f.delta)
    .join("");

  check(
    "the model called a tool",
    toolStarts.length > 0,
    toolStarts.map((t) => t.name).join(" -> ")
  );
  check(
    "write_file ran and succeeded",
    toolResults.some((r) => r.name === "write_file" && r.ok),
    toolResults.find((r) => r.name === "write_file")?.summary ?? ""
  );
  check(
    "read_file ran afterwards (multi-round loop works)",
    toolResults.some((r) => r.name === "read_file" && r.ok)
  );

  const filePath = path.join(WS_DIR, "hello.py");
  const onDisk = existsSync(filePath);
  check(
    "the file exists on disk",
    onDisk,
    onDisk ? path.relative(ROOT, filePath) : ""
  );
  if (onDisk) {
    const body = await readFile(filePath, "utf8");
    check(
      "the file has the right contents",
      body.includes("hello"),
      JSON.stringify(body.trim())
    );
  }

  check(
    "the model gave a final answer",
    answer.trim().length > 0,
    answer.trim().slice(0, 60) + (answer.length > 60 ? "…" : "")
  );

  // ------------------------------------------------------------------
  console.log(bold("\n2. Split-up tool arguments are reassembled"));
  // ------------------------------------------------------------------
  // The mock deliberately cuts the JSON arguments in half mid-string.
  const writeStart = toolStarts.find((t) => t.name === "write_file");
  let parsedArgs = null;
  try {
    parsedArgs = JSON.parse(writeStart?.args ?? "");
  } catch {
    /* ignore */
  }
  check(
    "arguments arrived split and were stitched back together",
    parsedArgs?.path === "hello.py",
    parsedArgs ? `path = ${parsedArgs.path}` : "could not parse arguments"
  );

  // ------------------------------------------------------------------
  console.log(bold("\n3. The AI cannot escape the workspace folder"));
  // ------------------------------------------------------------------
  // Windows needs a file:// URL to import by absolute path.
  const wsUrl = pathToFileURL(path.join(ROOT, "src", "lib", "workspace.ts")).href;
  let resolveInside = null;
  try {
    ({ resolveInside } = await import(wsUrl));
  } catch (err) {
    if (process.env.VERBOSE) console.log(dim("  import failed: " + err.message));
  }

  if (!resolveInside) {
    check(
      "path-safety module loaded",
      false,
      "could not import workspace.ts (needs Node 22.6+ for --experimental-strip-types)"
    );
  } else {
    const attacks = [
      "../../etc/passwd",
      "/etc/passwd",
      "..\\..\\windows\\system32",
      "ok/../../../escape.txt",
      "file\u0000.txt",
      "",
      "C:\\Windows\\System32\\drivers\\etc\\hosts",
    ];
    const leaked = [];
    for (const a of attacks) {
      try {
        const resolved = resolveInside(WS_ID, a);
        // Anything that resolves must still sit inside the workspace.
        if (!path.resolve(resolved).startsWith(path.resolve(WS_DIR))) {
          leaked.push(a);
        }
      } catch {
        /* blocked, which is the point */
      }
    }
    check(
      `all ${attacks.length} escape attempts were blocked`,
      leaked.length === 0,
      leaked.length ? `LEAKED: ${leaked.join(", ")}` : `${attacks.length}/${attacks.length} blocked`
    );
  }

  // ------------------------------------------------------------------
  console.log(bold("\n4. Workspace off really means off"));
  // ------------------------------------------------------------------
  const offDir = path.join(DATA_ROOT, "workspaces", "selftest-off");
  await rm(offDir, { recursive: true, force: true });

  const offFrames = await chat(appPort, {
    message: "create hello.py that prints a greeting",
    workspaceEnabled: false,
    workspaceId: "selftest-off",
  });

  check("no tools were run", !offFrames.some((f) => f.type === "tool_start"));
  check("no files were created", !existsSync(offDir));

  // ------------------------------------------------------------------
  console.log(
    "\n" +
      (failed === 0
        ? green(bold(`All ${passed} checks passed.`))
        : red(bold(`${failed} of ${passed + failed} checks failed.`)))
  );
  console.log(
    dim(`\n  Files the test created live in data${path.sep}workspaces${path.sep}${WS_ID}${path.sep}`) +
      dim("\n  Delete that folder any time — it's not tracked by git.\n")
  );

  cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(red("\nTest crashed: " + (err?.stack || err?.message || err)));
  cleanup();
  process.exit(1);
});

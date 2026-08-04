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
 */
import { spawn } from "node:child_process";
import { rm, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MOCK_PORT = 8821;
const APP_PORT = 3111;
const WS_ID = "selftest";
const WS_DIR = path.join(ROOT, "data", "workspaces", WS_ID);

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  ${green("PASS")}  ${label}${detail ? dim("  " + detail) : ""}`);
  } else {
    failed++;
    console.log(`  ${red("FAIL")}  ${label}${detail ? "  " + detail : ""}`);
  }
};

const children = [];
function start(label, cmd, args, env) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group, so killing it also kills the real server underneath.
    // `next dev` spawns a child of its own that otherwise survives and holds
    // the port, making the *next* run silently talk to a stale build.
    detached: true,
  });
  children.push(child);
  child.stdout.on("data", (d) => {
    if (process.env.VERBOSE) process.stdout.write(dim(`[${label}] ${d}`));
  });
  child.stderr.on("data", (d) => {
    if (process.env.VERBOSE) process.stdout.write(dim(`[${label}] ${d}`));
  });
  return child;
}

function cleanup() {
  for (const c of children) {
    try {
      // Negative pid kills the whole group, not just the wrapper shell.
      process.kill(-c.pid, "SIGKILL");
    } catch {
      try {
        c.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

/** Kills anything left listening on our test ports from an earlier run. */
async function freePorts() {
  for (const port of [MOCK_PORT, APP_PORT]) {
    try {
      const { execSync } = await import("node:child_process");
      const pids = execSync(`lsof -t -i:${port} 2>/dev/null || true`, {
        encoding: "utf8",
      })
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          /* ignore */
        }
      }
      if (pids.length) await new Promise((r) => setTimeout(r, 500));
    } catch {
      /* lsof missing — the EADDRINUSE message below will explain */
    }
  }
}

async function waitForPort(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { method: "GET" });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return false;
}

/** Sends a chat request and collects the streamed frames. */
async function chat(payload) {
  // A hung request must fail loudly rather than freeze the whole test run.
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/chat`, {
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
  await mkdir(path.join(ROOT, "data"), { recursive: true });
  await freePorts();

  console.log(dim("  starting fake DeepSeek and the app (first run compiles, ~30s)…\n"));
  start("mock", process.execPath, ["scripts/mock-deepseek.mjs"], {
    MOCK_PORT: String(MOCK_PORT),
  });
  const app = start("app", "npx", ["next", "dev", "--port", String(APP_PORT)], {
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  });

  const mockUp = await waitForPort(`http://127.0.0.1:${MOCK_PORT}/`, 20_000);
  const appUp = await waitForPort(`http://127.0.0.1:${APP_PORT}/api/conversations`);
  if (!mockUp || !appUp) {
    console.log(red("\n  Could not start the test servers. Run with VERBOSE=1 to see why.\n"));
    process.exit(1);
  }
  // A port answering isn't proof *our* app answered — a leftover server from a
  // previous run would also reply, and then every result below would be a lie.
  if (app.exitCode !== null || app.signalCode !== null) {
    console.log(
      red(
        `\n  The app exited during startup (something else is using port ${APP_PORT}).` +
          "\n  Run with VERBOSE=1 for the reason.\n"
      )
    );
    process.exit(1);
  }

  // ------------------------------------------------------------------
  console.log(bold("1. The AI creates a real file"));
  // ------------------------------------------------------------------
  const frames = await chat({
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

  check("the model called a tool", toolStarts.length > 0,
    toolStarts.map((t) => t.name).join(" → "));
  check("write_file ran and succeeded",
    toolResults.some((r) => r.name === "write_file" && r.ok),
    toolResults.find((r) => r.name === "write_file")?.summary ?? "");
  check("read_file ran afterwards (multi-round loop works)",
    toolResults.some((r) => r.name === "read_file" && r.ok));

  const filePath = path.join(WS_DIR, "hello.py");
  const onDisk = existsSync(filePath);
  check("the file exists on disk", onDisk, onDisk ? filePath.replace(ROOT + "/", "") : "");
  if (onDisk) {
    const body = await readFile(filePath, "utf8");
    check("the file has the right contents", body.includes("hello"), JSON.stringify(body.trim()));
  }

  check("the model gave a final answer", answer.trim().length > 0,
    answer.trim().slice(0, 60) + (answer.length > 60 ? "…" : ""));

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
  check("arguments arrived split and were stitched back together",
    parsedArgs?.path === "hello.py",
    parsedArgs ? `path = ${parsedArgs.path}` : "could not parse arguments");

  // ------------------------------------------------------------------
  console.log(bold("\n3. The AI cannot escape the workspace folder"));
  // ------------------------------------------------------------------
  const { resolveInside } = await import(
    path.join(ROOT, "src", "lib", "workspace.ts")
  ).catch(() => ({ resolveInside: null }));

  if (!resolveInside) {
    // Falls back to running through tsx when a plain import can't read TS.
    check("path-safety module loaded", false, "could not import workspace.ts");
  } else {
    const attacks = [
      "../../etc/passwd",
      "/etc/passwd",
      "..\\..\\windows\\system32",
      "ok/../../../escape.txt",
      "file\u0000.txt",
      "",
    ];
    let blocked = 0;
    for (const a of attacks) {
      try {
        resolveInside(WS_ID, a);
      } catch {
        blocked++;
      }
    }
    check(`all ${attacks.length} escape attempts were blocked`,
      blocked === attacks.length, `${blocked}/${attacks.length} blocked`);
  }

  // ------------------------------------------------------------------
  console.log(bold("\n4. Workspace off really means off"));
  // ------------------------------------------------------------------
  const offDir = path.join(ROOT, "data", "workspaces", "selftest-off");
  await rm(offDir, { recursive: true, force: true });

  const offFrames = await chat({
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
    dim(`\n  Files the test created live in data/workspaces/${WS_ID}/`) +
      dim("\n  Delete that folder any time — it's not tracked by git.\n")
  );

  cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(red("\nTest crashed: " + err.message));
  cleanup();
  process.exit(1);
});

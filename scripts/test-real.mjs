/**
 * Tests the workspace against the REAL DeepSeek API.
 *
 * Run:  npm run test:real
 *
 * Asks for your API key, starts the app itself, sends one real request, and
 * reports whether the model actually used the file tools. Costs well under a
 * cent.
 *
 * This exists because the equivalent curl command is a quoting minefield on
 * Windows. Nothing here needs quotes, escaping or a second terminal.
 */
import { rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { nextBin, findFreePort, killTree, spawnTracked, waitForServer } from "./lib/proc.mjs";

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
const WS_ID = "real-test";
const WS_DIR = path.join(DATA_ROOT, "workspaces", WS_ID);
const KEY_FILE = path.join(DATA_ROOT, ".deepseek-key");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (c) => (s) => (COLOR ? `\x1b[${c}m${s}\x1b[0m` : s);
const green = wrap(32);
const red = wrap(31);
const yellow = wrap(33);
const dim = wrap(2);
const bold = wrap(1);

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

/**
 * Finds the key without making the user paste it every time:
 * an env var, then the file we saved last run, then ask.
 */
async function getKey() {
  if (process.env.DEEPSEEK_API_KEY?.trim()) {
    console.log(dim("  using the key from your DEEPSEEK_API_KEY environment variable\n"));
    return process.env.DEEPSEEK_API_KEY.trim();
  }

  if (existsSync(KEY_FILE)) {
    const saved = (await readFile(KEY_FILE, "utf8")).trim();
    if (saved) {
      console.log(dim(`  using the key you saved last time (${saved.slice(0, 7)}…)`));
      console.log(dim(`  to use a different one, delete data${path.sep}.deepseek-key\n`));
      return saved;
    }
  }

  console.log("  Paste your DeepSeek API key and press Enter.");
  console.log(dim("  It starts with sk- . No quotes needed — just paste it.\n"));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("  key: ")).trim();
  rl.close();

  // Strip quotes in case they pasted it with some, which is an easy mistake.
  const key = answer.replace(/^["']|["']$/g, "").trim();

  if (!key) {
    console.log(red("\n  No key entered. Stopping.\n"));
    process.exit(1);
  }
  if (!key.startsWith("sk-")) {
    console.log(
      yellow(`\n  Warning: that doesn't look like a DeepSeek key (they start with "sk-").`)
    );
    console.log(yellow("  Carrying on anyway — if it's wrong you'll get an auth error.\n"));
  }

  await mkdir(DATA_ROOT, { recursive: true });
  await writeFile(KEY_FILE, key, "utf8");
  console.log(dim(`\n  Saved to data${path.sep}.deepseek-key so you won't be asked again.`));
  console.log(dim("  That folder is ignored by git, so the key never leaves your machine.\n"));

  return key;
}

async function main() {
  console.log(bold("\napiM workspace — REAL DeepSeek test\n"));
  console.log("  This sends ONE real request to DeepSeek using your key.");
  console.log(dim("  Expected cost: well under one cent.\n"));

  const key = await getKey();

  await rm(WS_DIR, { recursive: true, force: true });
  await mkdir(DATA_ROOT, { recursive: true });

  const appPort = await findFreePort();
  console.log(dim("  starting the app (first run compiles, ~30s)…\n"));

  const app = spawnTracked(
    process.execPath,
    [nextBin(ROOT), "dev", "--port", String(appPort)],
    { cwd: ROOT, env: { ...process.env } }
  );
  children.push(app);
  const echo = (d) => {
    if (process.env.VERBOSE) process.stdout.write(dim(`[app] ${d}`));
  };
  app.stdout.on("data", echo);
  app.stderr.on("data", echo);
  app.on("error", (err) => {
    console.log(red(`\n  Could not start the app: ${err.message}\n`));
    cleanup();
    process.exit(1);
  });

  const up = await waitForServer(
    `http://127.0.0.1:${appPort}/api/conversations`,
    180_000,
    () => app.exitCode !== null || app.signalCode !== null
  );
  if (!up) {
    console.log(red("\n  The app didn't start. Run with VERBOSE=1 to see why.\n"));
    cleanup();
    process.exit(1);
  }

  const task = "create fizzbuzz.py that prints fizzbuzz for the numbers 1 to 20";
  console.log(bold("  Asking DeepSeek:"));
  console.log(`  "${task}"\n`);

  const started = Date.now();
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${appPort}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(300_000),
      body: JSON.stringify({
        message: task,
        deepseekApiKey: key,
        workspaceEnabled: true,
        workspaceId: WS_ID,
        thinkingEffort: "high",
        webSearchMode: "off",
      }),
    });
  } catch (err) {
    console.log(red(`\n  The request failed: ${err.message}\n`));
    cleanup();
    process.exit(1);
  }

  if (!res.ok) {
    const text = await res.text();
    console.log(red(`\n  DeepSeek rejected the request (HTTP ${res.status}):`));
    console.log("  " + text.slice(0, 400) + "\n");
    if (res.status === 401) {
      console.log(yellow(`  That usually means the key is wrong.`));
      console.log(yellow(`  Delete data${path.sep}.deepseek-key and run again to re-enter it.\n`));
    }
    cleanup();
    process.exit(1);
  }

  // Stream the frames as they arrive, so you can watch it think and act live.
  const toolCalls = [];
  const toolResults = [];
  let answer = "";
  let usage = null;
  let errorFrame = null;
  let reasoningChars = 0;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const rest = line.slice(6).trim();
      if (!rest || rest === "[DONE]") continue;
      let f;
      try {
        f = JSON.parse(rest);
      } catch {
        continue;
      }

      if (f.type === "reasoning") reasoningChars += (f.delta ?? "").length;
      if (f.type === "content") answer += f.delta ?? "";
      if (f.type === "tool_start") {
        toolCalls.push(f);
        console.log(`  ${dim("→")} calling ${bold(f.name)} ${dim(String(f.args).slice(0, 70))}`);
      }
      if (f.type === "tool_result") {
        toolResults.push(f);
        const mark = f.ok ? green("ok") : red("failed");
        console.log(`  ${dim("←")} ${f.name} ${mark} ${dim(f.summary ?? "")}`);
      }
      if (f.type === "done") usage = f.usage;
      if (f.type === "error") errorFrame = f.error;
    }
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log(bold("\n  Result\n"));

  if (errorFrame) {
    console.log(red(`  The model returned an error: ${errorFrame}\n`));
    // The generic message points at Settings, which is wrong here — the key
    // came from this script, not the app's settings screen.
    if (/key|auth|401|rejected/i.test(errorFrame)) {
      console.log(yellow(`  If the key is wrong, delete this file and run again:`));
      console.log(yellow(`    data${path.sep}.deepseek-key\n`));
    }
    cleanup();
    process.exit(1);
  }

  const usedTools = toolCalls.length > 0;
  const wrote = toolResults.some((r) => r.name === "write_file" && r.ok);
  const filePath = path.join(WS_DIR, "fizzbuzz.py");
  const onDisk = existsSync(filePath);

  console.log(
    `  ${usedTools ? green("YES") : red("NO ")}  the real model used the file tools` +
      (usedTools ? dim(`  (${toolCalls.map((t) => t.name).join(" -> ")})`) : "")
  );
  console.log(`  ${wrote ? green("YES") : red("NO ")}  it successfully wrote a file`);
  console.log(
    `  ${onDisk ? green("YES") : red("NO ")}  fizzbuzz.py is on your disk` +
      (onDisk ? dim(`  (${path.relative(ROOT, filePath)})`) : "")
  );
  console.log(`  ${dim("time:")} ${seconds}s   ${dim("rounds:")} ${toolCalls.length}`);

  if (usage) {
    const inTok = usage.prompt_tokens ?? 0;
    const outTok = usage.completion_tokens ?? 0;
    // deepseek-v4-pro: $0.435 per 1M in, $0.87 per 1M out.
    const cost = (inTok / 1e6) * 0.435 + (outTok / 1e6) * 0.87;
    console.log(
      `  ${dim("tokens:")} ${inTok} in, ${outTok} out   ${dim("cost:")} about $${cost.toFixed(5)}`
    );
  }

  if (onDisk) {
    const body = await readFile(filePath, "utf8");
    console.log(bold("\n  What it wrote:\n"));
    for (const line of body.split("\n").slice(0, 25)) {
      console.log("    " + line);
    }
  }

  if (answer.trim()) {
    console.log(bold("\n  What it said:\n"));
    console.log("    " + answer.trim().slice(0, 400).replace(/\n/g, "\n    "));
  }

  console.log("");
  if (usedTools && wrote && onDisk) {
    console.log(green(bold("  It works with the real model.")));
    console.log(dim("  The workspace is ready for a UI.\n"));
  } else if (!usedTools) {
    console.log(yellow(bold("  The real model chose NOT to use the tools.")));
    console.log(
      dim("  It probably printed code in the chat instead. The tool descriptions\n") +
        dim("  need work — this is exactly what the test was for.\n")
    );
  } else {
    console.log(yellow(bold("  Partly working — see the failures above.\n")));
  }

  cleanup();
  process.exit(usedTools && wrote && onDisk ? 0 : 1);
}

main().catch((err) => {
  console.error(red("\n  Crashed: " + (err?.stack || err?.message || err)));
  cleanup();
  process.exit(1);
});

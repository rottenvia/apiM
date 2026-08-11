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
import { pathToFileURL } from "node:url";
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

/** The app's own pricing, so this cannot drift from what the UI shows. */
const MODEL = "deepseek-v4-pro";
const { estimateCost } = await import(
  pathToFileURL(path.join(ROOT, "src/lib/pricing.ts")).href
);

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

  /*
   * Two tasks, because one of them was never a real exercise.
   *
   * "create fizzbuzz.py" is answerable with write_file and nothing else. It
   * proved the model will use a tool at all, which was the question when this
   * script was written, and it is no longer the question — 33 tools exist and
   * that task can only ever touch two of them.
   *
   * The second task is built so the obvious route through it needs several:
   * a file already exists in the workspace, so it has to be found and read
   * before it can be changed; the change is described by behaviour rather
   * than by position, so a blind overwrite gets it wrong; and it is asked to
   * prove the result, which means running something.
   *
   *   quick  — the original, ~2 rounds, for a cheap smoke test
   *   full   — the default, more rounds and more tools, still cents
   *
   * Pass a mode: npm run test:real -- quick
   */
  const MODE = process.argv.slice(2).find((a) => !a.startsWith("-")) ?? "full";
  if (!["quick", "full"].includes(MODE)) {
    console.log(red(`\n  Unknown mode "${MODE}". Use "quick" or "full".\n`));
    cleanup();
    process.exit(1);
  }

  /*
   * A seeded file with a real defect.
   *
   * range(1, 20) stops at 19, so the last line of the requested output is
   * missing, and the two rules are checked in the wrong order — a multiple of
   * both 3 and 5 prints "Fizz" and never "FizzBuzz". Neither is visible
   * without reading the file or running it, which is the point.
   */
  if (MODE === "full") {
    await mkdir(WS_DIR, { recursive: true });
    await writeFile(
      path.join(WS_DIR, "counter.py"),
      [
        "def classify(n):",
        "    if n % 3 == 0:",
        '        return "Fizz"',
        "    if n % 5 == 0:",
        '        return "Buzz"',
        "    if n % 15 == 0:",
        '        return "FizzBuzz"',
        "    return str(n)",
        "",
        "",
        "for i in range(1, 20):",
        "    print(classify(i))",
        "",
      ].join("\n"),
      "utf8"
    );
  }

  const task =
    MODE === "quick"
      ? "create fizzbuzz.py that prints fizzbuzz for the numbers 1 to 20"
      : "There is a file in this workspace called counter.py. It is supposed " +
        "to print the FizzBuzz sequence for 1 to 20 inclusive, but it has " +
        "bugs. Find it, read it, fix it, and prove it is correct by running " +
        "it and checking the output is exactly right — 20 lines, with " +
        "FizzBuzz on line 15. Do not rewrite the file from scratch; edit the " +
        "parts that are wrong.";

  console.log(bold("  Asking DeepSeek:"));
  console.log(`  "${task}"\n`);
  if (MODE === "full") {
    console.log(
      dim("  (mode: full — seeded counter.py with two real bugs.\n") +
        dim("   for the old one-tool smoke test: npm run test:real -- quick)\n")
    );
  }

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
  const approvals = [];
  let answer = "";
  let usage = null;
  let errorFrame = null;
  let reasoningChars = 0;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  /*
   * A silence timer, so a stall says what it is.
   *
   * The previous version of this script hung with no output and no
   * explanation, and there was no way to tell "the model is thinking" from
   * "the app is waiting for something that is never coming". Ninety seconds
   * without a single frame is not thinking.
   */
  let lastFrame = Date.now();
  const stallWatch = setInterval(() => {
    const idle = Math.round((Date.now() - lastFrame) / 1000);
    if (idle >= 90) {
      console.log(
        yellow(
          `  nothing has arrived for ${idle}s — the last thing printed above ` +
            `is where it stopped.`
        )
      );
      lastFrame = Date.now();
    }
  }, 30_000);
  stallWatch.unref?.();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    lastFrame = Date.now();
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
      /*
       * Answer the approval prompt.
       *
       * This is why the test hung. The app asks permission before running a
       * command, and it asks by sending an `approval_request` frame and then
       * waiting on a SEPARATE HTTP request for the answer. In the real UI a
       * button sends that. This script had no handler at all, so the stream
       * sat there until the five-minute timeout with nothing printed after
       * "calling run_command" — it looked like a freeze and was actually the
       * app correctly waiting for a person who was never asked.
       *
       * Reported from a real run: the model wrote fizzbuzz.py and then tried
       * to run it to check its own work, which is exactly what it should do.
       *
       * Approving is right for this test. It is a fixed, harmless task in a
       * throwaway workspace, the whole point is to see whether the model can
       * write AND verify, and an unattended script cannot ask anyone.
       */
      if (f.type === "approval_request") {
        console.log(
          `  ${dim("?")} it wants to run ${bold(f.display ?? f.command)}` +
            (f.reason ? dim(`  — ${f.reason}`) : "")
        );
        // Deliberately not awaited: the stream we are reading is what
        // unblocks, so awaiting inside this loop would deadlock.
        fetch(`http://127.0.0.1:${appPort}/api/chat/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: f.id, approved: true }),
        }).catch((err) => {
          console.log(red(`  could not answer the prompt: ${err.message}`));
        });
        approvals.push(f);
      }

      if (f.type === "done") usage = f.usage;
      if (f.type === "error") errorFrame = f.error;
    }
  }

  clearInterval(stallWatch);

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
  /*
   * Any tool that puts bytes on disk counts.
   *
   * The old check named write_file specifically. On the full task, editing an
   * existing file with edit_file or apply_patch is the BETTER answer — the
   * prompt explicitly asks it not to rewrite from scratch — so insisting on
   * write_file would have marked the right behaviour as a failure.
   */
  const WRITERS = new Set([
    "write_file",
    "write_files",
    "edit_file",
    "edit_files",
    "apply_patch",
    "replace_in_files",
  ]);
  const wrote = toolResults.some((r) => WRITERS.has(r.name) && r.ok);
  const filePath = path.join(WS_DIR, MODE === "quick" ? "fizzbuzz.py" : "counter.py");
  const onDisk = existsSync(filePath);

  const distinct = [...new Set(toolCalls.map((t) => t.name))];
  console.log(
    `  ${usedTools ? green("YES") : red("NO ")}  the real model used the workspace tools` +
      (usedTools ? dim(`  (${distinct.length} distinct: ${distinct.join(", ")})`) : "")
  );
  console.log(
    `  ${wrote ? green("YES") : red("NO ")}  it successfully changed a file`
  );
  console.log(
    `  ${onDisk ? green("YES") : red("NO ")}  ${path.basename(filePath)} is on your disk` +
      (onDisk ? dim(`  (${path.relative(ROOT, filePath)})`) : "")
  );
  /*
   * Did it check its own work?
   *
   * Writing the file is the easy half. The task the user actually cares about
   * is an agent that runs what it wrote, reads the output and only then says
   * it is done — so that is worth reporting separately rather than folding
   * into a single pass/fail.
   *
   * Not part of the exit code: a model that writes correct fizzbuzz and does
   * not run it has still done what was asked.
   */
  const ranIt = toolResults.some(
    (t) => (t.name === "run_command" || t.name === "run_tests") && t.ok
  );
  console.log(
    `  ${ranIt ? green("YES") : dim("no ")}  it ran the file to check its own work` +
      (approvals.length ? dim(`  (${approvals.length} approved)`) : "")
  );
  /*
   * Check the answer myself, rather than believing the summary.
   *
   * On the reported run the model finished with "Output confirmed correct."
   * Nothing verified that claim — the test reported success because a file
   * existed and a command had exited 0, and the model's own sentence was the
   * only evidence the CONTENT was right.
   *
   * That is the exact failure mode the plan system was built to fight, so the
   * test that reports on it should not be the one place still taking the
   * model's word. Here the correct output is known ahead of time, so it is
   * computed independently and compared.
   */
  let correct = null;
  if (MODE === "full" && onDisk) {
    const expected = Array.from({ length: 20 }, (_, i) => {
      const n = i + 1;
      if (n % 15 === 0) return "FizzBuzz";
      if (n % 3 === 0) return "Fizz";
      if (n % 5 === 0) return "Buzz";
      return String(n);
    }).join("\n");

    const R = await import(
      pathToFileURL(path.join(ROOT, "src/lib/runner.ts")).href
    );
    const check = await R.runCommand(WS_ID, "python3", ["counter.py"]);
    const got = (check.stdout ?? "").replace(/\r\n/g, "\n").trim();
    correct = got === expected;

    console.log(
      `  ${correct ? green("YES") : red("NO ")}  the output is ACTUALLY correct` +
        dim("  (checked here, not taken from what it said)")
    );
    if (!correct) {
      const gotLines = got ? got.split("\n") : [];
      const expLines = expected.split("\n");
      const firstBad = expLines.findIndex((l, i) => gotLines[i] !== l);
      console.log(
        dim(
          `        ${gotLines.length} lines, expected ${expLines.length}` +
            (firstBad !== -1
              ? `; line ${firstBad + 1} was ${JSON.stringify(gotLines[firstBad] ?? null)}, ` +
                `expected ${JSON.stringify(expLines[firstBad])}`
              : "")
        )
      );
    }
  }

  console.log(`  ${dim("time:")} ${seconds}s   ${dim("rounds:")} ${toolCalls.length}`);

  if (usage) {
    const inTok = usage.prompt_tokens ?? 0;
    const outTok = usage.completion_tokens ?? 0;
    /*
     * Priced with the app's own function, not a second copy of the maths.
     *
     * This used to be an inline `in * 0.435 + out * 0.87`, which ignores the
     * cache split entirely and so charges full price for tokens DeepSeek
     * billed at a 120th of it. On the reported run — 18,950 in over two
     * rounds, where round two re-sends round one's prompt — that overstates
     * the bill by up to about 2.5x.
     *
     * Two things wrong with that beyond the number: the app already has
     * estimateCost, so this was a duplicate that could drift, and a test
     * whose job is to tell you what the real API costs should not be the one
     * place that gets it wrong.
     */
    const hit = usage.prompt_cache_hit_tokens ?? 0;
    const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, inTok - hit);
    const cost = estimateCost(usage, MODEL);
    console.log(
      `  ${dim("tokens:")} ${inTok} in (${hit} cached, ${miss} new), ${outTok} out`
    );
    console.log(
      `  ${dim("cost:")} about $${cost === null ? "?" : cost.toFixed(5)}` +
        (hit
          ? dim(`   cached input is ~120x cheaper, which is why it is counted apart`)
          : "")
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
  // On the full task, correctness is part of the verdict: the whole point is
  // that "it ran and exited 0" is not the same as "it is right".
  const passed = usedTools && wrote && onDisk && correct !== false;

  if (passed) {
    console.log(green(bold("  It works with the real model.")));
    if (MODE === "full") {
      console.log(
        dim(`  ${distinct.length} different tools, and the output was verified here.\n`)
      );
    } else {
      console.log(
        dim("  That was the quick smoke test — two tools. Run it without\n") +
          dim("  the argument for the one that exercises several.\n")
      );
    }
  } else if (!usedTools) {
    console.log(yellow(bold("  The real model chose NOT to use the tools.")));
    console.log(
      dim("  It probably printed code in the chat instead. The tool descriptions\n") +
        dim("  need work — this is exactly what the test was for.\n")
    );
  } else if (correct === false) {
    console.log(yellow(bold("  It said it was done, and it was not.")));
    console.log(
      dim("  The file was changed and the command exited 0, but the output is\n") +
        dim("  wrong. That gap is the reason this check exists.\n")
    );
  } else {
    console.log(yellow(bold("  Partly working — see the failures above.\n")));
  }

  cleanup();
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(red("\n  Crashed: " + (err?.stack || err?.message || err)));
  cleanup();
  process.exit(1);
});

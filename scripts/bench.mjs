/**
 * apiM benchmark: real tasks, hidden checks, a score.
 *
 * Mock suites prove nothing is broken; they cannot say whether the agent is
 * GOOD. This runs the real agent, on a real model, through the real app,
 * on a fixed set of tasks whose pass/fail is decided by hidden checks the
 * agent never sees — and reports pass rate, cost and time, so a change can
 * be judged by what it does to the score.
 *
 *   npm run bench -- --self-test            validate every task (free, no model)
 *   OPENROUTER_API_KEY=… npm run bench      run all tasks on the default model
 *   npm run bench -- --model glm-5.3-flash --tasks py-lru-cache,js-router
 *   npm run bench -- --concurrency 3 --effort high --budget 0.5
 *
 * Task layout (bench/tasks/<id>/):
 *   task.json   { title, category, language, difficulty, prompt,
 *                 timeoutMinutes?, budgetUsd? }
 *   files/      the starting workspace, copied in before the run
 *   check/      hidden: check.py or check.mjs, run from a COPY of the final
 *               workspace (cwd = that copy, the check lives in .bench_check/).
 *               Exit 0 = pass. A line "SCORE a/b" gives partial credit.
 *   solution/   reference solution overlaid on files/ (self-test only)
 *
 * --self-test proves every check is honest: it must FAIL on the untouched
 * starting files and PASS once the reference solution is applied. A check
 * that passes on the starting files measures nothing; one that fails on the
 * reference solution measures the check.
 *
 * Results land in bench/results/<stamp>-<model>.{json,md}; the summary
 * compares with the previous run on the same model.
 */
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { findFreePort, killTree, nextBin } from "./lib/proc.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const TASKS_DIR = path.join(ROOT, "bench", "tasks");
const RESULTS_DIR = path.join(ROOT, "bench", "results");

// ---------------------------------------------------------------- options
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const SELF_TEST = flag("self-test");
const MODEL = opt("model", process.env.BENCH_MODEL ?? "deepseek-v4.1-flash");
const EFFORT = opt("effort", "auto");
const CONCURRENCY = Math.max(1, Number(opt("concurrency", "2")));
const BUDGET = opt("budget", null);
const ONLY = opt("tasks", null)?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const EXISTING_URL = opt("url", null);
const LABEL = opt("label", "");
// --desktop runs the tasks through the Rust app's terminal mode instead of the web app.
const DESKTOP = flag("desktop");
const EXE = opt("exe", null);
const REPEAT = Math.max(1, Number(opt("repeat", "1")));
// --resume bench/results/<run folder> carries on a desktop run that was cut short: finished tasks are only checked again.
const RESUME = opt("resume", null);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = c(32), red = c(31), dim = c(2), bold = c(1), yellow = c(33);

// ---------------------------------------------------------------- tasks
function loadTasks() {
  if (!existsSync(TASKS_DIR)) return [];
  return readdirSync(TASKS_DIR)
    .filter((id) => existsSync(path.join(TASKS_DIR, id, "task.json")))
    .filter((id) => !ONLY || ONLY.includes(id))
    .sort()
    .map((id) => {
      const dir = path.join(TASKS_DIR, id);
      const spec = JSON.parse(readFileSync(path.join(dir, "task.json"), "utf8"));
      return { id, dir, ...spec };
    });
}

function checkScript(task) {
  for (const name of ["check.mjs", "check.py"]) {
    if (existsSync(path.join(task.dir, "check", name))) return name;
  }
  return null;
}

/** python3 on Unix, python / py on Windows. */
function pythonCommand() {
  for (const cmd of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return cmd;
  }
  return null;
}
const PYTHON = pythonCommand();

/**
 * Run a task's hidden check against a copy of a workspace directory.
 * The copy keeps the check from being influenced by (or influencing) the
 * real workspace, and keeps .bench_check out of the agent's reach.
 */
async function runCheck(task, workspaceDir) {
  const script = checkScript(task);
  if (!script) return { pass: false, output: "task has no check/check.py or check/check.mjs", score: null };
  const tmp = await mkdtemp(path.join(os.tmpdir(), `bench-${task.id}-`));
  try {
    await cp(workspaceDir, tmp, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git|\.history|\.snapshots)([\\/]|$)/.test(src) });
    await cp(path.join(task.dir, "check"), path.join(tmp, ".bench_check"), { recursive: true });
    const cmd = script.endsWith(".py") ? PYTHON : process.execPath;
    if (!cmd) return { pass: false, output: "python is not installed", score: null };
    const r = spawnSync(cmd, [path.join(".bench_check", script)], {
      cwd: tmp,
      encoding: "utf8",
      timeout: (task.checkTimeoutSeconds ?? 120) * 1000,
      env: { PATH: process.env.PATH, HOME: tmp, SYSTEMROOT: process.env.SYSTEMROOT ?? "", PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" },
    });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    const m = /SCORE\s+(\d+)\s*\/\s*(\d+)/.exec(output);
    return {
      pass: r.status === 0,
      output: r.error ? `${r.error.message}\n${output}` : output,
      score: m ? { got: Number(m[1]), of: Number(m[2]) } : null,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- self-test
async function selfTest(tasks) {
  console.log(bold(`\nBenchmark self-test — ${tasks.length} tasks\n`));
  let ok = 0;
  const problems = [];
  for (const task of tasks) {
    const issues = [];
    for (const key of ["title", "category", "language", "difficulty", "prompt"]) {
      if (!task[key]) issues.push(`task.json has no ${key}`);
    }
    if (!existsSync(path.join(task.dir, "files"))) issues.push("no files/ directory");
    if (!existsSync(path.join(task.dir, "solution"))) issues.push("no solution/ directory");
    if (!checkScript(task)) issues.push("no check script");
    let before = null;
    let after = null;
    if (!issues.length) {
      const start = await mkdtemp(path.join(os.tmpdir(), `bench-st-${task.id}-`));
      try {
        await cp(path.join(task.dir, "files"), start, { recursive: true });
        before = await runCheck(task, start);
        await cp(path.join(task.dir, "solution"), start, { recursive: true, force: true });
        after = await runCheck(task, start);
      } finally {
        await rm(start, { recursive: true, force: true });
      }
      if (before.pass) issues.push("check PASSES on the untouched starting files — it measures nothing");
      if (!after.pass) issues.push(`check FAILS on the reference solution:\n${after.output.split("\n").slice(-8).map((l) => "      " + l).join("\n")}`);
    }
    const good = issues.length === 0;
    if (good) ok++;
    else problems.push(task.id);
    console.log(
      `  ${good ? green("PASS") : red("FAIL")}  ${task.id.padEnd(28)} ${dim(`${task.category} · ${task.language} · ${task.difficulty}`)}` +
        (before?.score || after?.score
          ? dim(`  start ${before?.score ? `${before.score.got}/${before.score.of}` : "-"} → solution ${after?.score ? `${after.score.got}/${after.score.of}` : "-"}`)
          : "")
    );
    for (const i of issues) console.log(`        ${red("·")} ${i}`);
  }
  console.log(`\n${tasks.length} checks · ${ok} passed`);
  if (problems.length) console.log(red(`\nBroken tasks: ${problems.join(", ")}`));
  return problems.length === 0;
}

// ---------------------------------------------------------------- app
const children = [];
process.on("exit", () => children.forEach(killTree));
process.on("SIGINT", () => process.exit(130));

async function waitFor(url, ms, dead) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (dead?.()) return false;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Newest modification time under src/ and the config that shapes the build. */
function newestSourceMtime() {
  let newest = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  walk(path.join(ROOT, "src"));
  for (const f of ["package.json", "next.config.ts", "tsconfig.json"]) {
    if (existsSync(path.join(ROOT, f))) newest = Math.max(newest, statSync(path.join(ROOT, f)).mtimeMs);
  }
  return newest;
}

async function startApp(dataRoot) {
  if (EXISTING_URL) return { base: EXISTING_URL.replace(/\/$/, ""), dataRoot: null };
  const buildId = path.join(ROOT, ".next", "BUILD_ID");
  const built = existsSync(buildId);
  // A build older than the source measures old code — rebuild it.
  const stale = built && newestSourceMtime() > statSync(buildId).mtimeMs;
  if (!built || stale) {
    console.log(dim(`  ${built ? "the production build is older than the source" : "no production build yet"} — running next build (a few minutes)…`));
    const b = spawnSync(process.execPath, [nextBin(ROOT), "build"], { cwd: ROOT, stdio: "inherit" });
    if (b.status !== 0) throw new Error("next build failed");
  }
  const port = await findFreePort();
  const child = spawn(process.execPath, [nextBin(ROOT), "start", "-H", "127.0.0.1", "--port", String(port)], {
    cwd: ROOT,
    env: { ...process.env, APIM_DATA_ROOT: dataRoot },
    stdio: process.env.VERBOSE ? "inherit" : "ignore",
    detached: process.platform !== "win32",
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  if (!(await waitFor(`${base}/api/conversations`, 120_000, () => child.exitCode !== null))) {
    throw new Error("the app did not start (run with VERBOSE=1)");
  }
  return { base, dataRoot };
}

/** The folder the app keeps a workspace in (it is renamed after the chat title). */
function findWorkspaceDir(dataRoot, workspaceId) {
  const root = path.join(dataRoot, "workspaces");
  const direct = path.join(root, workspaceId);
  if (existsSync(direct)) return direct;
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    const marker = path.join(root, name, ".workspace-id");
    try {
      if (statSync(marker).isFile() && readFileSync(marker, "utf8").trim() === workspaceId) {
        return path.join(root, name);
      }
    } catch {
      /* not a workspace */
    }
  }
  return null;
}

// ---------------------------------------------------------------- run one task
async function runTask(app, task, creds, stamp) {
  const workspaceId = `bench-${task.id}-${stamp}`.replace(/[^\w-]/g, "-").slice(0, 120);
  const started = Date.now();
  const wsDir = path.join(app.dataRoot, "workspaces", workspaceId);
  await mkdir(wsDir, { recursive: true });
  await cp(path.join(task.dir, "files"), wsDir, { recursive: true });
  await writeFile(path.join(wsDir, ".workspace-id"), workspaceId);

  const timeoutMs = (task.timeoutMinutes ?? 20) * 60_000;
  const budgetUsd = BUDGET ? Number(BUDGET) : task.budgetUsd ?? 1;
  const frames = [];
  let error = null;
  try {
    const res = await fetch(`${app.base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        message: task.prompt,
        model: MODEL,
        ...creds,
        workspaceEnabled: true,
        workspaceId,
        webSearchMode: task.web ? "auto" : "off",
        thinkingEffort: EFFORT,
        autoRunCommands: true,
        budgetUsd,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let frame;
        try {
          frame = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        frames.push(frame);
        // Nobody is at the keyboard: questions get the first (default)
        // option, stray approvals are granted. Both are logged.
        if (frame.type === "question") {
          await fetch(`${app.base}/api/chat/answer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: frame.id, answer: frame.options?.[0] ?? "Use your best judgement." }),
          }).catch(() => {});
        }
        if (frame.type === "approval_request") {
          await fetch(`${app.base}/api/chat/approve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: frame.id, approved: true, remember: false }),
          }).catch(() => {});
        }
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const done = frames.find((f) => f.type === "done");
  const errors = frames.filter((f) => f.type === "error").map((f) => f.error);
  const ranDir = findWorkspaceDir(app.dataRoot, workspaceId) ?? wsDir;
  const check = await runCheck(task, ranDir);
  const usage = done?.usage ?? frames.filter((f) => f.type === "usage").at(-1)?.usage ?? null;
  const spent = frames.filter((f) => typeof f.spentUsd === "number").at(-1)?.spentUsd ?? null;
  return {
    id: task.id,
    title: task.title,
    category: task.category,
    language: task.language,
    difficulty: task.difficulty,
    pass: check.pass,
    score: check.score,
    checkOutput: check.output.split("\n").slice(-15).join("\n"),
    seconds: Math.round((Date.now() - started) / 1000),
    costUsd: spent,
    tokens: usage?.total_tokens ?? null,
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
    toolCalls: frames.filter((f) => f.type === "tool_start").length,
    delegated: frames.filter((f) => f.type === "tool_start" && f.name === "delegate").length,
    questions: frames.filter((f) => f.type === "question").length,
    finish: done?.ending?.finish ?? null,
    stoppedEarly: Boolean(done?.incomplete) || frames.some((f) => f.type === "budget_stopped"),
    error: error ?? (errors.length ? errors.join(" | ") : null),
  };
}

// ---------------------------------------------------------------- desktop app
function desktopExe() {
  const names = EXE ? [EXE] : ["target-bench", "target"].map((t) => path.join(ROOT, "desktop", t, "release", process.platform === "win32" ? "apim.exe" : "apim"));
  const found = names.find((p) => existsSync(p));
  if (!found) throw new Error(`no desktop build at ${names.join(" or ")} (cargo build --release in desktop/)`);
  return path.resolve(found);
}

/**
 * One task through `apim --ask --auto`: one reply, no window, its own data folder (so nothing it
 * learns leaks into the next task). The whole terminal output is kept beside the report: a failed
 * task is read round by round there.
 */
async function runTaskDesktop(app, task, outDir, run) {
  const started = Date.now();
  const name = `${task.id}${run ? `-${run + 1}` : ""}`;
  const wsDir = path.join(app.dataRoot, "w", name);
  const dataDir = path.join(app.dataRoot, "d", name);
  const transcript = path.join(outDir, `${name}.txt`);
  if (existsSync(transcript)) return scoreDesktop(task, wsDir, dataDir, readFileSync(transcript, "utf8"));
  await rm(wsDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  await cp(path.join(task.dir, "files"), wsDir, { recursive: true });
  await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ budget_usd: BUDGET ? Number(BUDGET) : task.budgetUsd ?? 1 }));
  const child = spawn(app.exe, ["--ask", "--auto", "--model", MODEL, ...(EFFORT === "auto" ? [] : ["--effort", EFFORT]), "--dir", wsDir, task.prompt], {
    env: { ...process.env, APIM_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  let timedOut = false;
  const timer = setTimeout(() => ((timedOut = true), killTree(child)), (task.timeoutMinutes ?? 20) * 60_000);
  await new Promise((r) => child.on("close", r));
  clearTimeout(timer);
  out = `${out.replace(/sk-or-v1-[a-f0-9]+/g, "[key]")}\n[bench: ${Math.round((Date.now() - started) / 1000)} seconds${timedOut ? ", timed out" : ""}]\n`;
  await writeFile(transcript, out);
  return scoreDesktop(task, wsDir, dataDir, out);
}

/** A finished task's numbers, from the workspace it left and what the app printed. */
async function scoreDesktop(task, wsDir, dataDir, out) {
  // Rounds answered by another endpoint than the round before (the app logs each): there the cache starts cold.
  const log = path.join(dataDir, "diagnostics.jsonl");
  const endpointMoves = existsSync(log) ? (readFileSync(log, "utf8").match(/"kind":"endpoint_moved"/g) ?? []).length : 0;
  const bench = /^\[bench: (\d+) seconds(, timed out)?\]/m.exec(out);
  const timedOut = Boolean(bench?.[2]);
  const check = await runCheck(task, wsDir);
  const usage = [...out.matchAll(/^\[tokens in (\d+) out (\d+) cached (\d+)(?: cost ([\d.]+))?\]/gm)];
  const last = usage.at(-1);
  const done = /^\[done: (?:Some\("?)?(\w+)[")]*(, incomplete)?(?:, (.*))?\]/m.exec(out);
  const tools = [...out.matchAll(/^> (\w+)/gm)].map((m) => m[1]);
  const error = /^\[error: (.*)\]/m.exec(out)?.[1] ?? (timedOut ? "timed out" : done ? null : "ended without a done line");
  return {
    id: task.id,
    title: task.title,
    category: task.category,
    language: task.language,
    difficulty: task.difficulty,
    pass: check.pass,
    score: check.score,
    checkOutput: check.output.split("\n").slice(-15).join("\n"),
    seconds: Number(bench?.[1] ?? 0),
    costUsd: last?.[4] ? Number(last[4]) : null,
    tokens: last ? Number(last[1]) + Number(last[2]) : null,
    promptTokens: last ? Number(last[1]) : null,
    completionTokens: last ? Number(last[2]) : null,
    cachedTokens: last ? Number(last[3]) : null,
    rounds: usage.length,
    toolCalls: tools.length,
    toolFailures: (out.match(/^  FAILED /gm) ?? []).length,
    delegated: tools.filter((t) => t === "delegate").length,
    planned: tools.includes("make_plan"),
    questions: (out.match(/^  \(question skipped/gm) ?? []).length,
    endpoint: /^\[.* runs on .* \(([^)]+)\):/m.exec(out)?.[1] ?? null,
    endpointMoves,
    finish: done?.[1] ?? null,
    stoppedEarly: Boolean(done?.[2]),
    error: error ?? done?.[3] ?? null,
  };
}

// ---------------------------------------------------------------- report
function summarise(results) {
  const n = results.length;
  const passed = results.filter((r) => r.pass).length;
  const cost = results.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const secs = results.map((r) => r.seconds).sort((a, b) => a - b);
  const median = secs.length ? secs[Math.floor(secs.length / 2)] : 0;
  const partial = results.reduce((s, r) => s + (r.pass ? 1 : r.score ? r.score.got / r.score.of : 0), 0);
  const byCategory = {};
  for (const r of results) {
    const c = (byCategory[r.category] ??= { tasks: 0, passed: 0 });
    c.tasks++;
    if (r.pass) c.passed++;
  }
  const sum = (key) => results.reduce((s, r) => s + (r[key] ?? 0), 0);
  return { tasks: n, passed, passRate: n ? passed / n : 0, partialScore: n ? partial / n : 0, costUsd: cost, medianSeconds: median, byCategory, tokens: sum("tokens"), promptTokens: sum("promptTokens"), cachedTokens: sum("cachedTokens"), endpointMoves: sum("endpointMoves"), rounds: sum("rounds"), toolCalls: sum("toolCalls"), toolFailures: sum("toolFailures") };
}

function previousRun(model, currentFile) {
  if (!existsSync(RESULTS_DIR)) return null;
  const files = readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith(".json") && f.includes(`-${model.replace(/[^\w.-]/g, "_")}`) && path.join(RESULTS_DIR, f) !== currentFile)
    .sort();
  if (!files.length) return null;
  try {
    return JSON.parse(readFileSync(path.join(RESULTS_DIR, files.at(-1)), "utf8"));
  } catch {
    return null;
  }
}

function markdown(run, prev) {
  const s = run.summary;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const lines = [
    `# apiM benchmark — ${run.model}${run.label ? ` (${run.label})` : ""}`,
    "",
    `${run.startedAt} · effort ${run.effort} · commit ${run.commit}`,
    "",
    `**${s.passed}/${s.tasks} passed (${pct(s.passRate)})** · partial credit ${pct(s.partialScore)} · $${s.costUsd.toFixed(3)} total · median ${s.medianSeconds}s per task`,
  ];
  lines.push("", Object.entries(s.byCategory).map(([name, c]) => `${name} ${c.passed}/${c.tasks}`).join(" · "));
  if (s.rounds) lines.push("", `${s.rounds} rounds · ${s.toolCalls} tool calls (${s.toolFailures} failed) · ${(s.tokens / 1e6).toFixed(2)}M tokens, ${s.promptTokens ? Math.round((s.cachedTokens / s.promptTokens) * 100) : 0}% of the input read from the cache · ${s.endpointMoves} rounds answered by another endpoint than the round before`);
  if (prev) {
    const p = prev.summary;
    lines.push("", `Previous run (${prev.startedAt}, ${prev.commit}): ${p.passed}/${p.tasks} (${pct(p.passRate)}), $${p.costUsd.toFixed(3)}, median ${p.medianSeconds}s`);
  }
  lines.push("", "| task | category | result | time | cost | tools | notes |", "|---|---|---|---|---|---|---|");
  for (const r of run.results) {
    const before = prev?.results?.find((x) => x.id === r.id);
    const delta = before && before.pass !== r.pass ? (r.pass ? " ⬆ newly passing" : " ⬇ regressed") : "";
    lines.push(
      `| ${r.id} | ${r.category} | ${r.pass ? "✅ pass" : r.score ? `❌ ${r.score.got}/${r.score.of}` : "❌ fail"}${delta} | ${r.seconds}s | ${r.costUsd != null ? `$${r.costUsd.toFixed(4)}` : "?"} | ${r.toolCalls}${r.delegated ? ` (${r.delegated} delegated)` : ""}${r.toolFailures ? ` (${r.toolFailures} failed)` : ""}${r.rounds ? ` in ${r.rounds} rounds` : ""} | ${[r.error, r.stoppedEarly ? "stopped early" : null].filter(Boolean).join("; ").replace(/\|/g, "/").slice(0, 120)} |`
    );
  }
  const failed = run.results.filter((r) => !r.pass);
  if (failed.length) {
    lines.push("", "## Failures");
    for (const r of failed) lines.push("", `### ${r.id}`, "```", r.checkOutput || "(no output)", "```");
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- main
async function main() {
  const tasks = loadTasks();
  if (!tasks.length) {
    console.log(red(`No tasks found in ${path.relative(ROOT, TASKS_DIR)}${ONLY ? ` matching ${ONLY.join(",")}` : ""}.`));
    process.exit(1);
  }
  if (SELF_TEST) process.exit((await selfTest(tasks)) ? 0 : 1);

  const creds = {
    openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
    deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? "",
  };
  if (!creds.openrouterApiKey && !creds.deepseekApiKey) {
    console.log(red("Set OPENROUTER_API_KEY (or DEEPSEEK_API_KEY) to run the benchmark. --self-test needs no key."));
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const resumed = RESUME ? path.resolve(RESUME) : null;
  const dataRoot = resumed ? readFileSync(path.join(resumed, "dataroot.txt"), "utf8").trim() : await mkdtemp(path.join(os.tmpdir(), "apim-bench-"));
  console.log(bold(`\napiM benchmark — ${tasks.length} tasks on ${MODEL} (effort ${EFFORT}, ${CONCURRENCY} at a time${DESKTOP ? ", desktop app" : ""})\n`));
  const app = DESKTOP ? { dataRoot, exe: desktopExe() } : await startApp(dataRoot);
  if (!app.dataRoot) app.dataRoot = dataRoot;
  const base = resumed ?? path.join(RESULTS_DIR, `${stamp}-${MODEL.replace(/[^\w.-]/g, "_")}${LABEL ? `-${LABEL.replace(/[^\w.-]/g, "_")}` : ""}`);
  if (DESKTOP) await mkdir(base, { recursive: true });
  if (DESKTOP && !resumed) await writeFile(path.join(base, "dataroot.txt"), dataRoot);
  const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout?.trim() || "?";
  const startedAt = new Date().toISOString();
  const prev = previousRun(MODEL, `${base}.json`);
  // Written after every task: a run that is cut short keeps what it finished.
  const save = async () => {
    const run = { model: MODEL, effort: EFFORT, label: LABEL, commit, startedAt, summary: summarise(results), results: [...results].sort((a, b) => a.id.localeCompare(b.id)) };
    await writeFile(`${base}.json`, JSON.stringify(run, null, 2));
    await writeFile(`${base}.md`, markdown(run, prev));
    return run;
  };

  const pricing = await import(pathToFileURL(path.join(ROOT, "src/lib/pricing.ts")).href).catch(() => null);
  const results = [];
  const queue = tasks.flatMap((task) => Array.from({ length: REPEAT }, (_, run) => ({ task, run })));
  const lanes = Math.min(CONCURRENCY, queue.length);
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { task, run } = job;
      console.log(dim(`  → ${task.id} started`));
      const r = DESKTOP ? await runTaskDesktop(app, task, base, run) : await runTask(app, task, creds, stamp);
      if (r.costUsd == null && pricing && r.tokens) {
        r.costUsd = pricing.estimateCost({ prompt_tokens: r.promptTokens, completion_tokens: r.completionTokens, total_tokens: r.tokens }, MODEL) ?? null;
      }
      results.push(r);
      await save();
      console.log(
        `  ${r.pass ? green("PASS") : red("FAIL")}  ${task.id.padEnd(28)} ${String(r.seconds).padStart(4)}s  ${r.costUsd != null ? `$${r.costUsd.toFixed(4)}` : "   ?   "}  ${dim(`${r.toolCalls} tools`)}${r.error ? "  " + yellow(r.error.slice(0, 80)) : ""}`
      );
    }
  };
  await Promise.all(Array.from({ length: lanes }, worker));
  const run = await save();

  const s = run.summary;
  console.log(bold(`\n${s.passed}/${s.tasks} passed (${Math.round(s.passRate * 100)}%) · $${s.costUsd.toFixed(3)} · median ${s.medianSeconds}s`));
  if (prev) console.log(dim(`previous: ${prev.summary.passed}/${prev.summary.tasks} · $${prev.summary.costUsd.toFixed(3)}`));
  console.log(dim(`report: ${path.relative(ROOT, base)}.md`));
  if (!process.env.BENCH_KEEP_DATA) await rm(dataRoot, { recursive: true, force: true });
  process.exit(0);
}

main().catch((e) => {
  console.error(red(e instanceof Error ? e.stack ?? e.message : String(e)));
  process.exit(1);
});


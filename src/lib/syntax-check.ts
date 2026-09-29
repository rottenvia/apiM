/**
 * A syntax check on every file an edit just wrote.
 *
 * The best CLI agents learn an edit broke the file the moment they make it:
 * the editor's language server reports it. Here the agent learned rounds
 * later, when a build or a test run failed — and by then it had stacked
 * more edits on the broken one. This runs a fast PARSE (not a type check,
 * not a build) on the files a write/edit touched and appends any error to
 * the tool result the model reads next, so a missing brace is fixed in the
 * very next round.
 *
 * Cheap and silent when clean: JSON parses in-process, Python through
 * `ast.parse`, JavaScript/TypeScript through the TypeScript parser in one
 * child process for the whole batch (falling back to `node --check` for
 * plain JS when TypeScript is not installed). Anything unavailable is
 * skipped, never reported as an error — a missing Python is not the
 * model's syntax mistake.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { resolveInside } from "@/lib/workspace";

const JS_TS = /\.(?:[cm]?[jt]sx?)$/i;
const PY = /\.pyw?$/i;
const JSON_FILE = /\.json$/i;
/** JSON dialects that allow comments and trailing commas. */
const JSON_WITH_COMMENTS = /(?:^|\/)(?:tsconfig[^/]*|jsconfig[^/]*|\.vscode\/[^/]*|devcontainer)\.json$/i;
/** Beyond this a file is generated or vendored; parsing it says nothing. */
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 12;
const MAX_REPORTED = 20;
const TIMEOUT_MS = 12_000;

export interface SyntaxProblem {
  path: string;
  line: number;
  column: number;
  message: string;
}

/** Workspace paths an edit-type tool call wrote, read from its arguments. */
export function pathsWrittenBy(name: string, args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  };
  switch (name) {
    case "write_file":
    case "create_file":
    case "edit_file":
      add(args.path);
      break;
    case "write_files":
      if (Array.isArray(args.files)) for (const f of args.files) add((f as { path?: unknown })?.path);
      break;
    case "edit_files":
      add(args.path);
      if (Array.isArray(args.edits)) {
        for (const e of args.edits) add((e as { path?: unknown })?.path);
      }
      break;
    case "apply_patch": {
      const patch = typeof args.patch === "string" ? args.patch : "";
      for (const m of patch.matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)) {
        if (m[1] !== "/dev/null") out.push(m[1]);
      }
      add(args.path);
      break;
    }
  }
  return [...new Set(out)].slice(0, MAX_FILES);
}

function run(
  cmd: string,
  args: string[],
  input?: string
): Promise<{ code: number | null; stdout: string; stderr: string } | null> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        timeout: TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        // Our own checker script, never workspace code — but still no
        // secrets in its environment.
        env: {
          PATH: process.env.PATH ?? "",
          SYSTEMROOT: process.env.SYSTEMROOT ?? "",
        } as unknown as NodeJS.ProcessEnv,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : error
              ? null
              : 0;
        if (error && (error as { code?: unknown }).code === "ENOENT") return resolve(null);
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      }
    );
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

/** Parses each JS/TS file with the TypeScript parser; prints JSON problems. */
const TS_CHECKER = `
let ts;
try { ts = require(require.resolve("typescript", { paths: [process.cwd()] })); }
catch { process.stdout.write("NO_TS"); process.exit(0); }
const fs = require("fs");
const files = JSON.parse(require("fs").readFileSync(0, "utf8"));
const out = [];
for (const f of files) {
  let text;
  try { text = fs.readFileSync(f.abs, "utf8"); } catch { continue; }
  const r = ts.transpileModule(text, {
    fileName: f.abs,
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true, noEmit: false },
  });
  for (const d of r.diagnostics || []) {
    if (d.category !== ts.DiagnosticCategory.Error || !d.file || d.start === undefined) continue;
    const p = d.file.getLineAndCharacterOfPosition(d.start);
    out.push({ path: f.rel, line: p.line + 1, column: p.character + 1,
      message: ts.flattenDiagnosticMessageText(d.messageText, " ") });
  }
}
process.stdout.write(JSON.stringify(out));
`;

/*
 * The TypeScript parser, kept warm.
 *
 * Loading typescript costs ~250ms, and a one-shot child paid it on every
 * edit — on a 40-edit task, ten seconds of nothing. One long-lived child
 * holds it loaded and answers line-delimited requests in a few ms; it exits
 * after a minute idle, and any failure falls back to the one-shot child.
 */
const TS_WORKER = `
let ts = null;
try { ts = require(require.resolve("typescript", { paths: [process.cwd()] })); } catch {}
const fs = require("fs");
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (!ts) { process.stdout.write(JSON.stringify({ id: req.id, noTs: true }) + "\\n"); return; }
  const out = [];
  for (const f of req.files) {
    let text;
    try { text = fs.readFileSync(f.abs, "utf8"); } catch { continue; }
    try {
      const r = ts.transpileModule(text, {
        fileName: f.abs,
        reportDiagnostics: true,
        compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true },
      });
      for (const d of r.diagnostics || []) {
        if (d.category !== ts.DiagnosticCategory.Error || !d.file || d.start === undefined) continue;
        const p = d.file.getLineAndCharacterOfPosition(d.start);
        out.push({ path: f.rel, line: p.line + 1, column: p.character + 1,
          message: ts.flattenDiagnosticMessageText(d.messageText, " ") });
      }
    } catch {}
  }
  process.stdout.write(JSON.stringify({ id: req.id, problems: out }) + "\\n");
});
`;

const WORKER_IDLE_MS = 60_000;
let worker: ChildProcess | null = null;
let workerBuffer = "";
let workerIdle: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
const waiting = new Map<number, (r: { noTs?: boolean; problems?: SyntaxProblem[] } | null) => void>();

function stopWorker(): void {
  const w = worker;
  worker = null;
  workerBuffer = "";
  for (const done of waiting.values()) done(null);
  waiting.clear();
  try {
    w?.kill();
  } catch {
    /* already gone */
  }
}

function getWorker(): ChildProcess | null {
  if (worker && worker.exitCode === null && !worker.killed) return worker;
  try {
    const w = spawn(process.execPath, ["-e", TS_WORKER], {
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        PATH: process.env.PATH ?? "",
        SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      } as unknown as NodeJS.ProcessEnv,
      windowsHide: true,
    });
    w.stdout?.setEncoding("utf8");
    w.stdout?.on("data", (chunk: string) => {
      workerBuffer += chunk;
      let nl: number;
      while ((nl = workerBuffer.indexOf("\n")) >= 0) {
        const line = workerBuffer.slice(0, nl);
        workerBuffer = workerBuffer.slice(nl + 1);
        try {
          const msg = JSON.parse(line) as { id: number; noTs?: boolean; problems?: SyntaxProblem[] };
          waiting.get(msg.id)?.(msg);
          waiting.delete(msg.id);
        } catch {
          /* a stray line */
        }
      }
    });
    w.on("exit", () => {
      if (worker === w) stopWorker();
    });
    w.on("error", () => {
      if (worker === w) stopWorker();
    });
    worker = w;
    holdOpen(w, false);
    return w;
  } catch {
    return null;
  }
}

/**
 * Keep the event loop alive only while a parse is pending: an idle warm
 * worker must never hold a finished process (or a test) open.
 */
function holdOpen(w: ChildProcess, hold: boolean): void {
  const handles = [w, w.stdin, w.stdout] as unknown as ({ ref?: () => void; unref?: () => void } | null)[];
  for (const h of handles) {
    if (hold) h?.ref?.();
    else h?.unref?.();
  }
}

async function parseWithWorker(
  files: { rel: string; abs: string }[]
): Promise<{ noTs?: boolean; problems?: SyntaxProblem[] } | null> {
  const w = getWorker();
  if (!w?.stdin) return null;
  if (workerIdle) clearTimeout(workerIdle);
  const id = nextId++;
  const answer = new Promise<{ noTs?: boolean; problems?: SyntaxProblem[] } | null>((resolve) => {
    waiting.set(id, resolve);
    const t = setTimeout(() => {
      if (waiting.has(id)) {
        // A wedged parser is killed; the next edit starts a fresh one.
        stopWorker();
      }
    }, TIMEOUT_MS);
    t.unref?.();
  });
  holdOpen(w, true);
  try {
    w.stdin.write(JSON.stringify({ id, files }) + "\n");
  } catch {
    stopWorker();
    return null;
  }
  const result = await answer;
  if (worker === w && waiting.size === 0) holdOpen(w, false);
  workerIdle = setTimeout(stopWorker, WORKER_IDLE_MS);
  workerIdle.unref?.();
  return result;
}

const PY_CHECKER = `
import ast, json, sys
out = []
for f in json.load(sys.stdin):
    try:
        with open(f["abs"], encoding="utf-8-sig") as h:
            src = h.read()
    except Exception:
        continue
    try:
        ast.parse(src, filename=f["rel"])
    except SyntaxError as e:
        out.append({"path": f["rel"], "line": e.lineno or 1, "column": e.offset or 1,
                    "message": e.msg + " (parsed with Python %d.%d)" % sys.version_info[:2]})
print(json.dumps(out))
`;

/** Files whose tools read JSON with comments and trailing commas. */
const JSONC_NAMES =
  /(?:^|\/)(?:\.eslintrc(?:\.[\w-]+)?\.json|\.babelrc(?:\.json)?|deno\.jsonc?|\.devcontainer\.json|settings\.json|launch\.json|tasks\.json|extensions\.json|[^/]+\.code-workspace|\.swcrc|api-extractor\.json|turbo\.json|biome\.json)$/i;

/**
 * Parses as JSON with comments: once comments and trailing commas are
 * removed outside strings. Only for a known JSONC file, or one that really
 * has comments — a trailing comma alone in package.json is a real error
 * (npm refuses it), not a dialect.
 */
function parsesAsJsonc(text: string, knownJsonc: boolean): boolean {
  let hadComment = false;
  let out = "";
  let i = 0;
  let quote = false;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') quote = false;
      i++;
      continue;
    }
    if (c === '"') {
      quote = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      hadComment = true;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      hadComment = true;
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  if (!knownJsonc && !hadComment) return false;
  try {
    JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
    return true;
  } catch {
    return false;
  }
}

async function eligible(
  workspaceId: string,
  rel: string
): Promise<{ rel: string; abs: string } | null> {
  let abs: string;
  try {
    abs = resolveInside(workspaceId, rel);
  } catch {
    return null;
  }
  try {
    const st = await fs.stat(abs);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
  } catch {
    return null;
  }
  return { rel: rel.replace(/\\/g, "/"), abs };
}

function parseProblems(raw: string): SyntaxProblem[] {
  try {
    const list = JSON.parse(raw) as SyntaxProblem[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Parse-check the given workspace files. Empty when clean or unsupported. */
export async function checkSyntax(
  workspaceId: string,
  relPaths: string[]
): Promise<SyntaxProblem[]> {
  const files = (
    await Promise.all(relPaths.slice(0, MAX_FILES).map((p) => eligible(workspaceId, p)))
  ).filter((f): f is { rel: string; abs: string } => f !== null);
  if (!files.length) return [];

  const problems: SyntaxProblem[] = [];
  // Flow-typed JavaScript (React Native) is not TypeScript: its type
  // annotations would all be reported as errors. Skipped, not guessed at.
  const jsTs: { rel: string; abs: string }[] = [];
  for (const f of files.filter((x) => JS_TS.test(x.rel))) {
    if (/\.[cm]?jsx?$/i.test(f.rel)) {
      const head = await fs.readFile(f.abs, "utf8").then((t) => t.slice(0, 2048)).catch(() => "");
      if (/@flow\b/.test(head)) continue;
    }
    jsTs.push(f);
  }
  const py = files.filter((f) => PY.test(f.rel));
  const json = files.filter((f) => JSON_FILE.test(f.rel) && !JSON_WITH_COMMENTS.test(f.rel));

  for (const f of json) {
    // A byte-order mark is legal in a file and fatal to JSON.parse (common
    // in Visual Studio / .NET files) — found by review as a false error.
    const text = (await fs.readFile(f.abs, "utf8").catch(() => "")).replace(/^\uFEFF/, "");
    try {
      JSON.parse(text);
    } catch (e) {
      // JSON-with-comments files are everywhere (.eslintrc.json, deno.json,
      // .devcontainer.json…): only report what fails even as JSONC.
      if (parsesAsJsonc(text, JSONC_NAMES.test(f.rel))) continue;
      const msg = e instanceof Error ? e.message : String(e);
      const pos = /position (\d+)/.exec(msg);
      let line = 1;
      let column = 1;
      if (pos) {
        const before = text.slice(0, Number(pos[1]));
        line = before.split("\n").length;
        column = before.length - before.lastIndexOf("\n");
      }
      problems.push({ path: f.rel, line, column, message: msg.replace(/^JSON\.parse: /, "") });
    }
  }

  const tasks: Promise<void>[] = [];
  if (jsTs.length) {
    tasks.push(
      (async () => {
        const warm = await parseWithWorker(jsTs);
        if (warm?.problems) {
          problems.push(...warm.problems);
          return;
        }
        const res = warm?.noTs
          ? { code: 0, stdout: "NO_TS", stderr: "" }
          : await run(process.execPath, ["-e", TS_CHECKER], JSON.stringify(jsTs));
        if (!res) return;
        if (res.stdout.trim() === "NO_TS") {
          // No TypeScript: plain JS still gets node's own parser.
          // node --check knows no JSX: skip anything that looks like it.
          const plain: typeof jsTs = [];
          for (const x of jsTs.filter((y) => /\.[cm]?js$/i.test(y.rel))) {
            const t = await fs.readFile(x.abs, "utf8").catch(() => "");
            if (!/<[A-Za-z][\w.]*(?:\s[^<>]*)?\/?>/.test(t)) plain.push(x);
          }
          for (const f of plain) {
            const r = await run(process.execPath, ["--check", f.abs]);
            if (r && r.code !== 0) {
              const m = /:(\d+)\n[\s\S]*?\n\n?(SyntaxError: .+)/.exec(r.stderr);
              problems.push({
                path: f.rel,
                line: m ? Number(m[1]) : 1,
                column: 1,
                message: m ? m[2] : r.stderr.trim().split("\n").pop() ?? "Syntax error",
              });
            }
          }
          return;
        }
        problems.push(...parseProblems(res.stdout));
      })()
    );
  }
  if (py.length) {
    tasks.push(
      (async () => {
        for (const cmd of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
          const res = await run(cmd, ["-c", PY_CHECKER], JSON.stringify(py));
          if (!res) continue;
          // The Windows Store "python" stub exits non-zero with a message
          // instead of ENOENT: no JSON answer means try the next command.
          if (!/^\s*\[/.test(res.stdout)) continue;
          problems.push(...parseProblems(res.stdout));
          return;
        }
      })()
    );
  }
  await Promise.all(tasks);
  return problems;
}

/** The note appended to a tool result, or "" when every file parsed. */
export function formatSyntaxProblems(problems: SyntaxProblem[]): string {
  if (!problems.length) return "";
  const shown = problems.slice(0, MAX_REPORTED);
  const more = problems.length - shown.length;
  const files = new Set(problems.map((p) => p.path)).size;
  return (
    `\n\n⚠ Syntax check: this edit left ${problems.length} parse error${problems.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"} — the file will not run until they are fixed:\n` +
    shown.map((p) => `  ${p.path}:${p.line}:${p.column} — ${p.message}`).join("\n") +
    (more > 0 ? `\n  …and ${more} more` : "") +
    `\nFix these next, before building on this file. (Parse check only: type errors are not checked here.)`
  );
}

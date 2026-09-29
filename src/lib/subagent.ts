/**
 * Sub-agents: read-only helpers with their own context.
 *
 * The main agent's context is its most expensive resource. "Find where auth
 * is handled", "review these twelve files", "what does this library's API
 * look like now" each cost dozens of reads that stay in the transcript for
 * the rest of the run, re-billed every round and crowding out the actual
 * task. The strongest CLI agents hand that kind of work to a helper that
 * explores in a SEPARATE context and returns only its conclusions.
 *
 * `delegate` does that. The helper gets a fresh transcript (its brief, the
 * workspace file list), the read-only tools, and a round budget; the main
 * agent receives one tool result — the helper's report. Several delegate
 * calls in one round run at the same time (the route starts them together),
 * so independent questions are answered in parallel.
 *
 * Read-only by construction: the helper is never offered a tool that
 * writes, runs a command or asks the user, and its calls are refused by
 * name if a model invents one anyway. It cannot delegate further.
 */

import { runTool, WORKSPACE_TOOLS, GITHUB_TOOLS, type ToolContext, type ToolDefinition } from "@/lib/tools";
import { buildWorkspaceContext } from "@/lib/workspace-context";
import { parseToolArguments } from "@/lib/transcript";
import { runGitAgentTool } from "@/lib/git-agent";

/** Read-only git tools: dispatched through the git agent, not runTool. */
const GIT_READ_TOOLS = new Set(["git_status", "git_diff", "git_log"]);

/** Tools a helper may use. Everything here only reads. */
export const SUBAGENT_TOOLS = new Set([
  "list_files",
  "read_file",
  "read_files",
  "search_files",
  "read_symbol",
  "find_references",
  "query_data",
  "read_document",
  "analyze_log",
  "git_status",
  "git_diff",
  "git_log",
  "fetch_url",
  "inspect_page",
  "web_search",
  "search_conversation",
]);

export const DELEGATE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "delegate",
    description:
      "Hand a self-contained research job to a helper agent that works in its OWN context and returns only its conclusions. " +
      "Use it for broad exploration (\"find everything involved in X\", \"how is Y wired end to end\"), reviewing many files, " +
      "or looking something up on the web — work whose reads you would otherwise carry in your context for the rest of the task. " +
      "The helper can read, search and browse but cannot change files or run commands. It cannot see this conversation, " +
      "so the brief must say everything it needs: the goal, what to look at, and what the report must contain. " +
      "Several delegate calls in the same round run in parallel — split independent questions across them. " +
      "Do not delegate a single known file read or an edit; do those yourself.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "The complete brief: what to find out, where to look, and exactly what the report should contain (e.g. file:line for every call site).",
        },
        max_rounds: {
          type: "number",
          description: "Upper bound on the helper's tool rounds (default 12, max 24). Raise only for genuinely large surveys.",
        },
      },
      required: ["task"],
    },
  },
};

const SYSTEM = `You are a research helper working for a coding agent. You can only READ: you have no way to change files, run commands or ask anyone anything.

Do the task you are given by reading and searching the workspace (and the web, if a tool for it is offered), then reply with your report. The agent that sent you sees NOTHING you read — only your final report — so the report must stand on its own:
- concrete findings with file paths and line numbers (path:line),
- short quoted snippets only where the exact text matters,
- what you could not find or could not verify, said plainly — never guess and present it as fact.

Work efficiently: read several files at once with read_files, locate things with search_files / find_references / read_symbol rather than opening files one by one, and stop as soon as you can answer. Make reasonable assumptions instead of asking, and state them. Keep the report under about 800 words unless the task needs more. Your final message is the report — no tool call in it.`;

/** Per tool result, inside the helper's own context. */
const RESULT_MAX_CHARS = 24_000;
/** Past this the helper is told to write up what it has. */
const CONTEXT_SOFT_CAP_CHARS = 420_000;
const REPORT_MAX_CHARS = 16_000;
const DEFAULT_ROUNDS = 12;
const MAX_ROUNDS = 24;
const REQUEST_TIMEOUT_MS = 180_000;

export interface SubAgentTarget {
  baseUrl: string;
  apiModel: string;
  headers: Record<string, string>;
  /** Thinking switches, endpoint pins: merged into every request body. */
  extraBody: Record<string, unknown>;
}

export interface SubAgentUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  [k: string]: unknown;
}

export interface SubAgentResult {
  ok: boolean;
  report: string;
  rounds: number;
  toolCalls: number;
  /** Paths the helper read, for the summary line. */
  filesRead: string[];
  stoppedBecause?: "rounds" | "context" | "budget" | "stopped" | "error";
}

export interface SubAgentOptions {
  task: string;
  workspaceId: string;
  target: SubAgentTarget;
  toolContext: ToolContext;
  /** Names of tools the main agent has this round (web_search, git…). */
  available: Set<string>;
  signal: AbortSignal;
  maxRounds?: number;
  /** Every request's usage, so the reply's total and spending cap include it. */
  onUsage?: (usage: SubAgentUsage) => void;
  /** Checked before each request; true stops the helper (spending cap). */
  shouldStop?: () => boolean;
  /** Progress for the UI: round number and the tools just used. */
  onProgress?: (p: { round: number; toolCalls: number; tools: string[] }) => void;
  /**
   * Context budget in chars. Derive it from the model's window: a fixed
   * 420k overflowed an 80K-token local model and lost all the work.
   */
  contextCapChars?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

/** Soft context cap for a model window of `tokens` (about 60% of it). */
export function helperContextCap(tokens: number): number {
  return Math.max(40_000, Math.min(CONTEXT_SOFT_CAP_CHARS, Math.floor(tokens * 3.2 * 0.6)));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

type Msg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

function clip(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n…[${text.length - max} more chars not shown to keep the helper's context small — read a narrower range if you need it]`;
}

async function complete(
  opts: SubAgentOptions,
  body: Record<string, unknown>
): Promise<{
  message: { content?: string | null; tool_calls?: Msg["tool_calls"] };
  usage?: SubAgentUsage;
}> {
  const doFetch = opts.fetchImpl ?? fetch;
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (opts.signal.aborted) throw new Error("stopped");
    if (attempt > 0) await sleep(attempt === 1 ? 1500 : 5000, opts.signal);
    if (opts.signal.aborted) throw new Error("stopped");
    try {
      const res = await doFetch(`${opts.target.baseUrl}/chat/completions`, {
        method: "POST",
        headers: opts.target.headers,
        signal: AbortSignal.any([opts.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string | null; tool_calls?: Msg["tool_calls"] } }[];
        usage?: SubAgentUsage;
      };
      const message = json.choices?.[0]?.message;
      if (!message) {
        lastError = "empty response";
        continue;
      }
      return { message, usage: json.usage };
    } catch (e) {
      if (opts.signal.aborted) throw new Error("stopped");
      const msg = e instanceof Error ? e.message : String(e);
      if (/^HTTP 4\d\d/.test(msg)) throw e;
      lastError = msg;
    }
  }
  throw new Error(lastError || "request failed");
}

/** Run one helper to completion and return its report. */
export async function runSubAgent(opts: SubAgentOptions): Promise<SubAgentResult> {
  const rounds = Math.max(1, Math.min(MAX_ROUNDS, Math.round(opts.maxRounds ?? DEFAULT_ROUNDS)));
  const tools = [...WORKSPACE_TOOLS, ...GITHUB_TOOLS].filter(
    (t) => SUBAGENT_TOOLS.has(t.function.name) && opts.available.has(t.function.name)
  );
  const allowed = new Set(tools.map((t) => t.function.name));

  let tree = "";
  try {
    tree = await buildWorkspaceContext(opts.workspaceId);
  } catch {
    /* the helper can still list_files */
  }
  const messages: Msg[] = [
    { role: "system", content: SYSTEM + tree },
    { role: "user", content: opts.task },
  ];

  const filesRead = new Set<string>();
  let toolCalls = 0;
  let contextChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  let stoppedBecause: SubAgentResult["stoppedBecause"];
  const cap = opts.contextCapChars ?? CONTEXT_SOFT_CAP_CHARS;
  let salvaged = false;

  for (let round = 1; round <= rounds + 1; round++) {
    if (opts.signal.aborted) {
      stoppedBecause = "stopped";
      break;
    }
    if (opts.shouldStop?.()) {
      stoppedBecause = "budget";
      break;
    }
    // The last pass (round budget or context cap) must answer, not explore.
    const finalPass = round > rounds || contextChars > cap;
    if (finalPass) {
      stoppedBecause = round > rounds ? "rounds" : "context";
      messages.push({
        role: "user",
        content:
          "Stop exploring now. Write your report from what you have found, and say what is left unchecked.",
      });
    }
    const body: Record<string, unknown> = {
      model: opts.target.apiModel,
      messages,
      max_tokens: 8192,
      stream: false,
      ...opts.target.extraBody,
    };
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = finalPass ? "none" : "auto";
    }

    let reply: Awaited<ReturnType<typeof complete>>;
    try {
      reply = await complete(opts, body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "stopped") {
        stoppedBecause = "stopped";
        break;
      }
      /*
       * A 4xx after some work is usually the context overflowing the
       * model's window. Found by review: that threw away everything the
       * helper had read. Shrink every tool result and ask for the report
       * once before giving up.
       */
      if (/^HTTP 4(?:00|13)/.test(msg) && !salvaged && toolCalls > 0) {
        salvaged = true;
        for (const m of messages) {
          if (m.role === "tool" && typeof m.content === "string" && m.content.length > 1500) {
            m.content = `${m.content.slice(0, 1500)}\n…[shortened to fit the model's context]`;
          }
        }
        contextChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
        round = rounds; // the next pass is the final one
        continue;
      }
      return {
        ok: false,
        report: `The helper failed: ${msg}. Nothing it found so far is available — do the research yourself or try a narrower brief.`,
        rounds: round,
        toolCalls,
        filesRead: [...filesRead],
        stoppedBecause: "error",
      };
    }
    if (reply.usage) opts.onUsage?.(reply.usage);

    const calls = (reply.message.tool_calls ?? []).filter((c) => c?.function?.name);
    if (!calls.length || finalPass) {
      const text = (reply.message.content ?? "").trim();
      return {
        ok: Boolean(text),
        report: text
          ? clip(text, REPORT_MAX_CHARS)
          : "The helper finished without writing a report.",
        rounds: round,
        toolCalls,
        filesRead: [...filesRead],
        stoppedBecause,
      };
    }

    messages.push({
      role: "assistant",
      content: reply.message.content ?? null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.function.name, arguments: c.function.arguments ?? "{}" },
      })),
    });

    // Reads touch nothing shared, so a round's calls run together.
    const results = await Promise.all(
      calls.map(async (call) => {
        const name = call.function.name;
        if (!allowed.has(name)) {
          return `Error: ${name} is not available to a read-only helper. Use the read and search tools, and put anything that needs a change in your report.`;
        }
        const parsed = parseToolArguments(call.function.arguments ?? "{}");
        if (!parsed.ok) return `Error: the arguments were not valid JSON (${parsed.error}).`;
        const args = parsed.value;
        if (typeof args.path === "string") filesRead.add(args.path);
        if (Array.isArray(args.paths)) for (const p of args.paths) if (typeof p === "string") filesRead.add(p);
        try {
          if (GIT_READ_TOOLS.has(name)) {
            return (await runGitAgentTool(opts.workspaceId, name, args, null)).content;
          }
          const r = await runTool(opts.workspaceId, name, args, {
            ...opts.toolContext,
            signal: opts.signal,
          });
          return r.content;
        } catch (e) {
          return `Error: ${e instanceof Error ? e.message : "tool failed"}`;
        }
      })
    );
    toolCalls += calls.length;
    // A round's results share what is left of the budget, so one round of
    // many large reads cannot blow far past it before the cap is checked.
    const share = Math.max(2_000, Math.floor((cap - contextChars) / calls.length));
    calls.forEach((call, i) => {
      const content = clip(results[i], Math.min(RESULT_MAX_CHARS, share));
      contextChars += content.length + (call.function.arguments?.length ?? 0);
      messages.push({ role: "tool", tool_call_id: call.id, content });
    });
    opts.onProgress?.({ round, toolCalls, tools: calls.map((c) => c.function.name) });
  }

  return {
    ok: false,
    report:
      stoppedBecause === "budget"
        ? "The helper stopped: the spending limit for this reply was reached."
        : "The helper was stopped before it could report.",
    rounds,
    toolCalls,
    filesRead: [...filesRead],
    stoppedBecause,
  };
}

/** What the main agent reads back as the delegate tool result. */
export function formatSubAgentResult(r: SubAgentResult): { content: string; summary: string } {
  const files = r.filesRead.length;
  const stats = `${r.rounds} round${r.rounds === 1 ? "" : "s"}, ${r.toolCalls} tool call${r.toolCalls === 1 ? "" : "s"}${files ? `, ${files} file${files === 1 ? "" : "s"} read` : ""}`;
  const note =
    r.stoppedBecause === "rounds"
      ? " It hit its round limit, so the report may be incomplete."
      : r.stoppedBecause === "context"
        ? " It filled its context, so the report may be incomplete."
        : "";
  return {
    content: `Helper report (${stats}).${note}\n\n${r.report}`,
    summary: r.ok ? `Helper finished · ${stats}` : `Helper did not finish · ${stats}`,
  };
}

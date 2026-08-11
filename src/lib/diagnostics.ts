/**
 * A record of what actually went wrong, so it can be fixed.
 *
 * ## Why this exists
 *
 * The user's words: *"I don't see all of the errors or imperfections myself,
 * can we add something that makes reports for you?"* — and they are right
 * that this is the bottleneck. Every fix in this project so far has depended
 * on the user noticing a problem, remembering it, and describing it. Things
 * that fail quietly, or fail once, or fail in a way that looks like the model
 * being stupid, never get reported at all.
 *
 * This records them as they happen. Not telemetry — nothing leaves the
 * machine — just an append-only log of facts that are hard to reconstruct
 * afterwards:
 *
 *   - a tool that failed, and what the error actually said
 *   - a command refused, and why
 *   - a run that hit a ceiling: rounds, output, budget
 *   - a request the API rejected
 *   - a browser action blocked by policy
 *
 * ## What it is deliberately not
 *
 * It is not a full transcript. Transcripts are already saved, they are large,
 * and they are the thing nobody reads. Each entry here is one line of fact
 * plus enough context to act on it, and the file is capped.
 *
 * It also records nothing about the CONTENT of the user's work — no file
 * bodies, no prompts, no API keys. A report is meant to be pasteable into a
 * chat without thinking twice about what is in it.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** Where the log lives. Alongside the chats, not inside a workspace. */
/** Overridable so parallel test suites do not share one log. */
const DATA_DIR = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.join(process.cwd(), "data");
const LOG_PATH = path.join(DATA_DIR, "diagnostics.jsonl");

/**
 * Keep the log bounded.
 *
 * Old entries are the least useful — a problem still happening will be
 * recorded again. 2000 lines is a few hundred KB and covers weeks of use.
 */
export const MAX_ENTRIES = 2000;

export type DiagnosticKind =
  | "tool_failed"
  | "command_refused"
  | "browser_blocked"
  | "api_error"
  | "limit_hit"
  | "run_stopped"
  | "ui_error";

export interface Diagnostic {
  at: string;
  kind: DiagnosticKind;
  /** Short, stable identifier — groupable. E.g. the tool or command name. */
  subject: string;
  /** What happened, in one line. Truncated; never a file body. */
  detail: string;
  /** Optional extra facts, all small scalars. */
  context?: Record<string, string | number | boolean>;
}

/** Long errors are cut: the first line is nearly always the useful part. */
function trim(text: string, max = 300): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

/**
 * Anything that could carry a secret is dropped before it is written.
 *
 * The log is meant to be pasteable. A key that leaked into an error message
 * would make it the opposite of that.
 */
function scrub(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/tvly-[A-Za-z0-9_-]{8,}/g, "tvly-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***")
    .replace(/([?&](?:api_?key|token|secret)=)[^&\s]+/gi, "$1***");
}

/**
 * Record one event.
 *
 * Never throws and never awaits anything the caller depends on: a diagnostic
 * that broke the thing it was observing would be worse than no diagnostic.
 */
export async function record(entry: {
  kind: DiagnosticKind;
  subject: string;
  detail: string;
  context?: Record<string, string | number | boolean>;
}): Promise<void> {
  try {
    const line: Diagnostic = {
      at: new Date().toISOString(),
      kind: entry.kind,
      subject: trim(entry.subject, 80),
      detail: scrub(trim(entry.detail)),
      context: entry.context,
    };
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(LOG_PATH, JSON.stringify(line) + "\n", "utf8");
  } catch {
    /* observing must never break the observed */
  }
}

/** Fire-and-forget, for call sites in a hot path. */
export function recordAsync(entry: Parameters<typeof record>[0]): void {
  void record(entry);
}

/** Read the log back, newest last, trimming it if it has grown too large. */
export async function readDiagnostics(): Promise<Diagnostic[]> {
  let raw: string;
  try {
    raw = await fs.readFile(LOG_PATH, "utf8");
  } catch {
    return [];
  }

  const entries: Diagnostic[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as Diagnostic);
    } catch {
      /* a torn final line from an interrupted write */
    }
  }

  if (entries.length > MAX_ENTRIES) {
    const kept = entries.slice(-MAX_ENTRIES);
    try {
      await fs.writeFile(
        LOG_PATH,
        kept.map((e) => JSON.stringify(e)).join("\n") + "\n",
        "utf8"
      );
    } catch {
      /* trimming is housekeeping, not correctness */
    }
    return kept;
  }

  return entries;
}

export async function clearDiagnostics(): Promise<void> {
  try {
    await fs.rm(LOG_PATH, { force: true });
  } catch {
    /* nothing to clear */
  }
}

export interface ReportGroup {
  kind: DiagnosticKind;
  subject: string;
  count: number;
  /** Most recent occurrence. */
  lastAt: string;
  /** A representative detail — the newest, which is usually the clearest. */
  example: string;
}

/**
 * Turn the raw log into something worth reading.
 *
 * Grouping is the whole point. Forty lines of "run_command failed" is noise;
 * "run_command failed 40 times, all `npm install`" is a bug report. Sorted by
 * frequency, because the thing happening most is nearly always the thing
 * worth fixing first.
 */
export function summarise(entries: Diagnostic[]): ReportGroup[] {
  const groups = new Map<string, ReportGroup>();

  for (const e of entries) {
    const key = `${e.kind}::${e.subject}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      /*
       * `>=`, not `>`.
       *
       * ISO timestamps have millisecond resolution, and two events recorded
       * in the same millisecond are common — a burst of tool failures in one
       * round produces several. With a strict `>` the first of them won and
       * the later, usually clearer, wording was thrown away.
       *
       * Entries are read back in the order they were written, so when the
       * timestamps tie, later in the file is later in time. Found by the
       * parallel test runner: the check passed alone on a slow machine where
       * the writes landed in different milliseconds, and failed under load
       * where they did not.
       */
      if (e.at >= existing.lastAt) {
        existing.lastAt = e.at;
        existing.example = e.detail;
      }
    } else {
      groups.set(key, {
        kind: e.kind,
        subject: e.subject,
        count: 1,
        lastAt: e.at,
        example: e.detail,
      });
    }
  }

  return [...groups.values()].sort(
    (a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)
  );
}

/** Human-readable labels, so the report is not a wall of enum names. */
const KIND_LABEL: Record<DiagnosticKind, string> = {
  tool_failed: "Tool failed",
  command_refused: "Command refused",
  browser_blocked: "Browser action blocked",
  api_error: "API error",
  limit_hit: "Hit a limit",
  run_stopped: "Run stopped early",
  ui_error: "Interface error",
};

/**
 * Render the report as Markdown, ready to paste into a chat.
 *
 * Markdown rather than JSON because the audience is a person or a model
 * reading it as prose, not a parser. The raw JSONL is still there for anyone
 * who wants it.
 */
export function renderReport(entries: Diagnostic[]): string {
  if (entries.length === 0) {
    return (
      "# apiM diagnostics\n\nNothing recorded. Either everything has worked, " +
      "or nothing has been run since the log was last cleared.\n"
    );
  }

  const groups = summarise(entries);
  const first = entries[0]?.at ?? "";
  const last = entries[entries.length - 1]?.at ?? "";

  const lines: string[] = [
    "# apiM diagnostics",
    "",
    `${entries.length} event${entries.length === 1 ? "" : "s"} recorded, ` +
      `from ${first.slice(0, 16).replace("T", " ")} ` +
      `to ${last.slice(0, 16).replace("T", " ")}.`,
    "",
    "Grouped by what happened, most frequent first. Nothing here leaves your " +
      "machine unless you share it, and keys are stripped before writing.",
    "",
    "| # | What | Where | Most recent example |",
    "| --- | --- | --- | --- |",
  ];

  for (const gr of groups.slice(0, 40)) {
    const cell = (s: string) => s.replace(/\|/g, "\\|");
    lines.push(
      `| ${gr.count} | ${KIND_LABEL[gr.kind] ?? gr.kind} | \`${cell(
        gr.subject
      )}\` | ${cell(gr.example)} |`
    );
  }

  lines.push("", "## Most recent, in order", "");
  for (const e of entries.slice(-25)) {
    lines.push(
      `- \`${e.at.slice(11, 19)}\` **${KIND_LABEL[e.kind] ?? e.kind}** ` +
        `\`${e.subject}\` — ${e.detail}`
    );
  }
  lines.push("");

  return lines.join("\n");
}

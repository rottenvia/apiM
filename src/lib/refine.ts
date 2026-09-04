import type { LessonUpdate, Lesson } from "@/lib/lessons";

/**
 * Turning what happened into what was learned.
 *
 * This is the pass that makes the difference between a notepad and something
 * that improves. It reads the outcomes of a finished task — which commands
 * ran, which failed, what the errors said — and asks a model to write down
 * only the facts that would have saved time if they had been known at the
 * start.
 *
 * Three deliberate choices:
 *
 *   - It runs on Flash, not Pro. Summarising outcomes is not reasoning work,
 *     and Flash is roughly a third of the price. Spending Pro tokens to save
 *     Pro tokens would undo the point.
 *   - It is given outcomes, not the transcript. The full history is tens of
 *     thousands of tokens and adds nothing: what matters is what succeeded
 *     and what failed.
 *   - Thinking is disabled. This is extraction, not deliberation, and
 *     reasoning tokens are the most expensive thing on the bill.
 */

/** One thing the agent did, and how it turned out. */
export interface Outcome {
  name: string;
  args: string;
  ok: boolean;
  summary: string;
}

const REFINE_SYSTEM = `You record what was learned while working in a project, so the same ground is not covered twice.

You will be given the actions taken during one task and whether each worked.

Write only facts that are PROVEN by those outcomes and that would have saved time if known at the start. Good examples:
- "npm install fails here; this project uses pnpm" (proved by a failed command)
- "tests live in spec/, not tests/" (proved by a path that did not exist)
- "the build needs NODE_OPTIONS=--max-old-space-size=4096" (proved by an OOM)

Never write:
- guesses, risks, or things that "might" happen
- restatements of what the task was
- generic advice true of any project ("write tests", "handle errors")
- anything not demonstrated by the outcomes you were given

If an outcome contradicts something in KNOWN, replace it: give the id in "replaces".
If an outcome confirms something in KNOWN, list its id in "confirms".

Most tasks teach nothing durable. Returning empty lists is the correct and common answer — never invent a lesson to seem useful.

Reply with JSON only:
{"lessons":[{"text":"...","evidence":"...","replaces":"id or omit"}],"confirms":["id"]}`;

/** Compact the outcomes into the smallest useful evidence for the model. */
export function buildOutcomeDigest(outcomes: Outcome[]): string {
  const lines: string[] = [];
  for (const o of outcomes) {
    let target = "";
    try {
      const parsed = JSON.parse(o.args) as Record<string, unknown>;
      const v = parsed.command ?? parsed.path ?? parsed.query;
      if (typeof v === "string") target = ` ${v}`;
    } catch {
      /* arguments that will not parse still have a name */
    }
    lines.push(`${o.ok ? "OK  " : "FAIL"} ${o.name}${target} — ${o.summary}`);
  }
  return lines.join("\n");
}

export interface RefineResult {
  lessons: LessonUpdate[];
  confirms: string[];
  /** Tokens spent, so the cost of learning is never hidden. */
  usage: { prompt_tokens: number; completion_tokens: number } | null;
}

/**
 * Ask a cheap model what this task proved.
 *
 * Failures are returned as empty rather than thrown: a refine pass is an
 * optional extra after the real work is already done and saved, and it must
 * never turn a finished task into a failed one.
 */
export async function runRefine(
  outcomes: Outcome[],
  known: Lesson[],
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal,
  /**
   * Which model to ask. Defaults to DeepSeek Flash. Ox Alpha-only setups
   * pass `x-preview-f-free` and skip DeepSeek's `thinking` object.
   */
  options?: { model?: string; thinkingStyle?: "deepseek" | "openai" | "qwen" }
): Promise<RefineResult> {
  const empty: RefineResult = { lessons: [], confirms: [], usage: null };

  // Nothing ran, so nothing was demonstrated.
  if (outcomes.length === 0) return empty;

  const digest = buildOutcomeDigest(outcomes);
  const knownBlock = known
    .filter((l) => !l.supersededBy)
    .map((l) => `[${l.id}] ${l.text}`)
    .join("\n");

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal,
      body: JSON.stringify({
        // Cheapest capable model: this is extraction, not reasoning.
        model: options?.model ?? "deepseek-v4-flash",
        // Reasoning tokens are the single most expensive part of a request,
        // and this task does not need any. DeepSeek needs an explicit
        // disable; OpenAI-compatible providers ignore the object.
        ...((!options?.thinkingStyle || options.thinkingStyle === "deepseek")
          ? { thinking: { type: "disabled" } }
          : {}),
        // Enough for a dozen short lessons and no more.
        max_tokens: 800,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: REFINE_SYSTEM },
          {
            role: "user",
            content:
              (knownBlock ? `KNOWN:\n${knownBlock}\n\n` : "") +
              `WHAT HAPPENED:\n${digest}`,
          },
        ],
      }),
    });

    if (!res.ok) return empty;

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const raw = body.choices?.[0]?.message?.content ?? "";
    if (!raw.trim()) return empty;

    const parsed = JSON.parse(raw) as {
      lessons?: unknown;
      confirms?: unknown;
    };

    const lessons: LessonUpdate[] = Array.isArray(parsed.lessons)
      ? parsed.lessons
          .map((l) => l as Record<string, unknown>)
          .filter(
            (l) => typeof l.text === "string" && typeof l.evidence === "string"
          )
          .slice(0, 12)
          .map((l) => ({
            text: String(l.text),
            evidence: String(l.evidence),
            replaces:
              typeof l.replaces === "string" && l.replaces
                ? l.replaces
                : undefined,
          }))
      : [];

    const confirms: string[] = Array.isArray(parsed.confirms)
      ? parsed.confirms.filter((c): c is string => typeof c === "string").slice(0, 20)
      : [];

    return {
      lessons,
      confirms,
      usage: body.usage
        ? {
            prompt_tokens: body.usage.prompt_tokens ?? 0,
            completion_tokens: body.usage.completion_tokens ?? 0,
          }
        : null,
    };
  } catch {
    // Network blip, bad JSON, aborted request — the task itself is unaffected.
    return empty;
  }
}

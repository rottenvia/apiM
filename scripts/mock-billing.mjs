/**
 * A fake DeepSeek that keeps the books.
 *
 * `mock-deepseek.mjs` exists to prove the workspace works. This one exists to
 * answer a different question: where does the money actually go?
 *
 * It behaves like a model on a long agentic task — reasons at a realistic
 * length, calls tools, reads files back — and, crucially, it simulates
 * DeepSeek's prompt cache the way the real API implements it:
 *
 *   - the cache matches a PREFIX of the serialised request, from token zero
 *   - matching is done in 64-token blocks, so a partial block never counts
 *   - a cache hit costs 1/120th of a miss on Pro
 *
 * Every request is scored and attributed: how many tokens hit, how many
 * missed, and which messages the missed ones came from. That last part is
 * what turns "it costs too much" into "the file tree is 41% of your bill".
 *
 * Run indirectly via `npm run cost:lab`.
 */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const PORT = Number(process.env.MOCK_PORT ?? 8821);
const REPORT = process.env.BILL_REPORT ?? "";

/** DeepSeek's published rates, per 1M tokens. */
const RATES = {
  "deepseek-v4-pro": { input: 0.435, cached: 0.003625, output: 0.87 },
  "deepseek-v4-flash": { input: 0.14, cached: 0.0028, output: 0.28 },
};

/** Cache granularity. A partially matching block is not a hit. */
const BLOCK = 64;

/** DeepSeek averages close to this on English + code. */
const CHARS_PER_TOKEN = 3.6;
const tok = (chars) => Math.max(0, Math.round(chars / CHARS_PER_TOKEN));

/**
 * How long the model reasons per round, in characters.
 *
 * Taken from a real run rather than invented: ~9k tokens of reasoning on max
 * effort, less as effort drops. This is the single largest output cost, so
 * getting the shape right matters more than the exact figure.
 */
const REASONING_CHARS = {
  max: 32_000,
  high: 14_000,
  low: 2_500,
  none: 0,
};

/**
 * What the model ACTUALLY does with the effort you asked for.
 *
 * From DeepSeek's own table (verified at api-docs.deepseek.com/guides/
 * thinking_mode). This is not a detail: on the Pro model, `low` is mapped
 * up to `high`. Asking Pro to think less does nothing at all.
 *
 *   requested   flash     pro
 *   low         low       high
 *   high        high      high
 *   max         max       max
 */
function actualEffort(requested, model) {
  if (requested === "none") return "none";
  if (model === "deepseek-v4-flash") return requested === "max" ? "max" : requested === "low" ? "low" : "high";
  // Pro has only two real settings.
  return requested === "max" ? "max" : "high";
}

/**
 * Everything sent so far, as prefix strings, so a later request can be scored
 * against the longest prefix any earlier one established.
 *
 * The real cache is shared across requests and survives for minutes, which is
 * exactly this.
 */
const seenPrefixes = [];

/** Per-message serialised size, so a miss can be blamed on something. */
function messageParts(messages) {
  return messages.map((m) => {
    const s = JSON.stringify(m);
    let kind = m.role;
    if (m.role === "system" && typeof m.content === "string") {
      kind = m.content.startsWith("Current workspace contents")
        ? "file-tree"
        : m.content.startsWith("Workspace changes since")
          ? "tree-delta"
          : "system-prompt";
    } else if (m.role === "assistant") {
      kind = m.reasoning_content ? "assistant+reasoning" : "assistant";
    }
    return { kind, chars: s.length, reasoning: (m.reasoning_content ?? "").length };
  });
}

/** Longest common prefix length, in characters. */
function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

const rounds = new Map();
const bill = {
  requests: [],
  totals: {
    hitTokens: 0,
    missTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    cost: 0,
  },
  /** Miss tokens attributed to the kind of message they came from. */
  missByKind: {},
};

function score(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const model = body.model ?? "deepseek-v4-pro";
  const rates = RATES[model] ?? RATES["deepseek-v4-pro"];

  /*
   * Tools ride along on every request and, on the real API, sit in front of
   * the messages for caching purposes. Counting them as part of the prefix is
   * what makes "26 tool schemas" show up as a first-request cost rather than
   * a per-round one.
   */
  const toolsBlob = body.tools ? JSON.stringify(body.tools) : "";
  const serialised = toolsBlob + messages.map((m) => JSON.stringify(m)).join("");

  let bestMatch = 0;
  for (const prev of seenPrefixes) {
    const n = commonPrefix(prev, serialised);
    if (n > bestMatch) bestMatch = n;
  }
  seenPrefixes.push(serialised);

  const promptTokens = tok(serialised.length);
  // Block-align the hit: a half-matched block is charged as a miss.
  const rawHit = tok(bestMatch);
  const hitTokens = Math.floor(rawHit / BLOCK) * BLOCK;
  const missTokens = Math.max(0, promptTokens - hitTokens);

  // Attribute the miss. Walk messages from the end backwards until the missed
  // characters are accounted for — the tail is always what missed.
  const parts = messageParts(messages);
  const missChars = serialised.length - bestMatch;
  const byKind = {};
  let remaining = missChars;
  for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
    const take = Math.min(parts[i].chars, remaining);
    byKind[parts[i].kind] = (byKind[parts[i].kind] ?? 0) + tok(take);
    remaining -= take;
  }
  if (remaining > 0 && toolsBlob) {
    byKind["tool-schemas"] = (byKind["tool-schemas"] ?? 0) + tok(Math.min(toolsBlob.length, remaining));
  }

  return { rates, promptTokens, hitTokens, missTokens, byKind, model };
}

createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      /* ignore */
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) {
      // A readiness probe, not a completion request. Billing it would put a
      // phantom round at the top of every report.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    const firstUser = messages.find((m) => m.role === "user");
    const key = String(firstUser?.content ?? "").slice(0, 200);
    const round = (rounds.get(key) ?? 0) + 1;
    rounds.set(key, round);

    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const effort = body.reasoning_effort ?? (body.thinking?.type === "disabled" ? "none" : "high");
    const totalRounds = Number(process.env.SIM_ROUNDS ?? 12);

    const scored = score(body);
    const effortUsed = actualEffort(effort, scored.model);

    if (process.env.DUMP_SHAPE) {
      const shape = messages.map((m, i) => {
        let kind = m.role;
        if (m.role === "system" && typeof m.content === "string")
          kind = m.content.startsWith("Current workspace contents") ? "TREE" : m.content.startsWith("Workspace changes since") ? "delta" : "sys";
        if (m.role === "assistant") kind = m.tool_calls?.length ? "asst+tools" : "asst";
        return `${i}:${kind}`;
      });
      console.error(`[shape r${round}] model=${body.model} tools=${hasTools} n=${messages.length} ` + shape.join(" ") + (messages.length ? "" : " RAW=" + raw.slice(0,300)));
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");

    // ---- What the model "says" this round ----
    const reasoning = "R".repeat(REASONING_CHARS[effortUsed] ?? REASONING_CHARS.high);
    let outputChars = reasoning.length;

    if (reasoning) {
      send({ choices: [{ delta: { reasoning_content: reasoning } }] });
    }

    if (hasTools && round < totalRounds) {
      /*
       * A realistic mix. Real agent runs are mostly reads with occasional
       * writes, and a write is what makes the file tree change — which is the
       * thing worth measuring.
       */
      const writeEvery = Number(process.env.SIM_WRITE_EVERY ?? 3);
      const writes = writeEvery > 0 && round % writeEvery === 0;
      const name = writes ? "write_file" : "read_file";
      const args = writes
        ? JSON.stringify({
            path: `src/generated/step${round}.ts`,
            content: `// step ${round}\n` + "export const x = 1;\n".repeat(40),
          })
        : JSON.stringify({ path: `src/lib/sample${round % 5}.ts` });

      outputChars += args.length;
      send({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${round}`,
                  type: "function",
                  function: { name, arguments: args },
                },
              ],
            },
          },
        ],
      });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    } else {
      rounds.delete(key);
      const answer = "Done. ".repeat(60);
      outputChars += answer.length;
      send({ choices: [{ delta: { content: answer } }] });
      send({ choices: [{ delta: {}, finish_reason: "stop" }] });
    }

    const completionTokens = tok(outputChars);
    const cost =
      (scored.missTokens / 1e6) * scored.rates.input +
      (scored.hitTokens / 1e6) * scored.rates.cached +
      (completionTokens / 1e6) * scored.rates.output;

    bill.requests.push({
      round,
      model: scored.model,
      effort: effortUsed,
      effortRequested: effort,
      promptTokens: scored.promptTokens,
      hitTokens: scored.hitTokens,
      missTokens: scored.missTokens,
      completionTokens,
      reasoningTokens: tok(reasoning.length),
      missByKind: scored.byKind,
      cost,
    });
    bill.totals.hitTokens += scored.hitTokens;
    bill.totals.missTokens += scored.missTokens;
    bill.totals.outputTokens += completionTokens;
    bill.totals.reasoningOutputTokens += tok(reasoning.length);
    bill.totals.cost += cost;
    for (const [k, v] of Object.entries(scored.byKind)) {
      bill.missByKind[k] = (bill.missByKind[k] ?? 0) + v;
    }
    if (REPORT) writeFileSync(REPORT, JSON.stringify(bill, null, 2));

    send({
      choices: [{ delta: {} }],
      usage: {
        prompt_tokens: scored.promptTokens,
        completion_tokens: completionTokens,
        total_tokens: scored.promptTokens + completionTokens,
        prompt_cache_hit_tokens: scored.hitTokens,
        prompt_cache_miss_tokens: scored.missTokens,
      },
    });

    res.write("data: [DONE]\n\n");
    res.end();
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[mock billing] listening on http://127.0.0.1:${PORT}`);
});

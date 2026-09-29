/**
 * A scripted model that fails the way real endpoints do.
 *
 * mock-autonomy plays cooperative, lazy and dishonest models; this one
 * plays a slow, flaky endpoint at max reasoning effort. Every scenario here
 * is a failure measured on a live DeepSeek V4.1 Flash run, turned into
 * something that can be replayed for free on every change:
 *
 *   - a think that drafts a whole program in thought (461 lines, 15 min),
 *   - a connection that drops mid-think (the run then went thought-less),
 *   - a drop in the no-thinking round after a cut-over,
 *   - an answer cut off by the output limit,
 *   - edits sent without a path.
 *
 * The scenario is picked per conversation by a `[scenario:name]` tag in the
 * first user message, so one mock serves a whole suite. Every request body
 * is appended to MOCK_LOG (one JSON line: scenario, turn index, whether
 * thinking was on, the messages) — the suite asserts on what the app SENT
 * after each failure, which is where every one of those bugs showed.
 */
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.MOCK_PORT ?? 8831);
const LOG = process.env.MOCK_LOG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const think = (text, then) => ({ kind: "think", text, then });
const tool = (name, args) => ({ kind: "tool", name, args });
const say = (text, finish = "stop", then) => ({ kind: "say", text, finish, then });
/** Stream reasoning, then end the body with no finish_reason: a dropped connection. */
const drop = (reasoning) => ({ kind: "drop", reasoning });
/** Think forever, drafting fenced code, until the client hangs up. */
const draft = () => ({ kind: "draft" });
/** Think slowly (prose) until the client hangs up — for Stop. */
const slowThink = () => ({ kind: "slowThink" });
/** Several tool calls in one round. */
const tools = (...calls) => ({ kind: "tools", calls });

const prose = (n) =>
  Array.from({ length: n }, (_, i) => `Considering option ${i}: the loader must stay in one environment.`).join(" ");

const SCENARIOS = {
  draft_cutover: [
    draft(),
    tool("write_file", { path: "app.lua", content: "print('hi')\n" }),
    think("Wrote it; checking it next.", tool("read_file", { path: "app.lua" })),
    say("Done."),
  ],
  drop_mid_think: [
    drop(prose(60)),
    think("Resuming from the carried reasoning.", tool("write_file", { path: "x.txt", content: "x\n" })),
    say("Done."),
  ],
  drop_after_cutover: [
    draft(),
    drop("a"),
    tool("write_file", { path: "b.lua", content: "return 1\n" }),
    think("Now verify.", tool("read_file", { path: "b.lua" })),
    say("Done."),
  ],
  length_cut: [
    think("Short plan.", say("The first half of a long answer, cut off at the", "length")),
    say(" limit — and the rest of it. Now the file.", "tool_calls", tool("write_file", { path: "c.txt", content: "c\n" })),
    think("Now check it.", tool("read_file", { path: "c.txt" })),
    say("Done."),
  ],
  stop_mid_think: [slowThink()],
  stop_mid_batch: [
    tools(
      tool("run_command", { command: "python3", args: ["-c", "import time; time.sleep(4)"] }),
      tool("write_file", { path: "late.txt", content: "late\n" })
    ),
    say("Done."),
  ],
  budget_prose: Array.from({ length: 30 }, () => say("More of a very long answer. ", "length")),
  // Two helpers in one round: they must run side by side, and their
  // reports must come back as the two tool results.
  delegate_pair: [
    tools(
      tool("delegate", { task: "Find where A is defined [scenario:delegate_pair]" }),
      tool("delegate", { task: "Find where B is defined [scenario:delegate_pair]" })
    ),
    say("Done."),
  ],
  pathless_edit: [
    tool("write_file", { path: "mod.py", content: "def f():\n    return 1\n" }),
    tool("edit_files", { edits: [{ old_text: "    return 1", new_text: "    return 2" }] }),
    say("Done."),
  ],
};

/** Turn index per conversation, keyed by the first user message. */
const progress = new Map();

function firstUserText(messages) {
  const m = messages.find((x) => x.role === "user");
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => p.text ?? "").join(" ");
  return "";
}

createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      /* ignore */
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const first = firstUserText(messages);
    const name = /\[scenario:(\w+)\]/.exec(first)?.[1] ?? "";

    // A delegate helper: non-streaming, answered with a one-line report
    // after a pause long enough to show whether two ran at the same time.
    if (body.stream === false) {
      const started = Date.now();
      await sleep(400);
      if (LOG) {
        appendFileSync(
          LOG,
          JSON.stringify({ scenario: name, event: "helper", task: first, started, ended: Date.now(), tools: (body.tools ?? []).map((t) => t.function?.name) }) + "\n"
        );
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: `REPORT: ${first.split(" [")[0]} — found at src/x.ts:1` } }],
        usage: { prompt_tokens: 2000, completion_tokens: 80, total_tokens: 2080 },
      }));
      return;
    }
    const turns = SCENARIOS[name] ?? [];
    const key = first.slice(0, 200);
    const index = progress.get(key) ?? 0;
    progress.set(key, index + 1);

    // DeepSeek style: thinking {type}; OpenRouter style: reasoning {effort}.
    const thinking =
      body.thinking?.type === "disabled" || body.reasoning?.effort === "none"
        ? "off"
        : "on";
    if (LOG) {
      appendFileSync(
        LOG,
        JSON.stringify({ scenario: name, index, thinking, messages: messages.slice(-4) }) + "\n"
      );
    }

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    let closed = false;
    let finished = false;
    res.on("close", () => {
      closed = true;
      // The client hung up before the response ended: Stop reached upstream.
      if (!finished && LOG) {
        appendFileSync(LOG, JSON.stringify({ scenario: name, index, event: "client_closed", at: Date.now() }) + "\n");
      }
    });
    const send = (o) => {
      if (!closed) res.write("data: " + JSON.stringify(o) + "\n\n");
    };
    const finish = (reason) => {
      send({ choices: [{ delta: {}, finish_reason: reason }] });
      send({
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 500, completion_tokens: 60, total_tokens: 560 },
      });
      finished = true;
      if (!closed) res.end("data: [DONE]\n\n");
    };

    const play = async (turn) => {
      if (!turn) {
        send({ choices: [{ delta: { content: "Nothing further." } }] });
        return finish("stop");
      }
      if (turn.kind === "think") {
        send({ choices: [{ delta: { reasoning_content: turn.text } }] });
        return play(turn.then);
      }
      if (turn.kind === "tool") {
        send({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: `call-${name}-${index}`,
                type: "function",
                function: { name: turn.name, arguments: JSON.stringify(turn.args) },
              }],
            },
          }],
        });
        return finish("tool_calls");
      }
      if (turn.kind === "tools") {
        send({
          choices: [{
            delta: {
              tool_calls: turn.calls.map((c, i) => ({
                index: i,
                id: `call-${name}-${index}-${i}`,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            },
          }],
        });
        return finish("tool_calls");
      }
      if (turn.kind === "slowThink") {
        for (let i = 0; i < 1200 && !closed; i++) {
          send({ choices: [{ delta: { reasoning_content: `Weighing approach ${i}. ` } }] });
          await sleep(50);
        }
        if (!closed) finish("stop");
        return;
      }
      if (turn.kind === "say") {
        send({ choices: [{ delta: { content: turn.text } }] });
        if (turn.then) return play(turn.then);
        return finish(turn.finish);
      }
      if (turn.kind === "drop") {
        send({ choices: [{ delta: { reasoning_content: turn.reasoning } }] });
        await sleep(20);
        // No finish_reason, no usage: the connection simply ends.
        finished = true;
        if (!closed) res.end();
        return;
      }
      if (turn.kind === "draft") {
        send({ choices: [{ delta: { reasoning_content: "Let me draft the whole module first.\n```lua\n" } }] });
        for (let i = 0; i < 2000 && !closed; i++) {
          send({ choices: [{ delta: { reasoning_content: `local v${i} = ${i} -- line ${i}\n` } }] });
          if (i % 20 === 0) await sleep(5);
        }
        if (!closed) finish("stop");
      }
    };
    await play(turns[index]);
  });
}).listen(PORT, "127.0.0.1", function () {
  console.log(`[mock loop] listening on ${this.address().port}`);
});

/**
 * A fake DeepSeek API for testing the workspace without spending money.
 *
 * It speaks the same streaming protocol as the real API and behaves like a
 * model doing a small task: think, call write_file, read the file back to
 * check it, then answer. The filename is taken from the prompt when one is
 * mentioned, so "create hello.js" really produces hello.js.
 *
 * Deliberately awkward in the same ways the real API is:
 *   - tool arguments arrive split across several chunks
 *   - reasoning arrives before the tool call
 * so this exercises the parts most likely to break.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8820);

/** Tracks how many rounds each conversation has done, keyed by first user message. */
const rounds = new Map();

function lastUserMessage(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return String(messages[i].content ?? "");
  }
  return "";
}

function pickFilename(prompt) {
  const explicit = prompt.match(/([\w-]+\.(py|js|ts|txt|md|json|html|css|sh))/i);
  if (explicit) return explicit[1];
  return "app.py";
}

function contentFor(filename) {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "js" || ext === "ts") return 'console.log("hello from apiM");\n';
  if (ext === "html") return "<h1>hello from apiM</h1>\n";
  if (ext === "md") return "# hello\n\nWritten by the mock model.\n";
  if (ext === "json") return '{\n  "hello": "apiM"\n}\n';
  if (ext === "sh") return '#!/bin/sh\necho "hello from apiM"\n';
  return 'print("hello from apiM")\n';
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

    const prompt = lastUserMessage(body);
    const key = prompt.slice(0, 200);
    const round = (rounds.get(key) ?? 0) + 1;
    rounds.set(key, round);

    // No tools offered means the workspace is off — just answer.
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");

    const filename = pickFilename(prompt);
    const fileBody = contentFor(filename);

    if (!hasTools) {
      rounds.delete(key);
      send({
        choices: [
          {
            delta: {
              reasoning_content:
                "No tools available, so I answer without touching files.",
            },
          },
        ],
      });
      for (const word of `I can't create files right now — the workspace is switched off for this message.`.split(
        " "
      )) {
        send({ choices: [{ delta: { content: word + " " } }] });
      }
      send({
        choices: [{ delta: {} }],
        // A cache split, like the real API reports. Round one is mostly a
        // miss; later rounds are mostly hits. Without this the mock could
        // not catch the display pricing cached tokens at the uncached rate.
        usage: {
          prompt_tokens: 90,
          completion_tokens: 18,
          total_tokens: 108,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 90,
        },
      });
    } else if (round === 1) {
      send({
        choices: [
          {
            delta: { reasoning_content: `I should create ${filename}.` },
          },
        ],
      });
      // Arguments split mid-word across two chunks, exactly like the real API.
      const args = JSON.stringify({ path: filename, content: fileBody });
      const cut = Math.floor(args.length / 2);
      send({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_write",
                  type: "function",
                  function: { name: "write_file", arguments: args.slice(0, cut) },
                },
              ],
            },
          },
        ],
      });
      send({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: args.slice(cut) } },
              ],
            },
          },
        ],
      });
    } else if (round === 2) {
      send({
        choices: [
          { delta: { reasoning_content: "Now I read it back to verify." } },
        ],
      });
      send({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_read",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: filename }),
                  },
                },
              ],
            },
          },
        ],
      });
    } else {
      rounds.delete(key);
      const answer = `Done — I created \`${filename}\` in your workspace and read it back to confirm it saved correctly.`;
      for (const word of answer.split(" ")) {
        send({ choices: [{ delta: { content: word + " " } }] });
      }
      send({
        choices: [{ delta: {} }],
        usage: {
          prompt_tokens: 320,
          completion_tokens: 42,
          total_tokens: 362,
          prompt_cache_hit_tokens: 288,
          prompt_cache_miss_tokens: 32,
        },
      });
    }

    res.write("data: [DONE]\n\n");
    res.end();
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[mock deepseek] listening on http://127.0.0.1:${PORT}`);
});

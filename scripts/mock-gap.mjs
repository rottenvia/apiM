/**
 * A mock DeepSeek that reproduces the SILENT GAP by hand.
 *
 * scripts/mock-deepseek.mjs streams its first reasoning delta instantly, so
 * the pre-reasoning waiting state (the one from the double-loader bug report:
 * what mounts between send and the first reasoning token?) lived for
 * milliseconds — impossible to screenshot. This mock stretches it:
 *
 *   request 1 (FAIL_FIRST=1, default): 500 after ~1s — wakes the transient
 *            retry path, so the retry banner renders mid-gap.
 *   request 2: GAP_MS (default 6000) of total silence, then reasoning, then
 *            prose. The gap is where the waiting-state UI is judged.
 *   request 3+: a short normal stream so follow-up rounds work.
 *
 * Run: node scripts/mock-gap.mjs   (env: MOCK_GAP_PORT, GAP_MS, FAIL_FIRST)
 */
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_GAP_PORT ?? 8826);
const GAP_MS = Number(process.env.GAP_MS ?? 6000);
const FAIL_FIRST = process.env.FAIL_FIRST !== "0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

    if (FAIL_FIRST && !globalThis.__gapFailed) {
      globalThis.__gapFailed = true;
      await sleep(1000);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "gap mock: transient 500" } }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");

    // The silent gap: headers open, zero deltas, nothing on screen but the
    // waiting-state UI. This is the window to screenshot.
    await sleep(GAP_MS);

    send({
      choices: [
        {
          delta: {
            reasoning_content:
              "Gap mock reasoning: the silence before this line is the whole test.",
          },
        },
      ],
    });
    for (const word of "The gap closed and the answer streamed normally.".split(
      " "
    )) {
      send({ choices: [{ delta: { content: word + " " } }] });
    }
    send({
      choices: [{ delta: {} }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 40,
        total_tokens: 160,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 120,
      },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(
    `[mock-gap] on http://127.0.0.1:${PORT} — gap ${GAP_MS}ms, failFirst=${FAIL_FIRST}`
  );
});

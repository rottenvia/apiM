/**
 * Slash commands, the context meter's window sizes, and /compact.
 *
 * Run:  npm run test:slash
 *
 * /compact is driven end to end through its route handler against a local
 * mock model: the summary it stores must cover every turn, the next request
 * must replay none of them, and Retry (which removes the cursor turn) must
 * drop the summary rather than leave it describing a deleted answer.
 */
import path from "node:path";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.APIM_DATA_ROOT ??= path.join(ROOT, ".test-data", "slash");

const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const read = (p) => readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const SC = await load("src/lib/slash-commands.ts");
const M = await load("src/lib/models.ts");
const HS = await load("src/lib/history-summary.ts");
const store = await load("src/lib/store.ts");
const history = await load("src/lib/chat-history.ts");
const compactRoute = await load("src/app/api/conversations/[id]/compact/route.ts");
const { NextRequest } = await import("next/server");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);
let pass = 0,
  fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

// --- parsing ---
console.log("\nparse");
{
  const p = SC.parseSlash("/compact keep the API design");
  check("command with argument", p?.kind === "command" && p.command.name === "compact" && p.arg === "keep the API design");
  const a = SC.parseSlash("/clear");
  check("alias resolves to its command", a?.kind === "command" && a.command.name === "new");
  check("case-insensitive", SC.parseSlash("/MODEL glm")?.command?.name === "model");
  check("unknown plain word is reported", SC.parseSlash("/frobnicate")?.kind === "unknown");
  check("a path is a message, not a command", SC.parseSlash("/home/me/app.py is broken") === null);
  check("a leading space sends it as a message", SC.parseSlash(" /compact") === null);
  check("ordinary text is not a command", SC.parseSlash("hello /compact") === null);
  check("trailing newline still parses", SC.parseSlash("/stop\n")?.command?.name === "stop");
  const multi = SC.parseSlash("/fix the login\nit 500s on submit");
  check("multi-line argument is kept whole", multi?.arg === "the login\nit 500s on submit");
}

// --- registry ---
console.log("\nregistry");
{
  const names = SC.SLASH_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  check("no two commands share a name or alias", new Set(names).size === names.length, `${names.length} names`);
  check("every command has a description and group", SC.SLASH_COMMANDS.every((c) => c.description && c.group));
  check("plenty of commands", SC.SLASH_COMMANDS.length >= 30, `${SC.SLASH_COMMANDS.length}`);
  check("required-argument commands name the argument", SC.SLASH_COMMANDS.filter((c) => c.argRequired).every((c) => c.args));
  const fix = SC.findCommand("fix").prompt("login 500s");
  check("prompt shortcut carries the argument", fix.includes("login 500s") && /root cause/.test(fix));
  check("review never edits", /Do not change any files/.test(SC.findCommand("review").prompt("")));
  check("prefix matches rank first", SC.matchCommands("co")[0].name.startsWith("co") || SC.matchCommands("co")[0].aliases?.some((a) => a.startsWith("co")));
  check("empty word lists everything", SC.matchCommands("").length === SC.SLASH_COMMANDS.length);
  check("contains-match as a fallback", SC.matchCommands("act").some((c) => c.name === "compact"));
  const opts = [{ value: "glm-5.3-flash", label: "GLM 5.3 Flash" }, { value: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" }];
  check("options match by label", SC.matchOptions(opts, "deep")[0].value === "deepseek-v4.1-flash");
  check("options match by value", SC.matchOptions(opts, "glm")[0].value === "glm-5.3-flash");
  check("budget parses dollars", SC.parseBudget("$2.50") === 2.5 && SC.parseBudget("3") === 3);
  check("budget off clears", SC.parseBudget("off") === null);
  check("budget rejects nonsense", Number.isNaN(SC.parseBudget("lots")));
}

// --- context windows ---
console.log("\ncontext window");
{
  check("GLM 5.3 Flash is 1M", M.contextWindowFor("glm-5.3-flash") === 1_000_000);
  check("DeepSeek V4.1 Flash is 1M", M.contextWindowFor("deepseek-v4.1-flash") === 1_000_000);
  check("local model uses the sidecar window", M.contextWindowFor("qwen-3.8-27b") === 81_920);
  const custom = { id: "custom:x/y", label: "Y", apiModel: "x/y", vision: "none", video: false, maxOutputTokens: 8192, contextLength: 200_000 };
  check("custom model uses its verified length", M.contextWindowFor("custom:x/y", [custom]) === 200_000);
  check("custom without a length falls back", M.contextWindowFor("custom:x/y", [{ ...custom, contextLength: undefined }]) === M.FALLBACK_CONTEXT_TOKENS);
  check("every catalog model states a window", M.MODELS.every((m) => M.contextWindowFor(m.id) >= 32_000));
}

// --- history shape with a /compact cursor ---
console.log("\nhistory shape");
const turns = (n, from = 0) =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${from + i}`,
    role: (from + i) % 2 ? "assistant" : "user",
    content: `TURN-${from + i} ` + "x".repeat(40),
  }));
{
  const all = turns(12);
  const manual = { text: "s", upToId: "t11", droppedTurns: 0, updatedAt: "", manual: true };
  const s = HS.shapeHistory(all, manual);
  check("cursor on the newest turn: nothing rides verbatim", s.verbatim.length === 0 && s.pending.length === 0);
  const later = HS.shapeHistory([...all, ...turns(3, 12)], manual);
  check("turns after the cursor ride verbatim", later.verbatim.map((t) => t.id).join() === "t12,t13,t14");
  const auto = HS.shapeHistory(all, { text: "s", upToId: "t2", droppedTurns: 0, updatedAt: "" });
  check("automatic cursor keeps the old split", auto.verbatim.length === 9 && auto.pending.length === 1, `${auto.verbatim.length}/${auto.pending.length}`);
  const big = Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, role: "user", content: "y".repeat(19_000) }));
  const { chunks, skipped } = HS.compactChunks(big);
  check("long chats roll through several chunks", chunks.length > 1 && chunks.flat().length + skipped === 40, `${chunks.length} chunks`);
  check("chunks stay oldest-first", chunks.flat()[0].id === (skipped ? `b${skipped}` : "b0"));
}

// --- /compact end to end ---
console.log("\n/compact");
const seen = [];
const mock = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    seen.push(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: `Goal: ship it. Summary #${seen.length}.` } }],
        usage: { prompt_tokens: 1000, completion_tokens: 50 },
      })
    );
  });
});
await new Promise((ok) => mock.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${mock.address().port}/v1`;

const call = async (id, extra = {}) => {
  const req = new NextRequest(`http://localhost/api/conversations/${id}/compact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen-3.8-27b", localBaseUrl: base, ...extra }),
  });
  const res = await compactRoute.POST(req, { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
};

try {
  const convId = `slash-${Date.now()}`;
  const now = () => new Date().toISOString();
  const pairs = [];
  for (let i = 0; i < 6; i++) {
    pairs.push({ id: `u${i}`, role: "user", content: `question ${i} about src/app.ts`, createdAt: now() });
    pairs.push({ id: `a${i}`, role: "assistant", content: `answer ${i}`, createdAt: now() });
  }
  await store.appendMessages(convId, "slash test", pairs);

  const first = await call(convId, { instructions: "the database schema" });
  check("compact succeeds", first.status === 200, JSON.stringify(first.body).slice(0, 120));
  check("summary covers every turn", first.body.summary?.upToId === "a5" && first.body.summary?.coveredTurns === 12);
  check("marked as a manual compact", first.body.summary?.manual === true);
  const sent = seen.at(-1);
  check("sent every turn to the model", /question 0/.test(JSON.stringify(sent)) && /answer 5/.test(JSON.stringify(sent)));
  check("focus instruction reaches the prompt", /database schema/.test(sent.messages[0].content));
  check("thinking is switched off for the summary", sent.chat_template_kwargs?.enable_thinking === false);
  check("reports the history shrinking", first.body.afterChars < first.body.beforeChars, `${first.body.beforeChars} → ${first.body.afterChars}`);

  const shape = await history.loadHistoryForRequest(convId);
  check("next request replays no old turns", shape.verbatim.length === 0 && shape.stored?.upToId === "a5");

  const again = await call(convId);
  check("compacting twice with nothing new is refused", again.status === 400);

  await store.appendMessages(convId, "slash test", [
    { id: "u6", role: "user", content: "new question", createdAt: now() },
    { id: "a6", role: "assistant", content: "new answer", createdAt: now() },
  ]);
  const shape2 = await history.loadHistoryForRequest(convId);
  check("turns after the compact ride verbatim", shape2.verbatim.map((t) => t.id).join() === "u6,a6");
  const rolled = await call(convId);
  check("a second compact rolls only the new turns", rolled.status === 200 && !/question 0/.test(JSON.stringify(seen.at(-1))) && /new answer/.test(JSON.stringify(seen.at(-1))));
  check("…on top of the previous summary", /Summary #/.test(JSON.stringify(seen.at(-1))));

  await store.truncateFrom(convId, "a6");
  check("Retry removing the cursor turn drops the summary", !(await store.getConversation(convId)).historySummary);

  // --- review fixes ---
  const withImages = Array.from({ length: 40 }, (_, i) => ({
    id: `w${i}`,
    role: i % 2 ? "assistant" : "user",
    content: "z".repeat(2800),
    attachments: i % 2 ? null : Array.from({ length: 4 }, (_, k) => ({ kind: "image", name: `shot-${k}.png`, description: "d".repeat(190) })),
  }));
  const { chunks: sized } = HS.compactChunks(withImages);
  const overflow = sized.map((c) => HS.buildSummaryDigest(c).dropped).reduce((a, b) => a + b, 0);
  check("compact chunks are sized as rendered, attachments included — no turn falls out", overflow === 0, `${sized.length} chunks, ${overflow} dropped`);
  check("dropped digest turns are counted, not lost silently", /digestDropped \+= fresh\.droppedTurns/.test(read("src/app/api/conversations/[id]/compact/route.ts")));

  const longId = `slash-long-${Date.now()}`;
  const many = [];
  for (let i = 0; i < 15; i++) {
    many.push({ id: `lu${i}`, role: "user", content: `q${i}`, createdAt: now() });
    many.push({ id: `la${i}`, role: "assistant", content: `a${i}`, createdAt: now() });
  }
  await store.appendMessages(longId, "long", many);
  const lc = await call(longId);
  check("a long chat compacts", lc.status === 200 && lc.body.summary.upToId === "la14");
  await store.truncateFrom(longId, "la14");
  const moved = (await store.getConversation(longId)).historySummary;
  check("Retry on a long chat keeps the summary, cursor moved back", moved?.upToId === "lu14" && moved?.revised === true, JSON.stringify(moved && { upToId: moved.upToId, revised: moved.revised }));
  check("…and the model is told the transcript wins", /the conversation is right/.test(HS.renderHistorySummary(moved)));
  check("a summary cursor pointing at a deleted turn is refused", (await store.saveHistorySummary(longId, "lu14", { ...moved, upToId: "gone" })) === false);

  check("/budget 0 is refused rather than removing the limit", Number.isNaN(SC.parseBudget("0")) && SC.parseBudget("off") === null);
  const composerSrc = read("src/components/ChatArea.tsx");
  check("words after a command that takes none are not thrown away", /if \(!c\.args && arg\) \{/.test(composerSrc));
  check("sending waits while this chat compacts", /disabled=\{!canSend \|\| compacting\}/.test(composerSrc) && /if \(!canSend \|\| compacting\) return;/.test(composerSrc));
  check("a compact's result stays with its own chat", /const compacting = compactingKey === draftKey;/.test(composerSrc) && /compactNoticeState\.key === draftKey/.test(composerSrc));
  check("the message box is announced as the menu's combobox", /role="combobox"/.test(composerSrc) && /aria-activedescendant=/.test(composerSrc));
  check("/rename reports a rejected rename", /The chat was not renamed/.test(read("src/app/page.tsx")));

  const missing = await call(`nope-${Date.now()}`);
  check("unknown chat is a 404", missing.status === 404);

  const src = read("src/app/api/conversations/[id]/compact/route.ts");
  check("refuses while a reply is running", /activeRuns\(id\)\.length > 0/.test(src) && /status: 409/.test(src));

  // Every command must land somewhere: a prompt, a case in the composer,
  // or a case in the page. One that falls through does nothing at all.
  const composer = read("src/components/ChatArea.tsx");
  const pageSrc = read("src/app/page.tsx");
  const unhandled = SC.SLASH_COMMANDS.filter(
    (c) =>
      !c.prompt &&
      !composer.includes(`case "${c.name}":`) &&
      !pageSrc.includes(`case "${c.name}":`)
  ).map((c) => c.name);
  check("every command has a handler", unhandled.length === 0, unhandled.join(", "));

  const chat = read("src/app/api/chat/route.ts");
  check("an automatic refresh keeps a compact summary's detail", /summary\?\.manual\s*\?\s*\{\s*system: compactSystemPrompt\(\)/.test(chat));
  check("AGENTS.md is read into the standing instructions", /\["AGENTS\.md", "CLAUDE\.md"\]/.test(chat) && /projectNotesBlock \+\s*lessonsBlock,/.test(chat));
  check("usage events carry the round's context tokens", /contextTokens: lastContextTokens \|\| undefined/.test(chat));
} finally {
  mock.close();
}

console.log(`\n${pass + fail} checks · ${pass} passed`);
process.exit(fail ? 1 : 0);

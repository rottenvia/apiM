/**
 * Recall on demand: the model searching this conversation's transcript.
 *
 * Run:  npm run test:conversation-search
 *
 * The history summary keeps meaning but drops verbatim text. Rather than
 * replaying old turns every request "in case", the model pulls exact
 * earlier wording back with search_conversation when it actually needs it.
 * Strictly scoped: this chat only, never other chats.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
// Before tools loads: it pulls in the store, which reads this once.
process.env.APIM_DATA_ROOT = path.join(ROOT, ".test-data", "conversation-search");

const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const read = (p) => readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const CS = await load("src/lib/conversation-search.ts");
const tools = await load("src/lib/tools.ts");
const store = await load("src/lib/store.ts");
const route = read("src/app/api/chat/route.ts");

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

const turn = (id, role, content, extra = {}) => ({ id, role, content, ...extra });

// --- matching ---
check("whole-word mode skips inside-word occurrences", (() => {
  const out = CS.searchStoredMessages(
    [turn("a", "user", "open the calculator app")],
    "calc"
  );
  return out.totalMatches === 0 && out.hits.length === 0;
})());
check("partial mode matches inside words", (() => {
  const out = CS.searchStoredMessages(
    [turn("a", "user", "open the calculator app")],
    "calc",
    { wholeWord: false }
  );
  return out.totalMatches === 1 && out.hits[0].turnIndex === 1;
})());
check("matching ignores case", (() => {
  const out = CS.searchStoredMessages(
    [turn("a", "assistant", "Run PNPM install here")],
    "pnpm"
  );
  return out.totalMatches === 1;
})());
check("empty queries match nothing", (() => {
  const out = CS.searchStoredMessages([turn("a", "user", "hello")], "   ");
  return out.totalMatches === 0 && out.turnsSearched === 1;
})());
check("turns are numbered 1-based over the whole conversation", (() => {
  const out = CS.searchStoredMessages(
    [turn("a", "user", "nope"), turn("b", "user", "the token"), turn("c", "user", "nope")],
    "token"
  );
  return out.hits.length === 1 && out.hits[0].turnIndex === 2;
})());
check("excerpts window the match and mark trimmed edges", (() => {
  const out = CS.searchStoredMessages(
    [turn("a", "user", `${"p".repeat(500)} NEEDLE ${"q".repeat(500)}`)],
    "needle"
  );
  const e = out.hits[0].excerpt;
  return (
    e.includes("NEEDLE") &&
    e.startsWith("…") &&
    e.endsWith("…") &&
    e.length < 500
  );
})());
check("attachment descriptions are searchable when text is not", (() => {
  const out = CS.searchStoredMessages(
    [
      turn("a", "user", "see attached", {
        attachments: [{ name: "err.png", description: "red out-of-memory trace" }],
      }),
    ],
    "out-of-memory"
  );
  return out.totalMatches === 1 && out.hits[0].excerpt.includes("Shared:");
})());
check("limits clamp and overflow is flagged, not silent", (() => {
  const turns = Array.from({ length: 12 }, (_, i) =>
    turn(`m${i}`, "user", `needle ${i}`)
  );
  const lo = CS.searchStoredMessages(turns, "needle", { limit: 0 });
  const hi = CS.searchStoredMessages(turns, "needle", { limit: 99 });
  return (
    lo.hits.length === 1 &&
    lo.truncated &&
    hi.hits.length === 10 &&
    hi.truncated &&
    hi.totalMatches === 12
  );
})());

// --- tool definition ---
const def = tools.WORKSPACE_TOOLS.find(
  (t) => t.function.name === "search_conversation"
);
check("search_conversation is offered to the model", Boolean(def));
check(
  "the query is required and scoped to this chat in the description",
  def?.function.parameters.required.includes("query") &&
    /this chat only/i.test(def.function.description) &&
    /summary/i.test(def.function.description)
);

// --- dispatch (isolated store) ---
const stamp = Date.now();
const convA = `cs-a-${stamp}`;
const convB = `cs-b-${stamp}`;
const now = () => new Date().toISOString();
await store.appendMessages(convA, "chat a", [
  { id: "a0", role: "user", content: "how do I start this?", createdAt: now() },
  { id: "a1", role: "assistant", content: "run docker-compose up please", createdAt: now() },
  { id: "a2", role: "user", content: "the database seed failed", createdAt: now() },
]);
await store.appendMessages(convB, "chat b", [
  { id: "b0", role: "user", content: "docker-compose is great", createdAt: now() },
]);

const searched = await tools.runTool(
  "ws-test",
  "search_conversation",
  { query: "docker-compose" },
  { conversationId: convA }
);
check(
  "dispatch finds the verbatim turn with its position",
  searched.ok &&
    searched.content.includes("Turn 2 of 3") &&
    searched.content.includes("docker-compose up please")
);
const scoped = await tools.runTool(
  "ws-test",
  "search_conversation",
  { query: "docker-compose" },
  { conversationId: convB }
);
check(
  "dispatch never crosses into another chat",
  scoped.ok &&
    scoped.content.includes("Turn 1 of 1") &&
    !scoped.content.includes("Turn 2")
);
const none = await tools.runTool(
  "ws-test",
  "search_conversation",
  { query: "kubernetes" },
  { conversationId: convA }
);
check(
  "no matches is a helpful ok, not an error",
  none.ok && none.content.includes("No matches") && none.content.includes("3 turns")
);
const emptyQ = await tools.runTool(
  "ws-test",
  "search_conversation",
  { query: "   " },
  { conversationId: convA }
);
check("empty queries fail fast", !emptyQ.ok);
const unscoped = await tools.runTool("ws-test", "search_conversation", {
  query: "docker-compose",
});
check("searches without a scope read nothing", !unscoped.ok);

// --- route wiring ---
check(
  "route scopes tool dispatch to the current conversation",
  /conversationId: convId,/.test(route)
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

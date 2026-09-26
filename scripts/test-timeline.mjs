/**
 * Checks that narration and actions keep their order.
 *
 * Run:  npm run test:timeline
 *
 * The whole feature is the pairing — "I'll create the file" next to the write
 * it introduced. If the order is lost, the split view is just two columns of
 * unrelated things.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const { buildTimelineRows, textHasTable, appendThinkRange, timelineHasThinking } =
  await import(pathToFileURL(path.join(ROOT, "src/lib/timeline.ts")).href);
const { rebuildResumeFromStored } = await import(
  pathToFileURL(path.join(ROOT, "src/lib/rebuild-resume.ts")).href
);
const { readFileSync } = await import("node:fs");
const messageTimeline = readFileSync(
  path.join(ROOT, "src/components/MessageTimeline.tsx"),
  "utf8"
);
const messageBubble = readFileSync(
  path.join(ROOT, "src/components/MessageBubble.tsx"),
  "utf8"
);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

const ev = (id, summary) => ({ id, name: "write_file", args: "{}", ok: true, summary });

console.log("\napiM timeline checks\n");

console.log("1. Pairing narration with the action it introduced");
let rows = buildTimelineRows(
  [
    { kind: "text", text: "First the main file." },
    { kind: "tool", id: "a" },
    { kind: "text", text: "Now a helper." },
    { kind: "tool", id: "b" },
    { kind: "text", text: "All done." },
  ],
  [ev("a", "Created main.py"), ev("b", "Created helper.py")]
);
check("three rows", rows.length === 3, `${rows.length}`);
check("first pairs its own action",
  rows[0].text.includes("main file") && rows[0].tools[0].summary === "Created main.py");
check("second pairs its own action",
  rows[1].text.includes("helper") && rows[1].tools[0].summary === "Created helper.py");
check("closing text has no action", rows[2].tools.length === 0);

console.log("\n2. Consecutive actions group together");
rows = buildTimelineRows(
  [
    { kind: "text", text: "Creating three files." },
    { kind: "tool", id: "a" },
    { kind: "tool", id: "b" },
    { kind: "tool", id: "c" },
  ],
  [ev("a", "one"), ev("b", "two"), ev("c", "three")]
);
check("one row, not three", rows.length === 1, `${rows.length}`);
check("all three actions in it", rows[0].tools.length === 3);

console.log("\n3. Streaming fragments don't fragment the view");
// Text arrives word by word; it must not become one row per word.
rows = buildTimelineRows(
  [
    { kind: "text", text: "Hello " },
    { kind: "text", text: "there " },
    { kind: "text", text: "friend." },
  ],
  []
);
check("split text merges into one row", rows.length === 1, `${rows.length}`);
check("the text is intact", rows[0].text === "Hello there friend.", JSON.stringify(rows[0].text));

console.log("\n4. Awkward shapes");
check("empty timeline yields nothing", buildTimelineRows([], []).length === 0);

rows = buildTimelineRows([{ kind: "tool", id: "a" }], [ev("a", "Created x")]);
check("an action with no preceding text still shows",
  rows.length === 1 && rows[0].tools.length === 1);

rows = buildTimelineRows(
  [{ kind: "text", text: "hi" }, { kind: "tool", id: "missing" }],
  []
);
check("an unknown action id is skipped, not crashed",
  rows.length === 1 && rows[0].tools.length === 0);

rows = buildTimelineRows([{ kind: "text", text: "just talking" }], []);
check("prose with no actions is one plain row",
  rows.length === 1 && rows[0].tools.length === 0);

console.log("\n5. Order is never rearranged");
rows = buildTimelineRows(
  [
    { kind: "tool", id: "a" },
    { kind: "text", text: "middle" },
    { kind: "tool", id: "b" },
  ],
  [ev("a", "first"), ev("b", "second")]
);
check("an action before any text keeps its place",
  rows[0].tools[0].summary === "first" && rows[1].tools[0].summary === "second");

console.log("\n6. A table is isolated, not squeezed beside the divider");
check("a GFM table is detected",
  textHasTable("header\n| a | b |\n|---|---|\n| 1 | 2 |") === true &&
    textHasTable("| a | b |\n|---|---|") === true);
check("plain prose is not mistaken for a table",
  textHasTable("Here is the plan.\n- first\n- second") === false &&
    textHasTable("") === false);
check("a row with a table is never split beside the tool column",
  /const split = hasText && hasTools && !textHasTable\(shown\);/.test(
    messageTimeline
  ),
  "squeezed into the left column the vertical divider reads as cutting through the table");

console.log("\n7. Streaming never re-parses finished rows");
check("rows are memoised on text plus tool identity",
  /memo\(function TimelineRow/.test(messageTimeline) &&
    /sameTools\(prev\.tools, next\.tools\)/.test(messageTimeline),
  "a completed row's tools keep their identity across stream frames");
check("rows render deferred markdown while live, exact text on done",
  /useDeferredValue\(text\)/.test(messageTimeline) &&
    /const shown = live \? deferredText : text;/.test(messageTimeline) &&
    /RowMarkdown text=\{shown\}/.test(messageTimeline) &&
    /live=\{message\.isStreaming\}/.test(messageBubble),
  "formatting stays live but the parse skips busy frames");

console.log("\n8. Thinking sits where it happened");
{
  // Round 1 thinks, narrates, writes; round 2 thinks and writes again.
  const tl = [];
  appendThinkRange(tl, 0, 40);
  appendThinkRange(tl, 40, 90); // same burst, next frame
  tl.push({ kind: "text", text: "I'll create the file." });
  tl.push({ kind: "tool", id: "a" });
  appendThinkRange(tl, 92, 150); // round 2 (after the round gap)
  tl.push({ kind: "tool", id: "b" });
  check("frames of one burst extend a single think entry",
    tl.filter((e) => e.kind === "think").length === 2 &&
      tl[0].start === 0 && tl[0].end === 90);
  const rows = buildTimelineRows(tl, [ev("a", "wrote a"), ev("b", "wrote b")]);
  check("each round's reasoning is its own row, before what it led to",
    rows.length === 4 &&
      rows[0].think?.start === 0 && rows[0].think?.end === 90 &&
      rows[1].text === "I'll create the file." && rows[1].tools[0]?.id === "a" &&
      rows[2].think?.start === 92 &&
      rows[3].tools[0]?.id === "b" && !rows[3].think,
    "the newest thinking is at the bottom, beside the newest tool — not in a box at the top");
  check("a tool after thinking never lands inside the think row",
    rows.every((row) => !row.think || (row.tools.length === 0 && row.text === "")));
  check("the timeline reports it places reasoning in-line",
    timelineHasThinking(tl) && !timelineHasThinking([{ kind: "text", text: "x" }]));
  check("an empty range records nothing",
    appendThinkRange([], 5, 5).length === 0);

  const rebuilt = rebuildResumeFromStored({
    id: "m", role: "assistant", content: "I'll create the file.",
    reasoningContent: "x".repeat(150), createdAt: "",
    toolEvents: [
      { id: "a", name: "write_file", args: "{}", ok: true, summary: "wrote a" },
      { id: "b", name: "write_file", args: "{}", ok: true, summary: "wrote b" },
    ],
    timeline: tl,
  });
  check("resume rebuilding skips reasoning ranges instead of stalling on them",
    rebuilt !== null &&
      rebuilt.messages.filter((m) => m.role === "assistant").length === 2 &&
      rebuilt.messages.filter((m) => m.role === "tool").length === 2,
    "a think entry matched neither branch of the replay loop and never advanced it — and it marks a new round");
  check("the bubble hands the reasoning to the timeline and steps its top box aside",
    /inlineThinking = useTimeline && timelineHasThinking/.test(messageBubble) &&
      /\{hasThinking && !inlineThinking && \(/.test(messageBubble) &&
      /reasoning=\{message\.reasoningContent/.test(messageBubble));
  check("a live think renders only its tail while followed",
    /LIVE_TAIL_CHARS/.test(messageTimeline) && /LIVE_TAIL_CHARS/.test(messageBubble),
    "laying out the whole think ten times a second is what made it crawl");
}

console.log("\n9. Every tool reads as what it is");
{
  const { describeTool } = await import(
    pathToFileURL(path.join(ROOT, "src/lib/tool-display.ts")).href
  );
  const rf = describeTool("read_files", JSON.stringify({ paths: ["src/A.luau", "src/B.luau", "tests/x.luau"] }));
  check("read_files is a read with a file count, not a pencil and a raw name",
    rf.kind === "read" && rf.done === "Read" && rf.target === "3 files",
    "the screenshot showed 'read_files' beside the edit icon");
  check("one path shows the path",
    describeTool("read_files", JSON.stringify({ paths: ["src/A.luau"] })).target === "src/A.luau");
  const ws = describeTool("web_search", JSON.stringify({ query: "luau signal library" }));
  check("a web search shows its query in prose",
    ws.kind === "web" && ws.target === "luau signal library" && !ws.mono);
  const rc = describeTool("run_command", JSON.stringify({ command: "npm", args: ["test"] }));
  check("a command shows its command line", rc.kind === "run" && rc.target === "npm test" && rc.mono);
  check("a plan shows its step count",
    describeTool("make_plan", JSON.stringify({ goal: "g", steps: ["a", "b", "c"] })).target === "3 steps");
  check("streaming (partial) arguments still yield the path",
    describeTool("write_file", '{"path":"src/Store.lu').target === "src/Store.lu");
  const unknown = describeTool("my_custom_tool", "{}");
  check("an unknown tool is humanised, not printed raw", unknown.done === "My custom tool" && unknown.kind === "other");
  check("the row uses the descriptor", /describeTool\(/.test(readFileSync(path.join(ROOT, "src/components/ToolActivity.tsx"), "utf8")));
}

console.log("\n" + (fail === 0 ? g(`All ${pass} checks passed.`) : r(`${fail} of ${pass + fail} failed.`)) + "\n");
process.exit(fail === 0 ? 0 : 1);

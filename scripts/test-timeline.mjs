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
const { buildTimelineRows, textHasTable } = await import(
  pathToFileURL(path.join(ROOT, "src/lib/timeline.ts")).href
);
const { readFileSync } = await import("node:fs");
const messageTimeline = readFileSync(
  path.join(ROOT, "src/components/MessageTimeline.tsx"),
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
  /const split = hasText && hasTools && !textHasTable\(row\.text\);/.test(
    messageTimeline
  ),
  "squeezed into the left column the vertical divider reads as cutting through the table");

console.log("\n" + (fail === 0 ? g(`All ${pass} checks passed.`) : r(`${fail} of ${pass + fail} failed.`)) + "\n");
process.exit(fail === 0 ? 0 : 1);

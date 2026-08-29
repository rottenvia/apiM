/**
 * Batching: one round should carry a batch of work, not one item.
 *
 * Run:  npm run test:batching
 *
 * The reported failure was GLM 5.3 Flash specifically: "it reads with tools
 * and makes like 50 calls for reads so it can't read the whole thing", and
 * "it can't batch edit a lot of files". Four separate causes, all checked
 * here:
 *
 *   1. Parallel tool calls arriving with a reused (or absent) stream index
 *      were concatenated into ONE call, whose arguments were several JSON
 *      objects glued together — unparseable, so a round of eight edits
 *      applied nothing.
 *   2. The per-round output ceiling was keyed off the PROVIDER, so a
 *      128K-output model served by OpenRouter was clipped to 64K. A big
 *      batch call is one enormous argument blob; clipped, it never parses.
 *   3. A batch cut off by the ceiling was discarded whole, so resending the
 *      same batch failed in the same place forever. The complete items are
 *      now recovered and run.
 *   4. read_files could only take literal paths, and the round guard was a
 *      flat 64 — so a model that reads one file per call ran out of rounds
 *      before it ran out of files.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

const transcript = await load("src/lib/transcript.ts");
const models = await load("src/lib/models.ts");
const limits = await load("src/lib/tool-limits.ts");
const route = read("src/app/api/chat/route.ts");

console.log("\napiM batching checks\n");

// ---------------------------------------------------------------- 1. stream
console.log("1. Parallel tool calls survive a provider that reuses the index");

const { ToolCallAccumulator } = transcript;

// A well-behaved provider: distinct indexes, arguments in fragments.
const tidy = new ToolCallAccumulator();
tidy.add({ index: 0, id: "a", function: { name: "read_file", arguments: '{"pa' } });
tidy.add({ index: 1, id: "b", function: { name: "read_file", arguments: '{"pa' } });
tidy.add({ index: 0, function: { arguments: 'th":"one.ts"}' } });
tidy.add({ index: 1, function: { arguments: 'th":"two.ts"}' } });
const tidyCalls = tidy.result();
check(
  "interleaved indexed fragments still assemble into two calls",
  tidyCalls.length === 2 &&
    tidyCalls[0].function.arguments === '{"path":"one.ts"}' &&
    tidyCalls[1].function.arguments === '{"path":"two.ts"}'
);

// The reported shape: three calls, all claiming slot 0, one after another.
const reused = new ToolCallAccumulator();
for (const [id, file] of [
  ["c1", "a.ts"],
  ["c2", "b.ts"],
  ["c3", "c.ts"],
]) {
  reused.add({ index: 0, id, function: { name: "edit_file", arguments: "" } });
  reused.add({ index: 0, id, function: { arguments: `{"path":"${file}"}` } });
}
const reusedCalls = reused.result();
check(
  "three calls on one index stay three calls",
  reusedCalls.length === 3,
  `got ${reusedCalls.length}`
);
check(
  "…and none of them has another call's arguments glued on",
  reusedCalls.every((c) => {
    try {
      return typeof JSON.parse(c.function.arguments).path === "string";
    } catch {
      return false;
    }
  })
);
check(
  "…in the order the model asked for them",
  reusedCalls.map((c) => JSON.parse(c.function.arguments).path).join(",") ===
    "a.ts,b.ts,c.ts"
);

// No index at all, and a new name rather than a new id.
const nameless = new ToolCallAccumulator();
nameless.add({ function: { name: "list_files", arguments: "{}" } });
nameless.add({ function: { name: "search_files", arguments: '{"query":"x"}' } });
const namelessCalls = nameless.result();
check(
  "a second call with no index and a different name is not appended to the first",
  namelessCalls.length === 2 &&
    namelessCalls[0].function.name === "list_files" &&
    namelessCalls[1].function.arguments === '{"query":"x"}'
);

// A provider that repeats metadata on every fragment must NOT be split.
const chatty = new ToolCallAccumulator();
chatty.add({ index: 0, id: "z", function: { name: "write_file", arguments: '{"path"' } });
chatty.add({ index: 0, id: "z", function: { name: "write_file", arguments: ':"x.ts",' } });
chatty.add({ index: 0, id: "z", function: { name: "write_file", arguments: '"content":"hi"}' } });
const chattyCalls = chatty.result();
check(
  "repeated id and name on every fragment is still one call",
  chattyCalls.length === 1 &&
    chattyCalls[0].function.name === "write_file" &&
    chattyCalls[0].function.arguments === '{"path":"x.ts","content":"hi"}'
);
check("reset clears everything", (chatty.reset(), chatty.result().length === 0));

// -------------------------------------------------------------- 2. ceilings
console.log("\n2. The output ceiling belongs to the model, not the front door");

check(
  "GLM 5.3 Flash gets its documented 128K output",
  models.maxOutputTokensFor("glm-5.3-flash") === 131_072
);
check(
  "Ox Alpha is unchanged",
  models.maxOutputTokensFor("ox-alpha") === 131_072
);
check(
  "the metered DeepSeek models keep the 64K bound",
  models.maxOutputTokensFor("deepseek-v4-pro") === 65_536 &&
    models.maxOutputTokensFor("deepseek-v4-flash") === 65_536
);
check(
  "every catalog model declares one",
  models.MODELS.every((m) => Number.isInteger(m.maxOutputTokens) && m.maxOutputTokens > 0)
);
check(
  "an unknown id falls back to the default model's ceiling",
  models.maxOutputTokensFor("nope") === models.maxOutputTokensFor(models.DEFAULT_MODEL_ID)
);
check(
  "the request asks for the model's ceiling, still wrapped by the spending cap",
  /max_tokens: maxTokensFor\(\s*budget,\s*model,[\s\S]{0,400}?maxOutputTokensFor\(model\)/.test(route)
);
check(
  "the old provider-keyed constants are gone from the route",
  !/OX_MAX_OUTPUT_TOKENS/.test(route)
);
check(
  "local Qwen still defers to the sidecar window",
  /thinkingStyle === "qwen"\s*\?\s*SIDECAR_MAX_OUTPUT/.test(route)
);

// ----------------------------------------------------------------- 3. rounds
console.log("\n3. Rounds");

check(
  "the default round guard is unchanged at 64",
  limits.agentRoundsFor("deepseek-v4-pro") === 64 &&
    limits.agentRoundsFor("qwen-3.8-27b") === 64
);
check(
  "open-ceiling models get room for a long agent task",
  limits.agentRoundsFor("glm-5.3-flash") === 256 &&
    limits.agentRoundsFor("ox-alpha") === 256
);
check(
  "the route takes the guard from the model",
  /MAX_AGENT_ROUNDS = agentRoundsFor\(model\)/.test(route)
);
check(
  "hitting it is reported as the round cap, not as a provider abort",
  /stoppedPrematurely = "round_cap"/.test(route)
);

const revive = await load("src/lib/revive.ts");
check(
  "the banner says the reply can be resumed",
  /Resume/.test(revive.prematureStopNotice("round_cap"))
);
check(
  "the nudge tells the model to batch from here",
  /edit_files/.test(revive.reviveInstruction("round_cap"))
);

// ---------------------------------------------------------------- 4. salvage
console.log("\n4. A batch cut off mid-JSON still lands the finished work");

const whole = JSON.stringify({
  edits: [
    { path: "a.ts", old_text: "one", new_text: "1" },
    { path: "b.ts", old_text: "two", new_text: "2" },
    { path: "c.ts", old_text: "three", new_text: "3" },
  ],
});

const cutMidItem = whole.slice(0, whole.length - 30);
const salvaged = transcript.salvageToolArguments(cutMidItem, "edit_files");
check("a cut-off edit_files call is recoverable", Boolean(salvaged));
check(
  "the finished edits survive",
  salvaged?.value.edits?.length === 2 &&
    salvaged.value.edits[1].new_text === "2"
);
check(
  "the half-written edit at the end is dropped, not applied",
  !JSON.stringify(salvaged?.value ?? {}).includes("c.ts")
);
check(
  "the count is what the caller reports back to the model",
  transcript.batchItemCount("edit_files", salvaged.value) === 2
);

const cutMidString = whole.slice(0, whole.indexOf("two") + 1);
const partialString = transcript.salvageToolArguments(cutMidString, "edit_files");
check(
  "a cut inside a string keeps the earlier item and drops the broken one",
  partialString?.value.edits?.length === 1 &&
    partialString.value.edits[0].path === "a.ts"
);

const paths = JSON.stringify({ paths: ["one.ts", "two.ts", "three.ts"] });
const cutPaths = transcript.salvageToolArguments(paths.slice(0, -6), "read_files");
check(
  "read_files recovers the whole paths it received",
  cutPaths?.value.paths?.length === 2 &&
    transcript.batchItemCount("read_files", cutPaths.value) === 2
);

check(
  "complete JSON is not treated as a salvage case",
  transcript.salvageToolArguments(whole, "edit_files") === null
);
check(
  "nonsense is refused rather than guessed at",
  transcript.salvageToolArguments("not json at all", "edit_files") === null &&
    transcript.salvageToolArguments("", "edit_files") === null
);
check(
  "a tool with no batch shape reports no items",
  transcript.batchItemCount("write_file", { path: "a", content: "b" }) === 0
);
check(
  "the route runs the recovered items instead of throwing the call away",
  /salvageToolArguments\(/.test(route) &&
    /batchItemCount\(call\.function\.name/.test(route) &&
    /Send ONLY the remaining items/.test(route)
);

// ---------------------------------------------------------------- 4b. single-file prefix
console.log("\n4b. A huge single file cut mid-content keeps its prefix");

const bigContent = "export function thing() {\n  // line " +
  Array.from({ length: 220 }, (_, i) => `line ${i} of the big file`).join("\n  ") +
  "\n}\n";
const bigCall = JSON.stringify({ path: "src/big.ts", content: bigContent });
const cutBig = bigCall.slice(0, 800);
const pf = transcript.salvagePartialFile(cutBig);
check("a cut-off single write_file recovers a prefix", Boolean(pf));
check(
  "the recovered path is the file being written",
  pf?.path === "src/big.ts"
);
check(
  "the recovered prefix is the exact start of the file",
  Boolean(pf) && bigContent.startsWith(pf.contentPrefix)
);
check(
  "the prefix ends on a complete line",
  Boolean(pf) && pf.contentPrefix.endsWith("\n")
);

// A batch whose trailing item is the cut one: complete items salvage as a
// batch AND the trailing file's prefix is recoverable.
const batchCall = JSON.stringify({
  files: [
    { path: "a.txt", content: "AAAA" },
    { path: "b.txt", content: "B".repeat(4000) },
  ],
});
const cutBatch = batchCall.slice(0, batchCall.indexOf('"B"') + 700);
const pf2 = transcript.salvagePartialFile(cutBatch);
check(
  "the streaming file of a cut batch is recovered too",
  pf2?.path === "b.txt" && pf2.contentPrefix.length > 200
);

// A single-line file (no newlines) is still recovered.
const oneLine = JSON.stringify({ path: "min.json", content: "x".repeat(3000) });
const pf3 = transcript.salvagePartialFile(oneLine.slice(0, 900));
check(
  "a single-line file keeps its prefix",
  pf3?.path === "min.json" && pf3.contentPrefix.length >= 200
);

check(
  "a tiny fragment is refused rather than pretended complete",
  transcript.salvagePartialFile(
    JSON.stringify({ path: "x.ts", content: "short" })
  ) === null
);

check(
  "the route writes the recovered prefix and tells the model to append",
  /salvagePartialFile\(/.test(route) &&
    /RECOVERED AND WRITTEN/.test(route) &&
    /Send the REST of the file only/.test(route)
);

// ------------------------------------------------------------- 5. read_files
console.log("\n5. read_files takes globs, so a directory is one call");

const tmpData = await mkdtemp(path.join(os.tmpdir(), "apim-batching-"));
process.env.APIM_DATA_ROOT = tmpData;

const tools = await load("src/lib/tools.ts");
const workspace = await load("src/lib/workspace.ts");
const WS = "batching-" + Math.random().toString(36).slice(2, 8);

await workspace.writeFile(WS, "src/lib/one.ts", "export const one = 1;");
await workspace.writeFile(WS, "src/lib/two.ts", "export const two = 2;");
await workspace.writeFile(WS, "src/lib/notes.md", "# notes");
await workspace.writeFile(WS, "src/app/page.tsx", "export default null;");

const globbed = await tools.runTool(WS, "read_files", { paths: ["src/lib/*.ts"] });
check(
  "a pattern reads every file it matches",
  globbed.ok &&
    globbed.content.includes("export const one = 1;") &&
    globbed.content.includes("export const two = 2;")
);
check(
  "…and nothing it does not",
  !globbed.content.includes("# notes")
);

const mixed = await tools.runTool(WS, "read_files", {
  paths: ["src/app/page.tsx", "src/lib/*.ts", "src/lib/one.ts"],
});
check(
  "a literal path and a pattern can be mixed",
  mixed.ok && mixed.content.includes("export default null;")
);
check(
  "a file matched twice is read once",
  (mixed.content.match(/--- src\/lib\/one\.ts ---/g) ?? []).length === 1
);

const missed = await tools.runTool(WS, "read_files", { paths: ["src/nope/*.ts"] });
check(
  "a pattern that matches nothing says so instead of reporting an empty read",
  !missed.ok && /nothing matched/i.test(missed.content)
);

const stillLiteral = await tools.runTool(WS, "read_files", {
  paths: ["src/lib/one.ts", "src/lib/missing.ts"],
});
check(
  "one missing path does not lose the others",
  stillLiteral.ok &&
    stillLiteral.content.includes("export const one = 1;") &&
    /could not read/.test(stillLiteral.content)
);

const schema = tools
  .workspaceToolsFor("glm-5.3-flash")
  .find((t) => t.function.name === "read_files");
check(
  "the schema tells the model patterns are allowed",
  /glob/i.test(JSON.stringify(schema))
);
const readOne = tools
  .workspaceToolsFor("glm-5.3-flash")
  .find((t) => t.function.name === "read_file");
check(
  "…and read_file tells it not to walk a file in slices",
  /never walk a file in slices/i.test(JSON.stringify(readOne))
);
check(
  "the workspace prompt tells an open-ceiling model to work in batches",
  /Work in batches, not one item per call/.test(route)
);

await rm(tmpData, { recursive: true, force: true });

console.log(
  `\n${pass + fail} checks · ${pass} passed${fail ? ` · ${fail} failed` : ""}\n`
);
if (fail) process.exit(1);

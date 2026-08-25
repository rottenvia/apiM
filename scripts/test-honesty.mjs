/**
 * The reported problems, each with a test that fails without the fix.
 *
 * Run:  npm run test:honesty
 *
 * Everything here comes from one report, and every item was reproduced before
 * it was changed:
 *
 *   "agent was lying to me everytime ... he could just say actions taken:
 *    [read 3412321]"          -> checkAnswerClaims
 *   "when i was stopping generating he could stop planning at all and erase
 *    his planning"            -> readPlan / writePlan
 *   "he didnt use browse he used only fetch url"
 *                             -> NO_BROWSER_PROMPT
 *   "i couldnt upload ... .log file"
 *                             -> looksUtf16
 *   "i couldnt upload a whole folder"
 *                             -> readFolderTree
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rm } from "node:fs/promises";
import { finishSuite } from "./lib/proc.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_ROOT = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.join(ROOT, "data");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const readSrc = async (p) =>
  (await import("node:fs/promises")).readFile(path.join(ROOT, p), "utf8");

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

console.log("\napiM — the reported problems\n");

// ---------------------------------------------------------------- 1. lying

console.log('1. "actions taken: [read 3412321]" when nothing was read');

const P = await load("src/lib/plan.ts");

const FAKE = `Done. Actions taken: [read 3412321] [edited config.ts]

The configuration is now correct.`;

check(
  "a summary claiming file work with no file tool is caught",
  P.checkAnswerClaims(FAKE, []) !== null,
  "this is the exact reported shape"
);
check(
  "the note says nothing on disk was touched",
  /nothing on disk was touched/.test(P.checkAnswerClaims(FAKE, []) ?? ""),
  "the user has to be able to tell without checking themselves"
);

check(
  "the same summary is fine once a file tool really ran",
  P.checkAnswerClaims(FAKE, ["read_file"]) === null,
  "a false accusation would teach the user to ignore the warning"
);
check(
  "any real file tool clears it, not just read_file",
  P.checkAnswerClaims(FAKE, ["apply_patch"]) === null &&
    P.checkAnswerClaims(FAKE, ["write_files"]) === null
);

for (const [label, text] of [
  ["I edited the file", "I edited the file to add the header."],
  ["I read the file", "I have read the file and it looks fine."],
  ["created the files", "I created the files you asked for."],
  /*
   * The block has to NAME a file operation.
   *
   * This case used to be "Actions taken:\n- looked at main.ts", and it
   * passed because the heading alone was treated as a file claim. That is
   * what made the check fire on a reply ending "[Actions taken: web_search
   * — ...]" after a search that really ran — a warning for the wrong reason,
   * reported the moment it shipped. "looked at" is not a file verb, so the
   * old fixture was asserting the bug.
   */
  ["actions taken block", "Actions taken:\n- read main.ts and edited it"],
]) {
  check(`"${label}" is recognised as a claim`, P.checkAnswerClaims(text, []) !== null);
}

check(
  "an Actions-taken block that names no file operation is not a file claim",
  P.checkAnswerClaims("Actions taken:\n- looked at main.ts", []) === null,
  "the heading alone says nothing about disk"
);
check(
  "and a real search reported that way is left alone",
  P.checkAnswerClaims(
    "[Actions taken: web_search — Playwright version]",
    ["web_search"]
  ) === null,
  "the false positive that prompted this"
);

/*
 * The block is usually a bulleted list on the lines BELOW the heading.
 *
 * My first fix scanned only the heading line, which misses that shape
 * entirely — caught by an existing fixture that used it. Scanning across
 * newlines with a 400-character bound covers the real form without letting
 * "Actions taken:" near the top of a long reply match an unrelated "read" a
 * page later.
 */
check(
  "a multi-line block naming a file operation is caught",
  P.checkAnswerClaims("Actions taken:\n- read main.ts and edited it", []) !== null,
  "the heading line alone is not where the claim lives"
);
check(
  "and not when the file tool really ran",
  P.checkAnswerClaims("Actions taken:\n- read main.ts", ["read_file"]) === null
);
check(
  "a 'read' far below the block does not reach back",
  P.checkAnswerClaims(
    "Actions taken:\n- ok\n" + "x".repeat(500) + "\nread the docs",
    []
  ) === null,
  "the bound is what stops a heading matching the whole reply"
);
check(
  "naming a TOOL in the block is itself a claim it ran",
  P.checkAnswerClaims("[Actions taken: web_search — Playwright version]", []) !==
    null,
  "no verb needed: listing it under Actions taken asserts the call happened"
);

for (const [label, text] of [
  ["a plain answer", "Python's sorted() returns a new list; .sort() is in place."],
  ["a proposal", "You could add a cache here, but I have not changed anything."],
  ["a question", "Which database are you using? I can write the migration once I know."],
]) {
  check(
    `"${label}" is NOT flagged`,
    P.checkAnswerClaims(text, []) === null,
    "flagging ordinary prose would make the warning worthless"
  );
}

check(
  "an empty answer is never flagged",
  P.checkAnswerClaims("", []) === null
);

const routeSrc = await readSrc("src/app/api/chat/route.ts");
check(
  "the check is wired into the reply, not just exported",
  /checkAnswerClaims\(\s*assistantContent/.test(routeSrc),
  "a guard nobody calls is decoration"
);
check(
  "it appends a note rather than discarding the reply",
  /assistantContent \+= note/.test(routeSrc) &&
    !/throw new Error\("unverified/.test(routeSrc),
  "blocking would throw away work that may be good apart from the last line"
);

/*
 * The 15-minute case: a whole reply narrating builds, edits and a
 * "24/24 verified" check — none of it ran. The run_command family catches
 * it on "exit 0", and a real run_command clears it.
 */
const FAKE_BUILD =
  "Done, all three fronts delivered. The build came back green — exit 0, " +
  "the verifier says 24/24, and the edits landed in the source.";
check(
  "a narrated build with exit code and 'verified' is caught",
  P.checkAnswerClaims(FAKE_BUILD, []) !== null,
  "the exact reported shape: 15 minutes of invented output"
);
check(
  "…and is left alone once run_command really ran",
  P.checkAnswerClaims(FAKE_BUILD, ["run_command"]) === null,
  "a false accusation makes the warning dead weight"
);

/*
 * The post-hoc note was not enough: by the time it is appended, the user has
 * already waited through the narration and read the lie as the reply. The
 * same detector now runs INSIDE the loop, before the no-tool-call round is
 * allowed to end, and sends the reply back once to be redone or confessed.
 */
const pageSrc = await readSrc("src/app/page.tsx");
const plugins = await load("src/lib/plugins.ts");

check(
  "the same detector runs in the loop, before the turn is allowed to end",
  (routeSrc.match(/checkAnswerClaims\(/g) ?? []).length === 2,
  "once where the round ends without a tool call, once at final save"
);
check(
  "the in-loop catch is gated on having not retried yet",
  /!claimRetried\s*&&[\s\S]{0,120}checkAnswerClaims\(/.test(routeSrc) &&
    /let claimRetried = false;/.test(routeSrc),
  "one retry per run, then the final-save note is the last word"
);
check(
  "the retry is spent exactly once",
  (routeSrc.match(/claimRetried = true/g) ?? []).length === 1,
  "a model that lies after being caught must not get a second free pass"
);
check(
  "the corrective nudge offers both exits: do it, or say it was not done",
  /actually call the tools now[\s\S]{0,220}state plainly what was and was not done/.test(
    routeSrc
  ) && /reason: "unverified_claim"/.test(routeSrc),
  "the model may not have been able to run the tool at all — honesty is a valid ending"
);
check(
  "the base prompt forbids the narration outright",
  /Never describe tool work as done unless that tool was actually called/.test(
    plugins.BASE_PROMPT
  ) && /say plainly that it was not run/.test(plugins.BASE_PROMPT),
  "applies to every provider — the lie was worst on Ox Alpha but not unique to it"
);
check(
  "the client names the reason while the redo is happening",
  /evt\.reason === "unverified_claim"/.test(pageSrc) &&
    /claimed work that did not run/.test(pageSrc),
  "otherwise the second pause looks like the app hung"
);

// ------------------------------------------------------------- 2. the plan

console.log('\n2. "when i was stopping generating he could ... erase his planning"');

const WS = "honestytest";
await rm(path.join(DATA_ROOT, "plans"), { recursive: true, force: true });

check(
  "with nothing saved, reading gives null rather than throwing",
  (await P.readPlan(WS)) === null
);

const plan = P.createPlan("Ship the login page with tests passing", [
  "Read the existing auth module to see what exists",
  "Write the login form component",
  "Run the test suite and confirm it is green",
]);
const advanced = P.updatePlan(plan, [
  {
    id: 1,
    state: "done",
    verified: "Read src/auth.ts — it exports signIn and signOut only",
  },
]);
await P.writePlan(WS, advanced);

/*
 * This is the reported bug. The plan lived in a `let` inside the request
 * handler, so pressing Stop ended the request and took the plan with it.
 * Reading it back in a fresh call is exactly what the next message does.
 */
const reloaded = await P.readPlan(WS);
check(
  "a saved plan survives the request that made it",
  reloaded !== null && reloaded.steps.length === 3,
  reloaded ? `${reloaded.steps.length} steps` : "null"
);
check(
  "and the verified step is still verified",
  reloaded?.steps[0].state === "done" &&
    /signIn and signOut/.test(reloaded?.steps[0].verified ?? ""),
  "losing proof of finished work is what forces a re-plan from nothing"
);
check(
  "an unfinished plan is not treated as complete",
  P.planIsComplete(reloaded) === false
);

const finished = P.updatePlan(reloaded, [
  { id: 2, state: "done", verified: "Created LoginForm.tsx with the form markup" },
  { id: 3, state: "done", verified: "Ran npm test — 41 suites, everything passed" },
]);
check("a fully verified plan reports complete", P.planIsComplete(finished));

await P.writePlan(WS, null);
check(
  "clearing removes it, so a finished task cannot leak into the next",
  (await P.readPlan(WS)) === null
);

await P.writePlan(WS, advanced);
const planFile = path.join(DATA_ROOT, "plans", `${encodeURIComponent(WS)}.json`);
await (await import("node:fs/promises")).writeFile(planFile, "{ not json", "utf8");
check(
  "a corrupt plan file reads as no plan rather than crashing the reply",
  (await P.readPlan(WS)) === null,
  "recoverable: the agent makes a new one"
);
await rm(path.join(DATA_ROOT, "plans"), { recursive: true, force: true });

check(
  "the route loads a saved plan at the start of a reply",
  /const saved = await readPlan\(workspace\)/.test(routeSrc)
);
check(
  "and saves on every change, not at the end",
  (routeSrc.match(/await writePlan\(workspace, plan\)/g) ?? []).length >= 2,
  "saving only at the end is the same bug in a different place"
);
check(
  "a completed plan is cleared instead of carried forward",
  /planIsComplete\(saved\)/.test(routeSrc)
);

// ----------------------------------------------------------- 3. the browser

console.log('\n3. "he didnt use browse he used only fetch url"');

const policySrc = await readSrc("src/lib/browser-policy.ts");
check(
  "there is a prompt for when the browser is missing",
  /NO_BROWSER_PROMPT/.test(policySrc)
);
check(
  "it names the one command that fixes it",
  /npm run browser:install/.test(policySrc),
  "the tool was hidden and nothing said why"
);
check(
  "it says what fetch_url cannot do",
  /built by JavaScript/i.test(policySrc),
  "so the difference is understandable rather than mysterious"
);
check(
  "it forbids pretending fetch_url saw a rendered page",
  /Do not pretend fetch_url saw/.test(policySrc)
);
check(
  "the route picks the prompt that matches reality",
  /hasBrowser \? BROWSER_POLICY_PROMPT : NO_BROWSER_PROMPT/.test(routeSrc),
  "before this it described browsing while withholding the tool"
);

// -------------------------------------------------------------- 4. uploads

console.log('\n4. "i couldnt upload ... .log file"');

const A = await load("src/lib/attachments.ts");
const enc = new TextEncoder();

const utf16le = new Uint8Array([
  0xff, 0xfe, 0x49, 0x00, 0x4e, 0x00, 0x46, 0x00, 0x4f, 0x00, 0x0a, 0x00,
]);
check("a UTF-16 byte-order mark is detected", A.looksUtf16(utf16le) === "le");

// PowerShell writes UTF-16 with no BOM often enough to matter.
const noBom = new Uint8Array(
  [..."INFO started ok\nWARN retrying\n"].flatMap((c) => [c.charCodeAt(0), 0])
);
check(
  "UTF-16 without a byte-order mark is still detected",
  A.looksUtf16(noBom) === "le",
  "PowerShell redirection produces exactly this"
);
check(
  "and it is no longer called binary",
  A.bytesLookBinary(noBom) === false,
  "this is the reason a .log could not be attached"
);

check(
  "ordinary UTF-8 text is unaffected",
  A.bytesLookBinary(enc.encode("2026-08-12 INFO started\n")) === false &&
    A.looksUtf16(enc.encode("2026-08-12 INFO started\n")) === null
);
check(
  "a real binary is still refused",
  A.bytesLookBinary(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00])) ===
    true,
  "the fix must not open the door to executables"
);
check(
  "an ANSI-coloured log is text",
  A.bytesLookBinary(enc.encode("\u001b[32mINFO\u001b[0m up\n".repeat(40))) === false
);
check(
  ".log has no blanket refusal",
  A.binaryFormatNote("server.log") === null &&
    A.binaryFormatNote("debug.LOG") === null
);
check(
  ".dll is routed to inspect_binary rather than decoded as text",
  /inspect_binary/.test(A.binaryFormatNote("thing.dll") ?? ""),
  "it is readable through PE metadata/decompilation, not through text decoding"
);

// --------------------------------------------------------------- 5. folders

console.log('\n5. "i couldnt upload a whole folder"');

const AR = await load("src/lib/archive.ts");

/** A File stand-in carrying webkitRelativePath, as a folder pick produces. */
const fileFrom = (relPath, text) => {
  const bytes = enc.encode(text);
  return {
    name: relPath.split("/").pop(),
    size: bytes.length,
    webkitRelativePath: relPath,
    slice: () => ({ arrayBuffer: async () => bytes.buffer }),
    arrayBuffer: async () => bytes.buffer,
  };
};

check(
  "a file from a folder pick is recognised by its path",
  AR.folderPathOf(fileFrom("proj/src/a.ts", "x")) === "proj/src/a.ts"
);
check(
  "an ordinary file is not",
  AR.folderPathOf({ name: "a.ts" }) === ""
);

const tree = await AR.readFolderTree([
  fileFrom("proj/src/index.ts", "export const a = 1;\n"),
  fileFrom("proj/README.md", "# hello\n"),
  fileFrom("proj/node_modules/dep/index.js", "module.exports = 1;\n"),
  fileFrom("proj/.git/config", "[core]\n"),
]);

check(
  "the readable files come through",
  tree.entries.length === 2,
  tree.entries.map((e) => e.path).join(", ")
);
check(
  "paths are relative to the folder, like an archive",
  tree.entries.some((e) => e.path === "src/index.ts"),
  tree.entries.map((e) => e.path).join(", ")
);
check(
  "node_modules and .git are skipped, not attached",
  tree.skipped.length === 2,
  tree.skipped.map((s) => s.path).join(", ")
);
check(
  "entries are ordered, so the manifest reads like a listing",
  tree.entries[0].path.localeCompare(tree.entries[1].path) <= 0
);

const dllBytes = new Uint8Array(64);
dllBytes[0] = 0x4d;
dllBytes[1] = 0x5a;
const withBinary = await AR.readFolderTree([
  fileFrom("proj/app.ts", "const x = 1;\n"),
  {
    name: "native.dll",
    size: dllBytes.length,
    webkitRelativePath: "proj/native.dll",
    slice: () => ({ arrayBuffer: async () => dllBytes.buffer }),
    arrayBuffer: async () => dllBytes.buffer,
  },
]);
/*
 * The reported case: a folder with a .dll in it. It used to be skipped. The
 * source still arrives, and the DLL now stays byte-exact for inspect_binary.
 */
check(
  "a .dll inside a folder is preserved without breaking text upload",
  withBinary.entries.length === 1 &&
    withBinary.binaries?.length === 1 &&
    withBinary.skipped.length === 0,
  `${withBinary.entries.length} text, ${withBinary.binaries?.length ?? 0} executable`
);

const chatSrc = await readSrc("src/components/ChatArea.tsx");
check(
  "the composer offers a folder picker",
  /webkitdirectory/.test(chatSrc) && /Attach a folder/.test(chatSrc)
);
check(
  "a folder becomes one attachment, not one per file",
  /kind: "folder"/.test(chatSrc) && /groups\.set/.test(chatSrc),
  "otherwise a 200-file project attaches ten and drops the rest"
);
check(
  "two folders stay two attachments",
  /rel\.split\("\/"\)\[0\]/.test(chatSrc),
  "grouped by top-level name"
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
await finishSuite(fail);

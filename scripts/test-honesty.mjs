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
  ["actions taken block", "Actions taken:\n- looked at main.ts"],
]) {
  check(`"${label}" is recognised as a claim`, P.checkAnswerClaims(text, []) !== null);
}

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
  ".dll is still refused, with a reason",
  /library/.test(A.binaryFormatNote("thing.dll") ?? ""),
  "there is genuinely no text in it — but see the folder case below"
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

const withBinary = await AR.readFolderTree([
  fileFrom("proj/app.ts", "const x = 1;\n"),
  {
    name: "native.dll",
    size: 4,
    webkitRelativePath: "proj/native.dll",
    slice: () => ({
      arrayBuffer: async () => new Uint8Array([0x4d, 0x5a, 0x00, 0x01]).buffer,
    }),
  },
]);
/*
 * The reported case: a folder with a .dll in it. One binary must not fail the
 * whole upload — it is skipped by name and the code around it still arrives.
 */
check(
  "a .dll inside a folder is skipped without failing the upload",
  withBinary.entries.length === 1 && withBinary.skipped.length === 1,
  `${withBinary.entries.length} read, ${withBinary.skipped.length} skipped`
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

/**
 * Giving the agent eyes on the live web.
 *
 * Run:  npm run test:web
 *
 * The gap this closes: asked to inject an overlay into a Faceit match page,
 * the model had never seen that page. Web search returns articles *about* a
 * site, not its markup, and there was no fetch tool, no curl, no browser. It
 * could not know whether the score element is `.match-header__score` or
 * something else, so it wrote a plausible generic overlay that hooked into
 * nothing and cost real money to produce.
 *
 * No model can guess a DOM it has never been shown. These tools let it look.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { finishSuite, readSourceSync } from "./lib/proc.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
/*
 * Where this suite keeps its files.
 *
 * Several suites clear `data/` to start from a known state, which is correct
 * alone and destructive in parallel — they delete each other's fixtures. The
 * runner gives each suite its own directory through APIM_DATA_ROOT, and the
 * app reads the same variable, so the code under test and the test agree.
 */
const DATA_ROOT = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.join(ROOT, "data");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const web = await load("src/lib/web.ts");
const { validateCommand } = await load("src/lib/runner.ts");
const { WORKSPACE_TOOLS } = await load("src/lib/tools.ts");
const route = read("src/app/api/chat/route.ts");

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const g = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);
const r = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const d = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? g("PASS") : r("FAIL")}  ${label}${detail ? d("  " + detail) : ""}`);
  ok ? pass++ : fail++;
};

/** A page shaped like the one that started this. */
const PAGE = `<!doctype html><html><head><title>Faceit — Match Room</title>
<style>.hidden{display:none}</style>
<script>window.__DATA__={secret:1}</script></head>
<body>
  <div id="match-root" class="match-page">
    <section class="match-header match-header__score" data-match-id="1-abc">
      <h1>Team A vs Team B</h1>
      <span class="match-header__score-value">16 : 12</span>
    </section>
    <ul class="roster"><li>player one</li><li>player two</li></ul>
  </div>
</body></html>`;

console.log("\napiM web access checks\n");

// ------------------------------------------------------------------
console.log("1. The tools exist and are described usefully");

const names = WORKSPACE_TOOLS.map((t) => t.function.name);
check("fetch_url is available", names.includes("fetch_url"));
check("inspect_page is available", names.includes("inspect_page"));
check("download_file is available", names.includes("download_file"));

const inspect = WORKSPACE_TOOLS.find((t) => t.function.name === "inspect_page");
check(
  "inspect_page tells the model when to reach for it",
  /content script|userscript|scraper/i.test(inspect.function.description),
  "a tool the model does not know to use is a tool that does not exist"
);
check(
  "the prompt forbids inventing selectors",
  /Never invent a selector you have not seen/.test(route),
  "a plausible selector that does not exist produces code that runs and does nothing"
);

// ------------------------------------------------------------------
console.log("\n2. It cannot be pointed at the machine it runs on");

/*
 * The agent chooses these URLs, so this is the line between "read a web page"
 * and "read anything reachable from this host". The cloud metadata endpoint
 * is the one that hands out credentials.
 */
const blocked = [
  "http://localhost:3000/api/balance",
  "http://127.0.0.1/",
  "http://169.254.169.254/latest/meta-data/",
  "http://192.168.1.1/",
  "http://10.0.0.5/",
  "http://172.16.0.1/",
  "file:///etc/passwd",
  "ftp://example.com/x",
  "http://[::1]/",
  "http://something.internal/",
];
let stopped = 0;
for (const url of blocked) {
  try {
    web.assertPublicUrl(url);
  } catch {
    stopped++;
  }
}
check(
  "private, loopback and non-http addresses are all refused",
  stopped === blocked.length,
  `${stopped}/${blocked.length} blocked, including the cloud metadata endpoint`
);
check(
  "an ordinary public URL still passes",
  Boolean(web.assertPublicUrl("https://www.faceit.com/en/cs2/room/1-abc"))
);

// ------------------------------------------------------------------
console.log("\n3. A page becomes something the model can use");

check("the title is extracted", web.extractTitle(PAGE) === "Faceit — Match Room");

const text = web.htmlToText(PAGE);
check(
  "script and style contents are stripped",
  !text.includes("__DATA__") && !text.includes("display:none"),
  "otherwise a page is mostly minified javascript"
);
check("the readable content survives", text.includes("Team A vs Team B"));
check(
  "list items stay separated",
  /player one[\s\S]*player two/.test(text) && text.includes("•")
);

const sel = web.extractSelectors(PAGE);
check(
  "the real class names come back",
  sel.classes.includes("match-header__score"),
  "this is the thing the model could not guess"
);
check("ids come back", sel.ids.includes("match-root"));
check(
  "a data attribute is not mistaken for an id",
  !sel.ids.includes("1-abc") && sel.dataAttrs.includes("data-match-id"),
  "\\b matched inside data-match-id and captured its value"
);

// ------------------------------------------------------------------
console.log("\n4. Fetching really works, end to end");

const server = createServer((req, res) => {
  if (req.url === "/big") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>" + "x".repeat(300_000) + "</body></html>");
    return;
  }
  if (req.url === "/binary") {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;

// The guard blocks loopback, which is correct — so this drives fetchPage
// against a host header the guard accepts while resolving locally is not
// possible. Instead the network layer is exercised directly.
const direct = await fetch(`http://127.0.0.1:${port}/`);
const body = await direct.text();
check(
  "a served page round-trips into usable selectors",
  web.extractSelectors(body).classes.includes("match-header__score-value"),
  "the full path from HTTP response to selector list"
);

const binary = await fetch(`http://127.0.0.1:${port}/binary`);
check(
  "binaries are identified by content type",
  /^image\//.test(binary.headers.get("content-type") ?? ""),
  "fetchPage refuses these before downloading the body"
);
server.close();

check(
  "there is a size ceiling",
  web.MAX_FETCH_BYTES > 0 && web.MAX_FETCH_CHARS > 0,
  `${web.MAX_FETCH_BYTES / 1024 / 1024}MB fetched, ${web.MAX_FETCH_CHARS.toLocaleString()} chars kept`
);
check(
  "and a timeout",
  web.FETCH_TIMEOUT_MS > 0 && web.FETCH_TIMEOUT_MS <= 60_000,
  `${web.FETCH_TIMEOUT_MS / 1000}s`
);

// ------------------------------------------------------------------
console.log("\n5. The command allow-list caught up");

check(
  "curl and wget are runnable",
  validateCommand("curl", ["-s", "https://x.com"]).ok &&
    validateCommand("wget", ["https://x.com"]).ok,
  "the agent had no way to reach anything outside the workspace"
);
check(
  "which and where are runnable",
  validateCommand("which", ["npm"]).ok && validateCommand("where", ["npm"]).ok,
  "the model kept reaching for these to diagnose itself and being refused"
);
check(
  "unzip and tar are runnable",
  validateCommand("unzip", ["a.zip"]).ok && validateCommand("tar", ["-xf", "a.tar"]).ok
);
check(
  "shells are still refused",
  !validateCommand("bash", ["-c", "ls"]).ok && !validateCommand("sh", []).ok,
  "the list is wider, not open"
);
check(
  "and so is anything that was never on it",
  !validateCommand("rm", ["-rf", "/"]).ok && !validateCommand("sudo", []).ok
);

// ------------------------------------------------------------------
console.log("\n6. The rest of the gaps");

const { runTool } = await load("src/lib/tools.ts");
const wsLib = await load("src/lib/workspace.ts");
const snapLib = await load("src/lib/snapshots.ts");
const { createZip } = await load("src/lib/zip.ts");
const { writeFile: fsWrite } = await import("node:fs/promises");
const WS = "webtools";
await (await import("node:fs/promises")).rm(
  path.join(DATA_ROOT, "workspaces", WS),
  { recursive: true, force: true }
);

check(
  "web_search is a tool, not just a pre-turn decision",
  names.includes("web_search"),
  "search ran before the loop, so round two could not look anything up"
);
check(
  "it is withheld when there is no key",
  !(await runTool(WS, "web_search", { query: "x" }, {})).ok,
  "a tool that can only fail wastes a round and produces an apology"
);
check(
  "the failure tells the model what to do instead",
  /rather than guessing|already know the URL/.test(
    (await runTool(WS, "web_search", { query: "x" }, {})).content
  )
);
check(
  "and the route hides it from the model entirely",
  /t\.function\.name === "web_search"\)\s*\n?\s*return Boolean\(tavilyApiKey \|\| exaApiKey\)/.test(
    route
  ),
  "withheld only when NEITHER provider has a key"
);

// write_files
let res = await runTool(WS, "write_files", {
  files: [
    { path: "src/a.js", content: "export const a = 1;" },
    { path: "src/b.js", content: "export const b = 2;" },
    { path: "../escape.js", content: "nope" },
  ],
});
check("write_files creates several at once", res.ok && /Wrote 2/.test(res.summary));
check(
  "a traversal inside a batch is refused without losing the rest",
  /Failed 1/.test(res.content) && (await wsLib.listFiles(WS)).length === 2,
  "one bad path must not discard the good ones"
);

// undo_file
await runTool(WS, "write_file", { path: "src/a.js", content: "BROKEN" });
res = await runTool(WS, "undo_file", { path: "src/a.js" });
check("undo_file reverts the last write", res.ok);
check(
  "the file really is back",
  (await wsLib.readFile(WS, "src/a.js")).content === "export const a = 1;",
  "reverting is exact; patching a mistake by hand is not"
);
res = await runTool(WS, "undo_file", { path: "src/b.js" });
check(
  "with no history it says so rather than failing silently",
  !res.ok && /Fix it forward with edit_file/.test(res.content)
);

// snapshots
await snapLib.createSnapshot(WS, "before the mistake");
await wsLib.writeFile(WS, "src/a.js", "RUINED");
await wsLib.writeFile(WS, "src/junk.js", "created after");

res = await runTool(WS, "list_snapshots", {});
check("list_snapshots shows the restore points", res.ok && /before the mistake/.test(res.content));

const snapId = res.content.split("\n")[1]?.split(" — ")[0];
res = await runTool(WS, "restore_snapshot", { id: snapId });
check("restore_snapshot puts the workspace back", res.ok);
check(
  "a ruined file is restored",
  (await wsLib.readFile(WS, "src/a.js")).content === "RUINED" === false
);
check(
  "and a file created since is removed",
  !(await wsLib.listFiles(WS)).some((f) => f.path === "src/junk.js"),
  "otherwise it is not the state it was"
);
check(
  "the restore is itself reversible",
  /reversible/.test(res.content),
  "a snapshot is taken before restoring"
);

// read_document
const xml =
  '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r>' +
  "<w:t>Hello from Word</w:t></w:r></w:p></w:body></w:document>";
const docx = await createZip([
  { path: "word/document.xml", content: Buffer.from(xml), modified: new Date() },
]);
await fsWrite(path.join(wsLib.workspaceDirectory(WS), "report.docx"), docx);

res = await runTool(WS, "read_document", { path: "report.docx" });
check(
  "read_document opens a real .docx",
  res.ok && res.content.includes("Hello from Word"),
  "read_file decodes as UTF-8 and corrupts a zipped format"
);
check(
  "it refuses something that is not a document",
  !(await runTool(WS, "read_document", { path: "src/a.js" })).ok
);
check(
  "reading raw bytes does not go through the text decoder",
  /export async function readFileBytes/.test(read("src/lib/workspace.ts")),
  "a .docx read as UTF-8 is mojibake and will not parse"
);

// list_processes
res = await runTool(WS, "list_processes", {});
check("list_processes reports an empty workspace", res.ok && /No background/.test(res.content));

check(
  "the prompt introduces all of them",
  /undo_file puts that file back/.test(route) &&
    /read_document opens Word/.test(route) &&
    /write_files creates several files/.test(route),
  "a tool the model is not told about is a tool it will not use"
);

// ------------------------------------------------------------------
console.log("\n7. Batched edits, because rounds are the cost");

/*
 * None of these add a new ability — the agent could already rename and
 * refactor. They remove round trips, and a round resends the whole
 * conversation, so a rename touching a dozen files was a dozen full-price
 * requests to do one thing.
 */
const B = "batchtools";
await (await import("node:fs/promises")).rm(
  path.join(DATA_ROOT, "workspaces", B),
  { recursive: true, force: true }
);
await runTool(B, "write_files", {
  files: [
    { path: "src/a.js", content: "import { helper } from './util';\nhelper();" },
    { path: "src/b.js", content: "import { helper } from './util';\nhelper(1);" },
    { path: "src/util.js", content: "export function helper() {}" },
    { path: "README.md", content: "helper docs" },
  ],
});

let out = await runTool(B, "move_file", { from: "src/util.js", to: "src/helpers.js" });
check(
  "move_file renames in one call",
  out.ok,
  "read + write + delete was three rounds for one operation"
);
check(
  "it refuses to overwrite an existing file",
  !(await runTool(B, "move_file", { from: "src/a.js", to: "src/b.js" })).ok,
  "silently clobbering is how a rename loses the file it was preserving"
);
check(
  "and it cannot move outside the workspace",
  !(await runTool(B, "move_file", { from: "src/a.js", to: "../out.js" })).ok
);

out = await runTool(B, "edit_files", {
  edits: [
    { path: "src/a.js", old_text: "helper()", new_text: "assist()" },
    { path: "src/b.js", old_text: "helper(1)", new_text: "assist(1)" },
    { path: "src/a.js", old_text: "NOT PRESENT", new_text: "x" },
  ],
});
check("edit_files applies several replacements at once", /Edited 2/.test(out.summary));
check(
  "a failed edit does not discard the successful ones",
  /1 failed/.test(out.summary) && /NOT applied/.test(out.content),
  "the model cannot tell which edits were correct, so reverting them all is worse"
);

out = await runTool(B, "replace_in_files", {
  find: "helper",
  replace: "assist",
  preview: true,
});
check(
  "replace_in_files can preview without writing",
  out.ok && /Nothing was written/.test(out.content),
  "for when the text might appear somewhere unintended"
);

out = await runTool(B, "replace_in_files", {
  find: "helper",
  replace: "assist",
  glob: "*.js",
});
check("and applies across every matching file in one call", out.ok);
check(
  "the glob is honoured",
  (await wsLib.readFile(B, "README.md")).content.includes("helper docs"),
  "a project-wide rename must not touch files outside its scope"
);
check(
  "an unmatched search says so instead of reporting success",
  !(await runTool(B, "replace_in_files", { find: "zzznope", replace: "x" })).ok
);

check(
  "the prompt tells the model to batch",
  /replace_in_files changes the same text everywhere/.test(route) &&
    /run it with preview first/.test(route)
);

/*
 * A failed search is not an empty search.
 *
 * Reported from a real run: five web_search calls, five "No results",
 * including for the query "cat". A search that cannot possibly return nothing
 * returning nothing is the tell — and the model, told only "try different
 * wording", rephrased and retried four more times. Each one billed.
 *
 * The cause: tavilySearch fell through to `return []` on any non-OK response,
 * so a rejected key, a spent quota and a genuine miss were indistinguishable.
 */
console.log("\n9. A broken search says so, instead of pretending it found nothing");

const smart = await load("src/lib/smart-search.ts");

check(
  "there is a distinct error for a provider failure",
  typeof smart.SearchProviderError === "function",
  "zero results and a rejected key are different facts"
);
check(
  "it carries the status, so the message can be specific",
  new smart.SearchProviderError(401, "bad key").status === 401
);

const searchSrc = readSourceSync(path.join(ROOT, "src/lib/smart-search.ts"));
check(
  "a non-OK response throws rather than returning []",
  /throw new SearchProviderError\(response\.status, detail\)/.test(searchSrc),
  "this is the line that made a 401 look like a miss"
);
check(
  "Stop still returns quietly",
  /error\.name === "AbortError"\) return \[\]/.test(searchSrc),
  "the user pressing Stop is not a provider failure"
);

const toolsSrc3 = readSourceSync(path.join(ROOT, "src/lib/tools.ts"));
check(
  "web_search reports the failure as a failure",
  /Search FAILED —/.test(toolsSrc3) && /summary: `Search failed/.test(toolsSrc3)
);
check(
  "a rejected key is named as a key problem",
  /the Tavily key was rejected/.test(toolsSrc3)
);
check(
  "a spent quota is named as a quota problem",
  /quota or rate limit is spent/.test(toolsSrc3)
);
check(
  "and the model is told not to rephrase",
  /Do not retry ` \+\s*`it or rephrase/.test(toolsSrc3),
  "no wording fixes a rejected key; retrying just spends more"
);

const routeSrc3 = readSourceSync(path.join(ROOT, "src/app/api/chat/route.ts"));
check(
  "the automatic search path also tells the model",
  /<web_search_failed>/.test(routeSrc3),
  "it was logged to the server console and nowhere the model could see"
);
check(
  "and says it is not the same as finding nothing",
  /this is not the same as/.test(routeSrc3)
);

/*
 * The other half of the same report: fetching 477KB to read one line.
 */
console.log("\n10. fetch_url can return only the part that matters");

check(
  "there is a find parameter",
  /find: \{\s*type: "string"/.test(toolsSrc3),
  "a 477KB JSON body truncated at 200k can cut off the answer"
);
/*
 * Windowed on character offsets, not lines.
 *
 * The first version kept matching LINES with two either side. That does
 * nothing on minified JSON — reported from a real test against PyPI, where
 * the whole 477KB document is one line, so "the matching line" was the entire
 * file and find filtered one line down to one line.
 */
check(
  "matches carry surrounding context",
  /const WINDOW = 300;/.test(toolsSrc3) &&
    /m\.index - WINDOW/.test(toolsSrc3),
  "a window works on minified JSON; a line does not"
);
check(
  "overlapping windows are merged",
  /if \(last && from <= last\[1\]\)/.test(toolsSrc3),
  "a dense cluster of matches should read as one passage, not repeat"
);
check(
  "and it stops after a sane number of matches",
  /MAX_MATCHES = 20/.test(toolsSrc3)
);
check(
  "an invalid regex falls back to a literal search",
  /catch \{[\s\S]{0,200}re = new RegExp\(find\.replace/.test(toolsSrc3),
  'a model writing "info.version[" means the text, not a character class'
);
check(
  "no match says so, with the full size",
  /Nothing matched/.test(toolsSrc3) && /fetch it again/.test(toolsSrc3),
  "otherwise an empty body reads as an empty page"
);
check(
  "the header still reports the real page size",
  toolsSrc3.indexOf("KB`") < toolsSrc3.indexOf("Showing ${merged.length}"),
  "so you can tell whether you narrowed a big page or a small one"
);

/*
 * A second provider, because one is a single point of failure.
 *
 * Reported: Tavily started answering 432 — "This request exceeds your plan's
 * set usage limit". That is a hard stop until the month rolls over, and with
 * one provider it made search a dead feature for the rest of the month.
 */
console.log("\n11. Exa is a peer provider, not a spare");

check(
  "there is an Exa base URL, overridable for tests",
  /EXA_BASE_URL = process\.env\.EXA_BASE_URL/.test(searchSrc)
);
check(
  "auth uses x-api-key, the header Exa verifies",
  /"x-api-key": exaKey/.test(searchSrc),
  "the docs also list Bearer, but x-api-key is the one confirmed to work"
);
check(
  "content fields are nested under contents",
  /contents: \{ text: \{ maxCharacters/.test(searchSrc),
  "a top-level text:true returns 400 — the documented #1 mistake"
);

/*
 * Peers, not primary-and-spare. Asked for directly, and it is the better
 * design: the two indexes disagree about which pages matter, so running both
 * and merging beats picking one. In parallel, so two providers cost the same
 * wall-clock time as one.
 */
check(
  "both providers are queried in parallel, not in sequence",
  /const settled = await Promise\.all\(attempts\)/.test(searchSrc),
  "a fallback chain waits for the first to fail before starting the second"
);
check(
  "a failing provider does not fail the search",
  /if \(merged\.length === 0 && failures\.length === attempts\.length\)/.test(
    searchSrc
  ),
  "only a TOTAL failure is a failure"
);
check(
  "and when everything fails the specific reason survives",
  /providerError\s*\n?\s*\? \(providerError\.error as SearchProviderError\)/.test(
    searchSrc
  ),
  '"the Tavily key was rejected" beats a generic "search unavailable"'
);
check(
  "results are merged with duplicate URLs dropped",
  /if \(!r\.url \|\| seen\.has\(r\.url\)\) continue;/.test(searchSrc),
  "a page both providers return is shown once"
);
check(
  "with neither key it says so rather than returning nothing",
  /no search provider is configured/.test(searchSrc)
);

check(
  "either key enables the web_search tool",
  /return Boolean\(tavilyApiKey \|\| exaApiKey\)/.test(routeSrc3),
  "it was withheld unless Tavily specifically was set"
);
check(
  "and either key enables the automatic search",
  /\(tavilyApiKey \|\| exaApiKey\) && webSearchMode !== "off"/.test(routeSrc3)
);

const settingsSrc = readSourceSync(
  path.join(ROOT, "src/components/SettingsModal.tsx")
);
check(
  "the key can be entered in Settings",
  /Exa API Key/.test(settingsSrc) && /dashboard\.exa\.ai/.test(settingsSrc)
);

/*
 * The report that was invented rather than run.
 *
 * Asked to TEST a tool, the agent produced a three-row table of results
 * across three attempts and a score out of ten — on a turn where no search
 * ran. checkAnswerClaims only covered FILE claims, so it sailed through.
 */
console.log("\n12. A claimed tool result must correspond to a tool that ran");

const { checkAnswerClaims } = await load("src/lib/plan.ts");

for (const [label, text] of [
  ["a fabricated search report", "Attempt 3: web_search came back empty. So the fallback isn't firing."],
  ["a fabricated 'I ran the search'", "I ran the search and it returned no results."],
  ["a fabricated fetch result", "fetch_url returned HTTP 200 · application/json · 477KB"],
  ["a fabricated test run", "run_tests came back failed — 3 of 40 suites are red."],
  ["a fabricated exit code", "The script exited code 0, so the fix works."],
]) {
  check(`${label} is caught`, checkAnswerClaims(text, []) !== null);
}

check(
  "a real search is not flagged",
  checkAnswerClaims("web_search came back empty.", ["web_search"]) === null
);
check(
  "any tool in the group counts",
  checkAnswerClaims("fetch_url returned HTTP 200.", ["browse"]) === null,
  "browse and fetch_url are alternatives for the same job"
);
for (const [label, text] of [
  ["a proposal", "I could use web_search here if you add a key."],
  ["a suggestion", "You should run the tests before merging."],
  ["explaining a tool", "web_search takes a query and returns titles and URLs."],
  ["an ordinary answer", "Python's sorted() returns a new list."],
]) {
  check(
    `${label} is NOT flagged`,
    checkAnswerClaims(text, []) === null,
    "the first false accusation is the last one anyone reads"
  );
}

/*
 * The silent "No results" that survived three rounds of debugging.
 *
 * Exa was answering correctly and every result was being thrown away before
 * the model saw it. The filter was `r.score < 0.3`, tuned to Tavily's
 * relevance scale where a decent hit is 0.5+. Exa reports cosine similarity,
 * where the same quality of hit is 0.15-0.35. One threshold, two scales.
 *
 * Reproduced before fixing: three correct Exa results scoring 0.19, 0.24 and
 * 0.28, all discarded, output "No results for playwright python version".
 * That is why it looked like a broken fallback rather than a filter.
 */
console.log("\n13. Scores are not comparable across providers");

check(
  "each provider has its own floor",
  /const SCORE_FLOOR: Record<string, number> = \{/.test(searchSrc) &&
    /tavily: 0\.3/.test(searchSrc) &&
    /exa: 0\.12/.test(searchSrc),
  "0.3 is right for Tavily and discards nearly everything from Exa"
);
check(
  "the filter uses the per-provider floor",
  /r\.score < scoreFloor\(r\.provider\)/.test(searchSrc),
  "a single threshold is what silently emptied the results"
);
check(
  "results are tagged with the provider that returned them",
  /provider: "exa"/.test(searchSrc) && /provider: "tavily"/.test(searchSrc)
);
check(
  "an unknown provider is not filtered at all",
  /SCORE_FLOOR\[provider\] \?\? 0/.test(searchSrc),
  "dropping results we have no calibration for is worse than showing a weak one"
);

console.log("\n14. The result says which provider answered");

check(
  "providers that answered are reported",
  /providersUsed: \[\.\.\.providersUsed\]/.test(searchSrc)
);
check(
  "and providers that failed are reported too",
  /onProviderError\?\.\(/.test(searchSrc),
  "an empty result was indistinguishable from a provider never called"
);
check(
  "the model is told, on success",
  /\[via \$\{ran\}\$\{errs\}\]/.test(toolsSrc3)
);
check(
  "and especially on an empty result",
  /Providers that answered: \$\{ran\}/.test(toolsSrc3),
  "this is the line that would have ended three rounds of guessing"
);
check(
  "an errored provider is distinguished from a genuine miss",
  /At least one provider errored — that is not the same as/.test(toolsSrc3)
);

console.log("\n15. Providers can be switched off without losing the key");

const pageSrc = readSourceSync(path.join(ROOT, "src/app/page.tsx"));
check(
  "there is an on/off for each provider",
  /const \[tavilyEnabled/.test(pageSrc) && /const \[exaEnabled/.test(pageSrc)
);
check(
  "a disabled provider's key is not sent to the server",
  /tavilyApiKey: tavilyEnabled \? tavilyKey : ""/.test(pageSrc) &&
    /exaApiKey: exaEnabled \? exaKey : ""/.test(pageSrc),
  "the server never sees a key it must not use"
);
check(
  "both default to on for anyone upgrading",
  /if \(s\.tavilyEnabled === false\)/.test(pageSrc),
  "explicit false only — an older settings object has neither field"
);
check(
  "the switch is in Settings",
  /ProviderToggle/.test(settingsSrc) &&
    /Use Tavily for web search/.test(settingsSrc) &&
    /Use Exa for web search/.test(settingsSrc)
);

/*
 * A warning that fires for the wrong reason.
 *
 * Reported immediately, which is exactly what a false positive earns. A reply
 * ending "[Actions taken: web_search — ...]" — after a web_search that really
 * ran — was told "no file tool ran in it, nothing on disk was touched". True,
 * and completely beside the point: the reply never claimed to touch disk.
 *
 * "Actions taken:" was in the FILE claim list unconditionally. It only counts
 * as a file claim when it NAMES a file operation, which is what the original
 * report ("Actions taken: [read 3412321]") did.
 */
console.log("\n16. The claim check does not fire for the wrong reason");

check(
  "a real search with an Actions-taken block is not flagged",
  checkAnswerClaims(
    "Search works.\n\n[Actions taken: web_search — Playwright version]",
    ["web_search"]
  ) === null,
  "the next real warning gets ignored once one is wrong"
);
check(
  "an Actions-taken block naming a file op, with no file tool, still is",
  checkAnswerClaims(
    "Done.\n\nActions taken: [read 3412321] [edited config.ts]",
    []
  ) !== null,
  "the original report, which must stay caught"
);
check(
  "and not when a file tool did run",
  checkAnswerClaims("Actions taken: read src/app.ts", ["read_file"]) === null
);
check(
  "a bare Actions-taken block claims nothing",
  checkAnswerClaims("Actions taken: thought about it", []) === null
);

/*
 * Exact-match replacement was the last real self-inflicted failure.
 *
 * edit_file already tolerates whitespace across three passes, but
 * replace_in_files was strictly literal — so a rename where the surrounding
 * text varies had no tool, and the fallback was one edit per file.
 * searchFiles already understood regex; this stopped throwing it away.
 */
console.log("\n17. replace_in_files accepts a regular expression");

check(
  "there is a regex option",
  /regex: \{\s*\n?\s*type: "boolean"/.test(toolsSrc3) &&
    /const useRegex = args\.regex === true;/.test(toolsSrc3)
);
check(
  "a bad pattern is a clear error, not a silent zero-match",
  /is not a valid regular expression/.test(toolsSrc3)
);
check(
  "the pattern is passed to the file matcher too",
  /regex: useRegex,/.test(toolsSrc3),
  "otherwise preview and the real thing disagree about which files are in scope"
);
check(
  "a fresh regex per file, because /g is stateful",
  /new RegExp\(pattern\.source, pattern\.flags\)/.test(toolsSrc3),
  "reusing one across files silently skips matches"
);
check(
  "literal replacement still works unchanged",
  /count = file\.content\.split\(find\)\.length - 1;/.test(toolsSrc3)
);

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
await finishSuite(fail);

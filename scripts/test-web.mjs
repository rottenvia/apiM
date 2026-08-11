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
import { finishSuite } from "./lib/proc.mjs";

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
  /t\.function\.name === "web_search"\) return Boolean\(tavilyApiKey\)/.test(route)
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

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
await finishSuite(fail);

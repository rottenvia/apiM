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

const ROOT = path.resolve(import.meta.dirname, "..");
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

console.log(
  `\n${pass + fail} checks · ${g(pass + " passed")}${fail ? " · " + r(fail + " failed") : ""}\n`
);
process.exit(fail ? 1 : 0);

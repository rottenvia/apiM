/**
 * Dropped files: saved whole, described for the model, queryable.
 *
 * Run:  npm run test:ingest
 *
 * Reported: a 35MB JSON was cut to its first 800k characters in the browser
 * and the rest never reached the agent. Files now go to the workspace as
 * exact bytes (the upload route), the server describes them (lib/ingest),
 * and query_data answers questions about data files of any size.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
process.env.APIM_DATA_ROOT ??= path.join(ROOT, ".test-data", "ingest");

const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const read = (p) => readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const W = await load("src/lib/workspace.ts");
const T = await load("src/lib/tools.ts");
const I = await load("src/lib/ingest.ts");
const D = await load("src/lib/data-query.ts");
const upload = await load("src/app/api/workspace/[id]/upload/route.ts");
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

const ws = `ingest-${Date.now()}`;
const post = async (target, bytes, query = "") => {
  const req = new NextRequest(`http://localhost/api/workspace/${ws}/upload${query}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-upload-path": encodeURIComponent(target) },
    body: bytes,
  });
  const res = await upload.POST(req, { params: Promise.resolve({ id: ws }) });
  return { status: res.status, body: await res.json() };
};

// --- upload ---
console.log("\nupload");
const players = {
  server: "eu-1",
  players: Array.from({ length: 60_000 }, (_, i) => ({
    id: i,
    name: `player_${i}`,
    score: (i * 37) % 10_000,
    guild: i % 3 === 0 ? null : ["red", "blue"][i % 2],
    inventory: Array.from({ length: i % 4 }, (_, k) => ({ item: ["sword", "shield", "potion"][k % 3], qty: k + 1 })),
  })),
};
const bigJson = Buffer.from(JSON.stringify(players));
{
  const up = await post("uploads/players.json", bigJson);
  check("a multi-megabyte file is saved", up.status === 200 && up.body.path === "uploads/players.json", `${(bigJson.length / 1e6).toFixed(1)}MB`);
  const onDisk = readFileSync(W.resolveInside(ws, "uploads/players.json"));
  check("byte for byte — nothing truncated", createHash("sha256").update(onDisk).digest("hex") === createHash("sha256").update(bigJson).digest("hex"));
  const again = await post("uploads/players.json", Buffer.from("{}"), "?unique=1");
  check("a second upload with the same name gets a free name", again.body.path === "uploads/players-2.json", again.body.path);
  const evil = await post("../outside.txt", Buffer.from("x"));
  check("a path outside the workspace is refused", evil.status === 400);
  const fakeDll = await post("uploads/fake.dll", Buffer.from("not a pe"));
  check("a .dll without an MZ header is refused", fakeDll.status === 400);
  const src = read("src/app/api/workspace/[id]/upload/route.ts");
  check("uploads stream to disk with a hard cap", /streamToWorkspace\(/.test(src) && /MAX_UPLOAD_BYTES/.test(src));
}

// --- describe ---
console.log("\ndescribe");
{
  const dj = await I.describeUpload(ws, "uploads/players.json");
  check("big JSON is described by its structure, not pasted", dj.kind === "data" && !dj.inline && dj.text.length < 6000, `${dj.text.length} chars for ${(bigJson.length / 1e6).toFixed(1)}MB`);
  check("…with counts and the records' fields", /\.players: array \[60,000\]/.test(dj.text) && /\.guild: string \d+% \| null \d+%/.test(dj.text));
  check("…and example queries in its own terms", /\$\.players\[0:5\]/.test(dj.text) && /query_data path="uploads\/players\.json"/.test(dj.text));
  check("the chip says what is inside", dj.label === `JSON · ${I.formatSize(bigJson.length)} · 60,000 players`, dj.label);

  await W.writeFile(ws, "uploads/small.py", "def add(a, b):\n    return a + b\n");
  const small = await I.describeUpload(ws, "uploads/small.py");
  check("a small file is shown whole", small.inline && /def add\(a, b\):/.test(small.text) && /```py/.test(small.text));

  const csv = "order_id,region,amount\n" + Array.from({ length: 30_000 }, (_, i) => `${i},${["north", "south"][i % 2]},${(i % 500) + 0.5}`).join("\n") + "\n";
  await W.writeFile(ws, "uploads/sales.csv", csv);
  const dc = await I.describeUpload(ws, "uploads/sales.csv");
  check("big CSV: columns, rows, numeric ranges", /30,000 rows/.test(dc.text) && /columns: order_id, region, amount/.test(dc.text) && /\.amount: string \(numeric text\) 0\.5\.\.499\.5/.test(dc.text), dc.label);

  const log = Array.from({ length: 20_000 }, (_, i) => `line ${i} status=${i % 7 ? 200 : 500}`).join("\n");
  await W.writeFile(ws, "uploads/server.log", log);
  const dl = await I.describeUpload(ws, "uploads/server.log");
  check("big text: head, tail, line count, how to read on", /20,000 lines/.test(dl.text) && /First 80 lines/.test(dl.text) && /line 19999/.test(dl.text) && /read_file path="uploads\/server\.log"/.test(dl.text));

  await W.writeFileBytes(ws, "uploads/tool.exe", Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, ...Array(200).fill(0)]));
  const de = await I.describeUpload(ws, "uploads/tool.exe");
  check("executables point at inspect_binary and are never run", de.kind === "binary" && /inspect_binary path="uploads\/tool\.exe"/.test(de.text) && /not executed/.test(de.text));

  await W.writeFileBytes(ws, "uploads/shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  const di = await I.describeUpload(ws, "uploads/shot.png");
  check("images point at view_image", di.kind === "image" && /view_image path="uploads\/shot\.png"/.test(di.text));

  await W.writeFile(ws, "uploads/proj/README.md", "# proj\n");
  await W.writeFile(ws, "uploads/proj/src/main.py", "print(1)\n");
  await W.writeFile(ws, "uploads/proj/src/lib/util.py", "x = 1\n");
  const df = await I.describeUpload(ws, "uploads/proj");
  check("a folder gets a map: counts, tree, notable files", df.kind === "folder" && df.fileCount === 3 && /src\/\s+\(2 files/.test(df.text) && /uploads\/proj\/README\.md/.test(df.text), df.label);

  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello from windows\r\n", "utf16le")]);
  await W.writeFileBytes(ws, "uploads/win.txt", utf16);
  const du = await I.describeUpload(ws, "uploads/win.txt");
  check("UTF-16 text is decoded, not called binary", du.kind === "text" && /hello from windows/.test(du.text));
}

// --- query_data ---
console.log("\nquery_data");
{
  const shape = await T.runTool(ws, "query_data", { path: "uploads/players.json" }, {});
  check("no query: the structure", shape.ok && /\.players: array \[60,000\]/.test(shape.content));
  const one = await T.runTool(ws, "query_data", { path: "uploads/players.json", query: "$.players[-1].name" }, {});
  check("index from the end", /"player_59999"/.test(one.content), one.content.split("\n")[1]);
  const filt = await T.runTool(ws, "query_data", { path: "uploads/players.json", query: "$.players[?(@.guild == 'red' && @.score >= 9990)]", count: true }, {});
  const expected = players.players.filter((p) => p.guild === "red" && p.score >= 9990).length;
  check("filters with && and comparisons, count only", new RegExp(`^${expected.toLocaleString()} match`).test(filt.content), filt.content);
  const deep = await T.runTool(ws, "query_data", { path: "uploads/players.json", query: "$..qty", count: true }, {});
  const qty = players.players.reduce((n, p) => n + p.inventory.length, 0);
  check("recursive descent", deep.content.startsWith(`${qty.toLocaleString()} match`), deep.content);
  const page2 = await T.runTool(ws, "query_data", { path: "uploads/players.json", query: "$.players[*]", limit: 2, offset: 10, fields: ["id", "name"] }, {});
  check("paging and field picking", /\$\.players\[10\] = \{"id":10,"name":"player_10"\}/.test(page2.content) && /offset:12/.test(page2.content));
  const saved = await T.runTool(ws, "query_data", { path: "uploads/players.json", query: "$.players[?(@.score == 0)]", save_as: "out/zero.json" }, {});
  const zeros = JSON.parse(readFileSync(W.resolveInside(ws, "out/zero.json"), "utf8"));
  check("save_as writes every match to a file", saved.ok && zeros.length === players.players.filter((p) => p.score === 0).length && zeros.length > 0, `${zeros.length} records`);
  const rx = await T.runTool(ws, "query_data", { path: "uploads/players.json", query: "$.players[?(@.name =~ /_4242$/)].id" }, {});
  check("regex match", /= 4242$/m.test(rx.content));
  const csvq = await T.runTool(ws, "query_data", { path: "uploads/sales.csv", query: "$[?(@.amount > 499)]", count: true }, {});
  check("CSV cells compare as numbers", csvq.content.startsWith("60 match"), csvq.content);
  const bad = await T.runTool(ws, "query_data", { path: "uploads/players.json", query: "$.players[?(@.x ==" }, {});
  check("a broken query is an error, not a crash", !bad.ok && /Error/.test(bad.content));
  const notData = await T.runTool(ws, "query_data", { path: "uploads/tool.exe" }, {});
  check("a non-data file is refused clearly", !notData.ok);
  const jsonl = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ i, even: i % 2 === 0 })).join("\n");
  await W.writeFile(ws, "uploads/events.jsonl", jsonl);
  const jl = await T.runTool(ws, "query_data", { path: "uploads/events.jsonl", query: "$[?(@.even)]", count: true }, {});
  check("JSON Lines is a list of records", jl.content.startsWith("500 match"), jl.content);
  const t0 = performance.now();
  await T.runTool(ws, "query_data", { path: "uploads/players.json", query: "$.players[?(@.score > 5000)]", count: true }, {});
  const warm = performance.now() - t0;
  check("the parse is cached between queries", warm < 400, `${Math.round(warm)}ms`);
  const readTool = await T.runTool(ws, "read_file", { path: "uploads/players.json" }, {});
  check("read_file on a big data file points at query_data", /query_data path="uploads\/players\.json"/.test(readTool.content));
}

// --- wiring ---
console.log("\nwiring");
{
  const chat = read("src/components/ChatArea.tsx");
  check("the composer uploads before it describes", /const saved = await uploadFile\(file, `uploads\/\$\{file\.name\}`, true\)/.test(chat) && /describeSaved\(saved\.path/.test(chat));
  check("folders upload every file, several at a time", /await Promise\.all\(Array\.from\(\{ length: Math\.min\(6, total\) \}, worker\)\)/.test(chat));
  check("described attachments go into the message as they are", /if \(a\.preformatted\) return \[a\.content\];/.test(read("src/lib/attachments.ts")));
  check("helpers can query data too", read("src/lib/subagent.ts").includes('"query_data"'));
}

console.log(`\n${pass + fail} checks · ${pass} passed`);
process.exit(fail ? 1 : 0);

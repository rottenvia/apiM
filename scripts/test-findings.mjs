/**
 * Durable findings.
 *
 * Run: npm run test:findings
 *
 * This is the memory that stops the model re-deriving its own conclusions
 * every turn ("oh yeah, that is the way!"): a finding is a short, cited,
 * falsifiable conclusion stored on disk and injected into the system prompt.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_ROOT = process.env.APIM_DATA_ROOT
  ? path.resolve(process.env.APIM_DATA_ROOT)
  : path.join(ROOT, "data");

const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { addFinding, reviseFinding, readFindings, formatFindingsForPrompt, replaceFindings, FINDINGS_MARKER_OPEN } =
  await load("src/lib/findings.ts");

const WS = "findings-test-" + Math.random().toString(36).slice(2, 8);
let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? " - " + detail : ""}`); }
};

// 1. Add and read back.
const f1 = await addFinding(WS, {
  claim: "bar.dll is the good build; its CreateMove reads the live pointer",
  refs: ["bar.dll", "CreateMove"],
  evidence: "decompiled focused-functions.c @0x1000",
});
check("finding gets an id", Boolean(f1.id), f1.id);
let store = await readFindings(WS);
check("finding is stored", store.findings.some((f) => f.id === f1.id));

// 2. Same claim is deduped, not duplicated.
await addFinding(WS, {
  claim: "bar.dll is the good build; its CreateMove reads the live pointer",
  refs: ["CreateMove"],
  evidence: "confirmed again",
});
store = await readFindings(WS);
check(
  "identical claim updates rather than duplicates",
  store.findings.filter((f) => f.claim.startsWith("bar.dll is the good build")).length === 1
);

// 3. The prompt block carries markers, the claim, refs and evidence.
let block = formatFindingsForPrompt(store);
check("prompt block is marker-wrapped", block.includes(FINDINGS_MARKER_OPEN) && block.includes("</workspace-findings>"));
check("prompt block contains the claim", block.includes("bar.dll is the good build"));
check("prompt block contains refs", block.includes("bar.dll") && block.includes("CreateMove"));
  check("empty store yields empty string", formatFindingsForPrompt({ version: 1, findings: [] }) === "");

  // 3b. A fat legacy store cannot flood the prompt: slices are hard.
  const fatBlock = formatFindingsForPrompt({
    version: 1,
    findings: [
      {
        id: "f-fat",
        claim: "x".repeat(100_000),
        refs: ["big.log"],
        evidence: "y".repeat(100_000),
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  check(
    "a fat legacy finding is sliced before it reaches the prompt",
    fatBlock.length < 2_000,
    String(fatBlock.length)
  );

// 4. Revise/supersede.
const f2 = await addFinding(WS, {
  claim: "foo.dll works",
  evidence: "first look",
});
const revised = await reviseFinding(
  WS,
  { id: f2.id, reason: "foo.dll reads a stale pointer", status: "disproved" },
  { claim: "foo.dll is flawed: stale pointer; use bar.dll" }
);
check("revision reports updated", revised.updated === true);
check("revision creates a replacement", Boolean(revised.replacement));
store = await readFindings(WS);
const old = store.findings.find((f) => f.id === f2.id);
check("old finding is marked disproved", old && old.status === "disproved");
block = formatFindingsForPrompt(store);
check("replacement is shown", block.includes("foo.dll is flawed"));

// 4b. Retire-on-completion: finished work must stop riding the prompt.
check(
  "the prompt block teaches retire-on-completion",
  block.includes("DONE and shipped") && block.includes("status 'disproved'"),
  "findings are working memory, not an archive — finished items retire"
);
const doneStore = {
  version: 1,
  findings: [
    {
      id: "f-done",
      claim: "fixed the fat-wire leak",
      refs: ["src/lib/prune.ts"],
      evidence: "shipped in commit abc1234",
      status: "superseded",
      supersededBy: "f-new",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};
const doneBlock = formatFindingsForPrompt(doneStore);
check(
  "a superseded finding is hidden from the prompt",
  !doneBlock.includes("fixed the fat-wire leak")
);
check(
  "formatFindingsForPrompt's intro carries the retire recipe",
  block.includes("status 'disproved'") && block.includes("DONE and shipped"),
  "the model must know the exact retirement call"
);

// 4c. Relevance-scoped silent use: a finding the current request does not
// need must never be dragged into the reply ("per my findings …").
check(
  "the prompt block scopes findings to the relevant ones, silently",
  block.includes("RELEVANT to the current request") &&
    block.includes("never mention, cite, or act on it"),
  "irrelevant findings are background, not reply material"
);
const routeSrc = readFileSync(
  path.join(ROOT, "src/app/api/chat/route.ts"),
  "utf8"
);
check(
  "the system prompt keeps unneeded findings out of the reply",
  routeSrc.includes("use the ones relevant to this turn") &&
    routeSrc.includes("stay out of your reply entirely"),
  "mention a finding only when it changed the course"
);

// 5. replaceFindings swaps a stale block in place (used on resume).
const stale = "prefix\n<workspace-findings>\nold wrong thing\n</workspace-findings>\nsuffix";
const fresh = formatFindingsForPrompt(store);
const replaced = replaceFindings(stale, fresh);
check(
  "replaceFindings replaces the block, keeps surrounding text, no duplicate markers",
  replaced.startsWith("prefix") &&
    replaced.endsWith("suffix") &&
    !replaced.includes("old wrong thing") &&
    (replaced.match(/<workspace-findings>/g) || []).length === 1
);

await rm(path.join(DATA_ROOT, "workspaces", WS), { recursive: true, force: true });

// Two fresh chats never share findings (the shared-EMPTY leak).
{
  const A = "findleak-a", B = "findleak-b";
  await rm(path.join(DATA_ROOT, "workspaces", A), { recursive: true, force: true });
  await rm(path.join(DATA_ROOT, "workspaces", B), { recursive: true, force: true });
  await addFinding(A, { claim: "Chat A's private conclusion about its own project." });
  const b = await readFindings(B);
  const ok = b.findings.length === 0;
  console.log(`${ok ? "PASS" : "FAIL"}  a finding in one new chat never appears in another new chat`);
  if (!ok) failures++;
  await rm(path.join(DATA_ROOT, "workspaces", A), { recursive: true, force: true });
}

// Machine-wide findings: toolchain facts proven once, shown in every chat.
{
  const F = await load("src/lib/findings.ts");
  const { runTool } = await load("src/lib/tools.ts");
  await rm(path.join(DATA_ROOT, "machine-findings.json"), { force: true });
  const r = await runTool(WS, "note_finding", {
    claim: "This Luau CLI build has no io library and _G is readonly; inject mocks with loadstring+setfenv.",
    evidence: "probe_io.luau printed io=nil; writing _G raised 'readonly table'",
    scope: "machine",
  });
  const machine = await F.readFindings(F.MACHINE_SCOPE);
  const block = F.formatMachineFindingsForPrompt(machine);
  const ok1 = r.ok && /EVERY chat/.test(r.content) && machine.findings.length === 1 &&
    /<machine-findings>/.test(block) && /no io library/.test(block);
  console.log(`${ok1 ? "PASS" : "FAIL"}  a machine-scoped finding is stored once and rendered for every chat`);
  if (!ok1) failures++;
  const local = await F.readFindings(WS);
  const ok2 = !local.findings.some((f) => /no io library/.test(f.claim));
  console.log(`${ok2 ? "PASS" : "FAIL"}  it does not land in the project's own findings`);
  if (!ok2) failures++;
  const id = machine.findings[0].id;
  const rev = await runTool(WS, "note_finding", { id, status: "disproved", claim: "io exists after all" });
  const after = await F.readFindings(F.MACHINE_SCOPE);
  const ok3 = rev.ok && after.findings.find((f) => f.id === id)?.status === "disproved";
  console.log(`${ok3 ? "PASS" : "FAIL"}  a machine finding can be retired by id from any chat`);
  if (!ok3) failures++;
  const route = readFileSync(path.join(ROOT, "src/app/api/chat/route.ts"), "utf8");
  const ok4 = /formatMachineFindingsForPrompt\(await readFindings\(MACHINE_SCOPE\)\)/.test(route);
  console.log(`${ok4 ? "PASS" : "FAIL"}  every chat's prompt carries the machine findings`);
  if (!ok4) failures++;
  // The model never picks scope 'machine' itself (measured on real runs):
  // a toolchain fact filed as a project finding is kept machine-wide too.
  await runTool(WS, "note_finding", {
    claim: "Luau CLI (tools/luau/luau) sandboxes every chunk: each main file and each require'd module gets its own fresh global table",
    evidence: "_probe_shared_a.luau: rawset on _G raised 'attempt to modify a readonly table'",
  });
  await runTool(WS, "note_finding", { claim: "The panel's drag handler must use InputChanged, not MouseMoved." });
  const auto = F.formatMachineFindingsForPrompt(await F.readFindings(F.MACHINE_SCOPE));
  const ok5 = /sandboxes every chunk/.test(auto) && !/drag handler/.test(auto);
  console.log(`${ok5 ? "PASS" : "FAIL"}  a toolchain fact is kept machine-wide automatically; a project fact is not`);
  if (!ok5) failures++;
  await rm(path.join(DATA_ROOT, "machine-findings.json"), { force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll findings checks passed.");

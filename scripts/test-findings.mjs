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

// Reported: "older findings in another chat show up in a new chat — a cross
// memory leak". Findings were copied to a machine-wide store by a keyword
// guess, and that store rode every chat's prompt. Chats are isolated now;
// sharing is opt-in (APIM_SHARED_FINDINGS=1) and never automatic.
{
  const F = await load("src/lib/findings.ts");
  const T = await load("src/lib/tools.ts");
  const { runTool } = T;
  const OTHER = "findtest-other-chat";
  const pass = (label, ok) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) failures++;
  };
  const saved = process.env.APIM_SHARED_FINDINGS;
  delete process.env.APIM_SHARED_FINDINGS;
  await rm(path.join(DATA_ROOT, "machine-findings.json"), { force: true });

  // The exact kinds of note that used to leak.
  const r1 = await runTool(WS, "note_finding", {
    claim: "WSL is unavailable on this PC: wsl.exe exits with 0xd0000034, so the sandbox cannot run",
    evidence: "sandbox_run returned Wsl/Service/CreateInstance/0xd0000034",
  });
  await runTool(WS, "note_finding", {
    claim: "Luau CLI (tools/luau/luau) sandboxes every chunk: each module gets its own fresh global table",
    evidence: "rawset on _G raised 'attempt to modify a readonly table'",
  });
  // Even asking for machine scope does nothing unless the user opted in.
  const r3 = await runTool(WS, "note_finding", {
    claim: "node on PATH is version 18 and lacks fetch",
    scope: "machine",
  });
  const machine = await F.readFindings(F.MACHINE_SCOPE);
  pass("by default nothing is written to the shared store, not even with scope 'machine'",
    machine.findings.length === 0);
  pass("and the agent is told the note stays in this chat",
    /in this chat/.test(r1.content) && !/EVERY chat/.test(r1.content + r3.content));
  const other = await F.readFindings(OTHER);
  pass("a brand-new chat starts with none of them", other.findings.length === 0);

  const route = readFileSync(path.join(ROOT, "src/app/api/chat/route.ts"), "utf8");
  pass("the prompt only carries the shared store when sharing is on",
    /sharedFindingsEnabled\(\)\s*\?\s*formatMachineFindingsForPrompt\(await readFindings\(MACHINE_SCOPE\)\)\s*:\s*""/.test(route));
  const note = (tools) => tools.find((t) => t.function.name === "note_finding").function.parameters.properties;
  pass("the agent is not offered scope 'machine' by default", !("scope" in note(T.WORKSPACE_TOOLS)));
  pass("but is when sharing is on", "scope" in note(T.withSharedFindingsScope(T.WORKSPACE_TOOLS)));
  pass("sharing is off unless APIM_SHARED_FINDINGS is exactly 1",
    !F.sharedFindingsEnabled({}) && !F.sharedFindingsEnabled({ APIM_SHARED_FINDINGS: "true" }) &&
      F.sharedFindingsEnabled({ APIM_SHARED_FINDINGS: "1" }));

  // Opted in: an explicit machine note is shared and retirable; nothing is
  // promoted on its own.
  process.env.APIM_SHARED_FINDINGS = "1";
  const r4 = await runTool(WS, "note_finding", {
    claim: "This Luau CLI build has no io library and _G is readonly; inject mocks with loadstring+setfenv.",
    scope: "machine",
  });
  await runTool(WS, "note_finding", {
    claim: "python3 on this PC lacks tkinter and is not on PATH as python",
  });
  const shared = await F.readFindings(F.MACHINE_SCOPE);
  pass("with sharing on, an explicit machine note is shared",
    r4.ok && /EVERY chat/.test(r4.content) && shared.findings.length === 1 &&
      /no io library/.test(F.formatMachineFindingsForPrompt(shared)));
  pass("and a note without scope is still never promoted",
    !shared.findings.some((f) => /tkinter/.test(f.claim)));
  const id = shared.findings[0].id;
  const rev = await runTool(OTHER, "note_finding", { id, status: "disproved", claim: "io exists after all" });
  const after = await F.readFindings(F.MACHINE_SCOPE);
  pass("a shared note can be retired by id from another chat",
    rev.ok && after.findings.find((f) => f.id === id)?.status === "disproved");

  if (saved === undefined) delete process.env.APIM_SHARED_FINDINGS;
  else process.env.APIM_SHARED_FINDINGS = saved;
  await rm(path.join(DATA_ROOT, "machine-findings.json"), { force: true });
  await rm(path.join(DATA_ROOT, "workspaces", OTHER), { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll findings checks passed.");

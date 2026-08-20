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
check("disproved finding is hidden from the prompt", !block.includes("foo.dll works"));
check("replacement is shown", block.includes("foo.dll is flawed"));

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

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll findings checks passed.");

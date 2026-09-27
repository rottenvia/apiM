/**
 * Durable findings — conclusions the agent reached, kept across messages,
 * Stop and compaction.
 *
 * The binary ledger remembers what was decompiled. This remembers what was
 * CONCLUDED about anything: "this path is dead because bar() returns null",
 * "the CreateMove hook reads a stale pointer", "option A fails with X so use
 * B". Without it, a long chat compacts the tool result where the agent worked
 * that out, the next question forces it to re-read the file, and it rediscovers
 * its own answer every turn ("oh yeah, that is the way!") — the model is not
 * being stupid, the conclusion was genuinely removed from the request.
 *
 * A finding is short, source-cited, and falsifiable. It lives in an internal
 * directory and is injected into the system prompt. The agent adds one with
 * note_finding the moment it has something it would otherwise have to re-derive.
 * The user (or a later run) can mark it wrong; it is superseded rather than
 * deleted, so a flip-flopping belief stays visible.
 *
 * Best-effort like the binary ledger: a write failure must never break a reply.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { workspaceDirectory } from "@/lib/workspace";

const FINDINGS_DIR = ".analysis";
const FINDINGS_FILE = "findings.json";

export type FindingStatus = "active" | "superseded" | "disproved";

export interface Finding {
  id: string;
  /** One-line conclusion, specific and factual. */
  claim: string;
  /** Files/paths/addresses/identifiers this is about, when known. */
  refs: string[];
  /** What established it: a command, file read, decompiled function, etc. */
  evidence: string;
  status: FindingStatus;
  /** id of the finding that replaced/disproved this one. */
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

interface FindingsStore {
  version: 1;
  findings: Finding[];
}

/*
 * A FRESH empty store every time, never a shared constant.
 *
 * This was one module-level `EMPTY` object returned whenever a workspace had
 * no findings file yet — and addFinding pushes into the store it reads. So
 * the first finding of any new chat was written into the shared object, and
 * every other new chat in the same server process started out "knowing" it:
 * findings leaked between chats (found when machine-scoped findings came
 * back carrying another chat's "bar.dll is the good build").
 */
const emptyStore = (): FindingsStore => ({ version: 1, findings: [] });

/**
 * The store id for facts about THIS MACHINE rather than one project.
 *
 * Findings were per-workspace only, so what a run proved about the
 * toolchain — "this Luau CLI: _G is readonly, no io, require isolates each
 * module's env" — was re-discovered from zero by the next chat, probe by
 * probe (reported: a whole ESP run spent its rounds re-learning exactly
 * that). Machine findings are kept once and shown in every chat.
 */
export const MACHINE_SCOPE = "__machine__";

/**
 * Does this claim describe the machine's toolchain rather than the project?
 *
 * Measured on real runs: the model recorded "Luau CLI (tools/luau/luau)
 * sandboxes every chunk: each main file and each require'd module gets its
 * own fresh global table" — the fact every run spent ~20 minutes probing
 * for — as a plain workspace finding, so the next chat would probe it all
 * over again. The model does not reach for scope 'machine' on its own, so a
 * claim that names a tool AND describes tool behaviour is also kept
 * machine-wide. Deliberately two-part: "the CLI" alone, or "sandbox" in a
 * game-design sense, is not enough.
 */
export function looksLikeToolchainFact(claim: string): boolean {
  const tool =
    /\b(CLI|command[- ]line|interpreter|compiler|binary|executable|runtime|toolchain|luau(?:-analyze)?|python3?|node(?:\.js)?|npm|pip|gcc|clang|cargo|rustc|go toolchain|dotnet|java|powershell|cmd\.exe|bash|git)\b/i;
  const behaviour =
    /\b(sandbox(?:es|ed)?|readonly|read-only|not available|unavailable|is nil|no `?io`?|lacks?|supports?|does(?:n't| not) support|flag|option|version|requires?|installed|on PATH|env(?:ironment)?|global table|exit code|stdout|stderr)\b/i;
  return tool.test(claim) && behaviour.test(claim);
}

/** Most machine findings shown per prompt: facts, not a diary. */
export const MAX_MACHINE_FINDINGS_SHOWN = 15;

function storePath(workspaceId: string): string {
  if (workspaceId === MACHINE_SCOPE) {
    const root = process.env.APIM_DATA_ROOT
      ? path.resolve(process.env.APIM_DATA_ROOT)
      : path.join(process.cwd(), "data");
    return path.join(root, "machine-findings.json");
  }
  return path.join(workspaceDirectory(workspaceId), FINDINGS_DIR, FINDINGS_FILE);
}

async function readStore(workspaceId: string): Promise<FindingsStore> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(storePath(workspaceId), "utf8")
    ) as Partial<FindingsStore>;
    if (parsed.version !== 1 || !Array.isArray(parsed.findings)) return emptyStore();
    // Sanitize on read. Findings written before the size caps existed can
    // carry megabytes of pasted content inside claim/evidence, and this
    // store rides the system prompt on EVERY request — one fat legacy note
    // is the "900k chars in" on a small request. Normalize whatever sits on
    // disk so nothing oversized can reach the prompt, no matter who wrote it.
    const now = new Date().toISOString();
    const findings: Finding[] = [];
    for (const f of parsed.findings) {
      if (!f || typeof f !== "object") continue;
      const rec = f as Partial<Finding>;
      const claim = String(rec.claim ?? "").trim().slice(0, 400);
      if (!claim) continue;
      findings.push({
        id: String(rec.id ?? `f${findings.length}-${now}`),
        claim,
        refs: normaliseRefs(rec.refs),
        evidence: String(rec.evidence ?? "").trim().slice(0, 300),
        // Preserve every terminal status the store wrote. The pre-cap
        // sanitizer collapsed "superseded" back to "active", so a finding
        // revised as done came back from disk still riding the prompt —
        // finished work resurrecting itself every session.
        status:
          rec.status === "disproved" || rec.status === "superseded"
            ? rec.status
            : "active",
        ...(rec.supersededBy
          ? { supersededBy: String(rec.supersededBy) }
          : {}),
        createdAt: String(rec.createdAt ?? now),
        updatedAt: String(rec.updatedAt ?? rec.createdAt ?? now),
      });
    }
    return { version: 1, findings };
  } catch {
    return emptyStore();
  }
}

async function writeStore(
  workspaceId: string,
  store: FindingsStore
): Promise<void> {
  const dir = path.dirname(storePath(workspaceId));
  await fs.mkdir(dir, { recursive: true });
  const target = storePath(workspaceId);
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

export interface NewFinding {
  claim: string;
  refs?: string[];
  evidence?: string;
}

function normaliseRefs(refs: unknown): string[] {
  if (!Array.isArray(refs)) return [];
  return [...new Set(refs.map((r) => String(r).trim()).filter(Boolean))].slice(
    0,
    12
  );
}

/**
 * Add a finding. If one with nearly the same claim exists, it is updated
 * rather than duplicated.
 */
export async function addFinding(
  workspaceId: string,
  input: NewFinding
): Promise<Finding> {
  const claim = input.claim.trim().slice(0, 400);
  if (!claim) throw new Error("A finding needs a claim.");
  const store = await readStore(workspaceId);
  const evidence = (input.evidence ?? "").trim().slice(0, 300);
  const refs = normaliseRefs(input.refs);
  const now = new Date().toISOString();

  const key = claim.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const existing = store.findings.find(
    (f) =>
      f.status === "active" &&
      f.claim.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === key
  );
  if (existing) {
    existing.evidence = evidence || existing.evidence;
    if (refs.length) {
      existing.refs = [...new Set([...existing.refs, ...refs])].slice(0, 12);
    }
    existing.updatedAt = now;
    await writeStore(workspaceId, store);
    return existing;
  }

  const finding: Finding = {
    id: `f${Date.now().toString(36)}${store.findings.length}`,
    claim,
    refs,
    evidence,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  store.findings.push(finding);
  await writeStore(workspaceId, store);
  return finding;
}

export interface FindingRevision {
  id: string;
  /** Why it is wrong / what replaces it. */
  reason: string;
  status?: "superseded" | "disproved";
}

/**
 * Is this "claim" a retirement note rather than a corrected conclusion?
 *
 * The prompt tells the model to retire finished work with a claim like
 * "done — shipped in abc123". That text was filed as a NEW active finding,
 * so every retirement put a "done — shipped" line on every later prompt —
 * the clutter retiring exists to remove (measured).
 */
export function isRetirementClaim(claim: string): boolean {
  return /^\s*(done|fixed|resolved|shipped|retired|completed?|obsolete|no longer (needed|relevant|applies|true)|n\/a)\b/i.test(
    claim
  );
}

/** Mark a prior finding wrong, with the reason. */
export async function reviseFinding(
  workspaceId: string,
  revision: FindingRevision,
  replacement?: NewFinding
): Promise<{ updated: boolean; replacement?: Finding; alreadyRetired?: boolean }> {
  const store = await readStore(workspaceId);
  const old = store.findings.find((f) => f.id === revision.id);
  if (!old) return { updated: false };
  // Retiring twice is refused: a second "disproved" used to succeed and add
  // yet another active replacement for a finding that was already gone.
  if (old.status !== "active") return { updated: false, alreadyRetired: true };
  const now = new Date().toISOString();
  old.status = revision.status === "disproved" ? "disproved" : "superseded";
  old.updatedAt = now;

  let replacementFinding: Finding | undefined;
  if (
    replacement &&
    replacement.claim.trim() &&
    !isRetirementClaim(replacement.claim)
  ) {
    replacementFinding = {
      id: `f${Date.now().toString(36)}${store.findings.length}`,
      claim: replacement.claim.trim().slice(0, 400),
      refs: normaliseRefs(replacement.refs),
      evidence: (revision.reason + " " + (replacement.evidence ?? ""))
        .trim()
        .slice(0, 300),
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    old.supersededBy = replacementFinding.id;
    store.findings.push(replacementFinding);
  }
  await writeStore(workspaceId, store);
  return { updated: true, replacement: replacementFinding };
}

export async function readFindings(
  workspaceId: string
): Promise<FindingsStore> {
  return readStore(workspaceId);
}

/**
 * The active-findings block for the system prompt.
 *
 * Returns "" when there is nothing to say. Bounded so a long investigation
 * cannot crowd out the answer — the oldest active findings are dropped from
 * the prompt first (they stay on disk).
 */
export function formatFindingsForPrompt(store: FindingsStore): string {
  const active = store.findings
    .filter((f) => f.status === "active")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (active.length === 0) return "";

  const shown = active.slice(0, 25);
  const lines = shown.map((f) => {
    const where = f.refs.length ? ` (${f.refs.slice(0, 4).join(", ")})` : "";
    const why = f.evidence ? ` — ${f.evidence.slice(0, 300)}` : "";
    return `- [${f.id}] ${f.claim.slice(0, 400)}${where}${why}`;
  });
  if (active.length > shown.length) {
    lines.push(`  … ${active.length - shown.length} more established findings.`);
  }
  return (
    `\n\n${FINDINGS_MARKER_OPEN}\n` +
    "Findings already established in this workspace (your own prior conclusions — use the ones RELEVANT to the current request, do not re-derive them; a finding this request does not need is background: never mention, cite, or act on it, leave it out of your reply entirely; if one is wrong, correct it with note_finding; when the work a finding describes is DONE and shipped, retire it — note_finding with that id, status 'disproved', and claim 'done — shipped in <commit/fix>' — so finished items stop riding every prompt):\n\n" +
    lines.join("\n") +
    `\n${FINDINGS_MARKER_CLOSE}\n`
  );
}

/** Machine-wide findings block for the system prompt ("" when none). */
export function formatMachineFindingsForPrompt(store: FindingsStore): string {
  const active = store.findings
    .filter((f) => f.status === "active")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_MACHINE_FINDINGS_SHOWN);
  if (active.length === 0) return "";
  const lines = active.map((f) => {
    const why = f.evidence ? ` — ${f.evidence.slice(0, 200)}` : "";
    return `- [${f.id}] ${f.claim.slice(0, 300)}${why}`;
  });
  return (
    `\n\n<machine-findings>\n` +
    "Facts about THIS machine and its tools, proven in earlier chats (not about any project). Trust them instead of re-probing; if one turns out wrong here, correct it with note_finding (that id, status 'disproved'):\n\n" +
    lines.join("\n") +
    `\n</machine-findings>\n`
  );
}

export const FINDINGS_MARKER_OPEN = "<workspace-findings>";
export const FINDINGS_MARKER_CLOSE = "</workspace-findings>";

/** Replace an existing findings block, or append; used on resume. */
export function replaceFindings(content: string, replacement: string): string {
  const start = content.indexOf(FINDINGS_MARKER_OPEN);
  if (start === -1) return content + replacement;
  const end = content.indexOf(FINDINGS_MARKER_CLOSE, start);
  if (end === -1) return content + replacement;
  return (
    content.slice(0, start) +
    replacement.trim() +
    content.slice(end + FINDINGS_MARKER_CLOSE.length)
  );
}

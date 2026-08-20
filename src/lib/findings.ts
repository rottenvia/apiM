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

const EMPTY: FindingsStore = { version: 1, findings: [] };

function storePath(workspaceId: string): string {
  return path.join(workspaceDirectory(workspaceId), FINDINGS_DIR, FINDINGS_FILE);
}

async function readStore(workspaceId: string): Promise<FindingsStore> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(storePath(workspaceId), "utf8")
    ) as Partial<FindingsStore>;
    if (parsed.version !== 1 || !Array.isArray(parsed.findings)) return EMPTY;
    return { version: 1, findings: parsed.findings };
  } catch {
    return EMPTY;
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

/** Mark a prior finding wrong, with the reason. */
export async function reviseFinding(
  workspaceId: string,
  revision: FindingRevision,
  replacement?: NewFinding
): Promise<{ updated: boolean; replacement?: Finding }> {
  const store = await readStore(workspaceId);
  const old = store.findings.find((f) => f.id === revision.id);
  if (!old) return { updated: false };
  const now = new Date().toISOString();
  old.status = revision.status === "disproved" ? "disproved" : "superseded";
  old.updatedAt = now;

  let replacementFinding: Finding | undefined;
  if (replacement) {
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
    const why = f.evidence ? ` — ${f.evidence}` : "";
    return `- [${f.id}] ${f.claim}${where}${why}`;
  });
  if (active.length > shown.length) {
    lines.push(`  … ${active.length - shown.length} more established findings.`);
  }
  return (
    `\n\n${FINDINGS_MARKER_OPEN}\n` +
    "Findings already established in this workspace (your own prior conclusions — use them, do not re-derive them; if one is wrong, correct it with note_finding):\n\n" +
    lines.join("\n") +
    `\n${FINDINGS_MARKER_CLOSE}\n`
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

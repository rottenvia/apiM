/**
 * Durable memory of which executables in this workspace were already
 * inspected/decompiled, and what the agent concluded about each.
 *
 * The problem this solves: a long binary-analysis run decompiles two DLLs
 * with Ghidra, the user presses Stop to correct a wrong conclusion, and on
 * the very next message compaction has folded those tool results down to a
 * single line each (`- inspect_binary(foo.dll)`). The model can no longer see
 * that it already spent minutes on Ghidra, where the artifacts landed, or
 * that one DLL "works but has flaws" while the good build is the other one.
 * It re-runs the decompiler and re-reads everything — more spend than the
 * compaction ever saved.
 *
 * A lesson file is the wrong shape for this (it only captures one short,
 * evidence-backed sentence, and the Stop path intentionally skips it). This
 * ledger is machine-maintained: every inspect_binary call appends/updates a
 * record keyed by path+hash, and an optional `note` holds the agent's or
 * user's verdict ("working, but CreateMove reads a stale pointer; the fixed
 * build is bar.dll"). It sits in an internal directory so it never appears
 * in the file tree, and it is injected into the system prompt as a compact
 * table that survives Stop, compaction and resume.
 *
 * Writes are best-effort and append-only in spirit: a failed ledger update
 * must never fail an inspection. The same write-then-rename discipline as the
 * lessons/chat store prevents half-written JSON from being parsed as a valid
 * (empty) ledger.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { workspaceDirectory, INTERNAL_DIRS } from "@/lib/workspace";

/** Internal subdirectory; never listed or shown as a user file. */
const LEDGER_DIR = ".analysis";
const LEDGER_FILE = "binaries.json";

/**
 * One executable's cumulative analysis state.
 *
 * Counts/timestamps let the prompt say "already decompiled twice, 4 minutes
 * ago" which is what stops a wasteful re-run. Output paths are recorded so
 * the model can read the existing artifact instead of regenerating it.
 */
export interface BinaryLedgerEntry {
  /** Workspace-relative path, using forward slashes. */
  path: string;
  /** SHA-256 of the bytes at last inspection. */
  sha256: string;
  /** File size in bytes at last inspection. */
  size: number;
  /** Short architecture label, e.g. "x86-64". */
  architecture?: string;
  /** True when the parser detected a DLL/library. */
  isDll?: boolean;
  /** Managed/.NET vs native, when known. */
  managed?: boolean;
  /** Last static-parse result: "ok" or the error message. */
  staticStatus?: string;
  /** Last deep-decompiler status: complete/partial/failed/unavailable/disabled. */
  deepStatus?: string;
  /** Which deep engine produced it: ghidra | ilspy | none. */
  deepEngine?: string;
  /** Whether the deep result was a cache hit (no CPU spent). */
  deepCached?: boolean;
  /** Focus terms used for the deep run, when focused. */
  deepFocusTerms?: string[];
  /** capa status, when run. */
  capaStatus?: string;
  /** Workspace-relative artifact files most recently produced. */
  outputs: string[];
  /** Analysis root directory (relative), where outputs live. */
  analysisRoot?: string;
  /** Number of times inspect_binary ran against this exact hash. */
  inspectCount: number;
  /** Number of deep decompilations actually attempted (cache misses). */
  deepRuns: number;
  /** ISO timestamp of the most recent inspection. */
  lastInspectedAt: string;
  /** ISO timestamp of the most recent deep run, if any. */
  lastDeepAt?: string;
  /**
   * The verdict: working/broken/flawed, where the good build is, what the
   * hook actually does. Free text, set by note_binary or a later run. This is
   * the part a Stop would otherwise throw away.
   */
  note?: string;
  /** ISO timestamp of the last note change. */
  notedAt?: string;
}

interface BinaryLedger {
  version: 1;
  entries: Record<string, BinaryLedgerEntry>;
}

const EMPTY_LEDGER: BinaryLedger = { version: 1, entries: {} };

function ledgerPath(workspaceId: string): string {
  return path.join(workspaceDirectory(workspaceId), LEDGER_DIR, LEDGER_FILE);
}

/** Stable key: same path+hash is one executable; a rebuilt DLL gets a new key. */
function keyFor(entry: Pick<BinaryLedgerEntry, "path" | "sha256">): string {
  return `${entry.path}::${entry.sha256.slice(0, 16)}`;
}

async function readLedger(workspaceId: string): Promise<BinaryLedger> {
  try {
    const raw = await fs.readFile(ledgerPath(workspaceId), "utf8");
    const parsed = JSON.parse(raw) as Partial<BinaryLedger>;
    if (!parsed || parsed.version !== 1 || typeof parsed.entries !== "object") {
      return { version: 1, entries: {} };
    }
    return { version: 1, entries: parsed.entries ?? {} };
  } catch {
    return EMPTY_LEDGER;
  }
}

async function writeLedger(
  workspaceId: string,
  ledger: BinaryLedger
): Promise<void> {
  const dir = path.dirname(ledgerPath(workspaceId));
  await fs.mkdir(dir, { recursive: true });
  const target = ledgerPath(workspaceId);
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(ledger, null, 2), "utf8");
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

export interface InspectionRecord {
  path: string;
  sha256: string;
  size: number;
  architecture?: string;
  isDll?: boolean;
  managed?: boolean | null;
  staticStatus?: string;
  deepStatus?: string;
  deepEngine?: string;
  deepCached?: boolean;
  deepFocusTerms?: string[];
  capaStatus?: string;
  outputs?: string[];
  analysisRoot?: string;
  /** A deep run was actually attempted this call (cache miss / force). */
  deepRan?: boolean;
}

function ensureArray(value: string[] | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Fold one inspection result into the ledger.
 *
 * A cache hit still increments inspectCount (the model looked at it) but not
 * deepRuns (no CPU was spent), which is the distinction that makes "you
 * already decompiled this" trustworthy. A changed hash starts a fresh entry
 * so a rebuilt DLL never inherits the old verdict.
 */
export async function recordBinaryInspection(
  workspaceId: string,
  rec: InspectionRecord
): Promise<void> {
  try {
    const ledger = await readLedger(workspaceId);
    const key = keyFor(rec);
    const now = new Date().toISOString();
    const previous = ledger.entries[key];
    const outputs = Array.from(
      new Set([...ensureArray(previous?.outputs), ...ensureArray(rec.outputs)])
    ).sort();

    const entry: BinaryLedgerEntry = {
      path: rec.path,
      sha256: rec.sha256,
      size: rec.size,
      architecture: rec.architecture ?? previous?.architecture,
      isDll: rec.isDll ?? previous?.isDll,
      managed:
        typeof rec.managed === "boolean"
          ? rec.managed
          : previous?.managed,
      staticStatus: rec.staticStatus ?? previous?.staticStatus,
      deepStatus: rec.deepStatus ?? previous?.deepStatus,
      deepEngine: rec.deepEngine ?? previous?.deepEngine,
      deepCached: rec.deepCached ?? previous?.deepCached,
      deepFocusTerms: rec.deepFocusTerms ?? previous?.deepFocusTerms,
      capaStatus: rec.capaStatus ?? previous?.capaStatus,
      outputs,
      analysisRoot: rec.analysisRoot ?? previous?.analysisRoot,
      inspectCount: (previous?.inspectCount ?? 0) + 1,
      deepRuns:
        (previous?.deepRuns ?? 0) + (rec.deepRan ? 1 : 0),
      lastInspectedAt: now,
      lastDeepAt:
        rec.deepRan || rec.deepStatus
          ? now
          : previous?.lastDeepAt,
      // A verdict about an executable is about its bytes; carry it forward
      // for the same hash but never copy it to a different build.
      note: previous?.note,
      notedAt: previous?.notedAt,
    };
    ledger.entries[key] = entry;
    await writeLedger(workspaceId, ledger);
  } catch (err) {
    // The ledger is an optimisation, never a requirement. Log and move on so
    // a disk error cannot turn an inspection into a failure.
    console.error("binary ledger record failed:", err);
  }
}

export interface BinaryNote {
  path: string;
  /** Optional: scope the note to a specific build's hash. */
  sha256?: string;
  note: string;
}

/**
 * Attach (or replace) the verdict for an executable.
 *
 * If a sha256 is given only that exact build is annotated. Otherwise the most
 * recent entry for the path is updated, or a stub is created so a note can be
 * recorded before the first inspection finishes.
 */
export async function noteBinaryInspection(
  workspaceId: string,
  note: BinaryNote
): Promise<{ updated: number; entry?: BinaryLedgerEntry }> {
  const ledger = await readLedger(workspaceId);
  const now = new Date().toISOString();
  const text = note.note.trim().slice(0, 500);
  if (!text) return { updated: 0 };

  let match: BinaryLedgerEntry | undefined;
  if (note.sha256) {
    // The ledger keys on a 16-char prefix; accept a full hash or any
    // reasonable prefix the model copied and match it as a prefix against the
    // entries for this path, so a 12-char short hash still resolves.
    const needle = note.sha256.toLowerCase();
    const candidates = Object.values(ledger.entries).filter(
      (e) =>
        e.path === note.path &&
        (e.sha256.toLowerCase().startsWith(needle) ||
          needle.startsWith(e.sha256.toLowerCase()))
    );
    candidates.sort((a, b) =>
      (b.notedAt ?? b.lastInspectedAt).localeCompare(
        a.notedAt ?? a.lastInspectedAt
      )
    );
    match = candidates[0];
  } else {
    let latest: BinaryLedgerEntry | undefined;
    for (const entry of Object.values(ledger.entries)) {
      if (entry.path !== note.path) continue;
      if (!latest || entry.lastInspectedAt > latest.lastInspectedAt) {
        latest = entry;
      }
    }
    match = latest;
  }

  if (match) {
    match.note = text;
    match.notedAt = now;
  } else {
    // No inspection yet — keep a stub so the verdict survives.
    const stub: BinaryLedgerEntry = {
      path: note.path,
      sha256: note.sha256 ?? "pending",
      size: 0,
      outputs: [],
      inspectCount: 0,
      deepRuns: 0,
      lastInspectedAt: now,
      note: text,
      notedAt: now,
    };
    ledger.entries[keyFor(stub)] = stub;
    match = stub;
  }
  await writeLedger(workspaceId, ledger);
  return { updated: 1, entry: match };
}

/** Read access, for tools/UI that want the raw structure. */
export async function readBinaryLedger(
  workspaceId: string
): Promise<BinaryLedger> {
  return readLedger(workspaceId);
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return new Date(then).toISOString().slice(0, 10);
}

/**
 * Render the ledger for the system prompt as a compact, scannable block.
 *
 * Returns "" when there is nothing to say, identical in spirit to the
 * workspace-context builder. Entries are ordered most-recent first so the
 * thing the agent was just working on is at the top.
 */
export function formatBinaryLedgerForPrompt(
  ledger: BinaryLedger
): string {
  const entries = Object.values(ledger.entries)
    .filter((e) => e.inspectCount > 0 || e.note)
    .sort((a, b) =>
      (b.notedAt ?? b.lastInspectedAt).localeCompare(
        a.notedAt ?? a.lastInspectedAt
      )
    );
  if (entries.length === 0) return "";

  const lines: string[] = [
    "Executables already analyzed in this workspace (do NOT re-decompile/re-inspect a matching hash — read the listed artifacts instead):",
  ];
  for (const e of entries.slice(0, 30)) {
    const tags: string[] = [];
    if (e.deepStatus) tags.push(`decompile:${e.deepStatus}${e.deepCached ? "(cached)" : ""}`);
    if (e.deepRuns > 0) tags.push(`${e.deepRuns} deep run${e.deepRuns === 1 ? "" : "s"}`);
    if (e.capaStatus) tags.push(`capa:${e.capaStatus}`);
    if (e.managed) tags.push("managed");
    const head =
      `- ${e.path} [${e.architecture ?? "?"}${e.isDll ? ", dll" : ""}] ` +
      `sha256:${e.sha256.slice(0, 12)} — inspected ${e.inspectCount}×, ` +
      `${relativeTime(e.lastInspectedAt)}${tags.length ? ` (${tags.join(", ")})` : ""}`;
    lines.push(head);
    if (e.outputs.length) {
      lines.push(
        `    artifacts: ${e.outputs.slice(0, 6).join(", ")}` +
          (e.outputs.length > 6 ? `, … +${e.outputs.length - 6} more` : "")
      );
    }
    if (e.note) {
      lines.push(`    VERDICT: ${e.note}`);
    }
  }
  if (entries.length > 30) {
    lines.push(`  … ${entries.length - 30} more (use list_analysis to see them)`);
  }
  lines.push(
    "If these files match what the user is asking about, read the existing artifacts with read_file and update the verdict via note_binary instead of re-running inspect_binary/decompilation."
  );
  // Bounded by markers so a stale copy baked into a saved/ resumed transcript
  // can be found and replaced with the current ledger in place, without
  // rebuilding (and re-pricing) the whole system message.
  return `\n\n<binary-analysis-ledger>\n${lines.join("\n")}\n</binary-analysis-ledger>\n`;
}

/** Opening/closing sentinels for the ledger block inside a system message. */
export const BINARY_LEDGER_MARKER_OPEN = "<binary-analysis-ledger>";
export const BINARY_LEDGER_MARKER_CLOSE = "</binary-analysis-ledger>";

/**
 * Replace any binary-ledger block already in `content` with `replacement`,
 * or append it when none exists. Used on resume, where the saved first system
 * message carries a ledger snapshot from before the interrupted run decompiled
 * anything - stale enough to make the model re-run Ghidra.
 */
export function replaceBinaryLedger(content: string, replacement: string): string {
  const start = content.indexOf(BINARY_LEDGER_MARKER_OPEN);
  if (start === -1) return content + replacement;
  const end = content.indexOf(BINARY_LEDGER_MARKER_CLOSE, start);
  if (end === -1) return content + replacement;
  const before = content.slice(0, start);
  const after = content.slice(end + BINARY_LEDGER_MARKER_CLOSE.length);
  return before + replacement.trim() + after;
}

export { LEDGER_DIR, LEDGER_FILE };

/**
 * Line diff.
 *
 * Small enough to own rather than take a dependency for: the workspace only
 * ever diffs source files a model just wrote, which are thousands of lines at
 * most.
 */

export type DiffKind = "same" | "added" | "removed";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number in the old file, null for added lines. */
  oldLine: number | null;
  /** 1-based line number in the new file, null for removed lines. */
  newLine: number | null;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** A run of changes plus a little surrounding context. */
export interface DiffHunk {
  lines: DiffLine[];
  /** Unchanged lines skipped before this hunk, for a "… 12 unchanged" marker. */
  skippedBefore: number;
}

/** Guard against a pathological file making the O(n·m) table enormous. */
const MAX_DIFF_LINES = 5000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  // Normalise line endings so a file written on Windows doesn't appear to
  // have changed on every single line.
  const normalised = text.replace(/\r\n/g, "\n");
  const lines = normalised.split("\n");
  // A trailing newline produces a final empty element that isn't a real line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Longest common subsequence over lines.
 *
 * The table is (n+1)×(m+1) numbers, which is why the line cap above exists.
 */
function lcsTable(a: string[], b: string[]): Uint32Array {
  const w = b.length + 1;
  const table = new Uint32Array((a.length + 1) * w);

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] =
        a[i] === b[j]
          ? table[(i + 1) * w + (j + 1)] + 1
          : Math.max(table[(i + 1) * w + j], table[i * w + (j + 1)]);
    }
  }
  return table;
}

/** Compares two versions of a file, line by line. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // Too large to diff properly — report it as a wholesale replacement rather
  // than locking the browser up building a 25-million-cell table.
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [
      ...a.map((text, i) => ({
        kind: "removed" as const,
        text,
        oldLine: i + 1,
        newLine: null,
      })),
      ...b.map((text, i) => ({
        kind: "added" as const,
        text,
        oldLine: null,
        newLine: i + 1,
      })),
    ];
  }

  const table = lcsTable(a, b);
  const w = b.length + 1;
  const out: DiffLine[] = [];

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (table[(i + 1) * w + j] >= table[i * w + (j + 1)]) {
      out.push({ kind: "removed", text: a[i], oldLine: i + 1, newLine: null });
      i++;
    } else {
      out.push({ kind: "added", text: b[j], oldLine: null, newLine: j + 1 });
      j++;
    }
  }
  while (i < a.length) {
    out.push({ kind: "removed", text: a[i], oldLine: i + 1, newLine: null });
    i++;
  }
  while (j < b.length) {
    out.push({ kind: "added", text: b[j], oldLine: null, newLine: j + 1 });
    j++;
  }

  return out;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added++;
    else if (line.kind === "removed") removed++;
  }
  return { added, removed };
}

/**
 * Groups changes into hunks with `context` unchanged lines either side.
 *
 * Without this, a one-line change in a 500-line file renders 500 lines and
 * the actual change is impossible to find.
 */
export function diffHunks(lines: DiffLine[], context = 3): DiffHunk[] {
  const changed = lines.map((l) => l.kind !== "same");
  if (!changed.some(Boolean)) return [];

  // Mark every line within `context` of a change as worth keeping.
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!changed[i]) continue;
    for (
      let j = Math.max(0, i - context);
      j <= Math.min(lines.length - 1, i + context);
      j++
    ) {
      keep[j] = true;
    }
  }

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  let skipped = 0;
  let pendingSkip = 0;

  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (current.length === 0) {
        skipped = pendingSkip;
        pendingSkip = 0;
      }
      current.push(lines[i]);
    } else {
      if (current.length > 0) {
        hunks.push({ lines: current, skippedBefore: skipped });
        current = [];
      }
      pendingSkip++;
    }
  }
  if (current.length > 0) {
    hunks.push({ lines: current, skippedBefore: skipped });
  }

  return hunks;
}

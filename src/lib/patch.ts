/**
 * Applying a unified diff.
 *
 * ## Why, when `edit_file` exists
 *
 * `edit_file` matches a snippet and replaces it. That works well for one
 * change and degrades for several, because each edit shifts every line below
 * it — so a model planning four changes to one file has to either make four
 * separate calls (four rounds) or get the later snippets exactly right
 * against text it has not seen since the earlier edits landed.
 *
 * A patch carries its own context. Each hunk says which lines it expects to
 * find, so all four changes are described against the file as the model last
 * read it, and they apply together or not at all.
 *
 * ## Deliberately strict, with one tolerance
 *
 * A patch that half-applies is worse than one that is rejected: the file ends
 * in a state neither the model nor the user predicted. So every hunk must
 * find its place, or nothing is written.
 *
 * The single tolerance is line position. Real diffs carry `@@ -12,7 +12,9 @@`
 * headers, and a model reproducing one usually gets the numbers slightly
 * wrong even when the content is right. The line number is therefore treated
 * as a hint: the hunk is searched for near where it claims to be, and then
 * anywhere in the file. Content still has to match exactly.
 */

export interface PatchHunk {
  /** Line the hunk claims to start at, 1-based. A hint, not a requirement. */
  startsAt: number;
  /** Context and removed lines, in order — what must be present. */
  expected: string[];
  /** Context and added lines — what replaces them. */
  replacement: string[];
}

export class PatchError extends Error {}

/**
 * Parse a unified diff into hunks.
 *
 * Tolerates the surrounding noise a model tends to include: `diff --git`
 * lines, `---`/`+++` headers, and a fenced code block around the whole thing.
 */
export function parsePatch(patch: string): PatchHunk[] {
  const text = patch.replace(/^\s*```[a-z]*\s*\n/i, "").replace(/\n```\s*$/, "");
  const lines = text.split("\n");

  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;

  for (const line of lines) {
    // Headers carry no content.
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      continue;
    }

    const header = /^@@\s*-(\d+)(?:,\d+)?\s+\+\d+(?:,\d+)?\s*@@/.exec(line);
    if (header) {
      if (current) hunks.push(current);
      current = {
        startsAt: Number(header[1]),
        expected: [],
        replacement: [],
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith("+")) {
      current.replacement.push(line.slice(1));
    } else if (line.startsWith("-")) {
      current.expected.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      current.expected.push(line.slice(1));
      current.replacement.push(line.slice(1));
    } else if (line === "") {
      // A blank line in a diff is context with its leading space stripped by
      // an editor or by the model. Treating it as a terminator instead would
      // silently truncate the hunk.
      current.expected.push("");
      current.replacement.push("");
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — metadata, not content.
      continue;
    }
  }

  if (current) hunks.push(current);

  if (hunks.length === 0) {
    throw new PatchError(
      "No @@ hunks found. A unified diff needs at least one hunk header like " +
        "`@@ -10,6 +10,7 @@`, followed by lines prefixed with ' ', '-' or '+'."
    );
  }

  return hunks;
}

/**
 * Where a hunk's expected lines sit, or -1.
 *
 * Two passes. Exact content first, because that is unambiguous. Then the
 * same comparison ignoring leading indentation, because a hunk hand-built
 * from a numbered read is routinely off by the gutter or by a tab/space
 * conversion — and rejecting the whole surgery over that costs a round to
 * learn nothing. A loose match is reported as loose; it is never silent.
 */
function locate(
  fileLines: string[],
  expected: string[],
  hint: number
): { at: number; exact: boolean } {
  if (expected.length === 0) return { at: -1, exact: true };

  const matchesAt = (index: number, loose: boolean): boolean => {
    if (index < 0 || index + expected.length > fileLines.length) return false;
    for (let i = 0; i < expected.length; i++) {
      const a = fileLines[index + i];
      const b = expected[i];
      if (loose ? a.trim() !== b.trim() : a !== b) return false;
    }
    return true;
  };

  for (const loose of [false, true]) {
    // The stated position first — correct in the common case and unambiguous.
    const hinted = hint - 1;
    if (matchesAt(hinted, loose)) return { at: hinted, exact: !loose };

    // Then outward from it, so the nearest candidate wins when a file
    // contains the same few lines more than once.
    for (let distance = 1; distance <= fileLines.length; distance++) {
      if (matchesAt(hinted - distance, loose)) {
        return { at: hinted - distance, exact: !loose };
      }
      if (matchesAt(hinted + distance, loose)) {
        return { at: hinted + distance, exact: !loose };
      }
    }
  }

  return { at: -1, exact: true };
}

/** Closest thing to this hunk in the file, for the failure report. */
function nearestCandidate(
  fileLines: string[],
  expected: string[]
): { line: number; matched: number; found: string } | null {
  const norm = (v: string) => v.trim().replace(/\s+/g, " ");
  const target = expected.map(norm);
  let bestScore = 0;
  let bestAt = -1;
  for (let i = 0; i + target.length <= fileLines.length; i++) {
    let score = 0;
    for (let j = 0; j < target.length; j++) {
      if (norm(fileLines[i + j]) === target[j]) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestAt = i;
    }
  }
  if (bestAt === -1 || bestScore === 0) return null;

  let firstDiff = 0;
  while (
    firstDiff < target.length &&
    norm(fileLines[bestAt + firstDiff] ?? "") === target[firstDiff]
  ) {
    firstDiff++;
  }
  return {
    line: bestAt + 1,
    matched: bestScore,
    found: (fileLines[bestAt + firstDiff] ?? "<end of file>").trim(),
  };
}

/** What happened to one hunk. Reported for every hunk, always. */
export interface HunkResult {
  /** 1-based, in the order the hunks appear in the patch. */
  index: number;
  applied: boolean;
  /** 1-based line it matched at, or null when it did not match. */
  at: number | null;
  /** False when it only matched with indentation ignored. */
  exact: boolean;
  /** First expected line, so a report names the hunk in the model's terms. */
  head: string;
  /** Why it failed — the nearest candidate and the first line that differs. */
  reason?: string;
}

export interface PatchResult {
  content: string;
  hunksApplied: number;
  hunksTotal: number;
  /** One entry per hunk, applied or not. */
  results: HunkResult[];
}

/** Human-readable per-hunk table. This is what the model actually reads. */
export function formatHunkReport(results: HunkResult[]): string {
  return results
    .map((h) => {
      const head = h.head ? ` ${JSON.stringify(h.head.slice(0, 60))}` : "";
      if (h.applied) {
        return (
          `  hunk ${h.index}/${results.length}: applied at line ${h.at}` +
          `${h.exact ? "" : " (matched ignoring indentation)"}${head}`
        );
      }
      return (
        `  hunk ${h.index}/${results.length}: NOT applied — expected to ` +
        `find${head || " its context"}; ${h.reason ?? "no match"}`
      );
    })
    .join("\n");
}

export class PatchReportError extends PatchError {
  constructor(
    message: string,
    readonly results: HunkResult[]
  ) {
    super(message);
  }
}

/**
 * Apply a unified diff.
 *
 * Atomic by default: every hunk must find its place, or nothing is written,
 * because a half-applied patch leaves a file in a state neither side
 * predicted. What changed is the FAILURE: it used to name the first bad hunk
 * and stop, so a nineteen-hunk surgery with one drifted context told you
 * almost nothing. Now every hunk is located and reported — which applied,
 * where, and for the ones that did not, the closest candidate and the exact
 * line that differs.
 *
 * `partial: true` writes the hunks that did match and reports the rest, for
 * when getting eighteen of nineteen in is worth more than atomicity.
 */
export function applyPatch(
  original: string,
  patch: string,
  options: { partial?: boolean } = {}
): PatchResult {
  const hunks = parsePatch(patch);
  const fileLines = original.split("\n");

  // Locate everything before changing anything, so the report describes the
  // file as the model last saw it rather than one already half-edited.
  const placed: { at: number; hunk: PatchHunk }[] = [];
  const results: HunkResult[] = [];

  for (const [i, hunk] of hunks.entries()) {
    const head = hunk.expected.find((l) => l.trim() !== "") ?? "";
    const { at, exact } = locate(fileLines, hunk.expected, hunk.startsAt);
    if (at === -1) {
      const near = nearestCandidate(fileLines, hunk.expected);
      results.push({
        index: i + 1,
        applied: false,
        at: null,
        exact: false,
        head,
        reason: near
          ? `closest match is line ${near.line} where ${near.matched} of ` +
            `${hunk.expected.length} lines agree; first difference there is ` +
            `${JSON.stringify(near.found.slice(0, 60))}`
          : `nothing in the file resembles this hunk — check the path and ` +
            `re-read the region`,
      });
      continue;
    }
    placed.push({ at, hunk });
    results.push({ index: i + 1, applied: true, at: at + 1, exact, head });
  }

  // Overlapping hunks would corrupt each other.
  const sorted = [...placed].sort((a, b) => a.at - b.at);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    if (prev.at + prev.hunk.expected.length > sorted[i].at) {
      throw new PatchReportError(
        `Two hunks overlap the same lines (around line ${sorted[i].at + 1}). ` +
          `Combine them into one hunk.\n\n${formatHunkReport(results)}`,
        results
      );
    }
  }

  const failed = results.filter((r) => !r.applied);
  if (failed.length && !options.partial) {
    throw new PatchReportError(
      `${failed.length} of ${hunks.length} hunk(s) did not match, so nothing ` +
        `was written. Full report:\n${formatHunkReport(results)}\n\n` +
        `Fix only the hunk(s) marked NOT applied and send the patch again, ` +
        `or set partial to true to land the ones that do match.`,
      results
    );
  }

  let out = [...fileLines];
  for (const { at, hunk } of [...placed].sort((a, b) => b.at - a.at)) {
    out = [
      ...out.slice(0, at),
      ...hunk.replacement,
      ...out.slice(at + hunk.expected.length),
    ];
  }

  return {
    content: out.join("\n"),
    hunksApplied: placed.length,
    hunksTotal: hunks.length,
    results,
  };
}

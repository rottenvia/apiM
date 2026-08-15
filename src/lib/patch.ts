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

/** Where a hunk's expected lines actually sit in the file, or -1. */
function locate(fileLines: string[], expected: string[], hint: number): number {
  if (expected.length === 0) return -1;

  const matchesAt = (index: number): boolean => {
    if (index < 0 || index + expected.length > fileLines.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (fileLines[index + i] !== expected[i]) return false;
    }
    return true;
  };

  // The stated position first — correct in the common case and unambiguous.
  const hinted = hint - 1;
  if (matchesAt(hinted)) return hinted;

  // Then outward from it, so the nearest candidate wins when a file contains
  // the same few lines more than once.
  for (let distance = 1; distance <= fileLines.length; distance++) {
    if (matchesAt(hinted - distance)) return hinted - distance;
    if (matchesAt(hinted + distance)) return hinted + distance;
  }

  return -1;
}

export interface PatchResult {
  content: string;
  hunksApplied: number;
}

/**
 * Apply every hunk, or throw.
 *
 * Hunks are applied from the bottom of the file upward, so an earlier hunk's
 * change cannot move the lines a later one was located against.
 */
export function applyPatch(original: string, patch: string): PatchResult {
  const hunks = parsePatch(patch);
  const fileLines = original.split("\n");

  // Locate everything before changing anything: a hunk that cannot be placed
  // must abort the whole patch, not leave the file half-modified.
  const placed: { at: number; hunk: PatchHunk }[] = [];
  for (const [i, hunk] of hunks.entries()) {
    const at = locate(fileLines, hunk.expected, hunk.startsAt);
    if (at === -1) {
      const preview = hunk.expected.slice(0, 3).join("\n");
      throw new PatchError(
        `Hunk ${i + 1} does not match the file. It expected to find:\n` +
          `${preview}\n\nRead the file again and build the patch from its ` +
          `current contents — something has changed since you last saw it.`
      );
    }
    placed.push({ at, hunk });
  }

  // Overlapping hunks would corrupt each other.
  const sorted = [...placed].sort((a, b) => a.at - b.at);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    if (prev.at + prev.hunk.expected.length > sorted[i].at) {
      throw new PatchError(
        "Two hunks overlap the same lines. Combine them into one hunk."
      );
    }
  }

  let out = [...fileLines];
  for (const { at, hunk } of [...placed].sort((a, b) => b.at - a.at)) {
    out = [
      ...out.slice(0, at),
      ...hunk.replacement,
      ...out.slice(at + hunk.expected.length),
    ];
  }

  return { content: out.join("\n"), hunksApplied: hunks.length };
}

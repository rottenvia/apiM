/**
 * Telling the model what changed, instead of re-telling it everything.
 *
 * Background, measured rather than assumed (`npm run cost:lab`):
 *
 * DeepSeek's prompt cache matches a PREFIX of the request, from the very
 * first token, in 64-token blocks. Everything up to the first byte that
 * differs from a previous request is billed at $0.003625/M; everything from
 * that byte onward is billed at $0.435/M. That is a 120x cliff, and where it
 * falls is decided entirely by message ORDER.
 *
 * The workspace listing used to be kept fresh by deleting the old copy and
 * appending a new one at the end of the transcript. That is two edits to the
 * array, and the first one — the delete — happens near the FRONT. Removing a
 * message at index 2 shifts every later message, so the serialised request
 * stops matching almost immediately and the entire conversation is re-read at
 * full price.
 *
 * The cost of that, on a measured 40-round task that wrote files every third
 * round: 702k missed tokens against 473k for the identical task with no
 * writes. 229k tokens — a third of all the input on the whole task — bought
 * nothing except moving a directory listing to the bottom of the array.
 *
 * The fix is to never move it and never rewrite it. The first listing is sent
 * once and then left alone forever. After that, each change is a short new
 * message appended at the end:
 *
 *     Workspace changes since the last listing:
 *       + src/generated/step3.ts  (820B)
 *       ~ src/lib/store.ts  (12KB)
 *       - old-notes.md
 *
 * Appending is free. The prefix in front of a new final message is
 * byte-identical to the previous request, so it all hits the cache. A change
 * that used to cost a 7k-token re-read now costs about 15 tokens, and the
 * model ends up better informed: it sees what changed, not just what exists.
 *
 * Deltas do not accumulate forever. Once enough have piled up the listing is
 * re-baselined — one full tree, one deliberate cache miss — because a hundred
 * small diffs are both larger and harder to read than one current listing.
 */

/** One file, as the workspace listing sees it. */
export interface TreeEntry {
  path: string;
  size: number;
}

export type ChangeKind = "added" | "modified" | "removed";

export interface TreeChange {
  kind: ChangeKind;
  path: string;
  /** Absent for a removal. */
  size?: number;
}

/**
 * Re-baseline after this many accumulated changes.
 *
 * The trade is one cache miss (a full tree, a few thousand tokens on a big
 * project) against the confusion of reconstructing current state from a long
 * chain of diffs. Forty is roughly where a delta list stops being obviously
 * cheaper to read than a fresh listing, and on a normal task it is never
 * reached at all.
 */
export const REBASELINE_AFTER_CHANGES = 40;

/**
 * Re-baseline if the deltas themselves grow past this many characters.
 *
 * A bulk operation — unzipping an archive, running a build — can add hundreds
 * of files in one round. At that point the delta IS the tree, with worse
 * formatting.
 */
export const REBASELINE_AFTER_CHARS = 8_000;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Compare two listings.
 *
 * Size is the only change signal available: the listing carries no hashes or
 * timestamps. An edit that happens to preserve the byte count is therefore
 * invisible here — which is acceptable, because the model performed that edit
 * itself and already has the tool result describing it. This exists to catch
 * changes the model did NOT make directly: a build that emitted files, an
 * archive that unpacked, a script that deleted something.
 */
export function diffTrees(
  before: TreeEntry[],
  after: TreeEntry[]
): TreeChange[] {
  const beforeMap = new Map(before.map((f) => [f.path, f.size]));
  const afterMap = new Map(after.map((f) => [f.path, f.size]));

  const changes: TreeChange[] = [];

  for (const [path, size] of afterMap) {
    const prev = beforeMap.get(path);
    if (prev === undefined) changes.push({ kind: "added", path, size });
    else if (prev !== size) changes.push({ kind: "modified", path, size });
  }
  for (const [path] of beforeMap) {
    if (!afterMap.has(path)) changes.push({ kind: "removed", path });
  }

  // Stable order so an identical set of changes always serialises the same
  // way. Two requests that differ only in map iteration order would miss the
  // cache for no reason.
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

/** Render changes as the short message appended to the transcript. */
export function formatChanges(changes: TreeChange[]): string {
  if (changes.length === 0) return "";

  const symbol: Record<ChangeKind, string> = {
    added: "+",
    modified: "~",
    removed: "-",
  };

  const lines = changes.map((c) => {
    const size = c.size === undefined ? "" : `  (${formatSize(c.size)})`;
    return `  ${symbol[c.kind]} ${c.path}${size}`;
  });

  return (
    "Workspace changes since the last full listing " +
    "(+ added, ~ modified, - removed):\n" +
    lines.join("\n")
  );
}

/**
 * Tracks the listing across one agent run and decides, each time the
 * workspace changes, whether to append a small delta or start over with a
 * full tree.
 *
 * Deliberately holds no transcript references and performs no I/O: it is
 * given two listings and returns what to say about them. That makes the
 * decision testable on its own, which matters because getting it wrong is
 * invisible — it does not break anything, it just quietly costs money.
 */
export class TreeTracker {
  private baseline: TreeEntry[] = [];
  private pendingChanges = 0;
  private pendingChars = 0;
  private started = false;

  /** Changes appended since the last full listing. Exposed for tests. */
  get pending(): number {
    return this.pendingChanges;
  }

  /**
   * Record a fresh listing and say what should be added to the transcript.
   *
   * Returns:
   *   - `{ kind: "none" }`      nothing changed; append nothing
   *   - `{ kind: "delta" }`     append `text` as a new trailing message
   *   - `{ kind: "baseline" }`  replace the listing with a full tree
   */
  update(
    files: TreeEntry[]
  ): { kind: "none" | "delta" | "baseline"; text: string; changes: number } {
    if (!this.started) {
      this.started = true;
      this.baseline = files;
      return { kind: "baseline", text: "", changes: 0 };
    }

    const changes = diffTrees(this.baseline, files);
    if (changes.length === 0) return { kind: "none", text: "", changes: 0 };

    const text = formatChanges(changes);

    const wouldBeChanges = this.pendingChanges + changes.length;
    const wouldBeChars = this.pendingChars + text.length;

    if (
      wouldBeChanges > REBASELINE_AFTER_CHANGES ||
      wouldBeChars > REBASELINE_AFTER_CHARS
    ) {
      this.baseline = files;
      this.pendingChanges = 0;
      this.pendingChars = 0;
      return { kind: "baseline", text: "", changes: changes.length };
    }

    // Each delta describes the step from the previous state to this one, so
    // reading the full listing and then every delta below it in order gives
    // exactly the current workspace. Diffing against the last FULL listing
    // instead would restate the same file on every round it changed, which
    // grows without bound during an edit-heavy task.
    this.baseline = files;
    this.pendingChanges = wouldBeChanges;
    this.pendingChars = wouldBeChars;
    return { kind: "delta", text, changes: changes.length };
  }
}

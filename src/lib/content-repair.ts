/**
 * Repair a whole-file write whose line breaks arrived as the two characters
 * `\` `n` instead of real newlines.
 *
 * Models occasionally double-escape the `content` argument: the JSON decodes
 * to one enormous line of `import os\nimport sys\n…`. Written as-is, the file
 * is broken (Python chokes on line 1), and the agent spends a run, a read and
 * a rewrite finding out — reported: "bundle.py landed on disk as one single
 * line with literal \n sequences".
 *
 * Deliberately narrow, because a false repair corrupts a correct file:
 *   - the content has NO real newline at all, and is not tiny;
 *   - literal `\n` appears often (at least 3 times, and at least one per
 *     300 characters) — a one-line minified bundle with a few "\n" inside
 *     string literals does not qualify;
 *   - JSON and minified files are never touched: a one-line JSON document
 *     with "\n" inside its strings is correct as written.
 */
export function repairEscapedNewlines(
  path: string,
  content: string
): { content: string; repaired: boolean } {
  const unchanged = { content, repaired: false };
  if (content.length < 120) return unchanged;
  if (/[\r\n]/.test(content)) return unchanged;
  if (/\.(json|jsonl|ndjson|map)$/i.test(path) || /\.min\./i.test(path)) {
    return unchanged;
  }
  const escapes = content.match(/\\n/g)?.length ?? 0;
  if (escapes < 3 || escapes < content.length / 300) return unchanged;

  const decoded = content.replace(/\\(r\\n|n|t|r|"|\\)/g, (_, esc: string) => {
    switch (esc) {
      case "r\\n":
        return "\n";
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "";
      case '"':
        return '"';
      default:
        return "\\";
    }
  });
  return { content: decoded, repaired: true };
}

/** Appended to a write's result when its content was repaired. */
export const REPAIRED_NEWLINES_NOTE =
  " Note: the content arrived as one line with escaped \\n sequences and no " +
  "real line breaks (double-escaped); it was decoded before writing so the " +
  "file has real lines. Send real newlines in future writes.";

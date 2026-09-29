/**
 * renderTable(rows, options = {}) -> string
 *
 * Renders an array of plain objects as a GitHub-flavoured markdown table,
 * padded so the columns line up in a monospace terminal.
 *
 * Columns
 *   options.columns (array of keys) picks and orders the columns. Without
 *   it, the columns are every key that appears in any row, in the order
 *   they are first seen (row by row, key by key). The header text of a
 *   column is its key. With no columns at all, return "".
 *
 * Cell text
 *   null / undefined / missing -> "" (empty). Anything else -> String(value).
 *   Then line breaks ("\r\n", "\n" or "\r") become "<br>" and every "|"
 *   becomes "\|". Header texts are escaped the same way. No trimming.
 *
 * Alignment
 *   options.align maps a column key to "left" | "right" | "center".
 *   Columns not listed there are "right" if they have at least one non-empty
 *   cell and every non-empty cell's value is a finite number (typeof
 *   "number"), otherwise "left".
 *
 * Layout
 *   The width of a column is the largest display width (see below) of its
 *   header and cell texts, but at least 3.
 *   Every line is "| " + cells joined with " | " + " |".
 *   Line 1 is the header, line 2 the delimiter row, then one line per row.
 *   Each header/data cell is padded with spaces to the column width:
 *   left-aligned text gets the spaces after it, right-aligned before it,
 *   centered text gets half before and half after (the odd space goes
 *   after). The delimiter cell is exactly as wide as the column:
 *     left   ":" then dashes      ":--------"
 *     right  dashes then ":"      "--------:"
 *     center ":" dashes ":"       ":-------:"
 *   Lines are joined with "\n"; no trailing newline.
 *
 * Display width
 *   Split the text into grapheme clusters (Intl.Segmenter, granularity
 *   "grapheme") and add up the width of each cluster:
 *     2  if the cluster contains a code point with the Emoji_Presentation
 *        property, or contains U+FE0F (emoji variation selector), or its
 *        first code point is East Asian Wide/Fullwidth, which for us means
 *        one of these ranges:
 *          U+1100-115F  U+2E80-303E  U+3041-33FF  U+3400-4DBF  U+4E00-9FFF
 *          U+A000-A4CF  U+AC00-D7A3  U+F900-FAFF  U+FE30-FE4F  U+FF00-FF60
 *          U+FFE0-FFE6  U+20000-2FFFD  U+30000-3FFFD
 *     0  if every code point in the cluster is a nonspacing/enclosing mark
 *        or a format character (general category Mn, Me or Cf), e.g. a lone
 *        zero-width space
 *     1  otherwise
 */
export function renderTable(rows, options = {}) {
  throw new Error("not implemented");
}

/** Display width of a string, per the rules above. */
export function displayWidth(text) {
  throw new Error("not implemented");
}

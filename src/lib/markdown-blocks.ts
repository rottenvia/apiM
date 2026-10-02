/**
 * Split markdown into independently renderable blocks.
 *
 * Reported: text streaming felt laggy, worse the longer a reply got.
 * Measured with a 4x-throttled CPU: frames went from 17ms to over 100ms
 * across one 35-second reply, because every update re-parsed the WHOLE
 * reply's markdown. Rendered block by block with each block memoised, a
 * stream only re-parses its last block, so the cost stays flat however long
 * the reply grows.
 *
 * Blocks break at blank lines outside fenced code, except where markdown
 * would carry on across the blank line: an indented continuation, or a list
 * that continues with another item. Pure, so it is tested directly.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;

export function splitMarkdownBlocks(text: string): string[] {
  const lines = String(text ?? "").split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  let blankRun = false;
  let inList = false;

  const flush = () => {
    if (current.length) blocks.push(current.join("\n"));
    current = [];
    inList = false;
  };

  for (const line of lines) {
    if (fence) {
      current.push(line);
      const close = FENCE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && !line.trim().slice(close[0].trim().length).trim()) {
        fence = null;
      }
      continue;
    }
    if (!line.trim()) {
      if (current.length) blankRun = true;
      continue;
    }
    if (blankRun) {
      const continues = /^\s/.test(line) || (inList && LIST_ITEM.test(line));
      if (continues) current.push("");
      else flush();
      blankRun = false;
    }
    const open = FENCE.exec(line);
    if (open) fence = open[1];
    if (LIST_ITEM.test(line)) inList = true;
    else if (!/^\s/.test(line) && current.length === 0) inList = false;
    current.push(line);
  }
  flush();
  return blocks;
}

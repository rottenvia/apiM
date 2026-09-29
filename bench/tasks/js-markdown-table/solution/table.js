/**
 * renderTable(rows, options = {}) -> string — reference solution.
 * (See the spec in the task's table.js.)
 */

const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];
const isWide = (cp) => WIDE.some(([a, b]) => cp >= a && cp <= b);
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function clusterWidth(cluster) {
  if (/\p{Emoji_Presentation}|️/u.test(cluster)) return 2;
  if (isWide(cluster.codePointAt(0))) return 2;
  if (/^[\p{Mn}\p{Me}\p{Cf}]+$/u.test(cluster)) return 0;
  return 1;
}

export function displayWidth(text) {
  let w = 0;
  for (const { segment } of segmenter.segment(text)) w += clusterWidth(segment);
  return w;
}

const escape = (s) => s.replace(/\r\n|\n|\r/g, "<br>").replace(/\|/g, "\\|");
const isEmpty = (v) => v === null || v === undefined;
const cellText = (v) => (isEmpty(v) ? "" : escape(String(v)));

function pad(text, width, align) {
  const gap = width - displayWidth(text);
  if (gap <= 0) return text;
  if (align === "right") return " ".repeat(gap) + text;
  if (align === "center") {
    const before = Math.floor(gap / 2);
    return " ".repeat(before) + text + " ".repeat(gap - before);
  }
  return text + " ".repeat(gap);
}

function delimiter(width, align) {
  if (align === "right") return "-".repeat(width - 1) + ":";
  if (align === "center") return ":" + "-".repeat(width - 2) + ":";
  return ":" + "-".repeat(width - 1);
}

export function renderTable(rows, options = {}) {
  let columns = options.columns;
  if (!columns) {
    const seen = new Set();
    for (const row of rows) for (const k of Object.keys(row)) seen.add(k);
    columns = [...seen];
  }
  if (columns.length === 0) return "";

  const cols = columns.map((key) => {
    const values = rows.map((r) => (Object.prototype.hasOwnProperty.call(r, key) ? r[key] : undefined));
    const nonEmpty = values.filter((v) => !isEmpty(v));
    const numeric = nonEmpty.length > 0 && nonEmpty.every((v) => typeof v === "number" && Number.isFinite(v));
    const align = options.align?.[key] ?? (numeric ? "right" : "left");
    const header = escape(String(key));
    const cells = values.map(cellText);
    const width = Math.max(3, displayWidth(header), ...cells.map(displayWidth));
    return { align, header, cells, width };
  });

  const line = (parts) => `| ${parts.join(" | ")} |`;
  const out = [
    line(cols.map((c) => pad(c.header, c.width, c.align))),
    line(cols.map((c) => delimiter(c.width, c.align))),
  ];
  for (let i = 0; i < rows.length; i++) out.push(line(cols.map((c) => pad(c.cells[i], c.width, c.align))));
  return out.join("\n");
}

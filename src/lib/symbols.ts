/**
 * Reading one function instead of one hundred and nine kilobytes.
 *
 * The single biggest round-saver left on the table, in the user's words: "a
 * read that is guaranteed exact, or a read-by-symbol that hands me one
 * function body by name". Both halves of that sentence are about the same
 * failure — a 109KB main.cpp cannot be read whole, so it gets read in slices,
 * and a slice boundary that lands mid-function is where anchors come from
 * that do not exist.
 *
 * A symbol read fixes the cause rather than the symptom: the span is chosen
 * by the code's own structure, so it always starts at a declaration and ends
 * at its closing brace, and the line numbers that come back can be handed
 * straight to edit_file as start_line/end_line without copying a single
 * character of whitespace.
 *
 * This is deliberately a lightweight structural scanner, not a parser. It
 * knows braces, strings, character literals and comments — enough to be
 * exactly right on well-formed C, C++, C#, Java, JS/TS, Rust and Go, and
 * enough to be honest ("I could not find the end") rather than wrong when it
 * meets something it does not understand.
 */

export interface SymbolMatch {
  name: string;
  /** "function" | "class" | "struct" | "method" | "block" */
  kind: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
  /** The declaration line, trimmed — for a one-line "which one is this". */
  signature: string;
  /** False when the closing brace was never found (truncated/odd source). */
  complete: boolean;
}

const PYTHON = /\.(py|pyi)$/i;

/**
 * Walk a brace-language body from `openIndex`, respecting strings/comments.
 *
 * Returns the index just past the matching close brace, or -1. Written as a
 * character scanner rather than a regex because a `}` inside a string literal
 * is exactly the case that makes regex-based extraction quietly wrong — and
 * quietly wrong is what this whole file exists to stop.
 */
function matchBrace(text: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  let inLine = false;
  let inBlock = false;
  let quote: string | null = null;

  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (c === "\n") inLine = false;
      i++;
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (quote) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }

    if (c === "/" && next === "/") {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every definition of `name` in `text`. Overloads all come back. */
export function findSymbols(
  text: string,
  name: string,
  filePath = ""
): SymbolMatch[] {
  const source = String(text ?? "");
  const wanted = String(name ?? "").trim();
  if (!wanted) return [];

  return PYTHON.test(filePath)
    ? findPythonSymbols(source, wanted)
    : findBraceSymbols(source, wanted);
}

function findBraceSymbols(source: string, name: string): SymbolMatch[] {
  const out: SymbolMatch[] = [];
  const id = escape(name);

  /*
   * Two shapes, deliberately narrow:
   *
   *   type/class/struct/enum/interface NAME     — a type definition
   *   ... NAME ( ... ) ... {                    — a function or method
   *
   * A bare mention of the name is NOT a definition, which is the difference
   * between this and search_files. Qualified method names (Foo::bar, this is
   * C++) match on the last segment.
   */
  const typeDecl = new RegExp(
    `\\b(class|struct|enum|interface|union|namespace)\\s+${id}\\b`,
    "g"
  );
  // The prefix may not cross a line: `\s` would happily swallow the newline
  // above and report the previous function's line as the start of this one.
  const funcDecl = new RegExp(
    `(^|[^\\w:])(?:[\\w:<>,*&~][^\\S\\n]*)*?(?:[\\w<>]+::)?${id}[^\\S\\n]*\\(`,
    "gm"
  );

  const seen = new Set<number>();

  for (const re of [typeDecl, funcDecl]) {
    for (const hit of source.matchAll(re)) {
      if (hit.index === undefined) continue;

      /*
       * Anchor on the NAME, then back up to the start of ITS line.
       *
       * Backing up from the start of the whole match instead reported the
       * line above whenever the return type sat on its own line — an
       * off-by-one-line span, which is the single worst thing a tool that
       * exists to give exact line numbers can produce.
       */
      const nameAt = hit.index + Math.max(0, hit[0].lastIndexOf(name));
      let lineStart = source.lastIndexOf("\n", nameAt) + 1;

      /*
       * A signature can be spread over several lines.
       *
       *     void
       *     InjectorWindow::OnPaint(HDC dc)
       *     {
       *
       * Starting at the name would hand back a span whose first line is the
       * middle of a declaration — paste it into an edit and the return type
       * is orphaned above. So the start walks back over lines that are
       * plainly a continuation: non-empty, not ended by ; { or }, not a
       * comment or a preprocessor line. At most three, because beyond that
       * the guess stops being safe.
       */
      for (let back = 0; back < 3 && lineStart > 0; back++) {
        const prevEnd = lineStart - 1;
        const prevStart = source.lastIndexOf("\n", prevEnd - 1) + 1;
        const prev = source.slice(prevStart, prevEnd).trim();
        if (!prev) break;
        if (/[;{}]$/.test(prev)) break;
        if (/^(\/\/|\*|\/\*|#)/.test(prev)) break;
        lineStart = prevStart;
      }
      if (seen.has(lineStart)) continue;

      // The body's opening brace must come before the next semicolon, or this
      // is a prototype/declaration rather than a definition.
      const brace = source.indexOf("{", nameAt);
      const semi = source.indexOf(";", nameAt);
      if (brace === -1) continue;
      if (semi !== -1 && semi < brace) continue;

      const end = matchBrace(source, brace);
      const complete = end !== -1;
      const bodyEnd = complete ? end : source.length;

      seen.add(lineStart);
      const body = source.slice(lineStart, bodyEnd);
      const startLine = lineOf(source, lineStart);
      out.push({
        name,
        kind: re === typeDecl ? (hit[1] ?? "class") : "function",
        startLine,
        endLine: startLine + body.split("\n").length - 1,
        text: body,
        signature: source.slice(lineStart, brace).trim().slice(0, 200),
        complete,
      });
    }
  }

  return out.sort((a, b) => a.startLine - b.startLine);
}

function findPythonSymbols(source: string, name: string): SymbolMatch[] {
  const lines = source.split("\n");
  const decl = new RegExp(`^(\\s*)(?:async\\s+)?(def|class)\\s+${escape(name)}\\b`);
  const out: SymbolMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const hit = decl.exec(lines[i]);
    if (!hit) continue;
    const indent = hit[1].length;

    // The body runs until a non-blank line indented no further than the
    // declaration — Python's own rule, applied literally.
    let end = lines.length - 1;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) continue;
      const width = line.length - line.trimStart().length;
      if (width <= indent) {
        end = j - 1;
        break;
      }
      end = j;
    }
    // Trailing blank lines belong to the file, not the function.
    while (end > i && !lines[end].trim()) end--;

    out.push({
      name,
      kind: hit[2] === "class" ? "class" : "function",
      startLine: i + 1,
      endLine: end + 1,
      text: lines.slice(i, end + 1).join("\n"),
      signature: lines[i].trim().slice(0, 200),
      complete: true,
    });
  }

  return out;
}

/** The receipt: exact span, exact lines, ready to hand to edit_file. */
export function formatSymbol(
  match: SymbolMatch,
  filePath: string,
  numbered: string
): string {
  return (
    `${filePath} — ${match.kind} ${match.name}, lines ${match.startLine}-` +
    `${match.endLine} (${match.endLine - match.startLine + 1} lines)` +
    `${match.complete ? "" : " — WARNING: no closing brace found, so this runs to end of file"}` +
    `.\n\nThis is the EXACT span, byte for byte. To change it, call edit_file ` +
    `with start_line=${match.startLine} and end_line=${match.endLine} — no ` +
    `whitespace to copy and no anchor to guess.\n\n${numbered}`
  );
}

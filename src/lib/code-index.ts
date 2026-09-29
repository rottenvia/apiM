/**
 * Workspace-wide "go to definition" and "find references".
 *
 * search_files finds text; these find CODE. A reference search is whole
 * identifier only (`save` does not match `autosave` or `save_as`), limited
 * to source files, and every hit is labelled — definition, import, or use —
 * so "who calls this?" before a rename or a signature change is one call
 * instead of a grep the model then has to sift by hand. Definitions reuse
 * lib/symbols, the same parser read_symbol uses on one file.
 */

import { promises as fs } from "node:fs";
import { listFiles, resolveInside } from "@/lib/workspace";
import { findSymbols, type SymbolMatch } from "@/lib/symbols";

export const CODE_FILE =
  /\.(?:[cm]?[jt]sx?|py|pyi|go|rs|java|kt|kts|scala|c|h|cc|cpp|cxx|hpp|hh|cs|rb|php|swift|lua|vue|svelte|m|mm|sh|bash|ps1|dart|ex|exs|zig)$/i;

/** Past this a file is generated or minified: its hits are noise. */
const MAX_FILE_BYTES = 1024 * 1024;
/** Total source read per query, so a monorepo cannot stall a round. */
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
export const MAX_REFERENCES = 200;

export interface SourceFile {
  path: string;
  content: string;
}

export async function readSourceFiles(
  workspaceId: string,
  within?: string
): Promise<{ files: SourceFile[]; skipped: number }> {
  const listed = await listFiles(workspaceId, within || ".");
  const candidates = listed.filter(
    (f) => CODE_FILE.test(f.path) && f.size <= MAX_FILE_BYTES && !/\.min\.[cm]?js$/i.test(f.path)
  );
  const files: SourceFile[] = [];
  let total = 0;
  let skipped = 0;
  for (const f of candidates) {
    if (total + f.size > MAX_TOTAL_BYTES) {
      skipped++;
      continue;
    }
    try {
      const content = await fs.readFile(resolveInside(workspaceId, f.path), "utf8");
      files.push({ path: f.path, content });
      total += f.size;
    } catch {
      skipped++;
    }
  }
  return { files, skipped };
}

export function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

/** The last segment of `Foo::bar`, `foo.bar` or `Foo#bar`. */
export function bareName(name: string): string {
  const parts = name.trim().split(/::|\.|#/);
  return parts[parts.length - 1] ?? "";
}

export interface Definition {
  path: string;
  match: SymbolMatch;
}

/** A declaration keyword on the signature: the strongest "this is it". */
const KEYWORD_DECL =
  /^(?:export\s+)?(?:default\s+)?(?:(?:public|private|protected|static|abstract|async|override|pub(?:\(\w+\))?|unsafe|inline|virtual)\s+)*(?:function\*?|class|interface|type|enum|struct|trait|impl|def|fn|func|fun|module|namespace|const|let|var)\b/;

export function findDefinitionsIn(files: SourceFile[], name: string): Definition[] {
  const out: Definition[] = [];
  for (const f of files) {
    if (!f.content.includes(bareName(name))) continue;
    for (const match of findSymbols(f.content, name, f.path)) out.push({ path: f.path, match });
  }
  // Declared with a keyword first, then source over tests and scripts:
  // the definition a person means is rarely a test helper of the same name.
  const rank = (d: Definition) =>
    (KEYWORD_DECL.test(d.match.signature) ? 0 : 2) +
    (/(?:^|\/)(?:tests?|__tests__|spec|scripts|examples?)\/|\.(?:test|spec)\.[^/]+$/i.test(d.path) ? 1 : 0);
  return out
    .map((d, i) => ({ d, i, r: rank(d) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.d);
}

export type ReferenceKind = "definition" | "import" | "use";

export interface Reference {
  path: string;
  line: number;
  kind: ReferenceKind;
  text: string;
}

function classify(line: string, id: string): ReferenceKind {
  const t = line.trim();
  // Signatures are short. A long line is data or minified code, and the
  // patterns below backtrack on it (found by review: 569ms on one line).
  if (t.length > 600) return "use";
  // A module-level assignment (Python constants, JS globals): column 0.
  if (new RegExp(`^${id}\\s*(?::[^=]*)?=(?!=)`).test(line)) return "definition";
  const importLine =
    /^(?:import\b|from\s+\S+\s+import\b|export\s+\{|export\s+\*|#include\b|use\s)/.test(t) ||
    (/\brequire\(/.test(t) && /^(?:const|let|var)\b/.test(t));
  if (importLine) return "import";
  const def = new RegExp(
    [
      // function/class/type declarations across the common languages
      `\\b(?:function\\*?|class|interface|type|enum|struct|trait|impl|def|fn|func|fun|module|namespace)\\s+${id}\\b`,
      // Go methods: func (s *Server) Handle(
      `\\bfunc\\s*\\([^)]*\\)\\s*${id}\\s*\\(`,
      // const foo = …, let foo: T = …, var foo = …
      `\\b(?:const|let|var|val)\\s+${id}\\b`,
      // C-family: returnType name(…) {  — a type word is required, and a
      // statement keyword is not one ("return foo(x)" is a use).
      `^(?!(?:return|await|new|throw|yield|else|case|typeof|delete|void|if|while|for|switch|echo|print|raise|defer|go|puts|export\\s+default)\\b)[\\w:<>,*&\\[\\]]+(?:\\s+[\\w:<>,*&\\[\\]]+)*\\s+[*&]*${id}\\s*\\([^;]*\\)\\s*(?:const\\s*)?(?:->[^{;]*)?\\{?\\s*$`,
      // object/class member: foo(…) {  or  foo = (…) =>  or  foo: function
      `^(?:(?:public|private|protected|static|async|override|readonly)\\s+)*${id}\\s*(?:=\\s*(?:async\\s*)?(?:\\([^)]*\\)|\\w+)\\s*=>|:\\s*(?:async\\s+)?function\\b|\\([^)]*\\)\\s*(?::[^{]+)?\\{)`,
    ].join("|")
  );
  return def.test(t) ? "definition" : "use";
}

/** Whole-identifier hits across source files, definitions first. */
export function findReferencesIn(
  files: SourceFile[],
  name: string
): { refs: Reference[]; total: number } {
  const bare = bareName(name);
  const id = bare.replace(/\$/g, "\\$");
  const re = new RegExp(`(?<![\\w$])${id}(?![\\w$])`);
  const refs: Reference[] = [];
  for (const f of files) {
    if (!f.content.includes(bare)) continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!re.test(line)) continue;
      refs.push({
        path: f.path,
        line: i + 1,
        kind: classify(line, id),
        text: line.trim().slice(0, 200),
      });
    }
  }
  const order: Record<ReferenceKind, number> = { definition: 0, import: 1, use: 2 };
  refs.sort((a, b) => order[a.kind] - order[b.kind]);
  return { refs: refs.slice(0, MAX_REFERENCES), total: refs.length };
}

export function formatReferences(
  name: string,
  refs: Reference[],
  total: number,
  scanned: number,
  skipped: number
): string {
  if (!refs.length) {
    return `No references to "${name}" in ${scanned} source files (whole-identifier match).${
      skipped ? ` ${skipped} large files were not scanned.` : ""
    }`;
  }
  const byKind = (k: ReferenceKind) => refs.filter((r) => r.kind === k).length;
  const files = new Set(refs.map((r) => r.path)).size;
  const head =
    `${total} reference${total === 1 ? "" : "s"} to "${name}" in ${files} file${files === 1 ? "" : "s"} ` +
    `(${byKind("definition")} definition, ${byKind("import")} import, ${byKind("use")} use` +
    `${total > refs.length ? `; first ${refs.length} shown` : ""}):`;
  const lines: string[] = [head];
  let current = "";
  for (const r of refs) {
    if (r.path !== current) {
      current = r.path;
      lines.push(`\n${r.path}`);
    }
    lines.push(`  ${String(r.line).padStart(5)} [${r.kind}] ${r.text}`);
  }
  if (skipped) lines.push(`\n(${skipped} files over the size limit were not scanned.)`);
  return lines.join("\n");
}

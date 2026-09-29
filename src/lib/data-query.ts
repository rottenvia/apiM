/**
 * Structured access to data files too big to read.
 *
 * A 35MB JSON export is usually ONE line: read_file shows the first 400k
 * characters of it and the rest does not exist for the model, and pasting
 * it into a message cut it at 800k. What an agent needs from such a file is
 * what a person would do with jq: see its shape, then pull out the part
 * that matters. This parses JSON, JSON Lines, CSV and TSV once (cached by
 * path + mtime), describes the structure with counts and examples, and
 * answers JSONPath-style queries with the result size kept under control.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** Parsing past this is a job for a script, not an in-process parse. */
export const MAX_DATA_BYTES = 400 * 1024 * 1024;
/** Default size of what one query returns to the model. */
export const DEFAULT_RESULT_CHARS = 20_000;
const SCHEMA_SAMPLE = 2_000;

export type DataFormat = "json" | "jsonl" | "csv" | "tsv";

export interface LoadedData {
  format: DataFormat;
  value: unknown;
  bytes: number;
  /** CSV/TSV: the header row. */
  columns?: string[];
  /** Lines that did not parse (JSONL) or rows with the wrong width (CSV). */
  badRows?: number;
}

export class DataQueryError extends Error {}

// ---------------------------------------------------------------- loading

export function formatFor(name: string, head: string): DataFormat | null {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".jsonl" || ext === ".ndjson") return "jsonl";
  if (ext === ".csv") return "csv";
  if (ext === ".tsv" || ext === ".tab") return "tsv";
  if (ext === ".json" || ext === ".geojson" || ext === ".har" || ext === ".map") return "json";
  const t = head.replace(/^﻿/, "").trimStart();
  if (t.startsWith("{") || t.startsWith("[")) {
    // One object per line reads as JSONL.
    const lines = t.split("\n", 3);
    if (lines.length > 1 && lines[0].trim().startsWith("{") && lines[0].trim().endsWith("}")) {
      return "jsonl";
    }
    return "json";
  }
  return null;
}

/** CSV/TSV rows, RFC 4180 quoting. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

function parseText(text: string, format: DataFormat): LoadedData {
  const clean = text.replace(/^﻿/, "");
  if (format === "json") {
    try {
      return { format, value: JSON.parse(clean), bytes: text.length };
    } catch (e) {
      // Several concatenated objects, one per line, often wear .json.
      const asLines = parseText(clean, "jsonl");
      if (asLines.badRows === 0 && Array.isArray(asLines.value) && asLines.value.length > 1) {
        return asLines;
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new DataQueryError(`Not valid JSON: ${msg}`);
    }
  }
  if (format === "jsonl") {
    const out: unknown[] = [];
    let bad = 0;
    for (const line of clean.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        bad++;
      }
    }
    return { format, value: out, bytes: text.length, badRows: bad };
  }
  const rows = parseDelimited(clean, format === "tsv" ? "\t" : ",");
  const columns = (rows.shift() ?? []).map((c, i) => c.trim() || `column_${i + 1}`);
  let bad = 0;
  const value = rows.map((r) => {
    if (r.length !== columns.length) bad++;
    const obj: Record<string, string> = {};
    columns.forEach((c, i) => (obj[c] = r[i] ?? ""));
    return obj;
  });
  return { format, value, bytes: text.length, columns, badRows: bad };
}

const cache = new Map<string, LoadedData>();

/** Parse a data file, cached by absolute path + mtime + size (two entries). */
export async function loadData(absPath: string, name = absPath): Promise<LoadedData> {
  const st = await fs.stat(absPath);
  if (!st.isFile()) throw new DataQueryError(`${name} is not a file`);
  if (st.size > MAX_DATA_BYTES) {
    throw new DataQueryError(
      `${name} is ${(st.size / 1024 / 1024).toFixed(0)}MB — past the ${MAX_DATA_BYTES / 1024 / 1024}MB in-process limit. Stream it with a script instead (run_command with python and ijson/pandas chunks).`
    );
  }
  const key = `${absPath}:${st.mtimeMs}:${st.size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const buf = await fs.readFile(absPath);
  let text: string;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = new TextDecoder("utf-16le").decode(buf);
  else if (buf[0] === 0xfe && buf[1] === 0xff) text = new TextDecoder("utf-16be").decode(buf);
  else text = buf.toString("utf8");
  const format = formatFor(name, text.slice(0, 4096));
  if (!format) {
    throw new DataQueryError(`${name} does not look like JSON, JSON Lines, CSV or TSV.`);
  }
  const loaded = parseText(text, format);
  loaded.bytes = st.size;
  for (const k of cache.keys()) if (k.startsWith(`${absPath}:`)) cache.delete(k);
  cache.set(key, loaded);
  while (cache.size > 2) cache.delete(cache.keys().next().value as string);
  return loaded;
}

// ---------------------------------------------------------------- schema

type Shape = {
  types: Map<string, number>;
  count: number;
  /** object members */
  keys?: Map<string, Shape>;
  /** array elements */
  items?: Shape;
  arrayLens?: [number, number];
  num?: [number, number];
  examples?: string[];
  /** Strings that are numbers (CSV cells): how many, and their range. */
  numeric?: { n: number; range: [number, number] };
  sampled?: number;
};

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function newShape(): Shape {
  return { types: new Map(), count: 0 };
}

function observe(shape: Shape, v: unknown, depth: number): void {
  shape.count++;
  const t = typeOf(v);
  shape.types.set(t, (shape.types.get(t) ?? 0) + 1);
  if (depth > 7) return;
  if (t === "object") {
    shape.keys ??= new Map();
    const entries = Object.entries(v as Record<string, unknown>);
    // Objects used as maps (thousands of id keys) are summarised as such.
    for (const [k, child] of entries.slice(0, 200)) {
      let s = shape.keys.get(k);
      if (!s) {
        if (shape.keys.size >= 200) continue;
        s = newShape();
        shape.keys.set(k, s);
      }
      observe(s, child, depth + 1);
    }
  } else if (t === "array") {
    const arr = v as unknown[];
    shape.items ??= newShape();
    shape.arrayLens = shape.arrayLens
      ? [Math.min(shape.arrayLens[0], arr.length), Math.max(shape.arrayLens[1], arr.length)]
      : [arr.length, arr.length];
    // The head plus an even spread: a stride alone can land on a pattern
    // (every third item) and describe a field as always empty.
    const head = Math.min(arr.length, SCHEMA_SAMPLE / 2);
    let seen = 0;
    for (let i = 0; i < head; i++, seen++) observe(shape.items, arr[i], depth + 1);
    const rest = arr.length - head;
    const spread = Math.min(rest, SCHEMA_SAMPLE / 2);
    for (let k = 0; k < spread; k++, seen++) {
      observe(shape.items, arr[head + Math.floor((k * rest) / spread)], depth + 1);
    }
    shape.items.sampled = (shape.items.sampled ?? 0) + seen;
  } else if (t === "number") {
    const n = v as number;
    shape.num = shape.num ? [Math.min(shape.num[0], n), Math.max(shape.num[1], n)] : [n, n];
  } else if (t === "string") {
    shape.examples ??= [];
    const s = v as string;
    if (/^\s*-?\d+(?:\.\d+)?\s*$/.test(s)) {
      const n = Number(s);
      shape.numeric = shape.numeric
        ? { n: shape.numeric.n + 1, range: [Math.min(shape.numeric.range[0], n), Math.max(shape.numeric.range[1], n)] }
        : { n: 1, range: [n, n] };
    }
    if (shape.examples.length < 3 && !shape.examples.includes(s)) {
      shape.examples.push(s.length > 60 ? `${s.slice(0, 57)}…` : s);
    }
  }
}

function describeShape(shape: Shape, label: string, indent: string, lines: string[], budget: { left: number }): void {
  if (budget.left <= 0) return;
  const types = [...shape.types.entries()].sort((a, b) => b[1] - a[1]);
  const typeText = types
    .map(([t, n]) => (types.length > 1 ? `${t} ${Math.round((n / shape.count) * 100)}%` : t))
    .join(" | ");
  let detail = "";
  if (shape.arrayLens) {
    const [a, b] = shape.arrayLens;
    detail += a === b ? ` [${a.toLocaleString()}]` : ` [${a.toLocaleString()}..${b.toLocaleString()}]`;
  }
  if (shape.num) {
    const [a, b] = shape.num;
    detail += a === b ? ` = ${a}` : ` ${a}..${b}`;
  }
  const strings = shape.types.get("string") ?? 0;
  if (shape.numeric && strings > 0 && shape.numeric.n === strings) {
    // A CSV column of numbers: say so, with the range, not three examples.
    const [a, b] = shape.numeric.range;
    detail += ` (numeric text) ${a}..${b}`;
  } else if (shape.examples?.length) {
    detail += ` e.g. ${shape.examples.map((e) => JSON.stringify(e)).join(", ")}`;
  }
  if (shape.keys && shape.keys.size >= 200) detail += " (200+ keys — likely a map keyed by id)";
  lines.push(`${indent}${label}: ${typeText}${detail}`);
  budget.left -= 1;
  if (shape.keys) {
    for (const [k, child] of shape.keys) {
      if (budget.left <= 0) {
        lines.push(`${indent}  …`);
        return;
      }
      const presence = child.count < shape.count
        ? ` (in ${Math.round((child.count / Math.max(1, shape.types.get("object") ?? shape.count)) * 100)}%)`
        : "";
      const safe = /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`;
      describeShape(child, safe + presence, `${indent}  `, lines, budget);
    }
  }
  if (shape.items && shape.items.count > 0) {
    describeShape(shape.items, "[*]", `${indent}  `, lines, budget);
  }
}

/** A compact structural description: types, counts, ranges, examples. */
export function describeData(data: LoadedData, maxLines = 120): string {
  const shape = newShape();
  observe(shape, data.value, 0);
  const lines: string[] = [];
  describeShape(shape, "$", "", lines, { left: maxLines });
  const header =
    `${data.format.toUpperCase()} · ${(data.bytes / 1024 / 1024).toFixed(1)}MB` +
    (Array.isArray(data.value) ? ` · ${data.value.length.toLocaleString()} ${data.format === "csv" || data.format === "tsv" ? "rows" : "items"}` : "") +
    (data.columns ? ` · columns: ${data.columns.join(", ")}` : "") +
    (data.badRows ? ` · ${data.badRows} malformed row(s) skipped` : "");
  return `${header}\nStructure (sampled; ranges and examples are from the sample):\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------- query

type Step =
  | { kind: "key"; name: string }
  | { kind: "index"; index: number }
  | { kind: "slice"; start?: number; end?: number; step?: number }
  | { kind: "wild" }
  | { kind: "descend"; name: string | null }
  | { kind: "filter"; expr: string; compiled?: (item: unknown) => boolean }
  | { kind: "union"; keys: (string | number)[] };

/** Parse a JSONPath subset: $, .key, ['key'], [n], [a:b], [*], .., [?(@…)], [a,b]. */
export function parsePath(query: string): Step[] {
  let q = query.trim();
  if (!q || q === "$") return [];
  if (q.startsWith("$")) q = q.slice(1);
  else if (!q.startsWith(".") && !q.startsWith("[")) q = `.${q}`;
  const steps: Step[] = [];
  let i = 0;
  const ident = () => {
    const m = /^[A-Za-z_$À-￿][\w$\-À-￿]*/.exec(q.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  while (i < q.length) {
    if (q.startsWith("..", i)) {
      i += 2;
      if (q[i] === "*") {
        i++;
        steps.push({ kind: "descend", name: null });
      } else if (q[i] === "[") {
        steps.push({ kind: "descend", name: null });
      } else {
        const name = ident();
        if (!name) throw new DataQueryError(`Expected a key after ".." at ${i} in ${query}`);
        steps.push({ kind: "descend", name });
      }
      continue;
    }
    if (q[i] === ".") {
      i++;
      if (q[i] === "*") {
        i++;
        steps.push({ kind: "wild" });
        continue;
      }
      const name = ident();
      if (!name) throw new DataQueryError(`Expected a key after "." at ${i} in ${query}`);
      steps.push({ kind: "key", name });
      continue;
    }
    if (q[i] === "[") {
      // Find the matching ] respecting quotes and parens.
      let j = i + 1;
      let depth = 0;
      let quote: string | null = null;
      for (; j < q.length; j++) {
        const c = q[j];
        if (quote) {
          if (c === "\\") j++;
          else if (c === quote) quote = null;
          continue;
        }
        if (c === "'" || c === '"') quote = c;
        else if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (c === "]" && depth === 0) break;
      }
      if (j >= q.length) throw new DataQueryError(`Unclosed [ in ${query}`);
      const inner = q.slice(i + 1, j).trim();
      i = j + 1;
      if (inner === "*") steps.push({ kind: "wild" });
      else if (inner.startsWith("?")) steps.push({ kind: "filter", expr: inner.slice(1).trim().replace(/^\(([\s\S]*)\)$/, "$1") });
      else if (/^-?\d*:-?\d*(?::-?\d+)?$/.test(inner)) {
        const [a, b, c] = inner.split(":");
        steps.push({
          kind: "slice",
          start: a === "" ? undefined : Number(a),
          end: b === "" || b === undefined ? undefined : Number(b),
          step: c ? Number(c) : undefined,
        });
      } else if (/^-?\d+$/.test(inner)) steps.push({ kind: "index", index: Number(inner) });
      else {
        const parts = inner.split(/\s*,\s*/).map((p) => {
          const m = /^(['"])([\s\S]*)\1$/.exec(p);
          if (m) return m[2];
          if (/^-?\d+$/.test(p)) return Number(p);
          throw new DataQueryError(`Cannot read [${inner}] in ${query}`);
        });
        if (parts.length === 1 && typeof parts[0] === "string") steps.push({ kind: "key", name: parts[0] });
        else steps.push({ kind: "union", keys: parts });
      }
      continue;
    }
    throw new DataQueryError(`Unexpected "${q[i]}" at ${i} in ${query}`);
  }
  return steps;
}

// Filter expressions: @.a.b OP literal, joined by && / ||, with !, parens.
type Tok = { t: string; v?: unknown };

function tokenizeFilter(expr: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = expr.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||", "=~"].includes(two)) {
      toks.push({ t: two });
      i += 2;
      continue;
    }
    if ("<>()!".includes(c)) {
      toks.push({ t: c });
      i++;
      continue;
    }
    if (c === "@") {
      let j = i + 1;
      while (j < expr.length && /[\w$.\[\]'"\-À-￿]/.test(expr[j])) {
        if (expr[j] === "'" || expr[j] === '"') {
          const q = expr[j];
          j++;
          while (j < expr.length && expr[j] !== q) j++;
        }
        j++;
      }
      toks.push({ t: "path", v: expr.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      while (j < expr.length && expr[j] !== c) {
        if (expr[j] === "\\") j++;
        s += expr[j];
        j++;
      }
      toks.push({ t: "lit", v: s });
      i = j + 1;
      continue;
    }
    if (c === "/") {
      const m = /^\/((?:\\.|[^/])*)\/([gimsuy]*)/.exec(expr.slice(i));
      if (m) {
        toks.push({ t: "lit", v: new RegExp(m[1], m[2].replace("g", "")) });
        i += m[0].length;
        continue;
      }
    }
    const num = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(expr.slice(i));
    if (num) {
      toks.push({ t: "lit", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const word = /^(true|false|null)\b/.exec(expr.slice(i));
    if (word) {
      toks.push({ t: "lit", v: word[1] === "true" ? true : word[1] === "false" ? false : null });
      i += word[0].length;
      continue;
    }
    throw new DataQueryError(`Cannot read filter near "${expr.slice(i, i + 12)}"`);
  }
  return toks;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function compare(a: unknown, op: string, b: unknown): boolean {
  if (op === "=~") {
    if (!(b instanceof RegExp)) return false;
    return typeof a === "string" && b.test(a);
  }
  const na = num(a);
  const nb = num(b);
  const numeric = na !== null && nb !== null && (typeof a === "number" || typeof b === "number");
  const x = numeric ? na : a;
  const y = numeric ? nb : b;
  switch (op) {
    case "==":
      return x === y || (typeof x === "string" && typeof y === "string" && x === y);
    case "!=":
      return x !== y;
    case "<":
      return (x as number) < (y as number);
    case "<=":
      return (x as number) <= (y as number);
    case ">":
      return (x as number) > (y as number);
    case ">=":
      return (x as number) >= (y as number);
  }
  return false;
}

type Pred = (item: unknown) => boolean;
type Operand = (item: unknown) => unknown;

/** Compile a filter once; a 150k-item scan must not re-tokenize per item. */
function compileFilter(expr: string): Pred {
  const toks = tokenizeFilter(expr);
  let p = 0;
  const operand = (tok: Tok): Operand => {
    if (tok.t === "lit") {
      const v = tok.v;
      return () => v;
    }
    if (tok.t === "path") {
      const rel = String(tok.v);
      if (!rel) return (item) => item;
      const steps = parsePath(`$${rel.startsWith("[") || rel.startsWith(".") ? "" : "."}${rel}`);
      // Plain @.a.b[0] lookups walk the value directly — no match objects.
      if (steps.every((st) => st.kind === "key" || st.kind === "index")) {
        return (item) => {
          let v: unknown = item;
          for (const st of steps) {
            if (v === null || typeof v !== "object") return undefined;
            if (st.kind === "key") {
              if (Array.isArray(v)) return st.name === "length" ? v.length : undefined;
              v = (v as Record<string, unknown>)[st.name];
            } else if (st.kind === "index" && Array.isArray(v)) {
              v = v[st.index < 0 ? v.length + st.index : st.index];
            } else return undefined;
          }
          return v;
        };
      }
      return (item) => {
        const hits = run(steps, [{ path: "@", value: item }]);
        return hits.length ? hits[0].value : undefined;
      };
    }
    throw new DataQueryError(`Unexpected ${tok.t} in filter`);
  };
  const primary = (): Pred => {
    const tok = toks[p++];
    if (!tok) throw new DataQueryError("Filter ended early");
    if (tok.t === "!") {
      const inner = primary();
      return (x) => !inner(x);
    }
    if (tok.t === "(") {
      const r = or();
      if (toks[p++]?.t !== ")") throw new DataQueryError("Missing ) in filter");
      return r;
    }
    const left = operand(tok);
    const op = toks[p];
    if (op && ["==", "!=", "<", "<=", ">", ">=", "=~"].includes(op.t)) {
      p++;
      const rightTok = toks[p++];
      if (!rightTok) throw new DataQueryError("Filter ended after an operator");
      const right = operand(rightTok);
      return (x) => compare(left(x), op.t, right(x));
    }
    // Bare @.x: present and not null/false (0 and "" count as present).
    return (x) => {
      const v = left(x);
      return v !== undefined && v !== null && v !== false;
    };
  };
  const and = (): Pred => {
    let r = primary();
    while (toks[p]?.t === "&&") {
      p++;
      const a = r;
      const b = primary();
      r = (x) => a(x) && b(x);
    }
    return r;
  };
  function or(): Pred {
    let r = and();
    while (toks[p]?.t === "||") {
      p++;
      const a = r;
      const b = and();
      r = (x) => a(x) || b(x);
    }
    return r;
  }
  const pred = or();
  if (p < toks.length) throw new DataQueryError(`Unexpected "${toks[p].t}" in filter`);
  return pred;
}

export interface Match {
  path: string;
  value: unknown;
}

const MAX_MATCHES = 1_000_000;

function childPath(base: string, key: string | number): string {
  if (typeof key === "number") return `${base}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

function children(m: Match): Match[] {
  if (Array.isArray(m.value)) return m.value.map((v, i) => ({ path: childPath(m.path, i), value: v }));
  if (m.value && typeof m.value === "object") {
    return Object.entries(m.value as Record<string, unknown>).map(([k, v]) => ({ path: childPath(m.path, k), value: v }));
  }
  return [];
}

function run(steps: Step[], start: Match[]): Match[] {
  let cur = start;
  for (const step of steps) {
    const next: Match[] = [];
    const push = (m: Match) => {
      if (next.length < MAX_MATCHES) next.push(m);
    };
    for (const m of cur) {
      const v = m.value;
      switch (step.kind) {
        case "key":
          if (v && typeof v === "object" && !Array.isArray(v) && step.name in (v as object)) {
            push({ path: childPath(m.path, step.name), value: (v as Record<string, unknown>)[step.name] });
          } else if (Array.isArray(v) && step.name === "length") {
            push({ path: `${m.path}.length`, value: v.length });
          }
          break;
        case "index":
          if (Array.isArray(v)) {
            const i = step.index < 0 ? v.length + step.index : step.index;
            if (i >= 0 && i < v.length) push({ path: childPath(m.path, i), value: v[i] });
          }
          break;
        case "slice":
          if (Array.isArray(v)) {
            const len = v.length;
            const norm = (x: number | undefined, d: number) =>
              x === undefined ? d : x < 0 ? Math.max(0, len + x) : Math.min(len, x);
            const s = norm(step.start, 0);
            const e = norm(step.end, len);
            const st = step.step && step.step > 0 ? step.step : 1;
            for (let i = s; i < e; i += st) push({ path: childPath(m.path, i), value: v[i] });
          }
          break;
        case "wild":
          for (const c of children(m)) push(c);
          break;
        case "union":
          for (const k of step.keys) {
            if (typeof k === "number" && Array.isArray(v)) {
              const i = k < 0 ? v.length + k : k;
              if (i >= 0 && i < v.length) push({ path: childPath(m.path, i), value: v[i] });
            } else if (typeof k === "string" && v && typeof v === "object" && k in (v as object)) {
              push({ path: childPath(m.path, k), value: (v as Record<string, unknown>)[k] });
            }
          }
          break;
        case "filter": {
          const pred = (step.compiled ??= compileFilter(step.expr));
          for (const c of children(m)) if (pred(c.value)) push(c);
          break;
        }
        case "descend": {
          const stack: Match[] = [m];
          while (stack.length && next.length < MAX_MATCHES) {
            const node = stack.pop()!;
            const kids = children(node);
            for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
            if (step.name === null) {
              if (node !== m) push(node);
            } else if (node.value && typeof node.value === "object" && !Array.isArray(node.value) && step.name in (node.value as object)) {
              push({ path: childPath(node.path, step.name), value: (node.value as Record<string, unknown>)[step.name] });
            }
          }
          break;
        }
      }
    }
    cur = next;
  }
  return cur;
}

export function query(value: unknown, pathExpr: string): Match[] {
  return run(parsePath(pathExpr), [{ path: "$", value }]);
}

/** JSON of a value, with long arrays/strings elided so one match cannot flood the result. */
export function preview(value: unknown, maxArray = 20, maxString = 2_000, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > maxString ? `${value.slice(0, maxString)}…[+${value.length - maxString} chars]` : value;
  }
  if (Array.isArray(value)) {
    const shown = value.slice(0, maxArray).map((v) => preview(v, maxArray, maxString, depth + 1));
    if (value.length > maxArray) shown.push(`…[${value.length - maxArray} more items]`);
    return shown;
  }
  if (value && typeof value === "object") {
    if (depth > 12) return "{…}";
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [k, v] of entries.slice(0, 200)) out[k] = preview(v, maxArray, maxString, depth + 1);
    if (entries.length > 200) out["…"] = `${entries.length - 200} more keys`;
    return out;
  }
  return value;
}

export interface QueryOutput {
  text: string;
  matches: number;
}

/** Run a query and render the matches within a character budget. */
export function renderQuery(
  data: LoadedData,
  pathExpr: string,
  opts: { limit?: number; offset?: number; maxChars?: number; fields?: string[]; count?: boolean } = {}
): QueryOutput {
  const matches = query(data.value, pathExpr);
  if (opts.count) {
    return { text: `${matches.length.toLocaleString()} match(es) for ${pathExpr}`, matches: matches.length };
  }
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 10_000));
  const maxChars = opts.maxChars ?? DEFAULT_RESULT_CHARS;
  const page = matches.slice(offset, offset + limit);
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const m of page) {
    let v = m.value;
    if (opts.fields?.length && v && typeof v === "object" && !Array.isArray(v)) {
      const picked: Record<string, unknown> = {};
      for (const f of opts.fields) {
        const hit = query(v, f.startsWith("$") ? f : `$.${f}`)[0];
        picked[f] = hit?.value;
      }
      v = picked;
    }
    const line = `${m.path} = ${JSON.stringify(preview(v))}`;
    if (used + line.length > maxChars && shown > 0) break;
    lines.push(line.length > maxChars ? `${line.slice(0, maxChars)}…` : line);
    used += line.length + 1;
    shown++;
  }
  const rest = matches.length - offset - shown;
  const head = `${matches.length.toLocaleString()} match(es) for ${pathExpr}` +
    (matches.length ? ` — showing ${offset + 1}–${offset + shown}` : "");
  const tail = rest > 0 ? `\n…${rest.toLocaleString()} more. Use offset:${offset + shown} for the next page, fields to pick columns, or save_as to write all matches to a file.` : "";
  return { text: `${head}\n${lines.join("\n")}${tail}`, matches: matches.length };
}

/**
 * Where the records are, for the example queries: the root when it is an
 * array, otherwise the largest array directly under the root.
 */
export function mainCollection(value: unknown): { path: string; length: number; key: string | null; sampleField: string | null } | null {
  const fieldOf = (arr: unknown[]) => {
    const first = arr.find((x) => x && typeof x === "object" && !Array.isArray(x)) as Record<string, unknown> | undefined;
    if (!first) return null;
    const k = Object.keys(first).find((f) => ["string", "number", "boolean"].includes(typeof first[f]) && /^[A-Za-z_$][\w$]*$/.test(f));
    return k ?? null;
  };
  if (Array.isArray(value)) return { path: "$", length: value.length, key: null, sampleField: fieldOf(value) };
  if (!value || typeof value !== "object") return null;
  let best: { key: string; arr: unknown[] } | null = null;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(v) && (!best || v.length > best.arr.length)) best = { key: k, arr: v };
  }
  if (!best) return null;
  const safe = /^[A-Za-z_$][\w$]*$/.test(best.key) ? `$.${best.key}` : `$[${JSON.stringify(best.key)}]`;
  return { path: safe, length: best.arr.length, key: best.key, sampleField: fieldOf(best.arr) };
}

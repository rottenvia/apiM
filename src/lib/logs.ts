/**
 * Reading a pile of pasted console output, mechanically.
 *
 * The forensic pass a human does by eye — "46 phase, 9 backstop, gains
 * clustered around 0.7, then the access violation on line 51" — is the same
 * four operations every time: count the tokens that matter, cluster the
 * repeated lines, describe the numbers, and find the fault sequence. Doing it
 * by eye is slow and, worse, unrepeatable: two passes over the same sixty
 * lines can disagree, and neither leaves a receipt.
 *
 * This is deliberately format-agnostic. It knows nothing about any particular
 * game, engine or logger — it works on shapes (levels, key=value pairs,
 * repeated skeletons, stack traces) that every console log has, so it is
 * still right on the next project.
 */

export interface LogCount {
  label: string;
  count: number;
  /** Share of all counted labels, so a ratio needs no arithmetic. */
  percent: number;
}

export interface LogCluster {
  /** The line with its variable parts replaced, e.g. "phase gain <num>". */
  pattern: string;
  count: number;
  firstLine: number;
  lastLine: number;
  sample: string;
}

export interface NumericSummary {
  key: string;
  n: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
}

export interface FaultEvent {
  line: number;
  kind: string;
  text: string;
}

/**
 * A monotone counter that identifies WHICH slice of a run this text is.
 *
 * Asked for by name: "put the first and last tick= in the coverage line —
 * your logs are tick-numbered, so that instantly tells me which session slice
 * I'm holding without reading a word of it." Generalised past `tick` to any
 * field that only ever goes up, because the next project will call it frame,
 * seq, or iter.
 */
export interface LogSpan {
  key: string;
  first: number;
  last: number;
  /** Lines carrying the counter — how much of the log the span speaks for. */
  n: number;
}

export interface LogAnalysis {
  lines: number;
  /** Non-empty lines, which is what every ratio below is measured against. */
  counted: number;
  levels: LogCount[];
  requested: LogCount[];
  clusters: LogCluster[];
  numerics: NumericSummary[];
  faults: FaultEvent[];
  /** Lines around the first fault, so the sequence reads in order. */
  faultContext: string[];
  truncated: boolean;
  /** First/last value of the run counter, when the log has one. */
  span: LogSpan | null;
}

const LEVELS: { label: string; pattern: RegExp }[] = [
  { label: "FATAL", pattern: /\b(?:FATAL|PANIC|CRITICAL)\b/ },
  { label: "ERROR", pattern: /\b(?:ERROR|ERR|FAIL(?:ED|URE)?)\b/ },
  { label: "WARN", pattern: /\b(?:WARN(?:ING)?)\b/ },
  { label: "INFO", pattern: /\b(?:INFO|NOTICE)\b/ },
  { label: "DEBUG", pattern: /\b(?:DEBUG|TRACE|VERBOSE)\b/ },
];

const FAULTS: { kind: string; pattern: RegExp }[] = [
  { kind: "access violation", pattern: /access violation|0xc0000005/i },
  { kind: "segfault", pattern: /segmentation fault|SIGSEGV|SIGABRT|SIGBUS/i },
  { kind: "exception", pattern: /unhandled exception|\bexception\b.*(thrown|at )|Traceback \(most recent call last\)/i },
  { kind: "assert", pattern: /assertion failed|\bassert\b.*fail/i },
  { kind: "stack overflow", pattern: /stack overflow|0xc00000fd/i },
  { kind: "abort", pattern: /\babort(?:ed|ing)?\b|terminate called/i },
  { kind: "crash", pattern: /\bcrash(?:ed|ing)?\b|has stopped working|faulting module/i },
  { kind: "nonzero exit", pattern: /exit(?:ed with)? code (?!0\b)-?\d+|exited with status (?!0\b)-?\d+/i },
  { kind: "timeout", pattern: /\btimed out\b|\btimeout\b/i },
];

/** Collapse the variable parts of a line so repeats group together. */
export function skeleton(line: string): string {
  return line
    .trim()
    .replace(/0x[0-9a-fA-F]+/g, "<hex>")
    .replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, "<guid>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")
    .replace(/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, "<time>")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<date>")
    .replace(/[A-Za-z]:\\[^\s"']+|\/(?:[\w.-]+\/)+[\w.-]+/g, "<path>")
    .replace(/-?\b\d+\.\d+\b/g, "<num>")
    .replace(/-?\b\d+\b/g, "<num>")
    .replace(/\s+/g, " ");
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined
    ? sorted[base]
    : sorted[base] + rest * (next - sorted[base]);
}

const round = (v: number) =>
  Number.isInteger(v) ? v : Number(v.toFixed(4));

/**
 * Parse a console dump into counts, clusters, distributions and faults.
 *
 * `count` names the tokens whose ratio matters for THIS project ("phase",
 * "backstop") — everything else is discovered from the text itself, so the
 * same call works on a log it has never seen.
 */
export function analyzeLog(
  text: string,
  options: { count?: string[]; maxClusters?: number; maxNumerics?: number } = {}
): LogAnalysis {
  const allLines = String(text ?? "").split(/\r?\n/);
  const lines = allLines.filter((l) => l.trim() !== "");

  const levels: LogCount[] = [];
  let levelTotal = 0;
  for (const level of LEVELS) {
    const count = lines.filter((l) => level.pattern.test(l)).length;
    if (count > 0) {
      levels.push({ label: level.label, count, percent: 0 });
      levelTotal += count;
    }
  }
  for (const entry of levels) {
    entry.percent = levelTotal ? Math.round((entry.count / levelTotal) * 100) : 0;
  }

  // Requested tokens: counted case-insensitively, as whole words where the
  // token looks like a word, so "phase" does not match "phaseshift".
  const requested: LogCount[] = [];
  let requestedTotal = 0;
  for (const label of options.count ?? []) {
    const token = String(label).trim();
    if (!token) continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = /^\w+$/.test(token)
      ? new RegExp(`\\b${escaped}\\b`, "i")
      : new RegExp(escaped, "i");
    let count = 0;
    for (const line of lines) if (pattern.test(line)) count++;
    requested.push({ label: token, count, percent: 0 });
    requestedTotal += count;
  }
  for (const entry of requested) {
    entry.percent = requestedTotal
      ? Math.round((entry.count / requestedTotal) * 100)
      : 0;
  }

  // Clusters: the shape of the log, without reading every line of it.
  const groups = new Map<string, LogCluster>();
  allLines.forEach((line, index) => {
    if (line.trim() === "") return;
    const key = skeleton(line);
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      existing.lastLine = index + 1;
      return;
    }
    groups.set(key, {
      pattern: key.slice(0, 160),
      count: 1,
      firstLine: index + 1,
      lastLine: index + 1,
      sample: line.trim().slice(0, 200),
    });
  });
  const clusters = [...groups.values()]
    .sort((a, b) => b.count - a.count || a.firstLine - b.firstLine)
    .slice(0, options.maxClusters ?? 12);

  // Numeric fields: key=value, key: value, key value.
  const numbers = new Map<string, number[]>();
  const pair = /([A-Za-z_][\w.\-]{0,40})\s*[=:]\s*(-?\d+(?:\.\d+)?)/g;
  for (const line of lines) {
    for (const match of line.matchAll(pair)) {
      const key = match[1];
      const value = Number(match[2]);
      if (!Number.isFinite(value)) continue;
      const bucket = numbers.get(key) ?? [];
      bucket.push(value);
      numbers.set(key, bucket);
    }
  }
  const numerics: NumericSummary[] = [...numbers.entries()]
    .filter(([, values]) => values.length >= 2)
    .map(([key, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      return {
        key,
        n: sorted.length,
        min: round(sorted[0]),
        max: round(sorted[sorted.length - 1]),
        mean: round(sum / sorted.length),
        median: round(quantile(sorted, 0.5)),
        p95: round(quantile(sorted, 0.95)),
      };
    })
    .sort((a, b) => b.n - a.n)
    .slice(0, options.maxNumerics ?? 10);

  /*
   * The run counter, if there is one.
   *
   * Preference order matters: an explicitly named counter beats a lucky
   * monotone field, so `tick` wins over a frame index that happens to rise.
   * A field only qualifies when it never decreases across the log — that is
   * what makes first/last a SPAN rather than two arbitrary samples.
   */
  const COUNTER_NAMES = ["tick", "frame", "seq", "iter", "step", "sample"];
  let span: LogSpan | null = null;
  const monotone = (values: number[]) =>
    values.length >= 2 && values.every((v, i) => i === 0 || v >= values[i - 1]);

  for (const name of COUNTER_NAMES) {
    const key = [...numbers.keys()].find(
      (k) => k.toLowerCase() === name
    );
    const values = key ? numbers.get(key)! : null;
    if (key && values && monotone(values)) {
      span = { key, first: values[0], last: values[values.length - 1], n: values.length };
      break;
    }
  }
  if (!span) {
    for (const [key, values] of numbers) {
      if (values.length >= 5 && monotone(values) && values[0] !== values[values.length - 1]) {
        span = { key, first: values[0], last: values[values.length - 1], n: values.length };
        break;
      }
    }
  }

  // Faults, in the order they happened — the sequence is the story.
  const faults: FaultEvent[] = [];
  allLines.forEach((line, index) => {
    if (line.trim() === "") return;
    for (const fault of FAULTS) {
      if (fault.pattern.test(line)) {
        faults.push({
          line: index + 1,
          kind: fault.kind,
          text: line.trim().slice(0, 200),
        });
        break;
      }
    }
  });

  const faultContext: string[] = [];
  if (faults.length) {
    const at = faults[0].line - 1;
    const from = Math.max(0, at - 3);
    const to = Math.min(allLines.length, at + 8);
    for (let i = from; i < to; i++) {
      faultContext.push(
        `${String(i + 1).padStart(5)}${i === at ? " >" : "  "} ${allLines[i]}`
      );
    }
  }

  return {
    lines: allLines.length,
    counted: lines.length,
    levels,
    requested,
    clusters,
    numerics,
    faults: faults.slice(0, 40),
    faultContext,
    truncated: faults.length > 40,
    span,
  };
}

/** The receipt a human would have written by hand. */
export function formatLogAnalysis(a: LogAnalysis): string {
  const out: string[] = [
    `${a.lines} line(s), ${a.counted} non-empty.` +
      (a.span
        ? ` Covers ${a.span.key} ${a.span.first} → ${a.span.last} ` +
          `(${a.span.n} line(s) carry it).`
        : ""),
  ];

  if (a.levels.length) {
    out.push(
      "",
      "Levels: " +
        a.levels.map((l) => `${l.label} ${l.count} (${l.percent}%)`).join(" · ")
    );
  }

  if (a.requested.length) {
    out.push(
      "",
      "Counted: " +
        a.requested
          .map((l) => `${l.label} ${l.count} (${l.percent}%)`)
          .join(" · ")
    );
    if (a.requested.length === 2 && a.requested[1].count > 0) {
      const ratio = a.requested[0].count / a.requested[1].count;
      out.push(
        `Ratio ${a.requested[0].label}:${a.requested[1].label} = ` +
          `${ratio.toFixed(2)}:1`
      );
    }
  }

  if (a.numerics.length) {
    out.push("", "Numeric fields:");
    for (const n of a.numerics) {
      out.push(
        `  ${n.key}: n=${n.n} min=${n.min} median=${n.median} ` +
          `mean=${n.mean} p95=${n.p95} max=${n.max}`
      );
    }
  }

  if (a.clusters.length) {
    out.push("", "Repeated lines (most frequent first):");
    for (const c of a.clusters) {
      out.push(
        `  ${String(c.count).padStart(4)}x  lines ${c.firstLine}-${c.lastLine}  ${c.sample}`
      );
    }
  }

  if (a.faults.length) {
    out.push("", `Fault sequence (${a.faults.length}${a.truncated ? "+" : ""}):`);
    for (const f of a.faults) {
      out.push(`  line ${f.line}: [${f.kind}] ${f.text}`);
    }
    if (a.faultContext.length) {
      out.push("", "Around the first fault:", ...a.faultContext);
    }
  } else {
    out.push("", "No fault signature found (no exception, crash or non-zero exit).");
  }

  return out.join("\n");
}

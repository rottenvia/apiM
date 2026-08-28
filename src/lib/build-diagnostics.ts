/**
 * Reading a failed build well enough that nobody has to do archaeology.
 *
 * Two patterns cost a real campaign a crashed session's worth of patience,
 * twice:
 *
 *   1. **first-build-fails, retry-succeeds.** True for dozens of versions, so
 *      a retry got armed "like a superstition because it keeps being right".
 *      A superstition is just an undocumented rule: the flaky classes are
 *      named here (MSBuild node races, PDB contention, transient IO), the
 *      retry happens automatically, and the report says WHICH rule fired and
 *      what the second attempt did. Nothing is retried blind — a genuine
 *      compile error is never retried, because retrying it wastes a round and
 *      teaches the model that failures are noise.
 *
 *   2. **LNK1104 with no owning process.** "delete was denied but rename
 *      worked" is the actual folklore, and it is correct: on Windows a
 *      running image keeps its file locked, and renaming it out of the way is
 *      the standard escape. So a lock failure now names the file, lists every
 *      holder it can identify — starting with processes THIS workspace
 *      started, which is the usual culprit — and spells out the rename
 *      gambit.
 *
 * Everything here is read-only: it parses text and asks the OS who holds a
 * handle. It never kills, renames or deletes anything on its own.
 */

import path from "node:path";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { listProcesses, isRunning } from "@/lib/processes";

export type BuildFailureKind =
  | "locked_file"
  | "av_quarantine"
  | "flaky_race"
  | "missing_toolchain"
  | "out_of_space"
  | "compile_error"
  | "unknown";

export interface BuildDiagnosis {
  kind: BuildFailureKind;
  /** Safe to run the exact same build again without changing anything. */
  retryable: boolean;
  /** The file a lock error is about, when one was named. */
  lockedFile: string | null;
  /** One line naming the rule that fired. */
  rule: string;
  /** What to do about it, in the model's terms. */
  advice: string;
}

/**
 * Failures that are known to pass on an immediate second attempt.
 *
 * Each entry is a real MSBuild/toolchain race, not a guess: parallel nodes
 * fighting over the same PDB, a node exiting before it reports, a transient
 * handle on an obj/ file. The pattern is deliberately specific — anything
 * broader would retry real errors.
 */
const FLAKY_RULES: { pattern: RegExp; rule: string }[] = [
  {
    pattern: /MSB4166|child node .* exited prematurely/i,
    rule: "MSB4166 — an MSBuild worker node died before reporting; this is a node-startup race",
  },
  {
    pattern: /fatal error C1041|cannot open program database|PDB .* is locked/i,
    rule: "C1041 — two compiler processes reached the same .pdb at once (parallel build PDB race)",
  },
  {
    pattern: /LNK1318|Unexpected PDB error/i,
    rule: "LNK1318 — linker PDB contention, the linker's own flavour of the same race",
  },
  {
    pattern: /MSB3021|MSB3027|Could not copy .* exceeded retry count/i,
    rule: "MSB3021/MSB3027 — copy step lost a race with a handle that has since closed",
  },
  {
    pattern: /error MSB6006:.*exited with code 1(\s|$)/i,
    rule: "MSB6006 — a tool exited without producing a diagnostic, which is usually a startup race",
  },
  {
    pattern: /The process cannot access the file .*obj\\|Access is denied.*\.tlog/i,
    rule: "transient handle on an intermediate (obj/tlog) file",
  },
];

const LOCK_PATTERNS: RegExp[] = [
  /LNK1104: cannot open file '([^']+)'/i,
  /cannot open output file ([^\s:]+): Permission denied/i,
  /The process cannot access the file '([^']+)' because it is being used by another process/i,
  /Could not copy "[^"]+" to "([^"]+)"\./i,
  /EBUSY: resource busy or locked, [a-z]+ '([^']+)'/i,
  /EPERM: operation not permitted, [a-z]+ '([^']+)'/i,
  /error MSB3027: Could not copy "[^"]+" to "([^"]+)"/i,
  /Unable to copy file "[^"]+" to "([^"]+)"\.\s*The process cannot access the file/i,
  // Last resort: the phrase is unambiguous even when no filename is quoted.
  /()The process cannot access the file because it is being used by another process/i,
];

/** Said in two places, so it is written once. */
const AV_ADVICE =
  "This is a scanner, not your code and not a stale handle. Rename the " +
  "output out of the way and build again — the rename gambit works because " +
  "a quarantined path is denied while a NEW path is not. If it repeats every " +
  "build, the real fix is an antivirus exclusion for the output directory, " +
  "which only the user can add. Do not 'fix' source that compiled cleanly.";

const MISSING_TOOLCHAIN =
  /is not recognized as an internal or external command|MSB1009|command not found|No such file or directory: '?(cl|link|msbuild|cmake|gcc|g\+\+|dotnet)/i;

/** Classify one build's output. */
/**
 * Real compiler diagnostics, ignoring the lines that a lock or a race rule
 * already explains.
 *
 * This matters because both classes SAY "fatal error": LNK1104 and C1041 are
 * spelled exactly like a genuine C2065. Testing the raw text would call every
 * flaky build a compile error, and stripping the explained lines first is what
 * lets the two coexist in one log — which they routinely do, because a failing
 * node race and a real syntax error can appear in the same run.
 */
function hasRealDiagnostic(text: string): boolean {
  const explained = [...LOCK_PATTERNS, ...FLAKY_RULES.map((f) => f.pattern)];
  const remaining = text
    .split(/\r?\n/)
    .filter((line) => !explained.some((p) => p.test(line)))
    .join("\n");
  return /\b(error [A-Z]{1,4}\d{3,5}|error:|fatal error)\b/i.test(remaining);
}

/** Classify one build's output. */
export function diagnoseBuildFailure(output: string): BuildDiagnosis {
  const text = output ?? "";

  // Environment first. A full disk and a missing compiler both announce
  // themselves as "fatal error", so classifying them before the generic
  // diagnostic sweep is what keeps "free some space" from being reported as
  // "fix your code".
  if (/no space left on device|ENOSPC|not enough space/i.test(text)) {
    return {
      kind: "out_of_space",
      retryable: false,
      lockedFile: null,
      rule: "the disk is full",
      advice: "Free space before building again — a retry cannot help.",
    };
  }

  if (MISSING_TOOLCHAIN.test(text)) {
    return {
      kind: "missing_toolchain",
      retryable: false,
      lockedFile: null,
      rule: "the toolchain itself was not found",
      advice:
        "The compiler or project file could not be located. Check the path " +
        "and the install rather than rebuilding.",
    };
  }

  // A genuine source error outranks every "this is just flaky" rule. Retrying
  // it would produce the identical log and teach the model that failures are
  // noise, which is the habit this whole classifier exists to break.
  if (hasRealDiagnostic(text)) {
    return {
      kind: "compile_error",
      retryable: false,
      lockedFile: null,
      rule: "real compiler diagnostics",
      advice:
        "Fix the errors in the source. A retry would produce the identical " +
        "failure and cost a round.",
    };
  }

  /*
   * Access denied with NO owning process: antivirus, not a build problem.
   *
   * The nastiest lock of the campaign, twice: "no owning process + access
   * denied = AV quarantine grip, where the rename gambit is the only key."
   * A freshly linked injector is exactly the shape a scanner grabs, and it
   * grabs it BETWEEN the linker closing the handle and the next build
   * opening it — so `handle.exe` finds nothing and the failure looks
   * inexplicable. It gets its own bucket so it can never again be mistaken
   * for a code problem or for an ordinary lock that waiting will clear.
   */
  /*
   * Antivirus, said out loud by the toolchain.
   *
   * Windows Defender does sometimes announce itself — "contains a virus or
   * potentially unwanted software" is a real, quotable message. When it does,
   * this must never be classified as a code problem: nothing in the source
   * changed, a rebuild will be eaten the same way, and the only keys are the
   * rename gambit or an exclusion the user adds.
   *
   * The QUIET version of the same thing — access denied with no process
   * holding the file — cannot be recognised from text alone, because the
   * evidence is the absence of a holder. That escalation happens in
   * formatLockReport(), which has actually asked the OS.
   */
  if (
    /contains a virus or potentially unwanted software|operation did not complete successfully because the file contains|quarantin|Defender|threat was (?:detected|found)/i.test(
      text
    )
  ) {
    const named =
      /([\w.\-\\/]+\.(?:exe|dll|sys|scr))/i.exec(text);
    return {
      kind: "av_quarantine",
      // Waiting does not help and neither does an identical rebuild: the
      // scanner grabs the next artefact at the same moment.
      retryable: false,
      lockedFile: named?.[1] ?? null,
      rule: "the toolchain reported an antivirus/EDR interception by name",
      advice: AV_ADVICE,
    };
  }

  for (const pattern of LOCK_PATTERNS) {
    const hit = pattern.exec(text);
    if (hit) {
      return {
        kind: "locked_file",
        // Deliberately NOT retryable. A handle that is still held will refuse
        // the second attempt exactly as it refused the first, so the useful
        // move is the lock report below — who holds it, and the rename gambit
        // — not another identical build.
        retryable: false,
        lockedFile: hit[1] || null,
        rule: `file lock — ${hit[0].slice(0, 120)}`,
        advice:
          "Something holds a handle on the output file. In order: stop any " +
          "process this workspace started that is running that binary " +
          "(list_processes, then stop_process); if nothing owns it, rename " +
          "the locked file out of the way and build again — on Windows a " +
          "running image cannot be deleted but CAN be renamed, which is why " +
          "the rename gambit works when delete is denied.",
      };
    }
  }

  for (const { pattern, rule } of FLAKY_RULES) {
    if (pattern.test(text)) {
      return {
        kind: "flaky_race",
        retryable: true,
        lockedFile: null,
        rule,
        advice:
          "This is a known-flaky class, not a code error. The same build is " +
          "run once more automatically; if it fails the same way twice it is " +
          "real and the second log is the one to read.",
      };
    }
  }

  return {
    kind: "unknown",
    retryable: false,
    lockedFile: null,
    rule: "no recognised failure signature",
    advice: "Read the log below; nothing here matches a known pattern.",
  };
}

export interface FileHolder {
  /** "workspace process" | "handle.exe" | "lsof" | "fuser" | "openfiles" */
  source: string;
  pid: number | null;
  detail: string;
  /** True when apiM started it and can stop it. */
  stoppable: boolean;
  /** id to pass to stop_process, when stoppable. */
  processId?: string;
}

/**
 * Who holds this file open?
 *
 * Answered in the order that is actually useful. Processes this workspace
 * started come FIRST: in practice the thing holding the exe is the exe the
 * agent launched two rounds ago, and that answer comes with the stop_process
 * id needed to fix it. Only then does it ask the OS, which needs tools that
 * may not be installed — a missing `handle.exe` is reported as "could not
 * determine", never as "nothing holds it".
 */
export function findFileHolders(
  workspaceId: string,
  filePath: string
): { holders: FileHolder[]; probed: string[]; unavailable: string[] } {
  const holders: FileHolder[] = [];
  const probed: string[] = [];
  const unavailable: string[] = [];

  const base = path.basename(filePath).toLowerCase();

  // 1. Our own processes — the common case, and the only one we can fix.
  probed.push("workspace processes");
  for (const proc of listProcesses(workspaceId)) {
    if (!isRunning(proc)) continue;
    const cmdline = `${proc.command} ${proc.args.join(" ")}`.toLowerCase();
    if (cmdline.includes(base) || proc.display.toLowerCase().includes(base)) {
      holders.push({
        source: "workspace process",
        pid: proc.pid ?? null,
        detail: `${proc.display} (started by this workspace)`,
        stoppable: true,
        processId: proc.id,
      });
    }
  }

  // 2. Ask the OS. Each probe is optional; absence is reported, not guessed.
  const attempts: { name: string; command: string; args: string[] }[] =
    process.platform === "win32"
      ? [
          {
            name: "handle.exe",
            command: process.env.APIM_HANDLE_PATH || "handle.exe",
            args: ["-nobanner", "-accepteula", filePath],
          },
          { name: "openfiles", command: "openfiles", args: ["/query", "/fo", "csv"] },
        ]
      : [
          { name: "fuser", command: "fuser", args: ["-v", filePath] },
          { name: "lsof", command: "lsof", args: ["--", filePath] },
        ];

  for (const attempt of attempts) {
    let out;
    try {
      out = spawnSync(attempt.command, attempt.args, {
        encoding: "utf8",
        timeout: 8_000,
        windowsHide: true,
      });
    } catch {
      unavailable.push(attempt.name);
      continue;
    }
    if (out.error || out.status === null) {
      unavailable.push(attempt.name);
      continue;
    }
    probed.push(attempt.name);
    const text = `${out.stdout ?? ""}\n${out.stderr ?? ""}`;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.toLowerCase().includes(base) && attempt.name !== "fuser") {
        continue;
      }
      const pid = /\b(?:pid:?\s*)?(\d{2,7})\b/i.exec(trimmed);
      holders.push({
        source: attempt.name,
        pid: pid ? Number(pid[1]) : null,
        detail: trimmed.slice(0, 200),
        stoppable: false,
      });
    }
    // One successful OS probe is enough.
    if (holders.some((h) => h.source === attempt.name)) break;
  }

  return { holders, probed, unavailable };
}

/** The lock section of a build report. */
export function formatLockReport(
  workspaceId: string,
  lockedFile: string
): string {
  const { holders, probed, unavailable } = findFileHolders(
    workspaceId,
    lockedFile
  );

  const lines = [`Locked file: ${lockedFile}`];

  if (holders.length === 0) {
    /*
     * No holder + a freshly built binary is a SIGNATURE, not a shrug.
     *
     * It happened twice on the same project and cost a round each time,
     * because "access denied, nothing holds it" reads as impossible and
     * invites a hunt through the source. It is almost always a live scanner
     * holding the artefact for the moment it takes to inspect it, and it is
     * the one case where renaming is the whole fix.
     */
    const binary = /\.(exe|dll|sys|scr)$/i.test(lockedFile);
    lines.push(
      `No holder identified (probed: ${probed.join(", ") || "nothing"}` +
        `${unavailable.length ? `; unavailable: ${unavailable.join(", ")}` : ""}).`
    );
    if (binary) {
      lines.push(
        `Access denied on a freshly built binary that NO process holds is ` +
          `the antivirus/EDR signature — the scanner grabs the artefact ` +
          `between the linker closing it and the next build opening it, so ` +
          `it never appears in a handle list.`,
        AV_ADVICE
      );
    } else {
      lines.push(
        `"No owning process" does not mean the lock is imaginary — a handle ` +
          `can outlive its process briefly, and antivirus and indexers hold ` +
          `files without appearing here. Rename the file out of the way and ` +
          `rebuild: a running image refuses delete but allows rename.`
      );
    }
    return lines.join("\n");
  }

  lines.push("Holders:");
  for (const holder of holders.slice(0, 10)) {
    lines.push(
      `  - ${holder.detail}${holder.pid ? ` [pid ${holder.pid}]` : ""}` +
        `${holder.stoppable ? ` — stop it with stop_process id="${holder.processId}"` : ""}`
    );
  }
  if (holders.some((h) => h.stoppable)) {
    lines.push(
      "Stop the workspace process above and build again; that releases the " +
        "handle without touching the file."
    );
  } else {
    lines.push(
      "None of these were started by this workspace, so rename the locked " +
        "file out of the way and rebuild."
    );
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ digest */

export interface BuildMessage {
  /** "C2065", "MSB3021", "CS0103" — empty for compilers that print none. */
  code: string;
  /** First place it appeared. */
  file: string;
  line: number | null;
  text: string;
  /** How many times this exact code+text repeated across the log. */
  count: number;
}

export interface BuildArtifact {
  path: string;
  bytes: number | null;
}

export interface BuildDigest {
  errors: BuildMessage[];
  warnings: BuildMessage[];
  artifacts: BuildArtifact[];
  /** Lines in the raw log the digest replaces, for an honest saving claim. */
  logLines: number;
}

const MSG =
  /^([^\s(][^(]*)\((\d+)(?:,\d+)?\)\s*:\s*(fatal error|error|warning)\s+([A-Z]{1,4}\d{3,5})\s*:\s*(.*)$/i;
const MSG_NO_FILE =
  /^(?:.*?:)?\s*(fatal error|error|warning)\s+([A-Z]{1,4}\d{3,5})\s*:\s*(.*)$/i;
const GCC =
  /^([^\s:][^:]*):(\d+):(?:\d+:)?\s*(error|warning):\s*(.*)$/i;

/** One diagnostic line, whichever compiler wrote it. */
function parseDiagnostic(
  line: string
): { kind: string; code: string; file: string; line: number | null; text: string } | null {
  const msvc = MSG.exec(line);
  if (msvc) {
    return {
      kind: msvc[3].toLowerCase(),
      code: msvc[4],
      file: msvc[1].trim(),
      line: Number(msvc[2]),
      text: msvc[5].trim(),
    };
  }
  const gcc = GCC.exec(line);
  if (gcc) {
    return {
      kind: gcc[3].toLowerCase(),
      code: "",
      file: gcc[1].trim(),
      line: Number(gcc[2]),
      text: gcc[4].trim(),
    };
  }
  const bare = MSG_NO_FILE.exec(line);
  if (bare) {
    return {
      kind: bare[1].toLowerCase(),
      code: bare[2],
      file: "",
      line: null,
      text: bare[3].trim(),
    };
  }
  return null;
}

/** MSBuild prints the linked output as `  ProjectName -> C:\path\thing.exe`. */
const LINKED = /->\s+([A-Za-z]:\\[^\s]+|\/[^\s]+)$/;

/**
 * One screen instead of forty lines of furniture.
 *
 * The ask, verbatim: "exit code, errors, unique warnings with first
 * file:line, linked size — one screen instead of me wall-scanning for C4244s
 * in forty lines of furniture." Every field here is one the reader was
 * extracting by eye anyway; the point is that they now arrive already
 * counted, already deduplicated, and in the same order every time, so two
 * builds can be compared without re-reading either log.
 *
 * The raw log is NEVER replaced by this — a digest that hides the one line
 * that mattered would be a worse version of the truncated-read problem. It
 * goes on top.
 */
export function digestBuild(output: string): BuildDigest {
  const lines = String(output ?? "").split(/\r?\n/);
  const errors = new Map<string, BuildMessage>();
  const warnings = new Map<string, BuildMessage>();
  const artifacts: BuildArtifact[] = [];

  for (const raw of lines) {
    const line = raw.trimEnd();

    const linked = LINKED.exec(line);
    if (linked && !artifacts.some((a) => a.path === linked[1])) {
      let bytes: number | null = null;
      try {
        bytes = statSync(linked[1]).size;
      } catch {
        bytes = null;
      }
      artifacts.push({ path: linked[1], bytes });
    }

    const hit = parseDiagnostic(line);
    if (!hit) continue;

    const kind = hit.kind;
    const message: BuildMessage = {
      code: hit.code,
      // Normalised first: path.basename() on a POSIX host leaves a Windows
      // path whole, and "d:\\proj\\main.cpp:500" is not a location anyone
      // can act on.
      file: hit.file ? path.basename(hit.file.replace(/\\/g, "/")) : "",
      line: hit.line,
      text: hit.text,
      count: 1,
    };

    // Deduplicated on code+text, so one warning repeated by every translation
    // unit is one row with a count — that repetition is exactly the furniture.
    const key = `${message.code}|${message.text}`;
    const bucket = kind.includes("error") ? errors : warnings;
    const existing = bucket.get(key);
    if (existing) existing.count += 1;
    else bucket.set(key, message);
  }

  return {
    errors: [...errors.values()],
    warnings: [...warnings.values()],
    artifacts,
    logLines: lines.length,
  };
}

function where(m: BuildMessage): string {
  if (!m.file) return "";
  return m.line ? ` ${m.file}:${m.line}` : ` ${m.file}`;
}

export function formatBuildDigest(
  digest: BuildDigest,
  exitCode: number | null,
  durationMs?: number
): string {
  const out: string[] = [
    `DIGEST — exit ${exitCode ?? "?"}` +
      (durationMs ? `, ${(durationMs / 1000).toFixed(1)}s` : "") +
      `, ${digest.errors.length} distinct error(s), ` +
      `${digest.warnings.length} distinct warning(s), ` +
      `${digest.logLines} log line(s).`,
  ];

  if (digest.errors.length) {
    out.push("", "Errors:");
    for (const e of digest.errors.slice(0, 20)) {
      out.push(
        `  ${e.code || "error"}${where(e)}: ${e.text}` +
          (e.count > 1 ? `  (x${e.count})` : "")
      );
    }
    if (digest.errors.length > 20) {
      out.push(`  … ${digest.errors.length - 20} more, in the log below.`);
    }
  }

  if (digest.warnings.length) {
    out.push("", "Warnings (unique, first sighting):");
    for (const w of digest.warnings.slice(0, 15)) {
      out.push(
        `  ${w.code || "warning"}${where(w)}: ${w.text}` +
          (w.count > 1 ? `  (x${w.count})` : "")
      );
    }
    if (digest.warnings.length > 15) {
      out.push(`  … ${digest.warnings.length - 15} more, in the log below.`);
    }
  }

  if (digest.artifacts.length) {
    out.push("", "Linked:");
    for (const a of digest.artifacts.slice(0, 10)) {
      out.push(
        `  ${a.path}${
          a.bytes === null
            ? " (size unknown — the file is not where the log said)"
            : ` — ${a.bytes.toLocaleString()} bytes`
        }`
      );
    }
  }

  return out.join("\n");
}

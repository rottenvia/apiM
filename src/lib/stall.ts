/**
 * No-progress detection: halting a run that moves without advancing.
 *
 * The loop-breaker catches one shape of stuck — the same call failing
 * identically. The real world has a wider one: every call differs, every
 * call "works", and nothing advances. Read the file, retry the edit with a
 * new anchor, fail, re-read the file, narrate the plan again, repeat until
 * the round cap. Each round re-sends the whole growing context, so the
 * meter on this loop is money, not just time.
 *
 * The rule is information-theoretic: a tool call is progress when it adds
 * something NEW — bytes on disk changed, the world was run, or text arrived
 * that was not already in context. Anything else is a stall round:
 *
 *   - a failed tool (failures teach the model, but six straight failures
 *     with no success between them is still stuck);
 *   - a successful call returning byte-identical text to the same call
 *     before it (the tenth re-read of an unchanged file);
 *   - plan bookkeeping (planning without doing is the narration loop in
 *     tool form — a run that only plans never touches the world).
 *
 * Writes, runs, and a user's answer reset the meter AND clear the
 * seen-map: the world changed, so the next read is fresh information even
 * for a file read before. Polling a live process passes naturally — new
 * output hashes differently, so only polling that yields nothing counts
 * down. Warn at four, halt at six. Per CALL, not per round: one model
 * decision can spend several calls, and each is billed.
 *
 * The consecutive counter above catches the NARROW loop — the same thing
 * six times in a row. The real money fire is the WIDE loop: thirty rounds
 * cycling the same files (models, providers, manager, selector, verify,
 * route, repeat), every call slightly novel so the counter keeps
 * resetting, nothing landing for thousands of tokens. A second meter
 * therefore counts byte-identical re-fetches CUMULATIVELY — novelty does
 * not reset it, only the world changing does. Warn at eight, halt at
 * twelve. Watching tools (read_process, list_processes, wait_for_output)
 * are exempt: a quiet wait is legitimate, and polling that yields nothing
 * already counts down the consecutive meter.
 *
 * Deterministic and model-independent, like the breaker. A Resume starts a
 * fresh tracker — the user steers, the model retries, and it gets a full
 * six on the new approach.
 */

import { fingerprintToolCall } from "@/lib/loop-breaker";

/** Stall calls before the model gets warned. */
export const STALL_WARN_CALLS = 4;

/** Stall calls before the run halts. */
export const STALL_TRIP_CALLS = 6;

/** Cumulative identical re-fetches before the model gets warned. */
export const REPEAT_WARN_TOTAL = 8;

/** Cumulative identical re-fetches before the run halts. */
export const REPEAT_TRIP_TOTAL = 12;

/**
 * Watching tools never feed the cumulative meter: re-polling a quiet
 * process is waiting, not spinning, and each identical poll already
 * counts down the consecutive meter above.
 */
const REPEAT_EXEMPT = new Set([
  "read_process",
  "list_processes",
  "wait_for_output",
]);

/**
 * Tools whose success changes the world, so the next read is fresh even
 * for a path read before. Kept as names, not a flag on the dispatcher —
 * the observation site sees every result (dispatcher, plan tools, approval
 * paths) uniformly, and names are all it needs.
 */
const WORLD_CHANGING = new Set([
  "write_file",
  "write_files",
  "edit_file",
  "edit_files",
  "apply_patch",
  "replace_in_files",
  "move_file",
  "delete_file",
  "undo_file",
  "restore_snapshot",
  "download_file",
  "run_command",
  "run_tests",
  "build_project",
  "start_process",
  "stop_process",
  "write_process",
  "github_push",
  "github_create_pr",
  "git_commit",
  "git_branch",
  "git_pull_base",
]);

/** Planning without doing is the narration loop in tool form. */
const BOOKKEEPING = new Set(["make_plan", "update_plan"]);

/** How many recent tool names the trip note can quote. */
const RECENT_KEPT = 8;

/** FNV-1a over the result text — fast, and only a heuristic guard. */
function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** "read_file(src/x.ts)" — what the trip note quotes for a repeated call. */
function targetOf(name: string, args: unknown): string {
  let value: unknown = args;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return name;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return name;
  const record = value as Record<string, unknown>;
  const path =
    record.path ?? record.paths ?? record.query ?? record.command ?? record.symbol;
  const target =
    typeof path === "string"
      ? path
      : Array.isArray(path)
        ? path.slice(0, 2).join(", ")
        : "";
  return target ? `${name}(${target})` : name;
}

export interface StallObservation {
  /** True when this call added something new. */
  progress: boolean;
  /** Consecutive stall calls including this one (0 after progress). */
  stallCalls: number;
  /** True exactly on the warning call — nudge the model now. */
  warn: boolean;
  /** True on the trip call and stays true while stalling continues. */
  trip: boolean;
  /** Cumulative identical re-fetches with nothing landing between them. */
  repeatTotal: number;
  /** True exactly when the cumulative meter hits its warning mark. */
  repeatWarn: boolean;
  /** True once the cumulative meter reaches its trip mark. */
  repeatTrip: boolean;
  /** Most-repeated call so far, for the warning and trip notes. */
  topRepeatTarget: string | null;
}

/** Per-run no-progress tracker. One instance per reply. */
export class StallTracker {
  /** Call fingerprint -> hash of the text it last returned. */
  private seen = new Map<string, number>();
  private stalls = 0;
  private recent: string[] = [];
  /**
   * Cumulative identical re-fetches. Novelty does NOT reset this — only
   * the world changing does — which is what makes it catch the wide loop
   * the consecutive counter above cannot see.
   */
  private repeatTotal = 0;
  /** Per-call identical-repeat counts, for the most-repeated quote. */
  private repeatCounts = new Map<string, number>();
  private repeatTargets = new Map<string, string>();

  observe(
    name: string,
    args: unknown,
    ok: boolean,
    content: string
  ): StallObservation {
    this.recent.push(name);
    if (this.recent.length > RECENT_KEPT) this.recent.shift();

    if (!ok) return this.stalled(false);
    // A user's answer unblocks the run — that is forward motion.
    if (name === "ask_user" || WORLD_CHANGING.has(name)) {
      this.seen.clear();
      this.stalls = 0;
      this.repeatTotal = 0;
      this.repeatCounts.clear();
      this.repeatTargets.clear();
      return this.fresh(true);
    }
    if (BOOKKEEPING.has(name)) return this.stalled(false);
    const fingerprint = fingerprintToolCall(name, args);
    const hash = hashText(content ?? "");
    if (this.seen.get(fingerprint) === hash) {
      if (!REPEAT_EXEMPT.has(name)) {
        this.repeatTotal += 1;
        this.repeatCounts.set(
          fingerprint,
          (this.repeatCounts.get(fingerprint) ?? 0) + 1
        );
        if (!this.repeatTargets.has(fingerprint)) {
          this.repeatTargets.set(fingerprint, targetOf(name, args));
        }
      }
      return this.stalled(true);
    }
    this.seen.set(fingerprint, hash);
    this.stalls = 0;
    return this.fresh(true);
  }

  private fresh(progress: boolean): StallObservation {
    return {
      progress,
      stallCalls: this.stalls,
      warn: false,
      trip: false,
      repeatTotal: this.repeatTotal,
      repeatWarn: false,
      repeatTrip: this.repeatTotal >= REPEAT_TRIP_TOTAL,
      topRepeatTarget: this.topTarget(),
    };
  }

  private topTarget(): string | null {
    let best: string | null = null;
    let bestCount = 0;
    for (const [fingerprint, count] of this.repeatCounts) {
      if (count > bestCount) {
        bestCount = count;
        best = this.repeatTargets.get(fingerprint) ?? null;
      }
    }
    return best;
  }

  private stalled(countedRepeat: boolean): StallObservation {
    this.stalls += 1;
    return {
      progress: false,
      stallCalls: this.stalls,
      warn: this.stalls === STALL_WARN_CALLS,
      trip: this.stalls >= STALL_TRIP_CALLS,
      repeatTotal: this.repeatTotal,
      repeatWarn: countedRepeat && this.repeatTotal === REPEAT_WARN_TOTAL,
      repeatTrip: this.repeatTotal >= REPEAT_TRIP_TOTAL,
      topRepeatTarget: this.topTarget(),
    };
  }

  /** Last tool names, oldest first, for the trip note. */
  recentActions(): string[] {
    return [...this.recent];
  }

  reset(): void {
    this.seen.clear();
    this.stalls = 0;
    this.recent = [];
    this.repeatTotal = 0;
    this.repeatCounts.clear();
    this.repeatTargets.clear();
  }
}

/**
 * Nudge appended to the tool result carrying the warning call — the text
 * the model is guaranteed to read next. Names the count and the
 * consequence; tells it what progress looks like from here.
 */
export function stallWarningText(stallCalls: number): string {
  const left = STALL_TRIP_CALLS - stallCalls;
  return (
    `\n\n[Harness: ${stallCalls} tool calls with no forward motion — ` +
    `nothing written, and every read/fetch returned text already in ` +
    `context. Stop re-reading: fetch something NEW (different files, run ` +
    `the code, search the web), or state what is missing and ask the user. ` +
    `${left} more unchanged call${left === 1 ? "" : "s"} stop${left === 1 ? "s" : ""} the run.]`
  );
}

/**
 * Nudge appended to the tool result carrying the cumulative warning call.
 *
 * Deliberately the OPPOSITE advice from the consecutive warning below it:
 * that one says "fetch something NEW", which is exactly how a wide loop
 * evades the consecutive meter. Here the disease is re-fetching, so the
 * prescription is to use what is already in context — and to bank durable
 * facts with note_finding, the one record compaction cannot eat.
 */
export function rereadWarningText(total: number, target: string | null): string {
  const left = REPEAT_TRIP_TOTAL - total;
  return (
    `\n\n[Harness: ${total} tool calls re-fetched byte-identical text with ` +
    `nothing written, run, or answered since` +
    (target ? ` — most-repeated: ${target}` : "") +
    `. The text is already in context; fetching it again teaches nothing ` +
    `and every round re-bills the whole transcript. Bank durable facts ` +
    `with note_finding so compaction cannot eat them, then ACT on what ` +
    `you have: edit, run, or state what is missing and ask the user. ` +
    `${left} more identical re-fetch${left === 1 ? "" : "es"} stop${left === 1 ? "s" : ""} the run.]`
  );
}

/**
 * Marker appended to the tool result carrying the cumulative trip call.
 * Separate from the consecutive marker below because the count differs —
 * quoting 6 for a 12-call trip would lie in the saved transcript.
 */
export function rereadTripMarker(total: number): string {
  return (
    `\n\n[Harness: the run was stopped after ${total} identical ` +
    `re-fetches with nothing written, run, or answered. On Resume, bank ` +
    `findings first, then act — the details are in the reply text.]`
  );
}

/**
 * User-facing note for a cumulative halt. Mirrors the consecutive note's
 * shape (verdict, evidence, cost, recovery) so both halts read as one
 * feature with two triggers.
 */
export function rereadTripUserNote(
  total: number,
  target: string | null,
  recent: string[]
): string {
  return (
    `Stalled and halted: ${total} tool calls re-fetched identical text ` +
    `without writing, running, or asking anything` +
    (target ? ` (most: ${target})` : ``) +
    (recent.length ? ` (last actions: ${compressActions(recent)})` : ``) +
    `. The run was stopped instead of burning more rounds — say what to ` +
    `try differently and Resume to carry on.`
  );
}

/**
 * Marker appended to the tool result carrying the trip call. The run ends
 * here, so this is for the saved transcript: on Resume the model sees WHY
 * the run stopped at the exact point it did.
 */
export function stallTripMarker(): string {
  return (
    `\n\n[Harness: the run was stopped after ${STALL_TRIP_CALLS} tool ` +
    `calls with no forward motion. On Resume, try a different approach ` +
    `— the details are in the reply text.]`
  );
}

function compressActions(names: string[]): string {
  const tail = names.slice(-STALL_TRIP_CALLS);
  const parts: string[] = [];
  for (const name of tail) {
    const last = parts[parts.length - 1];
    const match = last ? /^(.+) ×(\d+)$/.exec(last) : null;
    if (match && match[1] === name) {
      parts[parts.length - 1] = `${name} ×${Number(match[2]) + 1}`;
    } else if (last === name) {
      parts[parts.length - 1] = `${name} ×2`;
    } else {
      parts.push(name);
    }
  }
  return parts.join(", ");
}

/**
 * User-facing note for the reply text. Quotes the recent actions so the
 * user sees the shape of the stall, not just the verdict.
 */
export function stallTripUserNote(recent: string[]): string {
  return (
    `Stalled and halted: ${STALL_TRIP_CALLS} tool calls changed nothing ` +
    `on disk and fetched no new information` +
    (recent.length ? ` (last actions: ${compressActions(recent)})` : ``) +
    `. The run was stopped instead of burning more rounds — say what to ` +
    `try differently and Resume to carry on.`
  );
}

/* ------------------------------------------------------------------ *
 * Gathering without doing
 *
 * The meters above only count calls that return nothing NEW. The reported
 * loop evaded both: each round read a different module (Signal, Color,
 * Schema, Theme, the test harness...) or re-read one after it had been
 * collapsed, narrated "continuing step 1", and never wrote a line. Every
 * call was novel, so nothing fired. This counts the streak itself — calls
 * in a row that neither changed the world nor asked the user — and names
 * what is already in hand, because the model re-reads when it believes the
 * text is gone.
 * ------------------------------------------------------------------ */

/** Read-only calls in a row before the model is told to start doing. */
export const GATHER_NUDGE_CALLS = 10;

const READ_TOOLS = new Set(["read_file", "read_files", "read_document"]);

export interface GatherObservation {
  /** Calls in the current read-only streak. */
  streak: number;
  /** Nudge on this call (every GATHER_NUDGE_CALLS of the streak). */
  nudge: boolean;
  /** Files read during the streak, oldest first. */
  files: string[];
}

export class GatherTracker {
  private streak = 0;
  private files: string[] = [];

  observe(name: string, args: unknown, ok: boolean): GatherObservation {
    if (ok && (name === "ask_user" || WORLD_CHANGING.has(name))) {
      this.streak = 0;
      this.files = [];
      return { streak: 0, nudge: false, files: [] };
    }
    this.streak += 1;
    if (READ_TOOLS.has(name) && args && typeof args === "object") {
      const a = args as Record<string, unknown>;
      const raw = a.paths ?? a.path;
      for (const p of Array.isArray(raw) ? raw : [raw]) {
        if (typeof p === "string" && p.trim() && !this.files.includes(p.trim())) {
          this.files.push(p.trim());
        }
      }
    }
    return {
      streak: this.streak,
      nudge: this.streak % GATHER_NUDGE_CALLS === 0,
      files: [...this.files],
    };
  }

  reset(): void {
    this.streak = 0;
    this.files = [];
  }
}

/** Appended to the tool result on a gathering nudge. */
export function gatherNudgeText(obs: GatherObservation): string {
  const shown = obs.files.slice(-12);
  const list = shown.length
    ? ` You already have ${shown.join(", ")}${
        obs.files.length > shown.length ? ` (+${obs.files.length - shown.length} more)` : ""
      } — their text is kept in your context, so do not read them again.`
    : "";
  return (
    `\n\n[Harness: ${obs.streak} tool calls in a row without writing, ` +
    `running or asking anything.${list} Stop gathering and do the current ` +
    `step now: write or edit the code. If one specific thing you need is ` +
    `genuinely missing, name it in a line and fetch only that.]`
  );
}

/** Appended when a file is read again with byte-identical content. */
export function unchangedReadText(): string {
  return (
    `\n\n[Harness: you already read this in this run and it has not ` +
    `changed — the earlier copy is still in your context. Do not read it ` +
    `again; work from what you have.]`
  );
}

/** Is this one of the file-reading tools? */
export function isReadTool(name: string): boolean {
  return READ_TOOLS.has(name);
}

/* ------------------------------------------------------------------ *
 * Rewrite churn
 *
 * Every write resets the meters above — it changed the world — so the
 * loop "rewrite the whole file, run it, it fails, rewrite the whole file"
 * never registers as stuck, yet each lap re-sends the entire file as
 * output tokens. Counted per path between successful runs: the third whole
 * rewrite of one file with no passing run in between gets a nudge toward
 * reading the error and making a targeted edit.
 * ------------------------------------------------------------------ */

export const CHURN_NUDGE_REWRITES = 3;

const RUN_TOOLS = new Set(["run_command", "run_tests", "build_project"]);

export class ChurnTracker {
  private rewrites = new Map<string, number>();

  /** Returns the path being churned when this call should carry a nudge. */
  observe(name: string, args: unknown, ok: boolean): { path: string; count: number } | null {
    if (RUN_TOOLS.has(name)) {
      if (ok) this.rewrites.clear();
      return null;
    }
    if (!ok || (name !== "write_file" && name !== "write_files")) return null;
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    const paths: string[] = [];
    if (typeof a.path === "string") paths.push(a.path);
    if (Array.isArray(a.files)) {
      for (const f of a.files) {
        const p = (f as { path?: unknown })?.path;
        if (typeof p === "string") paths.push(p);
      }
    }
    let hit: { path: string; count: number } | null = null;
    for (const p of paths) {
      const key = p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
      const count = (this.rewrites.get(key) ?? 0) + 1;
      this.rewrites.set(key, count);
      if (count >= CHURN_NUDGE_REWRITES && !hit) hit = { path: key, count };
    }
    return hit;
  }
}

export function churnNudgeText(hit: { path: string; count: number }): string {
  return (
    `\n\n[Harness: ${hit.path} has now been rewritten whole ${hit.count} ` +
    `times with no passing run in between. Rewriting the entire file again ` +
    `is not converging and re-sends all of it each time. Read the exact ` +
    `error from the last run, find the line it names, and fix THAT with ` +
    `edit_file.]`
  );
}

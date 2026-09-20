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
 * Deterministic and model-independent, like the breaker. A Resume starts a
 * fresh tracker — the user steers, the model retries, and it gets a full
 * six on the new approach.
 */

import { fingerprintToolCall } from "@/lib/loop-breaker";

/** Stall calls before the model gets warned. */
export const STALL_WARN_CALLS = 4;

/** Stall calls before the run halts. */
export const STALL_TRIP_CALLS = 6;

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

export interface StallObservation {
  /** True when this call added something new. */
  progress: boolean;
  /** Consecutive stall calls including this one (0 after progress). */
  stallCalls: number;
  /** True exactly on the warning call — nudge the model now. */
  warn: boolean;
  /** True on the trip call and stays true while stalling continues. */
  trip: boolean;
}

/** Per-run no-progress tracker. One instance per reply. */
export class StallTracker {
  /** Call fingerprint -> hash of the text it last returned. */
  private seen = new Map<string, number>();
  private stalls = 0;
  private recent: string[] = [];

  observe(
    name: string,
    args: unknown,
    ok: boolean,
    content: string
  ): StallObservation {
    this.recent.push(name);
    if (this.recent.length > RECENT_KEPT) this.recent.shift();

    if (!ok) return this.stalled();
    // A user's answer unblocks the run — that is forward motion.
    if (name === "ask_user" || WORLD_CHANGING.has(name)) {
      this.seen.clear();
      this.stalls = 0;
      return { progress: true, stallCalls: 0, warn: false, trip: false };
    }
    if (BOOKKEEPING.has(name)) return this.stalled();
    const fingerprint = fingerprintToolCall(name, args);
    const hash = hashText(content ?? "");
    if (this.seen.get(fingerprint) === hash) return this.stalled();
    this.seen.set(fingerprint, hash);
    this.stalls = 0;
    return { progress: true, stallCalls: 0, warn: false, trip: false };
  }

  private stalled(): StallObservation {
    this.stalls += 1;
    return {
      progress: false,
      stallCalls: this.stalls,
      warn: this.stalls === STALL_WARN_CALLS,
      trip: this.stalls >= STALL_TRIP_CALLS,
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

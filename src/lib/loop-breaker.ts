/**
 * Circuit breaker for tool-call loops.
 *
 * The failure mode this stops: the model sends the same tool call with the
 * same arguments, it fails, and the model sends it again unchanged — three,
 * ten, fifty times, until the round cap. Each failed round makes the next
 * one worse, because the failure is appended to context: the model re-reads
 * its own miss and pattern-matches onto it instead of adapting. A weak
 * model does not escape this on its own; it narrates
 * ("Right, I'm mid-edit...") and retries.
 *
 * Strikes are counted PER CALL, not consecutively. The real loop interleaves
 * other work — read the file, retry the identical edit, read it again,
 * retry again — so "three in a row" would never fire on the exact failure
 * it exists to stop. Other calls neither clear nor advance a call's
 * strikes; only that call succeeding clears them (state changed — a later
 * failure is a new episode, not the same stuckness).
 *
 * The rule stays narrow on purpose:
 *
 *   - a call succeeding clears its own strikes;
 *   - a changed argument is a different call (the model IS adapting);
 *   - success repeats are never counted: polling a process or re-reading a
 *     file after other work is legitimate, and breaking on it would punish
 *     normal behaviour.
 *
 * Second strike warns the model inside the tool result it is already
 * reading. Third strike trips: the run halts, the user gets a note naming
 * the call and its error, and Resume carries steering instead of a fourth
 * identical attempt. Deterministic and model-independent — it works the
 * same on a frontier model and a free one.
 */

/** Identical failures before the model gets warned. */
export const LOOP_WARN_REPEATS = 2;

/** Identical failures before the run halts. */
export const LOOP_TRIP_REPEATS = 3;

/**
 * Stable fingerprint for one tool call: the name plus arguments with
 * recursively sorted keys, so `{a:1,b:2}` and `{b:2,a:1}` are the same call
 * but any changed value is a different one. A raw (unparseable) argument
 * blob fingerprints on its exact bytes — repeated malformed JSON trips too.
 */
export function fingerprintToolCall(name: string, args: unknown): string {
  return `${name}\n${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  try {
    return stable(value);
  } catch {
    return String(value);
  }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stable(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
    .join(",")}}}`;
}

export interface LoopObservation {
  /** Strikes against this call including this observation. */
  repeats: number;
  /** True exactly on the warning strike — nudge the model now. */
  warn: boolean;
  /** True on the trip strike and stays true while the strikes continue. */
  trip: boolean;
}

/**
 * Per-run strike tracker. One instance per reply; a Resume starts a fresh
 * one, which is correct — the user steers, the model retries, and it gets
 * a full three strikes on the new approach.
 */
export class LoopBreaker {
  private strikes = new Map<string, number>();

  observe(name: string, args: unknown, ok: boolean): LoopObservation {
    const fingerprint = fingerprintToolCall(name, args);
    if (ok) {
      this.strikes.delete(fingerprint);
      return { repeats: 0, warn: false, trip: false };
    }
    const repeats = (this.strikes.get(fingerprint) ?? 0) + 1;
    this.strikes.set(fingerprint, repeats);
    return {
      repeats,
      warn: repeats === LOOP_WARN_REPEATS,
      trip: repeats >= LOOP_TRIP_REPEATS,
    };
  }

  reset(): void {
    this.strikes.clear();
  }
}

/**
 * Nudge appended to the tool result carrying the second strike — the text
 * the model is guaranteed to read next. Names the consequence so a
 * literal-minded model does not treat it as advice.
 */
export function loopWarningText(toolName: string): string {
  return (
    `\n\n[Harness: this exact \`${toolName}\` call has now failed twice ` +
    `with identical arguments. Do NOT send it again unchanged — a third ` +
    `identical failure stops the run. Read the error, change the approach ` +
    `(inspect the file first, use a different anchor, or ask the user), ` +
    `then act.]`
  );
}

/**
 * Marker appended to the tool result carrying the third strike. The run
 * ends here, so this is for the saved transcript: on Resume the model sees
 * WHY the run stopped at the exact point it did.
 */
export function loopTripMarker(toolName: string): string {
  return (
    `\n\n[Harness: the run was stopped after this third identical ` +
    `\`${toolName}\` failure. On Resume, try a different approach — the ` +
    `details are in the reply text.]`
  );
}

/**
 * User-facing note for the reply text. Names the call and its last error so
 * the user can steer precisely instead of guessing what repeated.
 */
export function loopTripUserNote(toolName: string, lastError: string): string {
  const trimmed =
    lastError.trim().length > 300
      ? `${lastError.trim().slice(0, 300)}…`
      : lastError.trim();
  return (
    `Stopped by the loop breaker: \`${toolName}\` failed three times ` +
    `with identical arguments` +
    (trimmed ? ` (last error: ${trimmed})` : ``) +
    `. The run was halted instead of burning more rounds — say what to ` +
    `try differently and Resume to carry on.`
  );
}

/**
 * De-duplication for mid-answer continuations.
 *
 * When a stream is cut mid-sentence we ask the model to "carry straight on
 * from the last character". GLM and Ox often ignore that and restart the
 * sentence instead: the continuation stream opens with text that was already
 * streamed and saved from the cut round. The two used to be concatenated into
 * one garbled line, e.g.
 *
 *   "The chain is closed — **`m_hPawn = " +
 *   "The chain closed, love — **`m_hPawn ..."
 *
 * The continuation is streamed in small deltas, so the raw start is buffered
 * until it either diverges from the tail of the text already streamed (in
 * which case any repeated prefix is dropped) or proves to be entirely new.
 */

/** A repeat shorter than this is treated as coincidence, not an echo. */
const MIN_OVERLAP = 24;
/**
 * The new stream is released as soon as this many characters have buffered.
 * Small enough that the first words of a continuation appear within a
 * fraction of a second of arrival; large enough to contain the restarted
 * sentence that marks an echo.
 */
const BUFFER_CAP = 240;
/** Decide early once this many new (non-echoed) characters are confirmed. */
const NEW_TEXT_TO_RELEASE = 24;

export interface ContinuationDedup {
  /** Add a raw delta; returns what is safe to stream/save ("" if buffered). */
  push(delta: string): string;
  /** Whether a decision has been made and buffering has stopped. */
  readonly decided: boolean;
}

/**
 * Length of the longest prefix of `newText` that was already streamed, i.e.
 * occurs as a substring ending near the end of `tail`. The model restarts a
 * sentence byte-for-byte but rarely restart at exactly the cut character, so
 * we match on content rather than on "tail ends with the new prefix".
 *
 * A word-boundary condition keeps us from clipping prose that merely repeats
 * a common short phrase: the dropped length must land at a non-word boundary
 * in both the tail and the new stream (the echo ends mid-word only when it is
 * not actually an echo).
 */
function echoedPrefixLength(tail: string, newText: string): number {
  const max = Math.min(newText.length, tail.length);
  for (let len = max; len >= MIN_OVERLAP; len--) {
    const head = newText.slice(0, len);
    const at = tail.lastIndexOf(head);
    if (at === -1) continue;
    // Must be recent text (the restart happens at the last sentence).
    if (at + len < tail.length - 80) continue;
    return len;
  }
  return 0;
}

export function createContinuationDedup(existingTail: string): ContinuationDedup {
  let buffer = "";
  let decided = false;
  const tail = existingTail.slice(-2048);

  const finish = (): string => {
    const overlap = echoedPrefixLength(tail, buffer);
    const out = overlap >= MIN_OVERLAP ? buffer.slice(overlap) : buffer;
    decided = true;
    buffer = "";
    return out;
  };

  return {
    get decided() {
      return decided;
    },
    push(delta: string): string {
      if (decided) return delta;
      buffer += delta;

      if (buffer.length >= MIN_OVERLAP) {
        // If the head of the new stream is not a verbatim chunk of the recent
        // transcript, the model obeyed "do not repeat" — release immediately
        // so clean continuations are never delayed.
        const overlap = echoedPrefixLength(tail, buffer);
        if (overlap < MIN_OVERLAP) return finish();
        // We are inside an echo: once enough NEW text has followed the echoed
        // part, the boundary is clear and we can drop the prefix.
        if (
          buffer.length - overlap >= NEW_TEXT_TO_RELEASE ||
          buffer.length >= BUFFER_CAP
        ) {
          return finish();
        }
      }
      return "";
    },
  };
}

/**
 * Retrying transient upstream failures.
 *
 * A long agent task can run for many rounds. Without a retry, one dropped
 * connection on round thirty-two threw away the whole task — including the
 * tokens already paid for on the previous thirty-one rounds. The failure was
 * usually a blip that would have succeeded a second later.
 *
 * Only failures that are plausibly transient are retried. A rejected key or
 * an empty balance will fail identically every time, so retrying those just
 * delays an error the user needs to see.
 */

/** HTTP statuses worth trying again. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Statuses that will never succeed on retry, listed explicitly so a new
 * status code defaults to "do not retry" rather than looping on something
 * permanent.
 */
const FATAL_STATUS = new Set([400, 401, 402, 403, 404, 422]);

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Delay before the second attempt; doubles each time. */
  baseDelayMs?: number;
  /** Ceiling on the backoff, so a long task cannot stall for minutes. */
  maxDelayMs?: number;
  /** Aborts the wait as well as the request. */
  signal?: AbortSignal;
  /** Called before each retry, for surfacing "retrying…" in the UI. */
  onRetry?: (info: {
    attempt: number;
    attempts: number;
    delayMs: number;
    reason: string;
  }) => void;
}

export interface RetryResult {
  response: Response | null;
  /** Set when every attempt failed without producing a response. */
  error: Error | null;
  /** How many attempts were made in total. */
  attempts: number;
}

/** True for network-level failures, which are the most common transient case. */
export function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // A user pressing Stop is not a failure to retry.
  if (error.name === "AbortError") return false;
  return (
    error.name === "TimeoutError" ||
    error.name === "TypeError" || // fetch throws TypeError on connection loss
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(
      error.message
    )
  );
}

/** True when an HTTP status is worth another attempt. */
export function isRetryableStatus(status: number): boolean {
  if (FATAL_STATUS.has(status)) return false;
  return RETRYABLE_STATUS.has(status) || status >= 500;
}

/**
 * Honour a Retry-After header when the server sends one.
 *
 * Rate limiters know better than a fixed backoff how long to wait, and
 * ignoring the header tends to earn a longer ban.
 */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());

  return null;
}

/** Sleep that gives up immediately if the request is aborted. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run a fetch, retrying transient failures with exponential backoff.
 *
 * Returns rather than throws, so the caller can report a fatal status to the
 * user with its real message instead of a generic retry error.
 */
export async function fetchWithRetry(
  makeRequest: () => Promise<Response>,
  options: RetryOptions = {}
): Promise<RetryResult> {
  const {
    attempts = 3,
    baseDelayMs = 700,
    maxDelayMs = 8_000,
    signal,
    onRetry,
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) {
      return {
        response: null,
        error: new DOMException("Aborted", "AbortError") as unknown as Error,
        attempts: attempt - 1,
      };
    }

    let response: Response | null = null;
    let reason = "";

    try {
      response = await makeRequest();
    } catch (error) {
      // Stop means stop — never retry past a deliberate cancellation.
      if (error instanceof Error && error.name === "AbortError") {
        return { response: null, error, attempts: attempt };
      }
      if (!isTransientNetworkError(error)) {
        return {
          response: null,
          error: error instanceof Error ? error : new Error(String(error)),
          attempts: attempt,
        };
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      reason =
        lastError.name === "TimeoutError" ? "timed out" : "connection lost";
    }

    if (response) {
      if (response.ok || !isRetryableStatus(response.status)) {
        return { response, error: null, attempts: attempt };
      }
      reason =
        response.status === 429
          ? "rate limited"
          : `server error ${response.status}`;
    }

    // Out of attempts — hand back whatever the last try produced.
    if (attempt === attempts) {
      return {
        response,
        error: response ? null : lastError,
        attempts: attempt,
      };
    }

    const suggested = response ? retryAfterMs(response) : null;
    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    // Jitter stops repeated failures from re-colliding in lockstep.
    const jitter = Math.random() * 250;
    const waitMs = suggested ?? backoff + jitter;

    onRetry?.({ attempt, attempts, delayMs: Math.round(waitMs), reason });

    // Release the unread body before waiting, or the socket stays pinned.
    if (response) await response.body?.cancel().catch(() => {});

    try {
      await delay(waitMs, signal);
    } catch (error) {
      return {
        response: null,
        error: error instanceof Error ? error : new Error(String(error)),
        attempts: attempt,
      };
    }
  }

  return { response: null, error: lastError, attempts };
}

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
 * Statuses that, once every retry is spent, mean "their server is having a
 * moment" rather than "your key or balance is wrong" — so a reply that left
 * work on disk should continue itself (auto-resume) instead of parking on a
 * Resume button.
 *
 * 429 is deliberately NOT in this set: a rate limit is the shared pool
 * saying "slow down", and a separate resume agent owns limit stops. Looping
 * on it here is the "every model generates forever" bug again. 401/402
 * (dead key, empty balance) are fatal for the same reason.
 */
export const SERVER_SIDE_STATUS = new Set([408, 409, 425, 500, 502, 503, 504]);

/**
 * Statuses that will never succeed on retry, listed explicitly so a new
 * status code defaults to "do not retry" rather than looping on something
 * permanent.
 */
const FATAL_STATUS = new Set([400, 401, 402, 403, 404, 422]);

export interface RetryInfo {
  attempt: number;
  attempts: number;
  delayMs: number;
  reason: string;
}

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Delay before the second attempt; doubles each time. */
  baseDelayMs?: number;
  /** Ceiling on the backoff, so a long task cannot stall for minutes. */
  maxDelayMs?: number;
  /** Aborts the wait as well as the request. */
  signal?: AbortSignal;
  /** Called at the start of every try, including the first. */
  onAttempt?: (info: { attempt: number; attempts: number }) => void;
  /** Called before each retry, for surfacing "retrying…" in the UI. */
  onRetry?: (info: RetryInfo) => void;
}

/** How the live Ox / upstream banner should behave. */
export type UpstreamPhase = "attempt" | "backoff" | "clear";

export interface UpstreamNotice {
  phase: UpstreamPhase;
  attempt: number;
  attempts: number;
  delayMs?: number;
  reason?: string;
  host?: string;
  waitedMs?: number;
  /** Approximate JSON body size of the completion request. */
  inputChars?: number;
}

/** Hide a healthy first try until it has actually been sitting there. */
export const HIDE_ATTEMPT_BEFORE_MS = 2_000;

/** Default policy for DeepSeek and the local sidecar. */
export const DEFAULT_RETRY = {
  attempts: 3,
  baseDelayMs: 700,
  maxDelayMs: 8_000,
} as const;

/**
 * OpenCode Zen (Ox Alpha) 503s several times a day.
 *
 * Three tries is not enough for an outage that lasts a minute, and their
 * body often just says "retrying" — which we must not show as a final error.
 */
export const OPENCODE_RETRY = {
  attempts: 5,
  baseDelayMs: 1_200,
  maxDelayMs: 10_000,
} as const;

export interface RetryResult {
  response: Response | null;
  /** Set when every attempt failed without producing a response. */
  error: Error | null;
  /** How many attempts were made in total. */
  attempts: number;
}

/**
 * How many times the client will silently resume after a request timeout.
 *
 * The saved transcript already has the files, reads and reasoning. A new
 * HTTP request is what resets the route clock. Three is enough to ride out
 * a 5-minute Next ceiling on a long Qwen think; more than that is a hang.
 */
export const MAX_TIMEOUT_AUTO_RESUMES = 3;

const TIMEOUT_TEXT =
  /aborted due to timeout|timed out|took too long to respond|\bTimeoutError\b/i;

/**
 * True for a deadline abort — not the user pressing Stop.
 *
 * `AbortSignal.timeout()` is supposed to throw TimeoutError. Some runtimes
 * wrap that as AbortError with this exact message, which is how
 * "Internal server error: The operation was aborted due to timeout"
 * reached the chat bubble instead of a retry.
 */
export function isTimeoutFailure(error: unknown): boolean {
  if (error == null) return false;
  if (typeof error === "string") return TIMEOUT_TEXT.test(error);
  if (typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const message = "message" in error ? String(error.message) : "";
  if (name === "TimeoutError") return true;
  if (TIMEOUT_TEXT.test(message)) return true;
  const cause = "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  return Boolean(cause && cause !== error && isTimeoutFailure(cause));
}

/**
 * A failure that left real work on disk should continue itself.
 *
 * The Resume button is for the user choosing to pick up later. A server
 * dying mid-task is not the user's call — flashing the banner and waiting
 * for a click is how "everything is saved" still felt like a stop.
 *
 * Two doors in:
 *   - The route says `autoResume: true`. That is the server having checked
 *     the failure class itself (server-side: their 5xx, a dropped stream, a
 *     deadline — never a Stop, never a rate limit or a dead balance), so it
 *     is trusted for ANY provider, Ox included.
 *   - The client's own heuristic: a deadline-style error on the in-app Qwen
 *     sidecar. Kept local-only on purpose — Ox 429s and shared-pool
 *     timeouts are owned by the separate limit-resume agent, and looping
 *     them from here is the "every model generates forever and Stop does
 *     nothing" bug.
 *
 * Stop never reaches either door: a deliberate abort sends no error frame at
 * all, and `cancelAutoResumeRef` kills anything queued between the frame and
 * the re-post.
 */
export function shouldAutoResumeOnTimeout(input: {
  error?: string | null;
  autoResume?: boolean;
  hadWork: boolean;
  used: number;
  /**
   * Whether the main model is the in-app Qwen sidecar. Bounds the
   * CLIENT-SIDE heuristic only; an explicit `autoResume` from the route is
   * honoured regardless.
   */
  local?: boolean;
}): boolean {
  if (!input.hadWork) return false;
  if (input.used >= MAX_TIMEOUT_AUTO_RESUMES) return false;
  if (input.autoResume === true) return true;
  if (input.local === false) return false;
  return isTimeoutFailure(input.error ?? "");
}

/**
 * Abort a hung fetch before headers arrive, then let the body stream.
 *
 * Putting `AbortSignal.timeout()` on the fetch itself keeps the deadline
 * armed for the whole SSE body. A 27B thinking for five minutes then dies
 * with "The operation was aborted due to timeout" — that is a long
 * generation, not a hang. Clearing the timer once headers land is the
 * difference.
 */
export async function fetchUntilHeaders(
  makeRequest: (signal: AbortSignal) => Promise<Response>,
  timeoutMs: number,
  runSignal?: AbortSignal
): Promise<Response> {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);

  const onAbort = () => ac.abort();
  if (runSignal) {
    if (runSignal.aborted) {
      clearTimeout(timer);
      throw new DOMException("Aborted", "AbortError");
    }
    runSignal.addEventListener("abort", onAbort);
  }

  try {
    return await makeRequest(ac.signal);
  } catch (error) {
    if (timedOut) {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    runSignal?.removeEventListener("abort", onAbort);
  }
}

/** True for network-level failures, which are the most common transient case. */
export function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // A user pressing Stop is not a failure to retry.
  if (error.name === "AbortError" && !isTimeoutFailure(error)) return false;
  return (
    error.name === "TimeoutError" ||
    isTimeoutFailure(error) ||
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

function tenths(ms: number): string {
  return `${Math.round(Math.max(0, ms) / 100) / 10}`;
}

function sizeNote(inputChars?: number): string {
  if (typeof inputChars !== "number" || inputChars < 8_000) return "";
  return ` · ${(inputChars / 1000).toFixed(0)}k chars in`;
}

/**
 * Live label for the Ox / upstream banner.
 *
 * Split into phases so the line can spawn on a real wait and vanish the
 * instant tokens arrive, instead of sitting on a stale "retrying in 4.9s"
 * for ten seconds after the model has already started typing.
 */
export function formatUpstreamNotice(
  info: UpstreamNotice,
  nowMs = Date.now(),
  receivedAt = nowMs
): string | null {
  if (info.phase === "clear") return null;

  const host = info.host?.trim() || "the model";
  if (info.phase === "backoff") {
    const remaining = Math.max(0, (info.delayMs ?? 0) - (nowMs - receivedAt));
    const next = Math.min(info.attempt + 1, info.attempts);
    const reason = info.reason?.trim() || "unavailable";
    return `${reason} — retrying, try ${next} of ${info.attempts} in ${tenths(remaining)}s`;
  }

  const waited = info.waitedMs ?? Math.max(0, nowMs - receivedAt);
  const size = sizeNote(info.inputChars);
  if (waited < HIDE_ATTEMPT_BEFORE_MS && !info.reason) {
    return `Calling ${host} — try ${info.attempt} of ${info.attempts}${size}`;
  }
  const why = info.reason?.trim();
  const prefix = why ? `${why} — waiting on ${host}` : `Waiting on ${host}`;
  return `${prefix} — try ${info.attempt} of ${info.attempts}, ${tenths(waited)}s${size}`;
}

/**
 * What the UI should actually render right now.
 *
 * A healthy first attempt must not flash "Calling…" for 200ms and vanish.
 * A backoff or a named failure (503, empty stream) shows immediately.
 * `clear` and a brand-new attempt that has not sat long enough stay hidden.
 */
export function visibleUpstreamNotice(
  info: (UpstreamNotice & { receivedAt: number }) | null,
  nowMs: number,
  hideAttemptBeforeMs = HIDE_ATTEMPT_BEFORE_MS
): string | null {
  if (!info || info.phase === "clear") return null;
  // Only the first try stays quiet. A later try must replace the backoff
  // line immediately or the banner vanishes for two seconds mid-retry.
  if (
    info.phase === "attempt" &&
    info.attempt <= 1 &&
    !info.reason &&
    nowMs - info.receivedAt < hideAttemptBeforeMs
  ) {
    return null;
  }
  return formatUpstreamNotice(
    { ...info, waitedMs: nowMs - info.receivedAt },
    nowMs,
    info.receivedAt
  );
}

/**
 * Label shown while a transient failure is being retried.
 *
 * `attempt` is the try that just failed, so the user sees the *next* try
 * against the real total — `(1/2)` with `attempts: 3` looked like the
 * last retry when two were still left, which is why 503s read as "it
 * said retrying and then didn't".
 */
export function formatRetryNotice(info: RetryInfo): string {
  return (
    formatUpstreamNotice({
      phase: "backoff",
      attempt: info.attempt,
      attempts: info.attempts,
      delayMs: info.delayMs,
      reason: info.reason,
    }) ?? ""
  );
}

/**
 * Read one SSE chunk, or give up if the body stays silent.
 *
 * fetchWithRetry only times out waiting for HTTP headers. Zen/OpenRouter
 * often return 200 and then never send a token — that used to hang until
 * the 300s route ceiling, which is the "Test works, chat never loads,
 * no error" case.
 */
/**
 * Read one SSE chunk, or abort the moment Stop fires.
 *
 * `reader.read()` ignores `runSignal`. After headers land the body can sit
 * silent for minutes (Qwen thinking, Ox prefill) and the Stop button did
 * nothing — that is the infinite-generate loop.
 */
export async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  if (!signal) return reader.read();

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (chunk) => {
        signal.removeEventListener("abort", onAbort);
        resolve(chunk);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

export async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
  signal?: AbortSignal
): Promise<
  | { timedOut: true }
  | { timedOut: false; done: boolean; value?: Uint8Array }
> {
  if (ms <= 0) {
    const chunk = await reader.read();
    return { timedOut: false, done: chunk.done, value: chunk.value };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });

  let onAbort: (() => void) | undefined;
  const aborted =
    signal &&
    new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
    });

  try {
    const read = reader.read().then((chunk) => ({
      timedOut: false as const,
      done: chunk.done,
      value: chunk.value,
    }));
    return await (aborted ? Promise.race([read, timeout, aborted]) : Promise.race([read, timeout]));
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Honour a Retry-After header when the server sends one.
 *
 * Rate limiters know better than a fixed backoff how long to wait, and
 * ignoring the header tends to earn a longer ban. The wait is still
 * capped: OpenCode 503s sometimes send a multi-minute value, which
 * froze the UI on "retrying" until the user assumed nothing was happening.
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
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
    attempts = DEFAULT_RETRY.attempts,
    baseDelayMs = DEFAULT_RETRY.baseDelayMs,
    maxDelayMs = DEFAULT_RETRY.maxDelayMs,
    signal,
    onAttempt,
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

    onAttempt?.({ attempt, attempts });

    let response: Response | null = null;
    let reason = "";

    try {
      response = await makeRequest();
    } catch (error) {
      // Stop means stop — never retry past a deliberate cancellation.
      // A timeout abort is not Stop: some runtimes wrap TimeoutError as
      // AbortError with "aborted due to timeout".
      if (
        error instanceof Error &&
        error.name === "AbortError" &&
        !isTimeoutFailure(error)
      ) {
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
          : response.status === 503
            ? "inference unavailable"
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
    // Honour Retry-After, but never wait past the cap. A 120s header on a
    // Zen 503 looks exactly like "it said retrying and then hung".
    const waitMs = Math.min(maxDelayMs, suggested ?? backoff + jitter);

    onRetry?.({ attempt, attempts, delayMs: Math.round(waitMs), reason });

    // Release the unread body before waiting, or the socket stays pinned.
    if (response) await response.body?.cancel().catch(() => {});

    try {
      await sleep(waitMs, signal);
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

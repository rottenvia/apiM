const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs task() and, if it fails, retries it up to `retries` more times,
 * waiting `delayMs` between attempts. Resolves with the first success, or
 * rejects with the last error once all attempts have failed.
 */
export async function withRetry(task, { retries = 2, delayMs = 50 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(delayMs);
    }
  }
}

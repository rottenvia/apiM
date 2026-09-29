/**
 * Runs task(cb) and, if it fails, retries it up to `retries` more times,
 * waiting `delayMs` between attempts. callback(err, result) gets the first
 * success, or the last error once all attempts have failed.
 */
export function withRetry(task, { retries = 2, delayMs = 50 } = {}, callback) {
  let attempt = 0;
  function run() {
    attempt++;
    task((err, result) => {
      if (err && attempt <= retries) {
        setTimeout(run, delayMs);
      }
      if (err) return callback(err);
      callback(null, result);
    });
  }
  run();
}

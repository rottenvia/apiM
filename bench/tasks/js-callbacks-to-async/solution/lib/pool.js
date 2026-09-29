/**
 * Like Array.prototype.map, but the iterator is asynchronous and at most
 * `limit` iterators run at the same time. As soon as one finishes, the next
 * item is started.
 *
 *   iterator(item, index) -> Promise | value
 *   resolves to the results, in the same order as items
 *
 * If an iterator fails (rejects or throws), the returned promise rejects with
 * that first error and no further items are started; results of iterators
 * still running are ignored.
 */
export function mapLimit(items, limit, iterator) {
  return new Promise((resolve, reject) => {
    const results = new Array(items.length);
    let next = 0;
    let running = 0;
    let finished = 0;
    let failed = false;

    if (items.length === 0) return resolve(results);

    function launch() {
      while (!failed && running < limit && next < items.length) {
        const index = next++;
        running++;
        Promise.resolve()
          .then(() => iterator(items[index], index))
          .then(
            (value) => {
              running--;
              if (failed) return;
              results[index] = value;
              finished++;
              if (finished === items.length) resolve(results);
              else launch();
            },
            (err) => {
              running--;
              if (failed) return;
              failed = true;
              reject(err);
            },
          );
      }
    }
    launch();
  });
}

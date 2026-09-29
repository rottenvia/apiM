/**
 * Like Array.prototype.map, but the iterator is asynchronous and at most
 * `limit` iterators run at the same time. As soon as one finishes, the next
 * item is started.
 *
 *   iterator(item, index, cb)  -- cb(err, value)
 *   done(err, results)         -- results are in the same order as items
 *
 * If an iterator fails, done(err) is called with that first error and no
 * further items are started; results of iterators still running are ignored.
 */
export function mapLimit(items, limit, iterator, done) {
  const results = new Array(items.length);
  let next = 0;
  let running = 0;
  let finished = 0;
  let failed = false;

  if (items.length === 0) return done(null, results);

  function launch() {
    while (!failed && running < limit && next < items.length) {
      const index = next++;
      running++;
      iterator(items[index], index, (err, value) => {
        running--;
        if (failed) return;
        if (err) {
          failed = true;
          return done(err);
        }
        results[index] = value;
        finished++;
        if (finished === items.length) return done(null, results);
        launch();
      });
    }
  }
  launch();
}

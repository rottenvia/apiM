# debounce / throttle

`timing.js` exports `debounce(fn, wait, options?)` and
`throttle(fn, wait, options?)`. Both return a wrapped function; calling it
never invokes `fn` more than described below. When `fn` is invoked it gets
the `this` and the arguments of the call it stands for (the most recent call,
unless said otherwise). All times are in milliseconds.

## The clock option

Both functions accept `options.clock`, an object with three functions:

```js
{
  now(),                 // current time in ms
  setTimeout(cb, ms),    // run cb after ms; returns an id
  clearTimeout(id),      // cancel a timer created by this clock's setTimeout
}
```

All timing (reading the current time, scheduling, cancelling) must go through
the clock. When no clock is passed, use `Date.now`, `setTimeout` and
`clearTimeout` from the global scope. The clock's functions may be called
without `this` (e.g. `const { now } = clock`).

## Wrapped function API (both debounce and throttle)

- `wrapped(...args)` returns the value returned by the most recent invocation
  of `fn` so far (including one that happens during this very call), or
  `undefined` if `fn` has never been invoked.
- `wrapped.cancel()` drops the pending trailing invocation (if any) and resets
  the state, so the next call behaves like the very first one.
- `wrapped.flush()` if a trailing invocation is pending, performs it right
  now; then resets the state like `cancel()`. Returns the most recent result.
- `wrapped.pending()` is `true` while a trailing invocation is pending.

## debounce(fn, wait, { leading = false, trailing = true, maxWait, clock })

Calls are grouped into **bursts**. A call made when no burst is active starts
a new burst. Every call (the first one included) pushes the end of the burst
to `wait` ms after that call; when that moment is reached with no newer call,
the burst ends.

- `leading: true` — the first call of a burst invokes `fn` immediately.
- `trailing: true` — when the burst ends, `fn` is invoked with the most recent
  call's arguments, but only if there was a call in the burst that has not
  been followed by an invocation yet (a burst consisting of a single call
  that was already invoked on the leading edge is not invoked again).
- `maxWait` — (only relevant with `trailing: true`) caps how long `fn` can be
  postponed while the burst keeps going: once `maxWait` ms have passed since
  the last invocation of `fn` in the current burst (or since the burst's first
  call if there was none) and there has been a call since then, `fn` is
  invoked at that moment with the most recent call's arguments. The burst
  itself continues. `maxWait` smaller than `wait` behaves like `wait`.

Example, `wait = 50`, `maxWait = 80`, calls at t = 0, 30, 60, 90, 120:
invocations at t = 80 (with the args of the call at 60), t = 160 (call at
120) and none after that (the burst ends at 170 with nothing new).

## throttle(fn, wait, { leading = true, trailing = true, clock })

Throttling works in **windows** of `wait` ms. Every invocation of `fn` opens
a window that lasts `wait` ms from that moment.

- A call made while no window is open:
  - with `leading: true`, invokes `fn` immediately (which opens a window);
  - otherwise it becomes the pending call and a window opens at the time
    of that call.
- A call made while a window is open becomes the pending call (replacing
  any earlier pending call); with `trailing: false` it is simply dropped.
- When a window ends and there is a pending call (and `trailing` is true),
  `fn` is invoked with it right then — which opens a new window. Otherwise
  no window is open any more.

Example, `wait = 50`, calls at t = 0, 15, 30, 45, 60, 75, 90: invocations at
t = 0 (call at 0), t = 50 (call at 45) and t = 100 (call at 90); the window
opened at 100 ends at 150 with nothing pending.

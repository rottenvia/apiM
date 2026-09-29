// debounce / throttle — see TIMING.md for the exact behaviour.

const systemClock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export function debounce(fn, wait, options = {}) {
  const { leading = false, trailing = true, maxWait, clock = systemClock } = options;
  const { now, setTimeout: schedule, clearTimeout: unschedule } = clock;
  const maxW = maxWait === undefined ? null : Math.max(maxWait, wait);

  let active = false;
  let timer = null;
  let lastCallTime = 0;
  let anchor = 0; // last invocation in this burst, or the burst's first call
  let pendingCall = null; // { self, args } awaiting a trailing invocation
  let result;

  function invoke(call) {
    anchor = now();
    result = fn.apply(call.self, call.args);
    return result;
  }

  function reschedule() {
    if (timer !== null) unschedule(timer);
    let deadline = lastCallTime + wait;
    if (maxW !== null && pendingCall) deadline = Math.min(deadline, anchor + maxW);
    timer = schedule(onTimer, Math.max(0, deadline - now()));
  }

  function onTimer() {
    timer = null;
    const t = now();
    if (t >= lastCallTime + wait) {
      active = false;
      const call = pendingCall;
      pendingCall = null;
      if (call) invoke(call);
      return;
    }
    if (pendingCall && maxW !== null && t >= anchor + maxW) {
      const call = pendingCall;
      pendingCall = null;
      invoke(call);
    }
    reschedule();
  }

  function debounced(...args) {
    const call = { self: this, args };
    lastCallTime = now();
    if (!active) {
      active = true;
      anchor = lastCallTime;
      if (leading) invoke(call);
      else if (trailing) pendingCall = call;
    } else if (trailing) {
      pendingCall = call;
    }
    reschedule();
    return result;
  }

  function reset() {
    if (timer !== null) unschedule(timer);
    timer = null;
    active = false;
    pendingCall = null;
  }

  debounced.cancel = reset;
  debounced.flush = () => {
    const call = pendingCall;
    reset();
    if (call) invoke(call);
    return result;
  };
  debounced.pending = () => pendingCall !== null;
  return debounced;
}

export function throttle(fn, wait, options = {}) {
  const { leading = true, trailing = true, clock = systemClock } = options;
  const { setTimeout: schedule, clearTimeout: unschedule } = clock;

  let open = false;
  let timer = null;
  let pendingCall = null;
  let result;

  function openWindow() {
    open = true;
    if (timer !== null) unschedule(timer);
    timer = schedule(onWindowEnd, wait);
  }

  function invoke(call) {
    openWindow();
    result = fn.apply(call.self, call.args);
    return result;
  }

  function onWindowEnd() {
    timer = null;
    open = false;
    const call = pendingCall;
    pendingCall = null;
    if (call) invoke(call);
  }

  function throttled(...args) {
    const call = { self: this, args };
    if (!open) {
      if (leading) invoke(call);
      else if (trailing) {
        pendingCall = call;
        openWindow();
      }
    } else if (trailing) {
      pendingCall = call;
    }
    return result;
  }

  function reset() {
    if (timer !== null) unschedule(timer);
    timer = null;
    open = false;
    pendingCall = null;
  }

  throttled.cancel = reset;
  throttled.flush = () => {
    const call = pendingCall;
    reset();
    if (call) result = fn.apply(call.self, call.args);
    return result;
  };
  throttled.pending = () => pendingCall !== null;
  return throttled;
}

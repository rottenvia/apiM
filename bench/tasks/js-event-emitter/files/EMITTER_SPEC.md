# EventEmitter spec

`emitter.js` exports a class `EventEmitter`. Event names may be any string
or symbol. Every method that registers or removes listeners returns the
emitter itself so calls can be chained.

## on(event, listener)

Adds `listener` to the end of the listener list for `event`. The same
function may be added more than once; it is then called once per
registration. Throws a `TypeError` if `listener` is not a function.

## once(event, listener)

Like `on`, but the registration is removed right before the listener is
called for the first time, so it runs at most once — even if the listener
itself emits the same event again. `off(event, listener)` with the original
function removes a pending `once` registration, and `listeners(event)`
reports the original function.

## off(event, listener)

Removes one registration of `listener` for `event`: the most recently
added one if it was added several times. Does nothing if it is not
registered.

## removeAllListeners([event])

Removes all listeners for `event`, or for every event when called without
arguments.

## emit(event, ...args)

Calls the listeners registered for `event` synchronously, in the order they
were registered, with `args` as arguments and `this` set to the emitter.
Returns `true` if the event had listeners, `false` otherwise.

Changes made while an emit is running:

- A listener added during an emit is **not** called by that emit (it will be
  called by the next one).
- A listener registration removed during an emit, before its turn came, is
  **not** called by that emit.

If a listener throws, the exception propagates out of `emit` and the
remaining listeners for that emit are not called.

### The `error` event

If `'error'` is emitted and there are no listeners for it, `emit` throws:
the argument itself if it is an `Error`, otherwise a new `Error` whose
message contains `String(argument)`.

## listenerCount(event)

The number of registrations currently in place for `event`.

## listeners(event)

A new array with the registered listener functions for `event`, in
registration order (the original functions for `once` registrations).
Mutating the returned array does not affect the emitter.

// Minimal EventEmitter for the browser bundle. See EMITTER_SPEC.md.

export class EventEmitter {
  on(event, listener) {
    throw new Error("not implemented");
  }

  once(event, listener) {
    throw new Error("not implemented");
  }

  off(event, listener) {
    throw new Error("not implemented");
  }

  removeAllListeners(event) {
    throw new Error("not implemented");
  }

  emit(event, ...args) {
    throw new Error("not implemented");
  }

  listenerCount(event) {
    throw new Error("not implemented");
  }

  listeners(event) {
    throw new Error("not implemented");
  }
}

// Minimal EventEmitter for the browser bundle. See EMITTER_SPEC.md.

export class EventEmitter {
  #events = new Map(); // event -> array of { fn, once, removed }

  #list(event) {
    return this.#events.get(event) ?? [];
  }

  #add(event, fn, once) {
    if (typeof fn !== "function") throw new TypeError("listener must be a function");
    const list = this.#events.get(event);
    const entry = { fn, once, removed: false };
    if (list) list.push(entry);
    else this.#events.set(event, [entry]);
    return this;
  }

  #remove(event, entry) {
    const list = this.#events.get(event);
    if (!list) return;
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
    entry.removed = true;
    if (list.length === 0) this.#events.delete(event);
  }

  on(event, listener) {
    return this.#add(event, listener, false);
  }

  once(event, listener) {
    return this.#add(event, listener, true);
  }

  off(event, listener) {
    const list = this.#list(event);
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].fn === listener) {
        this.#remove(event, list[i]);
        break;
      }
    }
    return this;
  }

  removeAllListeners(event) {
    const events = arguments.length === 0 ? [...this.#events.keys()] : [event];
    for (const e of events) {
      for (const entry of this.#list(e)) entry.removed = true;
      this.#events.delete(e);
    }
    return this;
  }

  emit(event, ...args) {
    const list = this.#list(event);
    if (list.length === 0) {
      if (event === "error") {
        const err = args[0];
        throw err instanceof Error ? err : new Error(`Unhandled 'error' event: ${String(err)}`);
      }
      return false;
    }
    for (const entry of [...list]) {
      if (entry.removed) continue;
      if (entry.once) this.#remove(event, entry);
      entry.fn.apply(this, args);
    }
    return true;
  }

  listenerCount(event) {
    return this.#list(event).length;
  }

  listeners(event) {
    return this.#list(event).map((e) => e.fn);
  }
}

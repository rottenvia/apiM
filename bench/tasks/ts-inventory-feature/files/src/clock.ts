import type { Clock } from "./types.ts";

export const systemClock: Clock = { now: () => Date.now() };

/** A clock you move by hand — for tests. */
export class ManualClock implements Clock {
  #t: number;

  constructor(start = 0) {
    this.#t = start;
  }

  now(): number {
    return this.#t;
  }

  advance(ms: number): void {
    this.#t += ms;
  }

  set(t: number): void {
    this.#t = t;
  }
}

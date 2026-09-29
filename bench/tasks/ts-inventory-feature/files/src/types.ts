export type Sku = string;

export interface Product {
  sku: Sku;
  name: string;
  /** When available stock falls to this level or below, it's time to reorder. */
  reorderLevel: number;
}

export interface Clock {
  /** Milliseconds since the epoch (or any monotonic origin). */
  now(): number;
}

export type HistoryKind = "receive" | "ship" | "adjust";

export interface HistoryEntry {
  at: number;
  sku: Sku;
  kind: HistoryKind;
  /** Signed change in on-hand quantity. */
  qty: number;
  note?: string;
}

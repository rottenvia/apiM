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

export interface Reservation {
  id: string;
  sku: Sku;
  qty: number;
  createdAt: number;
  expiresAt: number;
}

export type StockStatus = "out" | "low" | "ok";

export interface StockReportRow {
  sku: Sku;
  name: string;
  onHand: number;
  reserved: number;
  available: number;
  status: StockStatus;
}

import type { Clock, HistoryEntry, HistoryKind, Product, Reservation, Sku, StockReportRow } from "./types.ts";
import { systemClock } from "./clock.ts";
import {
  InsufficientStockError,
  InvalidQuantityError,
  InventoryError,
  ReservationExpiredError,
  ReservationNotFoundError,
  UnknownProductError,
} from "./errors.ts";

export class InventoryService {
  #clock: Clock;
  #products = new Map<Sku, Product>();
  #onHand = new Map<Sku, number>();
  #history: HistoryEntry[] = [];
  #reservations = new Map<string, Reservation>();
  #nextId = 1;

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  addProduct(product: Product): void {
    if (this.#products.has(product.sku)) throw new InventoryError(`duplicate product: ${product.sku}`);
    this.#products.set(product.sku, { ...product });
    this.#onHand.set(product.sku, 0);
  }

  products(): Product[] {
    return [...this.#products.values()].map((p) => ({ ...p }));
  }

  /** Units physically in the warehouse. */
  getStock(sku: Sku): number {
    this.#product(sku);
    return this.#onHand.get(sku) ?? 0;
  }

  /** Units on hand that are not held by an active reservation. */
  getAvailable(sku: Sku): number {
    return this.getStock(sku) - this.#reserved(sku);
  }

  receive(sku: Sku, qty: number): number {
    this.#product(sku);
    this.#checkQty(qty);
    return this.#change(sku, qty, "receive");
  }

  ship(sku: Sku, qty: number): number {
    this.#product(sku);
    this.#checkQty(qty);
    const available = this.getAvailable(sku);
    if (qty > available) throw new InsufficientStockError(sku, qty, available);
    return this.#change(sku, -qty, "ship");
  }

  /** Stock-take correction; may go either way but never below zero. */
  adjust(sku: Sku, delta: number, note: string): number {
    this.#product(sku);
    if (!Number.isInteger(delta)) throw new InvalidQuantityError(delta);
    const next = this.getStock(sku) + delta;
    if (next < 0) throw new InventoryError(`adjustment would make ${sku} negative`);
    return this.#change(sku, delta, "adjust", note);
  }

  reserve(sku: Sku, qty: number, ttlMs: number): Reservation {
    this.#product(sku);
    this.#checkQty(qty);
    if (!(ttlMs > 0)) throw new InventoryError(`ttlMs must be positive, got ${ttlMs}`);
    const available = this.getAvailable(sku);
    if (qty > available) throw new InsufficientStockError(sku, qty, available);
    const now = this.#clock.now();
    const r: Reservation = { id: `R${this.#nextId++}`, sku, qty, createdAt: now, expiresAt: now + ttlMs };
    this.#reservations.set(r.id, r);
    return { ...r };
  }

  release(id: string): boolean {
    const r = this.#reservations.get(id);
    if (!r || this.#expired(r)) return false;
    this.#reservations.delete(id);
    return true;
  }

  commit(id: string): number {
    const r = this.#reservations.get(id);
    if (!r) throw new ReservationNotFoundError(id);
    // Expired reservations stay in the map so commit() can tell "expired" from "unknown".
    if (this.#expired(r)) throw new ReservationExpiredError(id);
    this.#reservations.delete(id);
    return this.#change(r.sku, -r.qty, "ship", `reservation ${id}`);
  }

  activeReservations(sku?: Sku): Reservation[] {
    return [...this.#reservations.values()]
      .filter((r) => (sku === undefined || r.sku === sku) && !this.#expired(r))
      .map((r) => ({ ...r }));
  }

  stockReport(): StockReportRow[] {
    return [...this.#products.values()]
      .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0))
      .map((p) => {
        const onHand = this.getStock(p.sku);
        const reserved = this.#reserved(p.sku);
        const available = onHand - reserved;
        const status = available <= 0 ? "out" : available <= p.reorderLevel ? "low" : "ok";
        return { sku: p.sku, name: p.name, onHand, reserved, available, status };
      });
  }

  history(sku?: Sku): HistoryEntry[] {
    return this.#history.filter((h) => sku === undefined || h.sku === sku).map((h) => ({ ...h }));
  }

  #expired(r: Reservation): boolean {
    return this.#clock.now() >= r.expiresAt;
  }

  #reserved(sku: Sku): number {
    let total = 0;
    for (const r of this.#reservations.values()) if (r.sku === sku && !this.#expired(r)) total += r.qty;
    return total;
  }

  #product(sku: Sku): Product {
    const p = this.#products.get(sku);
    if (!p) throw new UnknownProductError(sku);
    return p;
  }

  #checkQty(qty: number): void {
    if (!Number.isInteger(qty) || qty <= 0) throw new InvalidQuantityError(qty);
  }

  #change(sku: Sku, delta: number, kind: HistoryKind, note?: string): number {
    const next = (this.#onHand.get(sku) ?? 0) + delta;
    this.#onHand.set(sku, next);
    const entry: HistoryEntry = { at: this.#clock.now(), sku, kind, qty: delta };
    if (note !== undefined) entry.note = note;
    this.#history.push(entry);
    return next;
  }
}

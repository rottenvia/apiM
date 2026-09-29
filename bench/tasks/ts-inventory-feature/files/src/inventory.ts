import type { Clock, HistoryEntry, HistoryKind, Product, Sku } from "./types.ts";
import { systemClock } from "./clock.ts";
import { InsufficientStockError, InvalidQuantityError, InventoryError, UnknownProductError } from "./errors.ts";

export class InventoryService {
  #clock: Clock;
  #products = new Map<Sku, Product>();
  #onHand = new Map<Sku, number>();
  #history: HistoryEntry[] = [];

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

  receive(sku: Sku, qty: number): number {
    this.#product(sku);
    this.#checkQty(qty);
    return this.#change(sku, qty, "receive");
  }

  ship(sku: Sku, qty: number): number {
    this.#product(sku);
    this.#checkQty(qty);
    const onHand = this.getStock(sku);
    if (qty > onHand) throw new InsufficientStockError(sku, qty, onHand);
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

  history(sku?: Sku): HistoryEntry[] {
    return this.#history.filter((h) => sku === undefined || h.sku === sku).map((h) => ({ ...h }));
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

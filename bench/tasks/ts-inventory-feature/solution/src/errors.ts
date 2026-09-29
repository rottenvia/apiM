export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnknownProductError extends InventoryError {
  readonly sku: string;

  constructor(sku: string) {
    super(`unknown product: ${sku}`);
    this.sku = sku;
  }
}

export class InvalidQuantityError extends InventoryError {
  readonly qty: number;

  constructor(qty: number) {
    super(`quantity must be a positive integer, got ${qty}`);
    this.qty = qty;
  }
}

export class InsufficientStockError extends InventoryError {
  readonly sku: string;
  readonly requested: number;
  readonly available: number;

  constructor(sku: string, requested: number, available: number) {
    super(`not enough ${sku}: requested ${requested}, available ${available}`);
    this.sku = sku;
    this.requested = requested;
    this.available = available;
  }
}

export class ReservationNotFoundError extends InventoryError {
  readonly reservationId: string;

  constructor(id: string) {
    super(`no active reservation ${id}`);
    this.reservationId = id;
  }
}

export class ReservationExpiredError extends InventoryError {
  readonly reservationId: string;

  constructor(id: string) {
    super(`reservation ${id} has expired`);
    this.reservationId = id;
  }
}

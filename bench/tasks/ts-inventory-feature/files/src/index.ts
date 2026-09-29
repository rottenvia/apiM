export type { Clock, HistoryEntry, HistoryKind, Product, Sku } from "./types.ts";
export { systemClock, ManualClock } from "./clock.ts";
export { InventoryError, UnknownProductError, InvalidQuantityError, InsufficientStockError } from "./errors.ts";
export { InventoryService } from "./inventory.ts";

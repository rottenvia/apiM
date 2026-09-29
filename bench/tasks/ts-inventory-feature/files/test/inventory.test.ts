import { test } from "node:test";
import assert from "node:assert/strict";
import { InventoryService, ManualClock, InsufficientStockError, UnknownProductError, InvalidQuantityError } from "../src/index.ts";

function setup() {
  const clock = new ManualClock(1_000);
  const inv = new InventoryService(clock);
  inv.addProduct({ sku: "BOLT-M4", name: "M4 bolt", reorderLevel: 50 });
  inv.addProduct({ sku: "NUT-M4", name: "M4 nut", reorderLevel: 50 });
  return { clock, inv };
}

test("receive and ship", () => {
  const { inv } = setup();
  assert.equal(inv.receive("BOLT-M4", 100), 100);
  assert.equal(inv.ship("BOLT-M4", 30), 70);
  assert.equal(inv.getStock("BOLT-M4"), 70);
});

test("cannot ship more than on hand", () => {
  const { inv } = setup();
  inv.receive("NUT-M4", 5);
  assert.throws(() => inv.ship("NUT-M4", 6), InsufficientStockError);
});

test("validation", () => {
  const { inv } = setup();
  assert.throws(() => inv.receive("NOPE", 1), UnknownProductError);
  assert.throws(() => inv.receive("NUT-M4", 0), InvalidQuantityError);
  assert.throws(() => inv.receive("NUT-M4", 1.5), InvalidQuantityError);
});

test("history", () => {
  const { inv, clock } = setup();
  inv.receive("BOLT-M4", 10);
  clock.advance(500);
  inv.ship("BOLT-M4", 4);
  assert.deepEqual(inv.history("BOLT-M4"), [
    { at: 1000, sku: "BOLT-M4", kind: "receive", qty: 10 },
    { at: 1500, sku: "BOLT-M4", kind: "ship", qty: -4 },
  ]);
});

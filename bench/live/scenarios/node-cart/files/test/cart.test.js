import assert from "node:assert/strict";
import { test } from "node:test";

import { discount, format, subtotal, total } from "../src/cart.js";

const items = [
  { qty: 2, priceCents: 450 },
  { qty: 1, priceCents: 99 },
];

test("subtotal", () => {
  assert.equal(subtotal(items), 999);
});

test("a discount's half cent goes up", () => {
  assert.equal(discount(999, 50), 500);
  assert.equal(total(items, 50), 499);
});

test("format", () => {
  assert.equal(format(999), "9.99");
});

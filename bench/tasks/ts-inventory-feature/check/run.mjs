// Runs under `node --experimental-strip-types`; imports the agent's src/index.ts.
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

let cases = 0;
let passed = 0;
function test(label, fn) {
  cases++;
  try {
    fn();
    passed++;
  } catch (e) {
    console.log(`FAIL ${label}: ${String(e?.message ?? e).split("\n").slice(0, 3).join(" ")}`);
  }
}

let mod;
try {
  mod = await import(pathToFileURL(path.resolve("src/index.ts")).href);
} catch (e) {
  console.log(`FAIL src/index.ts does not load with --experimental-strip-types: ${String(e?.message ?? e).split("\n")[0]}`);
  console.log("SCORE 0/1");
  process.exit(1);
}
const { InventoryService } = mod;

function throwsNamed(fn, name) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `expected ${name} to be thrown, nothing was thrown`);
  const cls = mod[name];
  const ok = (typeof cls === "function" && err instanceof cls) || err?.name === name || err?.constructor?.name === name;
  assert.ok(ok, `expected ${name}, got ${err?.name}: ${err?.message}`);
  return err;
}

function setup() {
  let t = 10_000;
  const clock = { now: () => t };
  const inv = new InventoryService(clock);
  inv.addProduct({ sku: "C-300", name: "Clamp", reorderLevel: 0 });
  inv.addProduct({ sku: "A-100", name: "Anchor", reorderLevel: 5 });
  inv.addProduct({ sku: "B-200", name: "Bracket", reorderLevel: 10 });
  inv.receive("A-100", 20);
  inv.receive("B-200", 8);
  return { inv, advance: (ms) => (t += ms), at: (ms) => (t = ms), now: () => t };
}

test("new error classes are exported from src/index.ts", () => {
  for (const name of ["ReservationExpiredError", "ReservationNotFoundError", "InsufficientStockError", "UnknownProductError", "InvalidQuantityError"]) {
    assert.equal(typeof mod[name], "function", `${name} is not exported`);
  }
});

test("existing API still works", () => {
  const { inv, advance } = setup();
  assert.equal(inv.getStock("A-100"), 20);
  advance(5);
  assert.equal(inv.ship("A-100", 3), 17);
  throwsNamed(() => inv.ship("B-200", 9), "InsufficientStockError");
  const h = inv.history("A-100");
  assert.deepEqual(h.map((e) => [e.kind, e.qty, e.at]), [["receive", 20, 10000], ["ship", -3, 10005]]);
  throwsNamed(() => inv.receive("NOPE", 1), "UnknownProductError");
});

test("reserve returns a reservation and holds stock", () => {
  const { inv } = setup();
  const r = inv.reserve("A-100", 5, 60_000);
  assert.equal(typeof r.id, "string");
  assert.ok(r.id.length > 0);
  assert.equal(r.sku, "A-100");
  assert.equal(r.qty, 5);
  assert.equal(r.createdAt, 10_000);
  assert.equal(r.expiresAt, 70_000);
  assert.equal(inv.getStock("A-100"), 20, "reserved units are still on hand");
  assert.equal(inv.getAvailable("A-100"), 15);
});

test("reserve validates sku, quantity and availability", () => {
  const { inv } = setup();
  throwsNamed(() => inv.reserve("NOPE", 1, 1000), "UnknownProductError");
  for (const q of [0, -2, 1.5]) throwsNamed(() => inv.reserve("A-100", q, 1000), "InvalidQuantityError");
  throwsNamed(() => inv.reserve("A-100", 21, 1000), "InsufficientStockError");
  inv.reserve("A-100", 15, 1000);
  throwsNamed(() => inv.reserve("A-100", 6, 1000), "InsufficientStockError");
  inv.reserve("A-100", 5, 1000);
  assert.equal(inv.getAvailable("A-100"), 0);
  throwsNamed(() => inv.reserve("C-300", 1, 1000), "InsufficientStockError");
});

test("ship never takes reserved units", () => {
  const { inv } = setup();
  inv.reserve("A-100", 15, 60_000);
  throwsNamed(() => inv.ship("A-100", 6), "InsufficientStockError");
  assert.equal(inv.getStock("A-100"), 20);
  assert.equal(inv.ship("A-100", 5), 15);
  assert.equal(inv.getAvailable("A-100"), 0);
  throwsNamed(() => inv.ship("A-100", 1), "InsufficientStockError");
});

test("release gives the units back once", () => {
  const { inv } = setup();
  const r = inv.reserve("A-100", 7, 60_000);
  assert.equal(inv.release(r.id), true);
  assert.equal(inv.getAvailable("A-100"), 20);
  assert.equal(inv.release(r.id), false);
  assert.equal(inv.release("does-not-exist"), false);
  assert.equal(inv.getAvailable("A-100"), 20);
});

test("commit ships the reserved units", () => {
  const { inv, advance } = setup();
  const r = inv.reserve("A-100", 4, 60_000);
  advance(1000);
  assert.equal(inv.commit(r.id), 16);
  assert.equal(inv.getStock("A-100"), 16);
  assert.equal(inv.getAvailable("A-100"), 16);
  const last = inv.history("A-100").at(-1);
  assert.equal(last.kind, "ship");
  assert.equal(last.qty, -4);
  assert.equal(last.at, 11_000);
  throwsNamed(() => inv.commit(r.id), "ReservationNotFoundError");
  assert.equal(inv.release(r.id), false);
  throwsNamed(() => inv.commit("does-not-exist"), "ReservationNotFoundError");
  const r2 = inv.reserve("A-100", 1, 60_000);
  inv.release(r2.id);
  throwsNamed(() => inv.commit(r2.id), "ReservationNotFoundError");
});

test("reservation expires exactly at expiresAt", () => {
  const { inv, at } = setup();
  const r = inv.reserve("A-100", 10, 1000);
  at(10_999);
  assert.equal(inv.getAvailable("A-100"), 10);
  assert.equal(inv.activeReservations("A-100").length, 1);
  at(11_000);
  assert.equal(inv.getAvailable("A-100"), 20);
  assert.deepEqual(inv.activeReservations("A-100"), []);
  assert.equal(inv.release(r.id), false);
});

test("committing an expired reservation throws ReservationExpiredError and ships nothing", () => {
  const { inv, advance } = setup();
  const r = inv.reserve("A-100", 10, 1000);
  advance(5000);
  inv.getAvailable("A-100");
  inv.stockReport();
  inv.activeReservations();
  throwsNamed(() => inv.commit(r.id), "ReservationExpiredError");
  assert.equal(inv.getStock("A-100"), 20);
  assert.equal(inv.history("A-100").length, 1);
});

test("expired reservations free stock for others (no timers needed)", () => {
  const { inv, advance } = setup();
  inv.reserve("A-100", 20, 500);
  throwsNamed(() => inv.reserve("A-100", 1, 500), "InsufficientStockError");
  throwsNamed(() => inv.ship("A-100", 1), "InsufficientStockError");
  advance(500);
  const r = inv.reserve("A-100", 20, 500);
  assert.equal(r.createdAt, 10_500);
  advance(499);
  throwsNamed(() => inv.ship("A-100", 1), "InsufficientStockError");
  advance(1);
  assert.equal(inv.ship("A-100", 20), 0);
});

test("reservation ids are unique", () => {
  const { inv } = setup();
  inv.receive("C-300", 100);
  const ids = new Set();
  for (let i = 0; i < 60; i++) ids.add(inv.reserve("C-300", 1, 10_000).id);
  assert.equal(ids.size, 60);
  assert.equal(inv.getAvailable("C-300"), 40);
});

test("activeReservations lists what still holds stock", () => {
  const { inv, advance } = setup();
  const a = inv.reserve("A-100", 2, 1000);
  const b = inv.reserve("B-200", 3, 5000);
  const c = inv.reserve("A-100", 4, 5000);
  const d = inv.reserve("A-100", 1, 5000);
  inv.release(d.id);
  const all = inv.activeReservations();
  assert.deepEqual(all.map((r) => r.id).sort(), [a.id, b.id, c.id].sort());
  const onlyA = inv.activeReservations("A-100");
  assert.deepEqual(onlyA.map((r) => r.id).sort(), [a.id, c.id].sort());
  const cc = onlyA.find((r) => r.id === c.id);
  assert.equal(cc.qty, 4);
  assert.equal(cc.sku, "A-100");
  assert.equal(cc.expiresAt, 15_000);
  advance(1000);
  assert.deepEqual(inv.activeReservations("A-100").map((r) => r.id), [c.id]);
  inv.commit(b.id);
  assert.deepEqual(inv.activeReservations().map((r) => r.id), [c.id]);
});

test("stockReport rows, order and statuses", () => {
  const { inv, advance } = setup();
  inv.addProduct({ sku: "D-400", name: "Dowel", reorderLevel: 3 });
  inv.receive("D-400", 50);
  inv.reserve("A-100", 15, 1000); // A: on hand 20, available 5 -> low (reorderLevel 5)
  inv.reserve("B-200", 8, 5000); // B: available 0 -> out
  inv.reserve("D-400", 40, 5000); // D: available 10 -> ok
  const pick = (rows) => rows.map((r) => ({ sku: r.sku, name: r.name, onHand: r.onHand, reserved: r.reserved, available: r.available, status: r.status }));
  assert.deepEqual(pick(inv.stockReport()), [
    { sku: "A-100", name: "Anchor", onHand: 20, reserved: 15, available: 5, status: "low" },
    { sku: "B-200", name: "Bracket", onHand: 8, reserved: 8, available: 0, status: "out" },
    { sku: "C-300", name: "Clamp", onHand: 0, reserved: 0, available: 0, status: "out" },
    { sku: "D-400", name: "Dowel", onHand: 50, reserved: 40, available: 10, status: "ok" },
  ]);
  advance(1000); // A's reservation expires
  inv.ship("D-400", 7); // D available 3 -> low
  assert.deepEqual(pick(inv.stockReport()), [
    { sku: "A-100", name: "Anchor", onHand: 20, reserved: 0, available: 20, status: "ok" },
    { sku: "B-200", name: "Bracket", onHand: 8, reserved: 8, available: 0, status: "out" },
    { sku: "C-300", name: "Clamp", onHand: 0, reserved: 0, available: 0, status: "out" },
    { sku: "D-400", name: "Dowel", onHand: 43, reserved: 40, available: 3, status: "low" },
  ]);
});

test("services do not share reservations", () => {
  const one = setup().inv;
  const two = setup().inv;
  one.reserve("A-100", 20, 1000);
  assert.equal(two.getAvailable("A-100"), 20);
});

console.log(`SCORE ${passed}/${cases}`);
process.exit(passed === cases ? 0 : 1);

"""Build shop.db, a small sample of the shop's order database.

    python3 build_db.py [PATH]      (default: shop.db)

The data is generated deterministically, so every run builds the same database.
"""
import os
import sqlite3
import sys

SCHEMA = """
CREATE TABLE customers (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    country     TEXT NOT NULL,
    signup_date TEXT NOT NULL,              -- YYYY-MM-DD
    referred_by INTEGER REFERENCES customers(id)   -- NULL if not referred
);
CREATE TABLE products (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    category    TEXT,                       -- NULL if not categorised yet
    price_cents INTEGER NOT NULL            -- current list price
);
CREATE TABLE orders (
    id          INTEGER PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id),  -- NULL for guest checkouts
    order_date  TEXT NOT NULL,              -- 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS'
    status      TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'cancelled', 'refunded'))
);
CREATE TABLE order_items (
    order_id         INTEGER NOT NULL REFERENCES orders(id),
    product_id       INTEGER NOT NULL REFERENCES products(id),
    quantity         INTEGER NOT NULL,
    unit_price_cents INTEGER NOT NULL,      -- price actually charged per unit
    PRIMARY KEY (order_id, product_id)
);
"""


class Rand:
    """Tiny LCG so the data never depends on the Python version."""

    def __init__(self, seed):
        self.state = seed

    def next(self):
        self.state = (self.state * 6364136223846793005 + 1442695040888963407) % 2 ** 64
        return self.state >> 33

    def below(self, n):
        return self.next() % n

    def pick(self, seq):
        return seq[self.below(len(seq))]


FIRST = ["Ana", "Ben", "Chen", "Dara", "Eli", "Fay", "Gus", "Hana", "Ivo", "Jun", "Kai", "Lea", "Mo", "Nia", "Oto"]
LAST = ["Silva", "Okafor", "Novak", "Berg", "Rossi", "Kim", "Moreau", "Haddad", "Ito", "Walsh"]
COUNTRIES = ["Brazil", "Canada", "France", "Germany", "Japan", "Kenya", "Norway", "Spain"]
PRODUCTS = [
    ("Arabica Beans 1kg", "coffee", 2400), ("Espresso Blend 500g", "coffee", 1450), ("Decaf 250g", "coffee", 890),
    ("Green Tea 100g", "tea", 750), ("Earl Grey 100g", "tea", 690), ("Chai Mix", "tea", 820),
    ("Pour-over Kettle", "equipment", 5900), ("Burr Grinder", "equipment", 12900), ("French Press", "equipment", 3400),
    ("Paper Filters x100", "supplies", 450), ("Descaler", "supplies", 980), ("Cleaning Tablets", "supplies", 1150),
    ("Travel Mug", "merch", 1800), ("Logo T-shirt", "merch", 2200), ("Tote Bag", "merch", 1200),
    ("Gift Card 25", None, 2500), ("Mystery Box", None, 3900), ("Sample Pack", None, 1500),
    ("Milk Frother", "equipment", 2900), ("Cold Brew Jar", "equipment", 2600),
]


def build(path):
    if os.path.exists(path):
        os.remove(path)
    db = sqlite3.connect(path)
    db.executescript(SCHEMA)
    r = Rand(20240601)

    customers = []
    for cid in range(1, 71):
        name = f"{r.pick(FIRST)} {r.pick(LAST)} {cid}"
        country = r.pick(COUNTRIES)
        signup = f"{2022 + r.below(3)}-{1 + r.below(12):02d}-{1 + r.below(28):02d}"
        referred = 1 + r.below(cid - 1) if cid > 5 and r.below(10) < 3 else None
        customers.append((cid, name, country, signup, referred))
    db.executemany("INSERT INTO customers VALUES (?, ?, ?, ?, ?)", customers)
    db.executemany("INSERT INTO products (name, category, price_cents) VALUES (?, ?, ?)", PRODUCTS)

    statuses = ["completed"] * 7 + ["cancelled", "refunded", "pending"]
    orders, items = [], []
    for oid in range(1, 451):
        roll = r.below(20)
        # customers 61-70 never order; about one order in ten is a guest checkout
        customer = None if roll < 2 else 1 + r.below(60)
        year = r.pick([2023, 2024, 2024, 2025])
        date = f"{year}-{1 + r.below(12):02d}-{1 + r.below(28):02d}"
        if r.below(4) == 0:
            date += f" {r.below(24):02d}:{r.below(60):02d}:{r.below(60):02d}"
        status = r.pick(statuses)
        orders.append((oid, customer, date, status))
        chosen = set()
        for _ in range(0 if r.below(40) == 0 else 1 + r.below(4)):
            pid = 1 + r.below(len(PRODUCTS))
            if pid in chosen:
                continue
            chosen.add(pid)
            price = PRODUCTS[pid - 1][2]
            charged = price - price * r.below(4) * 5 // 100  # up to 15% off
            items.append((oid, pid, 1 + r.below(3), charged))
    # a few orders that came in through the wholesale and phone channels
    manual = [
        (451, 62, "2024-12-31 18:45:12", "completed", [(6, 9, 820), (10, 2, 450)]),
        (452, 63, "2024-06-15", "completed", [(6, 20, 697)]),
        (453, 70, "2024-03-02", "cancelled", [(6, 3, 820), (8, 1, 12900)]),
        (454, 61, "2025-02-10 09:12:44", "pending", [(13, 1, 1800)]),
        (455, 64, "2024-08-19", "refunded", [(3, 2, 890)]),
        (456, None, "2025-01-01 00:10:00", "completed", [(15, 1, 1200)]),
        (457, 5, "2024-01-01 07:30:00", "completed", [(16, 2, 2500)]),
    ]
    for oid, customer, date, status, lines in manual:
        orders.append((oid, customer, date, status))
        items.extend((oid, pid, qty, price) for pid, qty, price in lines)
    db.executemany("INSERT INTO orders VALUES (?, ?, ?, ?)", orders)
    db.executemany("INSERT INTO order_items VALUES (?, ?, ?, ?)", items)
    db.commit()
    db.close()


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "shop.db")

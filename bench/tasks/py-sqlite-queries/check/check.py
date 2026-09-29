"""Hidden grader for py-sqlite-queries: recompute every answer from a fresh database."""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))

tmp = tempfile.mkdtemp(prefix="shopdb-")
db_path = os.path.join(tmp, "shop.db")
subprocess.run([sys.executable, os.path.join(HERE, "build_db.py"), db_path], check=True, timeout=60)
db = sqlite3.connect(db_path)
customers = db.execute("SELECT id, country FROM customers").fetchall()
products = dict(db.execute("SELECT id, name FROM products").fetchall())
category = dict(db.execute("SELECT id, category FROM products").fetchall())
orders = db.execute("SELECT id, customer_id, order_date, status FROM orders").fetchall()
items = db.execute("SELECT order_id, product_id, quantity, unit_price_cents FROM order_items").fetchall()
db.close()

completed = {oid: (cust, date) for oid, cust, date, status in orders if status == "completed"}
value = {oid: 0 for oid in completed}
units = Counter()
by_cat = defaultdict(int)
for oid, pid, qty, price in items:
    if oid in completed:
        value[oid] += qty * price
        units[products[pid]] += qty
        by_cat[category[pid] if category[pid] is not None else "Uncategorized"] += qty * price

q1 = sum(v for oid, v in value.items() if completed[oid][1][:4] == "2024")
buyers = {cust for cust, _ in completed.values() if cust is not None}
per_country = Counter(country for cid, country in customers if cid in buyers)
best = max(per_country.values())
q2 = sorted(c for c, n in per_country.items() if n == best)
q3 = sum(1 for cid, _ in customers if cid not in buyers)
vals = sorted(value.values())
mid = len(vals) // 2
q4 = vals[mid] if len(vals) % 2 else (vals[mid - 1] + vals[mid]) / 2
q5 = [name for name, _ in sorted(units.items(), key=lambda kv: (-kv[1], kv[0]))[:3]]
q6 = dict(by_cat)
want = {"q1": q1, "q2": q2, "q3": q3, "q4": q4, "q5": q5, "q6": q6}


def num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


if not os.path.exists("answers.json"):
    print("FAIL answers.json was not written")
    print("SCORE 0/6")
    sys.exit(1)
try:
    with open("answers.json") as f:
        got = json.load(f)
    assert isinstance(got, dict)
except Exception as e:  # noqa: BLE001
    print(f"FAIL answers.json is not a JSON object: {e}")
    print("SCORE 0/6")
    sys.exit(1)

checks = {
    "q1": lambda g: num(g) and g == q1,
    "q2": lambda g: isinstance(g, list) and sorted(g) == q2,
    "q3": lambda g: num(g) and g == q3,
    "q4": lambda g: num(g) and abs(g - q4) <= 0.5,
    "q5": lambda g: isinstance(g, list) and g == q5,
    "q6": lambda g: isinstance(g, dict) and set(g) == set(q6) and all(num(g[k]) and g[k] == v for k, v in q6.items()),
}
passed = 0
for key, ok in checks.items():
    g = got.get(key)
    if ok(g):
        passed += 1
    else:
        print(f"FAIL {key}: got {g!r}")
print(f"SCORE {passed}/{len(checks)}")
sys.exit(0 if passed == len(checks) else 1)

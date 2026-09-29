"""Hidden grader for py-traceback-debug: run restock.py on inputs that hit both bugs."""
import csv
import json
import math
import os
import random
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WS = os.getcwd()


def expected(stock_rows, order_objs):
    stock = {}
    for r in stock_rows:
        ps = (r["pack_size"] or "").strip()
        stock[r["sku"].strip().upper()] = (int(r["on_hand"]), int(r["reorder_point"]), int(ps) if ps else 1)
    used, unknown = {}, {}
    for o in order_objs:
        if o.get("status") == "cancelled":
            continue
        for line in o["lines"]:
            sku = line["sku"].strip().upper()
            qty = int(line.get("qty", 1))
            target = used if sku in stock else unknown
            target[sku] = target.get(sku, 0) + qty
    out = []
    for sku in sorted(stock):
        on_hand, rp, ps = stock[sku]
        left = on_hand - used.get(sku, 0)
        if left <= rp:
            out.append(f"{sku} remaining={left} order={math.ceil((2 * rp - left) / ps) * ps}")
    out += [f"UNKNOWN {s} {q}" for s, q in sorted(unknown.items())]
    return out or ["nothing to restock"]


def write(tmp, stock_rows, order_objs, blank_lines=False):
    sp, op = os.path.join(tmp, "stock.csv"), os.path.join(tmp, "orders.jsonl")
    with open(sp, "w", newline="") as f:
        w = csv.DictWriter(f, ["sku", "name", "on_hand", "reorder_point", "pack_size"])
        w.writeheader()
        w.writerows(stock_rows)
    with open(op, "w") as f:
        for i, o in enumerate(order_objs):
            f.write(json.dumps(o) + "\n")
            if blank_lines and i % 4 == 1:
                f.write("\n")
    return sp, op


def S(sku, on_hand, rp, ps="", name=None):
    return {"sku": sku, "name": name or f"Item {sku.strip()}", "on_hand": str(on_hand), "reorder_point": str(rp),
            "pack_size": str(ps)}


def O(oid, status, *lines):
    return {"id": oid, "status": status, "lines": [dict(zip(("sku", "qty"), l)) for l in lines]}


def load_sample():
    with open(os.path.join(HERE, "sample", "stock.csv"), newline="") as f:
        rows = list(csv.DictReader(f))
    with open(os.path.join(HERE, "sample", "orders.jsonl")) as f:
        objs = [json.loads(l) for l in f if l.strip()]
    return rows, objs


def random_scenario():
    rnd = random.Random(1234)
    skus = [f"{c}-{n}" for c in "PQRS" for n in (10, 20, 30, 40, 50)]
    rows = [S(rnd.choice([s, s.lower(), " " + s]), rnd.randint(0, 60), rnd.randint(1, 12),
              rnd.choice(["", "", 1, 3, 5, 12])) for s in skus]
    orders = []
    for i in range(150):
        lines = []
        for _ in range(rnd.randint(1, 4)):
            s = rnd.choice(skus + ["X-1", "x-2"])
            s = rnd.choice([s, s.lower(), f" {s}", f"{s} ", s.title()])
            lines.append((s, rnd.randint(1, 4)) if rnd.random() < 0.8 else (s,))
        orders.append(O(f"R-{i}", rnd.choice(["open", "shipped", "shipped", "cancelled"]), *lines))
    return rows, orders


scenarios = [
    ("the sample data from the report", *load_sample()),
    ("SKU case and whitespace", [S("K-1", 20, 5, 5), S(" k-2", 10, 4, 2), S("K-3", 9, 3, 3)],
     [O("1", "open", ("k-1", 8), ("K-2 ", 3)), O("2", "shipped", (" K-1", 7), ("k-3", 4)), O("3", "open", ("K-1 ", 1))]),
    ("blank pack sizes", [S("M-1", 4, 5, ""), S("M-2", 10, 3, " "), S("M-3", 2, 1, "4"), S("M-4", 7, 7, "")],
     [O("1", "shipped", ("M-1", 9), ("M-3", 1)), O("2", "open", ("M-2", 7))]),
    ("unknown SKUs, cancelled orders, default qty", [S("N-1", 5, 2, 2)],
     [O("1", "open", ("q-7", 2), ("N-1",)), O("2", "shipped", (" Q-7", 1), ("n-1",), ("zz-1",)),
      O("3", "cancelled", ("Q-7", 50), ("N-1", 50), ("new-9", 3)), O("4", "open", ("Q-7 ",), ("N-1", 1))]),
    ("nothing to restock", [S("T-1", 100, 5, 10), S("T-2", 50, 5, "")], [O("1", "open", ("t-1", 3))]),
    ("larger mixed feed", *random_scenario()),
]

passed = 0
for label, rows, objs in scenarios:
    want = expected(rows, objs)
    with tempfile.TemporaryDirectory() as tmp:
        sp, op = write(tmp, rows, objs, blank_lines=True)
        try:
            r = subprocess.run([sys.executable, "restock.py", sp, op], cwd=WS, capture_output=True, text=True,
                               timeout=20)
        except subprocess.TimeoutExpired:
            print(f"FAIL {label}: timed out")
            continue
    got = [l.rstrip() for l in r.stdout.strip().splitlines()]
    if r.returncode != 0:
        err = r.stderr.strip().splitlines()
        print(f"FAIL {label}: exit {r.returncode}: {err[-1] if err else ''}")
    elif got != want:
        print(f"FAIL {label}: output differs from what the README rules give")
    else:
        passed += 1

print(f"SCORE {passed}/{len(scenarios)}")
sys.exit(0 if passed == len(scenarios) else 1)

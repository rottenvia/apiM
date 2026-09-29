"""Hidden grader for py-csv-report: recompute the report from the pristine CSV."""
import csv
import json
import os
import re
import sys
from collections import defaultdict
from fractions import Fraction

HERE = os.path.dirname(os.path.abspath(__file__))
MONTHS = {m: i + 1 for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split())}


def month_of(text):
    t = text.strip()
    m = re.fullmatch(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})", t)
    if m:
        return f"{m[1]}-{int(m[2]):02d}"
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", t)
    if m:  # US: month/day/year
        return f"{m[3]}-{int(m[1]):02d}"
    m = re.fullmatch(r"(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})", t)
    if m:
        return f"{m[3]}-{MONTHS[m[2].lower()]:02d}"
    raise SystemExit(f"grader cannot parse date {t!r}")


def amount(text):
    t = text.strip().replace("$", "").replace(",", "")
    return Fraction(t) if t else Fraction(0)


def expected():
    seen = set()
    orders = []
    with open(os.path.join(HERE, "sales.csv"), newline="") as f:
        rows = list(csv.reader(f))
    header = rows[0]
    for raw in rows[1:]:
        if not any(c.strip() for c in raw):
            continue
        row = dict(zip(header, raw))
        oid = row["order_id"].strip().lower()
        if oid in seen:
            continue
        seen.add(oid)
        qty = int(row["quantity"])
        orders.append((month_of(row["date"]), row["region"].strip().lower(), row["product"].strip(),
                       qty, qty * amount(row["unit_price"]), abs(amount(row["refund"]))))
    by_region, by_month, units = defaultdict(Fraction), defaultdict(Fraction), defaultdict(int)
    for month, region, product, qty, gross, refund in orders:
        by_region[region] += gross - refund
        by_month[month] += gross - refund
        units[product] += qty
    top = sorted(units.items(), key=lambda kv: (-kv[1], kv[0]))[0]
    gross = sum(o[4] for o in orders)
    refunds = sum(o[5] for o in orders)
    return {
        "orders": len(orders),
        "units": sum(o[3] for o in orders),
        "gross_revenue": float(gross),
        "refunds": float(refunds),
        "net_revenue": float(gross - refunds),
        "by_region": {k: float(v) for k, v in by_region.items()},
        "by_month": {k: float(v) for k, v in by_month.items()},
        "top_product": {"name": top[0], "units": top[1]},
        "refund_rate": sum(1 for o in orders if o[5] > 0) / len(orders),
    }


def num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def main():
    if not os.path.exists("report.json"):
        print("FAIL report.json was not written")
        print("SCORE 0/9")
        return 1
    try:
        with open("report.json") as f:
            got = json.load(f)
    except Exception as e:  # noqa: BLE001
        print(f"FAIL report.json is not valid JSON: {e}")
        print("SCORE 0/9")
        return 1
    if not isinstance(got, dict):
        print("FAIL report.json is not a JSON object")
        print("SCORE 0/9")
        return 1
    want = expected()
    cases = passed = 0

    def check(label, ok, detail):
        nonlocal cases, passed
        cases += 1
        if ok:
            passed += 1
        else:
            print(f"FAIL {label}: {detail}")

    for key in ("orders", "units"):
        g = got.get(key)
        check(key, num(g) and g == want[key], f"got {g!r}, want {want[key]!r}")
    for key in ("gross_revenue", "refunds", "net_revenue"):
        g = got.get(key)
        check(key, num(g) and abs(g - want[key]) <= 0.011, f"got {g!r}, want {want[key]:.2f}")
    for key in ("by_region", "by_month"):
        g = got.get(key)
        ok = isinstance(g, dict) and set(g) == set(want[key]) and all(
            num(g[k]) and abs(g[k] - v) <= 0.011 for k, v in want[key].items())
        shown = {k: round(v, 2) for k, v in sorted(want[key].items())}
        check(key, ok, f"got {g!r}, want {shown!r}")
    g = got.get("top_product")
    check("top_product", isinstance(g, dict) and g.get("name") == want["top_product"]["name"]
          and g.get("units") == want["top_product"]["units"], f"got {g!r}, want {want['top_product']!r}")
    g = got.get("refund_rate")
    check("refund_rate", num(g) and abs(g - want["refund_rate"]) <= 0.00006,
          f"got {g!r}, want {want['refund_rate']:.4f}")
    print(f"SCORE {passed}/{cases}")
    return 0 if passed == cases else 1


sys.exit(main())

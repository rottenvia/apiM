"""Build report.json from sales.csv."""
import csv
import json
from collections import defaultdict
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP

DATE_FORMATS = ["%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%d %b %Y"]


def parse_date(text):
    text = text.strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            pass
    raise ValueError(f"unknown date {text!r}")


def money(text):
    text = text.strip().replace("$", "").replace(",", "")
    return Decimal(text) if text else Decimal(0)


def r2(x):
    return float(Decimal(x).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def main():
    seen = set()
    orders = []
    with open("sales.csv", newline="") as f:
        for row in csv.DictReader(f):
            if not row.get("order_id") or not row["order_id"].strip():
                continue
            key = row["order_id"].strip().upper()
            if key in seen:
                continue
            seen.add(key)
            qty = int(row["quantity"].strip())
            orders.append({
                "month": parse_date(row["date"]).strftime("%Y-%m"),
                "region": row["region"].strip().lower(),
                "product": row["product"].strip(),
                "qty": qty,
                "gross": qty * money(row["unit_price"]),
                "refund": abs(money(row["refund"])),
            })
    by_region = defaultdict(Decimal)
    by_month = defaultdict(Decimal)
    units = defaultdict(int)
    for o in orders:
        net = o["gross"] - o["refund"]
        by_region[o["region"]] += net
        by_month[o["month"]] += net
        units[o["product"]] += o["qty"]
    gross = sum(o["gross"] for o in orders)
    refunds = sum(o["refund"] for o in orders)
    top = min(units, key=lambda p: (-units[p], p))
    report = {
        "orders": len(orders),
        "units": sum(o["qty"] for o in orders),
        "gross_revenue": r2(gross),
        "refunds": r2(refunds),
        "net_revenue": r2(gross - refunds),
        "by_region": {k: r2(v) for k, v in sorted(by_region.items())},
        "by_month": {k: r2(v) for k, v in sorted(by_month.items())},
        "top_product": {"name": top, "units": units[top]},
        "refund_rate": round(sum(1 for o in orders if o["refund"] > 0) / len(orders), 4),
    }
    with open("report.json", "w") as f:
        json.dump(report, f, indent=2)


if __name__ == "__main__":
    main()

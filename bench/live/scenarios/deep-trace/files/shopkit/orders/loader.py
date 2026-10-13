"""Orders from the monthly export."""
import csv

from shopkit.util.money import to_cents


def load(path):
    with open(path, newline="", encoding="utf-8") as f:
        return [{"id": int(r["id"]), "region": r["region"], "sku": r["sku"], "qty": int(r["qty"]), "unit": to_cents(r["unit_price"]), "code": r["code"]} for r in csv.DictReader(f)]

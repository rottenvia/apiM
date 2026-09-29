"""Read the stock file and the order feed."""
import csv
import json

from models import Order, StockItem


def _int(text, default=0):
    text = (text or "").strip()
    return int(text) if text else default


def load_stock(path):
    stock = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            sku = row["sku"].strip().upper()
            stock[sku] = StockItem(
                sku=sku,
                name=row["name"].strip(),
                on_hand=_int(row["on_hand"]),
                reorder_point=_int(row["reorder_point"]),
                pack_size=_int(row.get("pack_size")),
            )
    return stock


def load_orders(path):
    orders = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            data = json.loads(line)
            lines = [(item["sku"], int(item.get("qty", 1))) for item in data["lines"]]
            orders.append(Order(id=data["id"], status=data.get("status", "open"), lines=lines))
    return orders

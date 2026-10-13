"""Revenue of a month, per region and in all."""
from shopkit.orders.loader import load
from shopkit.orders.totals import order_total


def revenue_by_region(path):
    out = {}
    for order in load(path):
        out[order["region"]] = out.get(order["region"], 0) + order_total(order)
    return out


def total(path):
    return sum(revenue_by_region(path).values())

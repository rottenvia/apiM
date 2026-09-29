"""Add up what the orders use."""
from collections import defaultdict


def tally(orders):
    """Units ordered per SKU, ignoring cancelled orders."""
    units = defaultdict(int)
    for order in orders:
        if order.status == "cancelled":
            continue
        for sku, qty in order.lines:
            units[sku] += qty
    return dict(units)

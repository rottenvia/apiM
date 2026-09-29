"""Decide what to re-order."""
import math

from models import Restock


def plan(stock, units):
    remaining = {sku: item.on_hand for sku, item in stock.items()}
    unknown = {}
    for sku, qty in units.items():
        if sku.upper() not in stock:
            unknown[sku] = unknown.get(sku, 0) + qty
            continue
        remaining[sku] -= qty

    restock = []
    for sku in sorted(stock):
        item = stock[sku]
        left = remaining[sku]
        if left <= item.reorder_point:
            packs = math.ceil((2 * item.reorder_point - left) / item.pack_size)
            restock.append(Restock(sku, left, packs * item.pack_size))
    return restock, unknown

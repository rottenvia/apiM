"""Discounts and choosing the best one for an order."""
from decimal import Decimal

from .pricing import calculate_total


class Discount:
    def __init__(self, name, percent=0, amount_off=0):
        self.name = name
        self.percent = Decimal(str(percent))
        self.amount_off = Decimal(str(amount_off))

    def apply(self, net):
        net = net * (1 - self.percent / 100) - self.amount_off
        return max(net, Decimal("0"))

    def __repr__(self):
        return f"Discount({self.name!r})"


def best_discount(lines, candidates, region="default"):
    """Return the candidate discount giving the lowest total (None if no candidates)."""
    lines = list(lines)
    best = None
    best_total = None
    for d in candidates:
        total = calculate_total(lines, region, d)
        if best_total is None or total < best_total:
            best, best_total = d, total
    return best

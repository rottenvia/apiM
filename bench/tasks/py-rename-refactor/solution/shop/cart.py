"""A shopping cart."""
from . import pricing


class Cart:
    def __init__(self, region="default"):
        self.region = region
        self.lines = []

    def add(self, price, qty=1):
        if qty <= 0:
            raise ValueError("quantity must be positive")
        self.lines.append((price, qty))
        return self

    def total(self, discount=None):
        return pricing.calculate_total(self.lines, self.region, discount)

    def __len__(self):
        return sum(q for _, q in self.lines)

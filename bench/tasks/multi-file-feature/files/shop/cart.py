from __future__ import annotations

from .catalog import Catalog
from .models import Coupon, LineItem


class CartError(Exception):
    pass


class CouponError(CartError):
    pass


class Cart:
    MAX_QTY = 99

    def __init__(self, catalog: Catalog):
        self.catalog = catalog
        self._lines: dict[str, LineItem] = {}
        self.coupon: Coupon | None = None

    def add(self, sku: str, qty: int = 1) -> None:
        if qty <= 0:
            raise CartError("quantity must be positive")
        product = self.catalog.get(sku)
        line = self._lines.get(sku)
        new_qty = (line.qty if line else 0) + qty
        if new_qty > self.MAX_QTY:
            raise CartError(f"at most {self.MAX_QTY} of {sku}")
        self._lines[sku] = LineItem(product, new_qty)

    def set_qty(self, sku: str, qty: int) -> None:
        if sku not in self._lines:
            raise CartError(f"{sku} is not in the cart")
        if qty <= 0:
            del self._lines[sku]
        elif qty > self.MAX_QTY:
            raise CartError(f"at most {self.MAX_QTY} of {sku}")
        else:
            self._lines[sku].qty = qty

    def remove(self, sku: str) -> None:
        self._lines.pop(sku, None)

    def lines(self) -> list[LineItem]:
        """Lines in the order they were first added."""
        return list(self._lines.values())

    def is_empty(self) -> bool:
        return not self._lines

    def apply_coupon(self, coupon: Coupon) -> None:
        self.coupon = coupon

    def clear_coupon(self) -> None:
        self.coupon = None

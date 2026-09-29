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
        self.coupons: list[Coupon] = []

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

    @property
    def coupon(self) -> Coupon | None:
        """First applied coupon (kept for older callers)."""
        return self.coupons[0] if self.coupons else None

    def apply_coupon(self, coupon: Coupon) -> None:
        """Add a coupon, enforcing the stacking rules."""
        if any(c.code == coupon.code for c in self.coupons):
            raise CouponError(f"coupon {coupon.code} is already applied")
        if any(c.exclusive for c in self.coupons):
            raise CouponError("an exclusive coupon is applied; it cannot be combined")
        if coupon.exclusive and self.coupons:
            raise CouponError(f"coupon {coupon.code} cannot be combined with other coupons")
        if coupon.kind == "percent" and any(c.kind == "percent" for c in self.coupons):
            raise CouponError("only one percentage coupon per order")
        self.coupons.append(coupon)

    def remove_coupon(self, code: str) -> None:
        for i, c in enumerate(self.coupons):
            if c.code == code:
                del self.coupons[i]
                return
        raise CouponError(f"coupon {code} is not applied")

    def clear_coupon(self) -> None:
        self.coupons.clear()

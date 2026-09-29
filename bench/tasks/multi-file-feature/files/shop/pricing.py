from __future__ import annotations

from fractions import Fraction

from . import settings
from .models import Coupon, LineItem
from .money import percent_of, round_half_up


def subtotal(lines: list[LineItem]) -> int:
    return sum(line.total_cents for line in lines)


def coupon_discount(coupon: Coupon | None, amount: int) -> int:
    """Discount for `coupon` on a merchandise amount; 0 if it doesn't qualify."""
    if coupon is None or amount < coupon.min_subtotal_cents:
        return 0
    if coupon.kind == "percent":
        return percent_of(amount, coupon.value)
    return min(coupon.value, amount)


def tax(region: str, amount: int) -> int:
    bp = settings.TAX_RATES_BP.get(region, settings.DEFAULT_TAX_BP)
    return round_half_up(Fraction(amount * bp, 10000))


def shipping(amount: int) -> int:
    if amount == 0 or amount >= settings.FREE_SHIPPING_THRESHOLD_CENTS:
        return 0
    return settings.FLAT_SHIPPING_CENTS

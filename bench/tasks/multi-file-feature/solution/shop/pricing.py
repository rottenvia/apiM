from __future__ import annotations

from fractions import Fraction

from . import settings
from .models import Coupon, LineItem, TierRule
from .money import percent_of, round_half_up


def subtotal(lines: list[LineItem]) -> int:
    return sum(line.total_cents for line in lines)


def tier_discount(lines: list[LineItem], rules: list[TierRule]) -> int:
    """Quantity-tier discount: per category, the highest tier reached applies to
    each of that category's lines, rounded half up per line."""
    qty_by_category: dict[str, int] = {}
    for line in lines:
        qty_by_category[line.product.category] = qty_by_category.get(line.product.category, 0) + line.qty
    percent_by_category = {}
    for category, qty in qty_by_category.items():
        reached = [r for r in rules if r.category == category and r.min_qty <= qty]
        if reached:
            percent_by_category[category] = max(reached, key=lambda r: r.min_qty).percent
    return sum(percent_of(line.total_cents, percent_by_category[line.product.category])
               for line in lines if line.product.category in percent_by_category)


def apply_coupons(coupons: list[Coupon], amount: int) -> tuple[list[tuple[str, int]], list[str]]:
    """Apply stacked coupons to a merchandise amount (after tier discounts).

    Returns (applied [(code, cents)], rejected codes). Minimums are checked
    against `amount`; the percent coupon goes first, then fixed coupons in
    the order given, never taking the amount below zero.
    """
    eligible = [c for c in coupons if amount >= c.min_subtotal_cents]
    rejected = [c.code for c in coupons if amount < c.min_subtotal_cents]
    ordered = [c for c in eligible if c.kind == "percent"] + [c for c in eligible if c.kind == "fixed"]
    applied = []
    remaining = amount
    for c in ordered:
        cut = percent_of(remaining, c.value) if c.kind == "percent" else min(c.value, remaining)
        applied.append((c.code, cut))
        remaining -= cut
    return applied, rejected


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

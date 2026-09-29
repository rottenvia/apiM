from __future__ import annotations

from . import pricing
from .cart import Cart, CartError
from . import settings
from .models import Customer, Order, TierRule
from .money import fmt


def checkout(cart: Cart, customer: Customer, tier_rules: list[TierRule] | None = None) -> Order:
    if cart.is_empty():
        raise CartError("cart is empty")
    if tier_rules is None:
        tier_rules = settings.DEFAULT_TIER_RULES
    lines = cart.lines()
    sub = pricing.subtotal(lines)
    tier = pricing.tier_discount(lines, tier_rules)
    applied, rejected = pricing.apply_coupons(cart.coupons, sub - tier)
    coupons = sum(cents for _, cents in applied)
    discount = tier + coupons
    merchandise = sub - discount
    tax = pricing.tax(customer.region, merchandise)
    ship = pricing.shipping(merchandise)
    order = Order(
        customer=customer,
        lines=lines,
        subtotal=sub,
        discount=discount,
        tax=tax,
        shipping=ship,
        total=merchandise + tax + ship,
        coupon_code=applied[0][0] if applied else None,
        tier_discount=tier,
        coupon_discount=coupons,
        applied_coupons=applied,
        rejected_coupons=rejected,
    )
    for code in rejected:
        order.notes.append(f"coupon {code} not applied: minimum not met")
    return order


def format_receipt(order: Order) -> str:
    width = 40
    out = []
    for line in order.lines:
        label = f"{line.qty} x {line.product.name}"
        out.append(f"{label[:width - 12]:<{width - 12}}{fmt(line.total_cents):>12}")
    out.append("-" * width)
    rows = [("Subtotal", order.subtotal)]
    if order.tier_discount:
        rows.append(("Tier discount", -order.tier_discount))
    for code, cents in order.applied_coupons:
        rows.append((f"Coupon {code}", -cents))
    rows += [("Tax", order.tax), ("Shipping", order.shipping), ("Total", order.total)]
    for label, cents in rows:
        out.append(f"{label:<{width - 12}}{fmt(cents):>12}")
    out.extend(order.notes)
    return "\n".join(out)

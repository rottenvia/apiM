from __future__ import annotations

from . import pricing
from .cart import Cart, CartError
from .models import Customer, Order
from .money import fmt


def checkout(cart: Cart, customer: Customer) -> Order:
    if cart.is_empty():
        raise CartError("cart is empty")
    lines = cart.lines()
    sub = pricing.subtotal(lines)
    discount = pricing.coupon_discount(cart.coupon, sub)
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
        coupon_code=cart.coupon.code if cart.coupon and discount else None,
    )
    if cart.coupon and not discount:
        order.notes.append(f"coupon {cart.coupon.code} not applied: minimum not met")
    return order


def format_receipt(order: Order) -> str:
    width = 40
    out = []
    for line in order.lines:
        label = f"{line.qty} x {line.product.name}"
        out.append(f"{label[:width - 12]:<{width - 12}}{fmt(line.total_cents):>12}")
    out.append("-" * width)
    rows = [("Subtotal", order.subtotal)]
    if order.discount:
        rows.append((f"Discount ({order.coupon_code})", -order.discount))
    rows += [("Tax", order.tax), ("Shipping", order.shipping), ("Total", order.total)]
    for label, cents in rows:
        out.append(f"{label:<{width - 12}}{fmt(cents):>12}")
    out.extend(order.notes)
    return "\n".join(out)

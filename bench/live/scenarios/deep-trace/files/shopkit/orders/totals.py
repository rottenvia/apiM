"""What an order comes to."""
from shopkit.pricing import discounts


def order_total(order):
    return discounts.apply(order["qty"] * order["unit"], order["code"])

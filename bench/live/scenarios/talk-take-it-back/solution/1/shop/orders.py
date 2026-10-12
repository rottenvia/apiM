"""Placed orders."""
import shop.textutils as u


def describe(order):
    return f"order {order['id']}: {u.money(order['cents'])}"


def discount(order, percent):
    return {**order, "cents": order["cents"] * (100 - u.clamp(percent, 0, 50)) // 100}

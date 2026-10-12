"""The basket a customer fills."""
from shop.textutils import clamp, money


def total(lines):
    """Lines are (unit price in cents, quantity); quantities are kept between 0 and 99."""
    return sum(price * clamp(qty, 0, 99) for price, qty in lines)


def summary(lines):
    return f"{len(lines)} lines, total {money(total(lines))}"

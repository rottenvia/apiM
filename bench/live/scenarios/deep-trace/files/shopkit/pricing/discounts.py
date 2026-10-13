"""Discount codes."""
from shopkit.pricing.rounding import half_up_div

PERCENT = {"": 0, "TEN": 10, "QUARTER": 25}


def apply(cents, code):
    """The amount after the code's discount; the discount itself is rounded half up."""
    return cents - half_up_div(cents * PERCENT[code], 100)

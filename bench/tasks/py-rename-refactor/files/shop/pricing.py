"""Turn order lines into money.

The main entry point is :func:`calc`. Order lines are ``(unit_price,
quantity)`` pairs; prices may be ints, strings or Decimals.
"""
import logging
from decimal import Decimal, ROUND_HALF_UP

from .tax import TaxTable

log = logging.getLogger(__name__)
CENT = Decimal("0.01")


def subtotal(lines):
    return sum((Decimal(str(price)) * qty for price, qty in lines), Decimal("0"))


def calc(lines, region="default", discount=None):
    """Return the gross total for ``lines`` in ``region``, rounded to cents.

    calc applies ``discount`` (a :class:`shop.discounts.Discount` or None)
    to the net subtotal first, then adds the region's tax.
    """
    lines = list(lines)
    net = subtotal(lines)
    if discount is not None:
        net = discount.apply(net)
    gross = TaxTable.for_region(region).calc(net)
    log.debug("calc: %d lines, region=%s -> %s", len(lines), region, gross)
    return gross.quantize(CENT, rounding=ROUND_HALF_UP)

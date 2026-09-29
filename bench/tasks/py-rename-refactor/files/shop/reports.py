"""Management reports."""
from collections import OrderedDict
from decimal import Decimal

from .pricing import calc
from .tax import TaxTable


def region_summary(orders):
    """``orders`` is a list of ``(region, lines)``.

    Returns an OrderedDict region -> {"orders": n, "revenue": Decimal},
    regions in first-seen order.
    """
    out = OrderedDict()
    for region, lines in orders:
        row = out.setdefault(region, {"orders": 0, "revenue": Decimal("0.00")})
        row["orders"] += 1
        row["revenue"] += calc(lines, region)
    return out


def tax_breakdown(amounts, region):
    """Tax due on each net amount in ``amounts`` for ``region``."""
    calc = TaxTable.for_region(region)
    return [calc.calc(Decimal(str(a))) - Decimal(str(a)) for a in amounts]

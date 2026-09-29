"""Exercise the shop package and print the results as JSON.

usage: probe.py orig|new   (run with the package's parent dir first on sys.path)
"""
import json
import os
import sys
import warnings
from decimal import Decimal as D

mode = sys.argv[1]
sys.path.insert(0, os.getcwd())
warnings.simplefilter("error", DeprecationWarning)

import shop  # noqa: E402
from shop import Cart, Discount, TaxTable, best_discount, invoice, pricing, reports  # noqa: E402

total = pricing.calc if mode == "orig" else pricing.calculate_total

L1 = [("9.99", 2), ("5", 1)]
L2 = [(19.99, 3), ("0.01", 7)]
L3 = [(100, 1)]
out = {}


def rec(name, fn):
    try:
        out[name] = repr(fn())
    except Exception as e:  # noqa: BLE001
        out[name] = f"raised {type(e).__name__}: {e}"


rec("t1", lambda: total(L1))
rec("t2", lambda: total(L1, "reduced"))
rec("t3", lambda: total(L2, "export"))
rec("t4", lambda: total(L3, "default", Discount("d", percent=12.5)))
rec("t5", lambda: total(L3, "reduced", Discount("big", amount_off=150)))
rec("t6", lambda: total(iter(L1), region="reduced"))
rec("t7", lambda: total([], "default"))
rec("t8", lambda: total(L1, "mars"))
rec("cart", lambda: Cart("reduced").add("2.50", 4).add(1).total(Discount("x", percent=10)))
rec("cart2", lambda: Cart().add("19.99", 2).total())
a, b, c = Discount("a", percent=5), Discount("b", amount_off=10), Discount("c", percent=30)
rec("best1", lambda: best_discount([("50", 1)], [a, b, c]))
rec("best2", lambda: best_discount([("20", 1)], [a, b], region="reduced"))
rec("best3", lambda: best_discount([("20", 1)], []))
rec("inv", lambda: invoice.render_invoice("Bo", [("3.10", 3)], "reduced"))
rec("std", lambda: invoice.standard_total(L1))
rec("gross", lambda: invoice.TOTALS["gross"](L2, "reduced"))
rec("net", lambda: invoice.TOTALS["net"](L2))
rec("summary", lambda: dict(reports.region_summary([("default", L1), ("reduced", L1), ("default", L3)])))
rec("breakdown", lambda: reports.tax_breakdown([10, "33.33"], "reduced"))
rec("taxcalc", lambda: TaxTable.for_region("default").calc(D("10")))
rec("taxon", lambda: TaxTable.for_region("reduced").tax_on("40"))
print(json.dumps(out, sort_keys=True))

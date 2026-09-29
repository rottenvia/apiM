"""Plain-text invoices."""
import functools

from .pricing import calculate_total, subtotal

# Used by the nightly batch job: totals are always for the default region.
standard_total = functools.partial(calculate_total, region="default")

TOTALS = {
    "gross": calculate_total,
    "net": lambda lines, region="default", discount=None: subtotal(lines),
}


def render_invoice(customer, lines, region="default"):
    lines = list(lines)
    out = [f"Invoice for {customer}"]
    for price, qty in lines:
        out.append(f"  {qty} x {price}")
    out.append(f"Net:   {TOTALS['net'](lines):.2f}")
    out.append(f"Total: {calculate_total(lines, region)}")
    return "\n".join(out)

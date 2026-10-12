"""Invoice arithmetic. All money is integer cents."""
import calendar
import datetime as dt


def line_total(qty, unit_cents, discount_pct=0):
    """Cents for one line: qty * unit price, less the discount, rounded half up to a whole cent."""
    return (qty * unit_cents * (100 - discount_pct) + 50) // 100


def invoice_total(lines, tax_pct):
    """Total of an invoice: the line totals, plus tax on their sum, tax rounded half up to a whole cent.

    lines is a list of (qty, unit_cents, discount_pct).
    """
    net = sum(line_total(*line) for line in lines)
    return net + (net * tax_pct + 50) // 100


def format_cents(cents):
    """1234567 -> "12,345.67", -5 -> "-0.05": thousands separated by commas, always two decimals."""
    sign = "-" if cents < 0 else ""
    whole, part = divmod(abs(cents), 100)
    return f"{sign}{whole:,}.{part:02d}"


def due_date(issued, terms):
    """The day an invoice falls due. issued is a datetime.date.

    "net30" / "net60" (any number): that many days after issue.
    "eom": the last day of the month of issue.
    Anything else raises ValueError.
    """
    if terms == "eom":
        return issued.replace(day=calendar.monthrange(issued.year, issued.month)[1])
    if terms.startswith("net") and terms[3:].isdigit():
        return issued + dt.timedelta(days=int(terms[3:]))
    raise ValueError(f"unknown terms: {terms}")

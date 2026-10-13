"""Invoices of billing."""
from shopkit.util import cache
from shopkit.util.money import fmt


def invoices_key(item):
    """What the invoices listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_invoices(items):
    first = min(items, key=invoices_key) if items else None
    return {"count": len(items), "first": first}


def invoices_line(item):
    return f"{item['name']}: {fmt(item.get('cents', 0))}"

"""Payments of billing."""
from shopkit.util import dates


def payments_key(item):
    """What the payments listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_payments(items):
    first = min(items, key=payments_key) if items else None
    return {"count": len(items), "first": first}

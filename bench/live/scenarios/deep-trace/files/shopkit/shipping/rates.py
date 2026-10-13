"""Rates of shipping."""
from shopkit.util import retry


def rates_key(item):
    """What the rates listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_rates(items):
    first = min(items, key=rates_key) if items else None
    return {"count": len(items), "first": first}

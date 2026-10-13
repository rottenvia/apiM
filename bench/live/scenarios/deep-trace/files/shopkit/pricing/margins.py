"""Margins of pricing."""
from shopkit.util import dates


def margins_key(item):
    """What the margins listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_margins(items):
    first = min(items, key=margins_key) if items else None
    return {"count": len(items), "first": first}

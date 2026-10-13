"""Splitting of orders."""
from shopkit.util import retry


def splitting_key(item):
    """What the splitting listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_splitting(items):
    first = min(items, key=splitting_key) if items else None
    return {"count": len(items), "first": first}

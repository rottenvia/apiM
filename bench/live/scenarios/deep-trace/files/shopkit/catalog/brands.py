"""Brands of catalog."""
from shopkit.util import cache


def brands_key(item):
    """What the brands listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_brands(items):
    first = min(items, key=brands_key) if items else None
    return {"count": len(items), "first": first}

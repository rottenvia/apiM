"""Variants of catalog."""
from shopkit.util import dates


def variants_key(item):
    """What the variants listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_variants(items):
    first = min(items, key=variants_key) if items else None
    return {"count": len(items), "first": first}

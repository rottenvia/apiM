"""Bundles of catalog."""
from shopkit.util import csvio


def bundles_key(item):
    """What the bundles listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_bundles(items):
    first = min(items, key=bundles_key) if items else None
    return {"count": len(items), "first": first}

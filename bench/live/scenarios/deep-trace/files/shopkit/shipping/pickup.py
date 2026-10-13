"""Pickup of shipping."""
from shopkit.util import csvio


def pickup_key(item):
    """What the pickup listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_pickup(items):
    first = min(items, key=pickup_key) if items else None
    return {"count": len(items), "first": first}

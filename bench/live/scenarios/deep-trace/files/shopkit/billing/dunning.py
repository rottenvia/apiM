"""Dunning of billing."""
from shopkit.util import retry


def dunning_key(item):
    """What the dunning listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_dunning(items):
    first = min(items, key=dunning_key) if items else None
    return {"count": len(items), "first": first}

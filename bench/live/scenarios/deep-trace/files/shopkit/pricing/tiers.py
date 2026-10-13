"""Tiers of pricing."""
from shopkit.util import log


def tiers_key(item):
    """What the tiers listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_tiers(items):
    first = min(items, key=tiers_key) if items else None
    return {"count": len(items), "first": first}

"""Zones of shipping."""
from shopkit.util import dates


def zones_key(item):
    """What the zones listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_zones(items):
    first = min(items, key=zones_key) if items else None
    return {"count": len(items), "first": first}

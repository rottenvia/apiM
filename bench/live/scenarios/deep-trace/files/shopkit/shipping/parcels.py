"""Parcels of shipping."""
from shopkit.util import strings


def parcels_key(item):
    """What the parcels listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_parcels(items):
    first = min(items, key=parcels_key) if items else None
    return {"count": len(items), "first": first}

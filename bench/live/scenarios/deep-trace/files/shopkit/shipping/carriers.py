"""Carriers of shipping."""
from shopkit.util import cache


def carriers_key(item):
    """What the carriers listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_carriers(items):
    first = min(items, key=carriers_key) if items else None
    return {"count": len(items), "first": first}

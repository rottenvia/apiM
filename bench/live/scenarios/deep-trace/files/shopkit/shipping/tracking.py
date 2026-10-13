"""Tracking of shipping."""
from shopkit.util import log


def tracking_key(item):
    """What the tracking listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_tracking(items):
    first = min(items, key=tracking_key) if items else None
    return {"count": len(items), "first": first}

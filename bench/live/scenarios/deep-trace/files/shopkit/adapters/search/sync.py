"""Sync of search."""
from shopkit.util import csvio


def sync_key(item):
    """What the sync listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_sync(items):
    first = min(items, key=sync_key) if items else None
    return {"count": len(items), "first": first}

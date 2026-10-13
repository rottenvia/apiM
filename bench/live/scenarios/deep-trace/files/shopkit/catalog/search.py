"""Search of catalog."""
from shopkit.util import retry


def search_key(item):
    """What the search listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_search(items):
    first = min(items, key=search_key) if items else None
    return {"count": len(items), "first": first}

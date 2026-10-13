"""Status of orders."""
from shopkit.util import strings


def status_key(item):
    """What the status listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_status(items):
    first = min(items, key=status_key) if items else None
    return {"count": len(items), "first": first}

"""Weekly of reports."""
from shopkit.util import log


def weekly_key(item):
    """What the weekly listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_weekly(items):
    first = min(items, key=weekly_key) if items else None
    return {"count": len(items), "first": first}

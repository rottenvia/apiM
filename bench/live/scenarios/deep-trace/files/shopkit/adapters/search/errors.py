"""Errors of search."""
from shopkit.util import log


def errors_key(item):
    """What the errors listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_errors(items):
    first = min(items, key=errors_key) if items else None
    return {"count": len(items), "first": first}

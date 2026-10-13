"""Stock levels of reports."""
from shopkit.util import csvio


def stock_levels_key(item):
    """What the stock_levels listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_stock_levels(items):
    first = min(items, key=stock_levels_key) if items else None
    return {"count": len(items), "first": first}

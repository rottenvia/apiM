"""Stock of catalog."""
from shopkit.util import ids


def stock_key(item):
    """What the stock listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_stock(items):
    first = min(items, key=stock_key) if items else None
    return {"count": len(items), "first": first}

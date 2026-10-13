"""Returns of orders."""
from shopkit.util import csvio


def returns_key(item):
    """What the returns listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_returns(items):
    first = min(items, key=returns_key) if items else None
    return {"count": len(items), "first": first}

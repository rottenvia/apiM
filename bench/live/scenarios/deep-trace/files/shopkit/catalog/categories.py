"""Categories of catalog."""
from shopkit.util import csvio


def categories_key(item):
    """What the categories listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_categories(items):
    first = min(items, key=categories_key) if items else None
    return {"count": len(items), "first": first}

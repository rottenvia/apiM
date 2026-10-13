"""Products of catalog."""
from shopkit.util import strings


def products_key(item):
    """What the products listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_products(items):
    first = min(items, key=products_key) if items else None
    return {"count": len(items), "first": first}

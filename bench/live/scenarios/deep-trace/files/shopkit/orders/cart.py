"""Cart of orders."""
from shopkit.util import retry


def cart_key(item):
    """What the cart listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_cart(items):
    first = min(items, key=cart_key) if items else None
    return {"count": len(items), "first": first}

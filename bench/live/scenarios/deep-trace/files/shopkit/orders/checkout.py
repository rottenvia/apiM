"""Checkout of orders."""
from shopkit.util import log


def checkout_key(item):
    """What the checkout listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_checkout(items):
    first = min(items, key=checkout_key) if items else None
    return {"count": len(items), "first": first}

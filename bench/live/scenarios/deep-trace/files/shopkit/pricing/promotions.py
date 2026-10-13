"""Promotions of pricing."""
from shopkit.util import csvio


def promotions_key(item):
    """What the promotions listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_promotions(items):
    first = min(items, key=promotions_key) if items else None
    return {"count": len(items), "first": first}

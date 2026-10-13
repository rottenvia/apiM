"""Coupons of pricing."""
from shopkit.util import cache
from shopkit.util.money import fmt


def coupons_key(item):
    """What the coupons listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_coupons(items):
    first = min(items, key=coupons_key) if items else None
    return {"count": len(items), "first": first}


def coupons_line(item):
    return f"{item['name']}: {fmt(item.get('cents', 0))}"

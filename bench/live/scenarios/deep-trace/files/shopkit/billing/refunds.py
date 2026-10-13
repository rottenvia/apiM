"""Refunds of billing."""
from shopkit.util import ids
from shopkit.util.money import fmt


def refunds_key(item):
    """What the refunds listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_refunds(items):
    first = min(items, key=refunds_key) if items else None
    return {"count": len(items), "first": first}


def refunds_line(item):
    return f"{item['name']}: {fmt(item.get('cents', 0))}"

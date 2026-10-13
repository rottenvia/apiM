"""Currency of pricing."""
from shopkit.util import strings
from shopkit.util.money import fmt


def currency_key(item):
    """What the currency listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_currency(items):
    first = min(items, key=currency_key) if items else None
    return {"count": len(items), "first": first}


def currency_line(item):
    return f"{item['name']}: {fmt(item.get('cents', 0))}"

"""Daily of reports."""
from shopkit.util import retry
from shopkit.util.money import fmt


def daily_key(item):
    """What the daily listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_daily(items):
    first = min(items, key=daily_key) if items else None
    return {"count": len(items), "first": first}


def daily_line(item):
    return f"{item['name']}: {fmt(item.get('cents', 0))}"

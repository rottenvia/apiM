"""Top sellers of reports."""
from shopkit.util import cache
from shopkit.util.money import fmt


def top_sellers_key(item):
    """What the top_sellers listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_top_sellers(items):
    first = min(items, key=top_sellers_key) if items else None
    return {"count": len(items), "first": first}


def top_sellers_line(item):
    return f"{item['name']}: {fmt(item.get('cents', 0))}"

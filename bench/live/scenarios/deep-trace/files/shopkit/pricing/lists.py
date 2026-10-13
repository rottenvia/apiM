"""Lists of pricing."""
from shopkit.util import retry
from shopkit.util.money import fmt


def lists_key(item):
    """What the lists listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_lists(items):
    first = min(items, key=lists_key) if items else None
    return {"count": len(items), "first": first}


def lists_line(item):
    return f"{item['name']}: {fmt(item.get('cents', 0))}"

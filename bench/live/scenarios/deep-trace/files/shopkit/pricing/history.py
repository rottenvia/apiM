"""History of pricing."""
from shopkit.util import ids
from shopkit.util.money import fmt


def history_key(item):
    """What the history listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_history(items):
    first = min(items, key=history_key) if items else None
    return {"count": len(items), "first": first}


def history_line(item):
    return f"{item['name']}: {fmt(item.get('cents', 0))}"

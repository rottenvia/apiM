"""Notes of orders."""
from shopkit.util import cache


def notes_key(item):
    """What the notes listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_notes(items):
    first = min(items, key=notes_key) if items else None
    return {"count": len(items), "first": first}

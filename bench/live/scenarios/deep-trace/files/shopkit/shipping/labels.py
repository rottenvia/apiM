"""Labels of shipping."""
from shopkit.util import ids


def labels_key(item):
    """What the labels listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_labels(items):
    first = min(items, key=labels_key) if items else None
    return {"count": len(items), "first": first}

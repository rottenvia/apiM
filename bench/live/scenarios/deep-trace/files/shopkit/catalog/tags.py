"""Tags of catalog."""
from shopkit.util import strings


def tags_key(item):
    """What the tags listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_tags(items):
    first = min(items, key=tags_key) if items else None
    return {"count": len(items), "first": first}

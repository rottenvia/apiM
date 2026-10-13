"""Models of search."""
from shopkit.util import strings


def models_key(item):
    """What the models listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_models(items):
    first = min(items, key=models_key) if items else None
    return {"count": len(items), "first": first}

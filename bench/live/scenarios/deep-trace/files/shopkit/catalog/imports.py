"""Imports of catalog."""
from shopkit.util import cache


def imports_key(item):
    """What the imports listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_imports(items):
    first = min(items, key=imports_key) if items else None
    return {"count": len(items), "first": first}

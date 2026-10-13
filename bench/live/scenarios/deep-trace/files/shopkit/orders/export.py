"""Export of orders."""
from shopkit.util import ids


def export_key(item):
    """What the export listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_export(items):
    first = min(items, key=export_key) if items else None
    return {"count": len(items), "first": first}

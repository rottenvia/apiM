"""Export csv of reports."""
from shopkit.util import dates


def export_csv_key(item):
    """What the export_csv listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_export_csv(items):
    first = min(items, key=export_csv_key) if items else None
    return {"count": len(items), "first": first}
